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

contextBridge.exposeInMainWorld('playbill', {
  // Filled in by the bootstrap below once the main process responds.
  shouldUseDarkColors: undefined,

  // Subscribe to live theme changes from GNOME.
  onThemeChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
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
