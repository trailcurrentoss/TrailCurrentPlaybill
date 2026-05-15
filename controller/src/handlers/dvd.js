/* dvd.* command handlers — owns the DVD-insertion → rip → library
   lifecycle. Wires:

     • DvdWatcher events  ⇒ state.dvd patches + 'dvd.detected' IPC event
     • DvdRipper events   ⇒ state.dvd.ripping progress
     • bus actions         dvd.getStatus, dvd.lookup, dvd.startRip,
                           dvd.cancelRip, dvd.dismiss, dvd.eject,
                           dvd.libraryList

   The DvdRipper module is a singleton because only one optical drive
   exists and ripping is mutually exclusive — making that a class
   invariant rather than a runtime check keeps the handler simple. */

'use strict';

const { execFile } = require('child_process');
const DvdWatcher    = require('../services/dvd-watcher');
const dvdRipper     = require('../services/dvd-ripper');
const dvdLibrary    = require('../services/dvd-library');
const { downloadPoster } = require('../services/dvd-poster');
const { heuristicTitle, lookupOmdb } = require('../services/dvd-metadata');
const SettingsStore = require('../settings');
const { HEADWATERS_FILE } = require('../paths');

const watcher = new DvdWatcher();

function buildPrompt(label) {
  const guess = heuristicTitle(label) || { title: '', yearHint: null };
  return {
    label,
    suggestedTitle: guess.title || label || 'New Disc',
    yearHint: guess.yearHint || null,
  };
}

// Use the same headwaters.json store the existing handler does, since
// the OMDb key is a one-line credential and would clutter settings.json.
// Lazy-instantiate so we don't open the file before it exists on first run.
let _omdbStore = null;
async function ensureOmdbStore() {
  if (!_omdbStore) {
    _omdbStore = new SettingsStore({
      filePath: HEADWATERS_FILE,
      schema: { type: 'object', additionalProperties: true },
      required: true,
    });
    try { await _omdbStore.load(); } catch (_) { /* file may not exist yet */ }
  }
  return _omdbStore;
}
async function loadOmdbKey() {
  const s = await ensureOmdbStore();
  const cur = s.get() || {};
  return cur.omdbApiKey || null;
}

