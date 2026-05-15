/* DVD library — read-side index of the on-disk Playbill Library tree.

   We don't keep a separate database — the source of truth is the file
   system. Every ripped title is a folder containing one .mkv and one
   .json sidecar; scanning is "for each subfolder under Movies/Shows,
   read the sidecar." Cheap (low hundreds of entries even for a heavy
   ripper) and survives backups + manual file moves without a re-index
   step. */

'use strict';

const fs   = require('fs');
const path = require('path');
const { LIBRARY_ROOT } = require('./dvd-ripper');

function safeReadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

// Build a file:// URL from an absolute path. The renderer uses these
// as <img> / background-image sources. Paths contain spaces and
// parentheses (e.g. "Inception (2010).jpg") so encodeURI is mandatory
// to keep them legal.
function toFileUrl(absPath) {
  // encodeURI preserves '/' but escapes spaces/parens. Prepend file://
  // (Linux paths begin with '/', so the result is file:///home/...).
  return 'file://' + encodeURI(absPath);
}

function scanCategory(category) {
  const root = path.join(LIBRARY_ROOT, category);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    // Pair every .mkv with its sidecar — for movies there's one of each,
    // for shows there can be many episode .mkvs in a single show folder.
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith('.mkv')) continue;
      const base = f.slice(0, -4);
      const jsonPath = path.join(dir, base + '.json');
      const meta = safeReadJson(jsonPath);
      // .mkv with no sidecar means a half-written rip — skip; the library
      // shouldn't show broken entries.
      if (!meta) continue;
      // Resolve the poster: prefer the on-disk file (off-grid usage),
      // fall back to the remote URL only when no local copy exists yet
      // (rip in progress, or older rip from before poster-caching).
      let posterLocalUrl = null;
      const localPosterRel = meta.posterPath
        || (fs.existsSync(path.join(dir, base + '.jpg')) ? base + '.jpg' : null);
      if (localPosterRel) {
        const absPoster = path.join(dir, localPosterRel);
        if (fs.existsSync(absPoster)) posterLocalUrl = toFileUrl(absPoster);
      }
      // mtime of the .mkv stands in for "added to library at." The rip
      // pipeline writes the .mkv last; the sidecar is rewritten at poster
      // backfill time, so the .mkv is the more stable timestamp.
      const mkvPath = path.join(dir, f);
      let addedAt = 0;
      try { addedAt = fs.statSync(mkvPath).mtimeMs; } catch (_) { /* missing — leave 0 */ }
      out.push({
        id:        path.join(category, entry.name, f),
        kind:      category === 'Shows' ? 'show' : 'movie',
        title:     meta.title || base,
        year:      meta.year || null,
        plot:      meta.plot || null,
        // Primary display source — local file:// URL if present,
        // remote URL otherwise. Renderer just uses .posterUrl and
        // doesn't have to know which it is.
        posterUrl: posterLocalUrl || meta.posterUrl || null,
        // Remote URL kept separately so a backfill action can re-fetch
        // it later without having to re-look-up in OMDb.
        posterUrlRemote: meta.posterUrl || null,
        posterLocal:     !!posterLocalUrl,
        rating:    meta.rating || null,
        runtime:   meta.runtime || null,
        path:      mkvPath,
        sidecar:   jsonPath,
        addedAt,
      });
    }
  }
  // Newest first — drives "most recent" rows on the home screen and the
  // ordering inside the Library view.
  out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  return out;
}

function list() {
  return {
    movies: scanCategory('Movies'),
    shows:  scanCategory('Shows'),
    root:   LIBRARY_ROOT,
  };
}

module.exports = { list, LIBRARY_ROOT };
