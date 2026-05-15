/* Preload — minimal IPC surface for Stage 1.
   Only the theme bridge is exposed today. Stage 2 adds Headwaters / CAN /
   camera bridges; each gets its own namespaced method, never `require` or
   `process` access from the renderer. */

const { contextBridge, ipcRenderer } = require('electron');

// Pull the initial theme synchronously before the renderer's first paint
// so the shell can set data-theme without a flash of wrong colours.
let initialTheme = { shouldUseDarkColors: true };
try {
  initialTheme = ipcRenderer.sendSync && false
    ? null
    : null; // sendSync is sync but we use invoke; the inline script reads
            // window.playbill.shouldUseDarkColors which we populate below
            // after the async getTheme resolves on DOMContentLoaded.
} catch (_) { /* noop */ }

const listeners = new Set();
ipcRenderer.on('playbill:theme', (_evt, payload) => {
  for (const fn of listeners) {
    try { fn(payload.shouldUseDarkColors); } catch (_) { /* noop */ }
  }
});

// Controller bridge — state subscription + command dispatch. The renderer
// uses `playbill.controller.subscribe(fn)` to track state and
// `playbill.controller.command({action, ...})` to talk to the daemon.
const controllerStateListeners = new Set();
const controllerStatusListeners = new Set();
// channel-name → Set<fn>. Controller events are one-shot signals (e.g.
// nav.dpad keypresses arriving from CAN/MQTT). The renderer subscribes per
// channel rather than receiving every event because the chrome only cares
// about a handful of channels.
const controllerEventListeners = new Map();
ipcRenderer.on('playbill.controller.state',  (_e, state) => {
  for (const fn of controllerStateListeners) {
    try { fn(state); } catch (e) { console.error('controller state listener:', e); }
  }
});
ipcRenderer.on('playbill.controller.status', (_e, status) => {
  for (const fn of controllerStatusListeners) {
    try { fn(status); } catch (e) { console.error('controller status listener:', e); }
  }
});
ipcRenderer.on('playbill.controller.event', (_e, { channel, payload }) => {
  const set = controllerEventListeners.get(channel);
  if (!set) return;
  for (const fn of set) {
    try { fn(payload); } catch (e) { console.error(`controller event ${channel}:`, e); }
  }
});

contextBridge.exposeInMainWorld('playbill', {
  // Filled in by the bootstrap below once the main process responds.
  shouldUseDarkColors: undefined,

  // Subscribe to live theme changes from GNOME.
  onThemeChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // Controller daemon. The Settings UI uses this; later screens consume
  // state.* directly. `command` is a typed dispatch that resolves with
  // the handler's return value (or rejects on error).
  controller: {
    getState: () => ipcRenderer.invoke('playbill.controller.getState'),
    command:  (cmd) => ipcRenderer.invoke('playbill.controller.command', cmd),
    onState:  (fn) => { controllerStateListeners.add(fn);  return () => controllerStateListeners.delete(fn); },
    onStatus: (fn) => { controllerStatusListeners.add(fn); return () => controllerStatusListeners.delete(fn); },
    // Subscribe to a controller-published event channel. Today the only
    // channel in use is 'nav.dpad' — keypresses from a remote-style CAN
    // device or the PWA, delivered as { key, ts, from }. Returns an
    // unsubscribe function.
    onEvent: (channel, fn) => {
      let set = controllerEventListeners.get(channel);
      if (!set) { set = new Set(); controllerEventListeners.set(channel, set); }
      set.add(fn);
      return () => {
        const s = controllerEventListeners.get(channel);
        if (s) { s.delete(fn); if (s.size === 0) controllerEventListeners.delete(channel); }
      };
    },
    // Convenience wrapper — same shape every screen wants for D-pad input.
    onNavDpad: (fn) => {
      let set = controllerEventListeners.get('nav.dpad');
      if (!set) { set = new Set(); controllerEventListeners.set('nav.dpad', set); }
      set.add(fn);
      return () => {
        const s = controllerEventListeners.get('nav.dpad');
        if (s) { s.delete(fn); if (s.size === 0) controllerEventListeners.delete('nav.dpad'); }
      };
    },
    // Same shape for streamed text — payload is { text, ts, from }. The
    // renderer routes this into document.activeElement (when it's an input)
    // or synthesizes per-character keydowns for state-machine screens.
    onNavText: (fn) => {
      let set = controllerEventListeners.get('nav.text');
      if (!set) { set = new Set(); controllerEventListeners.set('nav.text', set); }
      set.add(fn);
      return () => {
        const s = controllerEventListeners.get('nav.text');
        if (s) { s.delete(fn); if (s.size === 0) controllerEventListeners.delete('nav.text'); }
      };
    },
  },

  // Hardware control surfaces. Each namespace is a thin pass-through to a
  // main-process service module — the renderer never touches `child_process`
  // or `/dev` directly. The same surface is what the Headwaters PWA will
  // eventually call over HTTP for restream + remote control.
  dvb: {
    listAdapters: ()    => ipcRenderer.invoke('playbill.dvb.listAdapters'),
    scan:         (a)   => ipcRenderer.invoke('playbill.dvb.scan', a),
    stopScan:     ()    => ipcRenderer.invoke('playbill.dvb.stopScan'),
    listChannels: ()    => ipcRenderer.invoke('playbill.dvb.listChannels'),
    tune:         (a)   => ipcRenderer.invoke('playbill.dvb.tune', a),
    stopTune:     (a)   => ipcRenderer.invoke('playbill.dvb.stopTune', a),
    probeTools:   ()    => ipcRenderer.invoke('playbill.dvb.probeTools'),
  },
  // Radio. The renderer keeps calling playbill.radio.* — main.js's
  // forwardRadio() shim translates each call into controller.command()
  // with the matching action name. Keeping the legacy IPC channel names
  // means renderer/components/radio.jsx didn't have to change.
  radio: {
    listAdapters: ()    => ipcRenderer.invoke('playbill.radio.listAdapters'),
    tune:         (a)   => ipcRenderer.invoke('playbill.radio.tune', a),
    stop:         ()    => ipcRenderer.invoke('playbill.radio.stop'),
    getState:     ()    => ipcRenderer.invoke('playbill.radio.getState'),
    scan:         (a)   => ipcRenderer.invoke('playbill.radio.scan', a),
    lookupScanner:(a)   => ipcRenderer.invoke('playbill.radio.lookupScanner', a),
    listPresets:  ()    => ipcRenderer.invoke('playbill.radio.listPresets'),
    setPresets:   (arr) => ipcRenderer.invoke('playbill.radio.setPresets', arr),
    probeTools:   ()    => ipcRenderer.invoke('playbill.radio.probeTools'),
  },
  // (playbill.player.* exposure retired in Phase 7. Playback is owned by
  // the controller daemon. Renderer code uses
  // window.playbill.controller.command({action:'transport.play', url, ...}))
});

// Bootstrap: ask main for the current theme and patch it onto window.playbill
// so the inline script in index.html can read it on first paint.
ipcRenderer.invoke('playbill:getTheme').then(({ shouldUseDarkColors }) => {
  // contextIsolation prevents direct mutation; reach through the bridge object.
  // We re-expose a fresh property by replacing the bridge value.
  window.playbill = Object.assign({}, window.playbill, { shouldUseDarkColors });
  // Notify any already-registered listeners so the shell flips immediately.
  for (const fn of listeners) {
    try { fn(shouldUseDarkColors); } catch (_) { /* noop */ }
  }
}).catch(() => { /* fall back to prefers-color-scheme in the inline script */ });
