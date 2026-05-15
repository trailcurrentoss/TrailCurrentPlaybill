/* DVD metadata lookup — turn a disc's ISO-9660 volume label into a
   human-readable title + poster + year, using OMDb.

   The volume label format on commercial DVDs is a noisy, decades-old
   convention:
     • all uppercase
     • underscores as word separators
     • episode markers like "_DISC2" / "_D2" / "_VOL3" tacked on the end
     • studio prefixes like "WB_" sometimes prepended

   Strategy:
     1. heuristicTitle(label) — strip junk, lowercase, title-case. This is
        the suggested title the user sees in the prompt; they can edit it.
     2. lookupOmdb(title, year?) — hit https://www.omdbapi.com/?t=...
        with the user's API key. Returns null if unconfigured, network
        failure, or "Movie not found!" — caller falls back to manual
        entry in that case.

   We deliberately do NOT try to identify the disc by binary hash
   (libdvdread CRC, anyDVD-style content fingerprint). Those approaches
   need a server-side database and either commercial license (Gracenote)
   or non-trivial infrastructure (CDDB analogues). Title-based OMDb is
   90% as good for 1% of the effort. */

'use strict';

const https = require('https');

// Studio prefixes/suffixes that show up on retail discs but aren't part
// of the title. Strip them before title-casing. Lower-case for matching.
const STUDIO_JUNK = [
  'wb', 'mgm', 'fox', 'columbia', 'universal', 'paramount', 'disney',
  'dreamworks', 'lionsgate', 'criterion', 'sony', 'lvfs',
];

const DISC_MARKER_RE = /[_-]?(disc|disk|vol|d|cd)\s*\d+\b.*$/i;
const SEASON_MARKER_RE = /[_-]?s\d{1,2}e\d{1,2}\b.*$/i;
const YEAR_TAIL_RE = /[_-]?\(?(19|20)\d{2}\)?$/;

function titleCase(s) {
  // Lower-case the whole string then upper-case the start of each word.
  // Small words (a, an, the, of, and, ...) are kept lower-case unless
  // they're the first word — matches the convention in the rest of the
  // library's data.js fixture.
  const smalls = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with']);
  return s.toLowerCase().split(/\s+/).map((w, i) => {
    if (i > 0 && smalls.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

/** Convert a DVD volume label into a best-guess movie title. */
function heuristicTitle(label) {
  if (!label || typeof label !== 'string') return '';

  let s = label.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Strip disc / season markers.
  s = s.replace(DISC_MARKER_RE, '').trim();
  s = s.replace(SEASON_MARKER_RE, '').trim();
  // Trailing year (e.g. "INCEPTION 2010") — we keep it as a hint for the
  // lookup but pull it out of the title.
  let year = null;
  const ym = s.match(YEAR_TAIL_RE);
  if (ym) {
    year = ym[0].replace(/[^\d]/g, '');
    s = s.replace(YEAR_TAIL_RE, '').trim();
  }
  // Strip leading studio prefixes.
  const firstWord = s.split(/\s+/)[0] || '';
  if (STUDIO_JUNK.includes(firstWord.toLowerCase())) {
    s = s.split(/\s+/).slice(1).join(' ');
  }

  return { title: titleCase(s), yearHint: year };
}

/**
 * Query OMDb for a title. Returns the OMDb payload normalized to:
 *   { title, year, plot, posterUrl, rating, kind, imdbId, runtime, source }
 * Returns null on any failure path so callers can fall back to manual entry.
 *
 * @param {string} apiKey      OMDb API key (free tier: 1000 reqs/day)
 * @param {object} q
 * @param {string} q.title
 * @param {string} [q.year]
 * @param {AbortSignal} [q.signal]
 */
function lookupOmdb(apiKey, q) {
  if (!apiKey || !q || !q.title) return Promise.resolve(null);
  const params = new URLSearchParams({ apikey: apiKey, t: q.title, plot: 'short' });
  if (q.year) params.set('y', q.year);
  const url = `https://www.omdbapi.com/?${params.toString()}`;

  return new Promise((resolve) => {
    const req = https.request(url, { method: 'GET', timeout: 6000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.Response !== 'True') {
            // Surface the real failure reason instead of swallowing it. OMDb
            // returns Response:"False" + Error:"..." for invalid key,
            // movie-not-found, daily-limit, etc.; without this log, a
            // misconfigured key or daily-limit-hit looks identical to
            // "didn't find a match" and the user has no diagnostic path.
            console.warn(`[dvd-metadata] OMDb lookup '${q.title}' returned Response=${j.Response} Error=${j.Error || '(none)'}`);
            resolve(null); return;
          }
          resolve({
            title:     j.Title,
            year:      j.Year && j.Year.replace(/[^\d].*$/, ''),  // OMDb returns "2010–" for ongoing shows
            plot:      j.Plot && j.Plot !== 'N/A' ? j.Plot : null,
            posterUrl: j.Poster && j.Poster !== 'N/A' ? j.Poster : null,
            rating:    j.imdbRating && j.imdbRating !== 'N/A' ? j.imdbRating : null,
            kind:      j.Type === 'series' ? 'show' : 'movie',
            imdbId:    j.imdbID,
            runtime:   j.Runtime && j.Runtime !== 'N/A' ? j.Runtime : null,
            source:    'omdb',
          });
        } catch (e) {
          console.warn(`[dvd-metadata] OMDb lookup '${q.title}' JSON parse failed: ${e.message}; body=${body.slice(0, 200)}`);
          resolve(null);
        }
      });
    });
    req.on('timeout', () => {
      console.warn(`[dvd-metadata] OMDb lookup '${q.title}' timed out after 6 s`);
      try { req.destroy(); } catch(_){}
      resolve(null);
    });
    req.on('error', (e) => {
      // TLS certificate issues / DNS failures / connection refused all
      // surface as 'error'. Including the actual e.message means a future
      // "the lookup silently failed" debugging session takes 5 seconds in
      // the journal instead of 50 minutes of bisecting through code paths.
      console.warn(`[dvd-metadata] OMDb lookup '${q.title}' HTTP error: ${e.message}`);
      resolve(null);
    });
    req.end();
  });
}

module.exports = { heuristicTitle, lookupOmdb };
