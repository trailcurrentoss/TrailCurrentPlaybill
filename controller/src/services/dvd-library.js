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
      out.push({
        id:        path.join(category, entry.name, f),
        kind:      category === 'Shows' ? 'show' : 'movie',
        title:     meta.title || base,
        year:      meta.year || null,
        plot:      meta.plot || null,
        posterUrl: meta.posterUrl || null,
        rating:    meta.rating || null,
        runtime:   meta.runtime || null,
        path:      path.join(dir, f),
        sidecar:   jsonPath,
      });
    }
  }
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
