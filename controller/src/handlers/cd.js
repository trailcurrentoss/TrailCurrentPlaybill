/* music.* command handlers — owns the audio-CD insertion → rip → library
   lifecycle. Mirrors the DVD handler one-for-one but uses MusicBrainz
   for metadata instead of OMDb, and writes to ~/Playbill/Music.

   Bus actions registered:
     music.getStatus, music.refreshStatus
     music.lookup    (TOC-based MB lookup)
     music.search    (title/artist text fallback)
     music.startRip, music.cancelRip
     music.dismiss, music.eject
     music.libraryList
     music.refreshArt

   Singleton: only one optical drive exists, and the cd-ripper module is
   itself a singleton — calls are serialized through this handler. */

'use strict';

const { execFile } = require('child_process');
const CdWatcher    = require('../services/cd-watcher');
const cdRipper     = require('../services/cd-ripper');
const cdLibrary    = require('../services/cd-library');
const { downloadCoverArt } = require('../services/cd-artwork');
const {
  lookupMusicBrainzByToc,
  lookupMusicBrainzByQuery,
} = require('../services/cd-metadata');

const watcher = new CdWatcher();

function register({ bus, state, ipc }) {
  // Initial slice — same null-by-default discipline as state.dvd.
  state.patch({ music: {
    present: false,
    device: CdWatcher.DEFAULT_DEVICE,
    discid: null,
    ntracks: null,
    lengthSec: null,
    toc: null,            // { ntracks, trackOffsetsLba, lengthSec } — used by metadata lookup
    status: 'idle',       // 'idle' | 'prompting' | 'ripping' | 'done' | 'error'
    ripping: null,        // { trackIndex, ntracks, percent, currentTitle }
    lastRipped: null,     // { title, artist, path }
    error: null,
    dismissed: false,
  }});

  // ─── CdWatcher → state + IPC event ──────────────────────────────────
  watcher.on('inserted', ({ device, discid, ntracks, trackOffsetsLba, lengthSec }) => {
    const cur = state.get().music || {};
    if (cur.status === 'ripping') return;

    state.patch({ music: {
      ...cur,
      present: true,
      device,
      discid,
      ntracks,
      lengthSec,
      toc: { ntracks, trackOffsetsLba, lengthSec },
      status: 'prompting',
      error: null,
      dismissed: false,
    }});
    if (ipc && typeof ipc.publishEvent === 'function') {
      ipc.publishEvent('cd.detected', {
        device, discid, ntracks, lengthSec, ts: Date.now(),
      });
    }
  });

  watcher.on('removed', ({ device }) => {
    const cur = state.get().music || {};
    state.patch({ music: {
      ...cur,
      present: false,
      device,
      discid: null,
      ntracks: null,
      lengthSec: null,
      toc: null,
      status: cur.status === 'prompting' ? 'idle' : cur.status,
      dismissed: false,
    }});
  });

  // ─── CdRipper → state ripping slice ─────────────────────────────────
  cdRipper.on('progress', (p) => {
    const cur = state.get().music || {};
    state.patch({ music: { ...cur, status: 'ripping', ripping: p } });
  });
  cdRipper.on('finished', ({ path, metadata }) => {
    const cur = state.get().music || {};
    state.patch({ music: {
      ...cur,
      status: 'done',
      ripping: null,
      lastRipped: { title: metadata.title, artist: metadata.artist || null, path, year: metadata.year || null },
      error: null,
    }});
  });
  cdRipper.on('cancelled', () => {
    const cur = state.get().music || {};
    state.patch({ music: { ...cur, status: 'idle', ripping: null, error: null } });
  });
  cdRipper.on('failed', ({ error }) => {
    const cur = state.get().music || {};
    state.patch({ music: { ...cur, status: 'error', ripping: null, error: error || 'rip failed' } });
  });

  // ─── Bus actions ────────────────────────────────────────────────────
  bus.register('music.getStatus', async () => state.get().music || null);

  bus.register('music.lookup', async () => {
    // TOC-based MusicBrainz lookup. No user input needed — we already
    // have the disc's TOC from the watcher.
    const cur = state.get().music || {};
    if (!cur.toc) return { ok: false, reason: 'no-disc' };
    const result = await lookupMusicBrainzByToc(cur.toc);
    if (!result) return { ok: false, reason: 'not-found' };
    return { ok: true, metadata: result };
  });

  bus.register('music.search', async (cmd) => {
    // Title/artist fallback. The GUI calls this when music.lookup
    // returned not-found and the user typed something to search by.
    const q = cmd && cmd.value;
    if (!q || (!q.album && !q.artist)) {
      throw new Error('music.search: value.album or value.artist required');
    }
    const result = await lookupMusicBrainzByQuery({ album: q.album, artist: q.artist });
    if (!result) return { ok: false, reason: 'not-found' };
    return { ok: true, metadata: result };
  });

  bus.register('music.dismiss', async () => {
    const cur = state.get().music || {};
    state.patch({ music: { ...cur, status: 'idle', dismissed: true } });
    return { ok: true };
  });

  bus.register('music.startRip', async (cmd) => {
    const metadata = cmd && cmd.value && cmd.value.metadata;
    if (!metadata || !metadata.title) {
      throw new Error('music.startRip: value.metadata.title required');
    }
    if (!Array.isArray(metadata.tracks) || metadata.tracks.length === 0) {
      throw new Error('music.startRip: value.metadata.tracks required');
    }
    const cur = state.get().music || {};
    if (!cur.present)             throw new Error('music.startRip: no disc present');
    if (cur.status === 'ripping') throw new Error('music.startRip: rip already in progress');

    state.patch({ music: {
      ...cur,
      status: 'ripping',
      ripping: { trackIndex: 0, ntracks: metadata.tracks.length, percent: 0, currentTitle: metadata.title },
      error: null,
    }});

    cdRipper.start({ device: cur.device, metadata })
      .catch((e) => {
        console.warn('[music.startRip] ripper rejected:', e.message);
      });

    return { ok: true, target: cdRipper.getCurrent() };
  });

  bus.register('music.cancelRip', async () => {
    const cancelled = cdRipper.cancel();
    return { ok: cancelled, cancelled };
  });

  bus.register('music.eject', async () => {
    const device = (state.get().music && state.get().music.device) || CdWatcher.DEFAULT_DEVICE;
    return new Promise((resolve) => {
      execFile('eject', [device], (err) => {
        if (err) resolve({ ok: false, error: err.message });
        else     resolve({ ok: true });
      });
    });
  });

  bus.register('music.libraryList', async () => cdLibrary.list());

  // Walk the library, find albums missing local cover.jpg but with a
  // coverArtUrl in their sidecar, and download. Serial fetch — MB rate
  // limits + CAA is a free service we should be polite to.
  bus.register('music.refreshArt', async () => {
    const lib = cdLibrary.list();
    let attempted = 0, ok = 0, failed = 0, skipped = 0;
    for (const album of lib.albums) {
      if (album.coverLocal) { skipped++; continue; }
      if (!album.coverArtUrlRemote) { skipped++; continue; }
      attempted++;
      const r = await downloadCoverArt({
        url: album.coverArtUrlRemote,
        dir: album.path,
        sidecar: album.sidecar,
      });
      if (r.ok) ok++; else failed++;
    }
    return { ok: true, attempted, downloaded: ok, failed, skipped, total: lib.albums.length };
  });

  bus.register('music.refreshStatus', async () => {
    await watcher.probeOnce();
    return state.get().music || null;
  });

  watcher.start();
}

module.exports = { register };
