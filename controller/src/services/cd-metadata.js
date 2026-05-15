/* Audio-CD metadata lookup — turn a disc's table-of-contents into an
   album title + artist + per-track names, using MusicBrainz.

   MusicBrainz is the right backend for audio CDs because:
     • free, no API key (rate-limited to ~1 req/sec; we obey)
     • indexed by CD TOC, so any pressing of any commercial CD matches
       without needing the user to type anything
     • covers obscure / regional / out-of-print pressings that Gracenote
       and freedb.org miss
     • Cover Art Archive (coverartarchive.org) provides the album art
       keyed by MusicBrainz release id

   Two lookup paths:
     1. TOC lookup — the strong path. We have the disc's track LBA
        offsets + leadout from cd-discid; convert to MB-TOC format
        (https://musicbrainz.org/doc/Disc_ID_Calculation) and query
        /ws/2/discid/-?toc=...&inc=artists+recordings. If the disc has
        been seen by anyone on MB before, this returns an exact match.
     2. Title search — fallback when the user typed a guess. Used when
        TOC lookup returns nothing (rare pressings, scratched discs).

   The volume label on a commercial audio CD is usually empty or just
   the bare album name; we don't use it as a primary key (unlike the
   DVD flow), but we surface whatever we got from cd-info as a hint to
   pre-fill the manual-entry form. */

'use strict';

const https = require('https');

const MB_HOST = 'musicbrainz.org';
// User-Agent is REQUIRED by MusicBrainz's policy. Identifies the app +
// contact in case our requests cause problems.
const USER_AGENT = 'TrailCurrent-Playbill/0.1 ( https://trailcurrent.com )';

// Minimum gap between requests to musicbrainz.org. They publish a hard
// rate limit of 1 req/sec; bursting gets us throttled. A single global
// timestamp is enough because the controller is single-process.
const MB_MIN_INTERVAL_MS = 1100;
let _lastMbRequestAt = 0;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function mbFetch(path) {
  // Pace requests.
  const wait = Math.max(0, MB_MIN_INTERVAL_MS - (Date.now() - _lastMbRequestAt));
  if (wait > 0) await sleep(wait);
  _lastMbRequestAt = Date.now();

  return new Promise((resolve) => {
    const req = https.request({
      host: MB_HOST,
      path,
      method: 'GET',
      timeout: 8000,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 404) { resolve(null); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) { resolve(null); return; }
        try { resolve(JSON.parse(body)); }
        catch (_) { resolve(null); }
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch(_){} resolve(null); });
    req.on('error',   () => resolve(null));
    req.end();
  });
}

/**
 * Convert cd-discid's TOC representation into the MB-TOC string the
 * MusicBrainz `discid` endpoint accepts via ?toc=. MB's format:
 *
 *   first_track last_track leadout_lba track1_lba track2_lba ... trackN_lba
 *
 * cd-discid gives us track LBA offsets directly (already include the
 * 150-frame pregap) and the disc length in SECONDS (NOT LBA, no pregap).
 * Convert leadout: leadout_lba = lengthSec * 75 + 150 (75 frames/second
 * + the standard 2-second pregap).
 */
function buildMbToc({ ntracks, trackOffsetsLba, lengthSec }) {
  if (!ntracks || !Array.isArray(trackOffsetsLba) || trackOffsetsLba.length !== ntracks) return null;
  const leadoutLba = (lengthSec * 75) + 150;
  return [1, ntracks, leadoutLba, ...trackOffsetsLba].join('+');
}

/**
 * Normalize a MusicBrainz release object into our internal shape. MB
 * returns a release with `media[]` → each medium has tracks. For an
 * audio CD there's usually exactly one medium; we collapse it.
 */
function normalizeRelease(release) {
  if (!release) return null;
  const title = release.title || '';
  const artist = (release['artist-credit'] || [])
    .map((a) => (a.artist && a.artist.name) || a.name || '')
    .filter(Boolean)
    .join(', ');
  const year = release.date ? release.date.slice(0, 4) : null;
  const mbid = release.id || null;
  const media = (release.media && release.media.length) ? release.media[0] : null;
  const rawTracks = (media && media.tracks) || [];
  const tracks = rawTracks.map((t, i) => ({
    number:      t.position || (i + 1),
    title:       (t.title || (t.recording && t.recording.title) || `Track ${i + 1}`),
    durationMs:  t.length || (t.recording && t.recording.length) || null,
    artist:      (t['artist-credit'] || [])
      .map((a) => (a.artist && a.artist.name) || a.name || '')
      .filter(Boolean)
      .join(', ') || artist,
  }));
  return {
    title, artist, year, mbid,
    country:  release.country || null,
    barcode:  release.barcode || null,
    tracks,
    coverArtUrl: mbid ? `https://coverartarchive.org/release/${mbid}/front` : null,
    source: 'musicbrainz',
  };
}

/**
 * TOC-based lookup. Returns the first matching release or null.
 * @param {object} toc { ntracks, trackOffsetsLba, lengthSec, discid? }
 */
async function lookupMusicBrainzByToc(toc) {
  const tocStr = buildMbToc(toc);
  if (!tocStr) return null;
  // discid '-' means "no discid; look up by TOC alone." MB also accepts
  // a real discid (their own format, not FreeDB) for tighter matches —
  // we don't compute it here because the TOC lookup is sufficient.
  const path = `/ws/2/discid/-?toc=${encodeURIComponent(tocStr)}&inc=artists+recordings&fmt=json`;
  const j = await mbFetch(path);
  if (!j) return null;
  // MB returns { releases: [...] } when at least one match; { error: ... }
  // otherwise.
  const releases = j.releases || [];
  if (!releases.length) return null;
  // Prefer official releases over bootlegs / promotional. Then prefer
  // releases with the earliest year (canonical pressing). Then alpha by
  // country for determinism.
  releases.sort((a, b) => {
    const sa = (a.status === 'Official') ? 0 : 1;
    const sb = (b.status === 'Official') ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const ya = a.date || '9999';
    const yb = b.date || '9999';
    return ya.localeCompare(yb);
  });
  return normalizeRelease(releases[0]);
}

/**
 * Title/artist search fallback. Used when TOC lookup returned nothing
 * and the user typed a guess. Returns the best match or null.
 */
async function lookupMusicBrainzByQuery({ album, artist }) {
  if (!album && !artist) return null;
  const parts = [];
  if (album)  parts.push(`release:"${album.replace(/"/g, '')}"`);
  if (artist) parts.push(`artist:"${artist.replace(/"/g, '')}"`);
  const query = parts.join(' AND ');
  const path = `/ws/2/release/?query=${encodeURIComponent(query)}&fmt=json&limit=5`;
  const j = await mbFetch(path);
  if (!j || !Array.isArray(j.releases) || !j.releases.length) return null;
  // The /release search endpoint doesn't include media/tracks in its
  // results — we have to fetch the full release by id to get the
  // tracklist.
  const best = j.releases[0];
  const detail = await mbFetch(`/ws/2/release/${best.id}?inc=artists+recordings&fmt=json`);
  return normalizeRelease(detail || best);
}

module.exports = {
  buildMbToc,
  lookupMusicBrainzByToc,
  lookupMusicBrainzByQuery,
  normalizeRelease,
};
