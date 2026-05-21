/* Music library — read-side index of the on-disk Playbill Music tree.

   Mirrors dvd-library.js: file system is the source of truth, no
   separate database. Each album is a folder containing one album.json
   sidecar + N .flac files + (optionally) cover.jpg. Scanning walks
   <root>/<Artist>/<Album>/.

   Returns the shape the renderer expects:
     {
       albums: [{
         id, title, artist, year, mbid, coverUrl,
         tracks: [{ number, title, artist, durationMs, url }],
         path,            // absolute album folder
         sidecar,
       }],
       root,
     }

   `url` on each track is a file:// URL the renderer can hand directly
   to transport.play. */

'use strict';

const fs   = require('fs');
const path = require('path');
const { LIBRARY_ROOT } = require('./cd-ripper');

function safeReadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

// See dvd-library.js for the parens rationale — albums under folders
// like "Best Of (1999-2009)" need %28/%29 so the URL stays parseable
// inside CSS url() rules.
function toFileUrl(absPath) {
  return 'file://' + encodeURI(absPath)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function scanAlbumDir(albumDir) {
  const sidecarPath = path.join(albumDir, 'album.json');
  const meta = safeReadJson(sidecarPath);
  if (!meta) return null;
  if (!Array.isArray(meta.tracks)) return null;

  // Cover art: prefer the on-disk cover.jpg (off-grid), fall back to
  // the remote coverArtUrl (rip in progress, or fetch failed).
  let coverUrl = null;
  const localCover = path.join(albumDir, meta.coverPath || 'cover.jpg');
  if (fs.existsSync(localCover)) coverUrl = toFileUrl(localCover);
  else if (meta.coverArtUrl) coverUrl = meta.coverArtUrl;

  // Tracks: only surface tracks whose flac is on disk. A partial rip
  // shows N tracks where N < album total, which is the truth — the
  // user can resume from a fresh insert.
  const tracks = meta.tracks
    .map((t, i) => {
      if (!t || !t.file) return null;
      const abs = path.join(albumDir, t.file);
      if (!fs.existsSync(abs)) return null;
      return {
        number:     t.number || (i + 1),
        title:      t.title || `Track ${t.number || i + 1}`,
        artist:     t.artist || meta.artist || '',
        durationMs: t.durationMs || null,
        url:        toFileUrl(abs),
        path:       abs,
      };
    })
    .filter(Boolean);

  if (!tracks.length) return null;

  return {
    id:       albumDir,    // absolute path is a unique stable id
    title:    meta.title || path.basename(albumDir),
    artist:   meta.artist || 'Unknown Artist',
    year:     meta.year || null,
    mbid:     meta.mbid || null,
    coverUrl,
    coverLocal: coverUrl && coverUrl.startsWith('file://'),
    coverArtUrlRemote: meta.coverArtUrl || null,
    tracks,
    trackCount: tracks.length,
    totalDurationMs: tracks.reduce((s, t) => s + (t.durationMs || 0), 0) || null,
    path:     albumDir,
    sidecar:  sidecarPath,
  };
}

function list() {
  const root = LIBRARY_ROOT;
  if (!fs.existsSync(root)) return { albums: [], root };
  const albums = [];
  for (const artistEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!artistEntry.isDirectory()) continue;
    const artistDir = path.join(root, artistEntry.name);
    for (const albumEntry of fs.readdirSync(artistDir, { withFileTypes: true })) {
      if (!albumEntry.isDirectory()) continue;
      const album = scanAlbumDir(path.join(artistDir, albumEntry.name));
      if (album) albums.push(album);
    }
  }
  // Sort albums by artist then year then title for a stable grid.
  albums.sort((a, b) => {
    const ax = (a.artist || '').toLowerCase();
    const bx = (b.artist || '').toLowerCase();
    if (ax !== bx) return ax < bx ? -1 : 1;
    const ay = a.year || '9999';
    const by = b.year || '9999';
    if (ay !== by) return ay < by ? -1 : 1;
    return (a.title || '').localeCompare(b.title || '');
  });
  return { albums, root };
}

module.exports = { list, LIBRARY_ROOT };
