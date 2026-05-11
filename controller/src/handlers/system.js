/* System command handlers — GUI lifecycle + screensaver. Bridges
   PlaybillSystemCmd (DBC 0x106/0x116/0x126) actions onto the bus.

   Six bus actions (matching commands.schema.json system.* and DBC enum):

     system.launchGui    spawn the Electron GUI (no-op if already running)
     system.quitGui      pkill the Electron binary
     system.focus        bring GUI window to front — launch if not running,
                         or fan a 'system.focus' IPC event so Electron's
                         main process can call BrowserWindow.show()+.focus()
                         on its own window (Wayland forbids raising OTHER
                         apps' windows but lets you raise your own)
     system.wake         deactivate GNOME Screensaver
     system.sleep        activate GNOME Screensaver

   The actual mechanics are in services/gui.js; this file is the bus glue.
   No state updates here — the IpcServer's first-client / last-client-gone
   events drive state.gui from index.js so the source of truth is the
   actual GUI presence, not whether we *tried* to launch it. */

'use strict';

const gui = require('../services/gui');

function register({ bus, ipc }) {
  bus.register('system.launchGui', async () => gui.launch());
  bus.register('system.quitGui',   async () => gui.quit());
  bus.register('system.focus',     async () => {
    // If the GUI is already up, ask its main process to raise the window.
    // Electron can focus its own BrowserWindow under Wayland; the
    // controller cannot (third-party-raise is blocked).
    if (await gui.isRunning()) {
      if (ipc && typeof ipc.publishEvent === 'function') {
        ipc.publishEvent('system.focus', { ts: Date.now() });
      }
      return { ok: true, focused: true, via: 'main-process' };
    }
    return gui.launch();
  });
  bus.register('system.wake',      async () => gui.wake());
  bus.register('system.sleep',     async () => gui.sleep());
}

module.exports = { register };
