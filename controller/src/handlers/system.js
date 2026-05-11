/* System command handlers — GUI lifecycle + screensaver. Bridges
   PlaybillSystemCmd (DBC 0x106/0x116/0x126) actions onto the bus.

   Six bus actions (matching commands.schema.json system.* and DBC enum):

     system.launchGui    spawn the Electron GUI (no-op if already running)
     system.quitGui      pkill the Electron binary
     system.focus        raise existing window if possible (Wayland: no-op)
     system.wake         deactivate GNOME Screensaver
     system.sleep        activate GNOME Screensaver

   The actual mechanics are in services/gui.js; this file is the bus glue.
   No state updates here — the IpcServer's first-client / last-client-gone
   events drive state.gui from index.js so the source of truth is the
   actual GUI presence, not whether we *tried* to launch it. */

'use strict';

const gui = require('../services/gui');

function register({ bus }) {
  bus.register('system.launchGui', async () => gui.launch());
  bus.register('system.quitGui',   async () => gui.quit());
  bus.register('system.focus',     async () => gui.focus());
  bus.register('system.wake',      async () => gui.wake());
  bus.register('system.sleep',     async () => gui.sleep());
}

module.exports = { register };