function register({ bus, state, ipc }) {
  // Initial state slice — every other slice that's null-by-default uses
  // null too, but for DVD it's clearer to publish a real shape so the
  // GUI doesn't have to guard every read.
  state.patch({ dvd: {
    present: false,
    device: DvdWatcher.DEFAULT_DEVICE,
    label: null,
    prompt: null,        // populated when present === true (the GUI reads this for the modal)
    status: 'idle',      // 'idle' | 'prompting' | 'ripping' | 'done' | 'error'
    ripping: null,       // { percent, etaSec, title }
    lastRipped: null,    // { title, path }
    error: null,
    dismissed: false,    // user clicked "Not now" for this disc — don't re-prompt
    omdbApiKeySet: false, // populated async below — the Settings UI reads
                          // this to know whether to show "(currently set;
                          // paste again to rotate)" hint
  }});

  // Probe the stored OMDb key asynchronously so state.dvd.omdbApiKeySet
  // reflects truth as soon as it can. We can't await here (register is
  // sync-ish across handlers in index.js), but the first state.subscribe
  // event the GUI receives carries the resolved value.
  ensureOmdbStore().then((s) => {
    const cur = state.get().dvd || {};
    const apiKey = (s.get() || {}).omdbApiKey;
    state.patch({ dvd: { ...cur, omdbApiKeySet: !!apiKey } });
  }).catch((e) => console.warn('[dvd] omdb key probe failed:', e.message));

  // ─── DvdWatcher → state + IPC event ─────────────────────────────────
  watcher.on('inserted', ({ device, label, fstype }) => {
    const cur = state.get().dvd || {};
    // If a rip is in flight, don't overwrite that with a new prompt —
    // the disc we just saw IS the one being ripped.
    if (cur.status === 'ripping') return;

    const prompt = buildPrompt(label);
    state.patch({ dvd: {
      ...cur,
      present: true,
      device,
      label,
      fstype,
      prompt,
      status: 'prompting',
      error: null,
      dismissed: false,
    }});
    // One-shot IPC event so the Electron main process can pop a desktop
    // notification immediately (it raises the window when clicked).
    if (ipc && typeof ipc.publishEvent === 'function') {
      ipc.publishEvent('dvd.detected', { device, label, suggestedTitle: prompt.suggestedTitle, ts: Date.now() });
    }
  });

  watcher.on('removed', ({ device }) => {
    const cur = state.get().dvd || {};
    // Removing a disc DURING a rip is an error — surface it; the ripper
    // process will exit non-zero on its own.
    state.patch({ dvd: {
      ...cur,
      present: false,
      device,
      label: null,
      fstype: null,
      prompt: null,
      // If we were prompting, clear back to idle. Don't touch a 'done'/'error'
      // terminal state — the GUI clears that on user dismiss.
      status: cur.status === 'prompting' ? 'idle' : cur.status,
      dismissed: false,
    }});
  });

  // ─── DvdRipper → state ripping slice ────────────────────────────────
  dvdRipper.on('progress', (p) => {
    const cur = state.get().dvd || {};
    state.patch({ dvd: { ...cur, status: 'ripping', ripping: p } });
  });
  dvdRipper.on('finished', ({ path, metadata }) => {
    const cur = state.get().dvd || {};
    state.patch({ dvd: {
      ...cur,
      status: 'done',
      ripping: null,
      lastRipped: { title: metadata.title, path, year: metadata.year || null },
      error: null,
    }});
  });
  dvdRipper.on('cancelled', () => {
    const cur = state.get().dvd || {};
    state.patch({ dvd: { ...cur, status: 'idle', ripping: null, error: null } });
  });
  dvdRipper.on('failed', ({ code, stderr }) => {
    const cur = state.get().dvd || {};
    state.patch({ dvd: {
      ...cur,
      status: 'error',
      ripping: null,
      error: `HandBrakeCLI failed (exit ${code}): ${(stderr || '').split('\n').slice(-2).join(' ')}`,
    }});
  });

  // ─── Bus actions ────────────────────────────────────────────────────
  bus.register('dvd.getStatus', async () => state.get().dvd || null);

  bus.register('dvd.lookup', async (cmd) => {
    // Args: { title, year? } — uses OMDb if a key is configured.
    const title = cmd && cmd.value && cmd.value.title;
    if (!title) throw new Error('dvd.lookup: value.title required');
    const apiKey = await loadOmdbKey();
    if (!apiKey) return { ok: false, reason: 'no-api-key' };
    const year = cmd.value && cmd.value.year;
    const result = await lookupOmdb(apiKey, { title, year });
    if (!result) return { ok: false, reason: 'not-found' };
    return { ok: true, metadata: result };
  });

  bus.register('dvd.dismiss', async () => {
    // User clicked "Not now". Clear the prompt + flag so re-probing the
    // same disc (next 3s tick) doesn't re-fire.
    const cur = state.get().dvd || {};
    state.patch({ dvd: { ...cur, status: 'idle', prompt: null, dismissed: true } });
    return { ok: true };
  });

  bus.register('dvd.startRip', async (cmd) => {
    const metadata = cmd && cmd.value && cmd.value.metadata;
    if (!metadata || !metadata.title) {
      throw new Error('dvd.startRip: value.metadata.title required');
    }
    const cur = state.get().dvd || {};
    if (!cur.present)             throw new Error('dvd.startRip: no disc present');
    if (cur.status === 'ripping') throw new Error('dvd.startRip: rip already in progress');

    // Optimistic patch — flip to ripping immediately so the GUI's prompt
    // dismisses without waiting for the first HandBrake progress line
    // (which can take ~10s after spin-up).
    state.patch({ dvd: {
      ...cur,
      status: 'ripping',
      prompt: null,
      ripping: { percent: 0, etaSec: null, currentTitle: metadata.title },
      error: null,
    }});

    // Fire-and-forget the rip — the bus ack returns immediately so the GUI
    // can close its modal. Progress + completion arrive via state patches.
    dvdRipper.start({ device: cur.device, metadata })
      .catch((e) => {
        // 'failed' / 'cancelled' events have already patched state.
        // Just log here so the daemon log carries the full error.
        console.warn('[dvd.startRip] ripper rejected:', e.message);
      });

    return { ok: true, target: dvdRipper.getCurrent() };
  });

  bus.register('dvd.cancelRip', async () => {
    const cancelled = dvdRipper.cancel();
    return { ok: cancelled, cancelled };
  });

  bus.register('dvd.eject', async () => {
    const device = (state.get().dvd && state.get().dvd.device) || DvdWatcher.DEFAULT_DEVICE;
    return new Promise((resolve) => {
      execFile('eject', [device], (err) => {
        if (err) resolve({ ok: false, error: err.message });
        else     resolve({ ok: true });
      });
    });
  });

  bus.register('dvd.libraryList', async () => dvdLibrary.list());

  // library.diskInfo — total + free bytes on the partition that holds the
  // video library. Drives the "X.X GB available" text in the Offline
  // Library UI; replaced the hardcoded "1.2 TB available" mock string
  // 2026-05-15. Uses `df -B1` so the result is in bytes — the renderer
  // formats to human-readable.
  bus.register('library.diskInfo', async () => {
    return new Promise((resolve) => {
      execFile('df', ['-B1', '--output=size,avail,target', dvdLibrary.LIBRARY_ROOT],
        { timeout: 4000 }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const lines = (stdout || '').trim().split('\n');
        if (lines.length < 2) { resolve(null); return; }
        const parts = lines[1].trim().split(/\s+/);
        const totalBytes = parseInt(parts[0], 10);
        const freeBytes  = parseInt(parts[1], 10);
        const mountpoint = parts[2] || null;
        if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes)) {
          resolve(null); return;
        }
        resolve({ totalBytes, freeBytes, mountpoint });
      });
    });
  });

  // dvd.refreshPosters — walk the library, find titles that have a
  // remote posterUrl in their sidecar but no local .jpg next to the
  // .mkv, and download them. Used for older rips (before poster-caching
  // was wired) and for retrying titles where the original download
  // failed (no internet at rip time). Synchronous serial fetch — the
  // library is on the order of hundreds of entries, network is the
  // bottleneck, parallelism gains nothing.
  bus.register('dvd.refreshPosters', async () => {
    const lib = dvdLibrary.list();
    const all = [...lib.movies, ...lib.shows];
    const fs = require('fs');
    const path = require('path');
    let attempted = 0, ok = 0, failed = 0, skipped = 0;
    for (const item of all) {
      if (item.posterLocal) { skipped++; continue; }
      if (!item.posterUrlRemote) { skipped++; continue; }
      attempted++;
      const dir = path.dirname(item.path);
      const base = path.basename(item.path, '.mkv');
      const r = await downloadPoster({ url: item.posterUrlRemote, dir, basename: base });
      if (r.ok) ok++; else failed++;
    }
    return { ok: true, attempted, downloaded: ok, failed, skipped, total: all.length };
  });

  bus.register('dvd.setOmdbKey', async (cmd) => {
    // Persist the OMDb key alongside the Headwaters API key. Two keys, one
    // file — both are external-service credentials, neither warrants its own
    // file. Empty string clears.
    const key = cmd && cmd.value && cmd.value.apiKey;
    const s = await ensureOmdbStore();
    const cur = s.get() || {};
    if (!key) {
      const { omdbApiKey, ...rest } = cur;
      await s.replace(rest);
      const d = state.get().dvd || {};
      state.patch({ dvd: { ...d, omdbApiKeySet: false } });
      return { ok: true, cleared: true };
    }
    await s.replace({ ...cur, omdbApiKey: String(key).trim() });
    const d = state.get().dvd || {};
    state.patch({ dvd: { ...d, omdbApiKeySet: true } });
    return { ok: true };
  });

  // dvd.validateOmdbKey — make a no-op lookup against OMDb with the given
  // (or stored) key so the Settings UI can confirm the key is valid at
  // save time, the same way Settings → Headwaters validates the rig key
  // before persisting. We use the title 'a' (always returns a match) so
  // the lookup is a near-instant network round trip.
  const { lookupOmdb } = require('../services/dvd-metadata');
  bus.register('dvd.validateOmdbKey', async (cmd) => {
    let key = cmd && cmd.value && cmd.value.apiKey;
    if (!key) {
      const s = await ensureOmdbStore();
      key = (s.get() || {}).omdbApiKey;
    }
    if (!key) return { ok: false, kind: 'missing', error: 'No API key to validate.' };
    // OMDb's "ten" returns a match in every region; a bad key returns
    // {Response:'False', Error:'Invalid API key!'}. lookupOmdb maps both
    // outcomes (no body or Response!=='True') to null, so we differentiate
    // by re-hitting and inspecting status. Simpler: call with key, treat
    // null result as auth failure since 'ten' DOES have OMDb data.
    const result = await lookupOmdb(key.trim(), { title: 'ten' });
    if (!result) return { ok: false, kind: 'unauthorized', error: 'OMDb rejected the key (or no network). Double-check the key on omdbapi.com.' };
    return { ok: true };
  });

  // Kick the watcher so the daemon sees a disc that was already in the
  // drive when it started up. We deliberately don't fire 'inserted' on
  // controller-start (the watcher's start() handles that) — but the user
  // may want to re-prompt for an already-loaded disc once the GUI opens.
  // That's what dvd.refreshStatus is for.
  bus.register('dvd.refreshStatus', async () => {
    await watcher.probeOnce();
    return state.get().dvd || null;
  });

  watcher.start();
}

module.exports = { register };
