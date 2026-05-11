/* TrailCurrent Playbill — Electron main process.
   Single fullscreen Wayland-native window. NOT kiosk-locked; Playbill is a
   normal application launched from the GNOME dock that the user can quit,
   minimize, or alt-tab away from at any time. */

const { app, BrowserWindow, screen, nativeTheme, ipcMain, globalShortcut, Menu } = require('electron');
const path = require('path');

const ControllerClient = require('./ipc-client');

// Radio AND Live TV are owned by the controller daemon
// (controller/src/services/{radio,livetv}.js) so a single rtl_fm /
// dvbv5-zap process exists per device — PWA, CAN button, IR remote, and
// the Electron GUI all drive them through the same command bus. The
// renderer's `playbill.radio.*` and `playbill.dvb.*` calls below are thin
// shims that forward to the controller; if the daemon isn't up the calls
// return an error and the renderer's existing toast surface reports it.

// The single connection to the playbill-controller daemon. Created at
// app start; auto-reconnects if the daemon isn't up yet (common during
// development) or restarts. The renderer talks to the controller via
// preload-exposed methods that route through this client.
const controller = new ControllerClient();

// --- Wayland-native rendering on the GNOME desktop ----------------------------
// Force Electron's Ozone Wayland backend so we hit the real Wayland path
// instead of XWayland. NOTE: appendSwitch here runs AFTER Ozone has already
// chosen a backend, so the .desktop file's Exec= line ALSO passes
// --ozone-platform=wayland on the command line — that's the load-bearing one.
// These calls are defense-in-depth in case the binary is launched without flags.
app.commandLine.appendSwitch('ozone-platform', 'wayland');
app.commandLine.appendSwitch(
  'enable-features',
  'UseOzonePlatform,WaylandWindowDecorations'
);

let mainWindow = null;

function createWindow() {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.workAreaSize;
  const bg = nativeTheme.shouldUseDarkColors ? '#000000' : '#f5f5f5';

  mainWindow = new BrowserWindow({
    width,
    height,
    fullscreen: true,
    frame: false,
    backgroundColor: bg,
    title: 'TrailCurrent Playbill',
    icon: path.join(__dirname, '..', 'packaging', 'icons', '512x512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Forward live theme changes from GNOME → renderer.
  const sendTheme = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('playbill:theme', {
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    });
  };
  nativeTheme.on('updated', sendTheme);

  mainWindow.on('closed', () => {
    nativeTheme.off('updated', sendTheme);
    mainWindow = null;
  });
}

ipcMain.handle('playbill:getTheme', () => ({
  shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
}));

// ─── Controller daemon bridge ───────────────────────────────────────────
// The renderer talks to the controller through these. Snapshot/delta
// state is pushed to the renderer via webContents.send so React can
// subscribe with useEffect.
ipcMain.handle('playbill.controller.getState',  () => ({
  state: controller.getState(),
  connected: controller.isConnected(),
}));
ipcMain.handle('playbill.controller.command',   (_e, cmd) => controller.command(cmd));

function broadcastControllerState(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('playbill.controller.state', state);
}
function broadcastControllerStatus(connected) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('playbill.controller.status', { connected });
}
function broadcastControllerEvent(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('playbill.controller.event', { channel, payload });
}
controller.on('state',         broadcastControllerState);
controller.on('connected',     () => broadcastControllerStatus(true));
controller.on('disconnected',  () => broadcastControllerStatus(false));
controller.on('event',         broadcastControllerEvent);
controller.start();

/* ---------------------------------------------------------------------------
   Tuner / radio / player IPC.

   Each handler is a thin shim over the matching service module. The service
   modules contain the actual control logic and are intentionally UI-agnostic
   so the same surface can later be exposed over HTTP for the Headwaters PWA
   (live-TV restream + remote control). When that day comes, the new HTTP
   server mounts the same module exports — these IPC handlers stay as-is.
   --------------------------------------------------------------------------- */

// Radio AND Live TV — both forwarded to the controller daemon. The on-disk
// services live at controller/src/services/{radio,livetv}.js; the bus
// actions registered by controller/src/handlers/{radio,livetv}.js do the
// work. We keep the legacy `playbill.radio.*` and `playbill.dvb.*` IPC
// names so the renderer (radio.jsx, live.jsx) works unchanged. Each
// handler below is a one-liner that dispatches a typed bus command.
const fs = require('fs');
function logFwd(tag, err) {
  try {
    const line = `[${new Date().toISOString()}] ${tag} ${err && (err.stack || err.message || String(err))}\n`;
    fs.appendFileSync('/tmp/playbill-controller-fwd.log', line);
  } catch (_) { /* best-effort; never let logging itself throw */ }
}
function forwardToController(action, valueFromArgs) {
  return async (_e, args) => {
    try {
      const value = valueFromArgs ? valueFromArgs(args) : undefined;
      return await controller.command(value === undefined ? { action } : { action, value });
    } catch (e) { logFwd(action, e); throw e; }
  };
}

// DVB → livetv. Renderer keeps calling playbill.dvb.* unchanged.
ipcMain.handle('playbill.dvb.listAdapters', forwardToController('livetv.listAdapters'));
ipcMain.handle('playbill.dvb.scan',         forwardToController('livetv.scan',         (a) => a || {}));
ipcMain.handle('playbill.dvb.listChannels', forwardToController('livetv.listChannels'));
ipcMain.handle('playbill.dvb.tune',         forwardToController('livetv.tune',         (a) => a || {}));
ipcMain.handle('playbill.dvb.stopTune',     forwardToController('livetv.stopTune',     (a) => a || {}));
ipcMain.handle('playbill.dvb.probeTools',   forwardToController('livetv.probeTools'));

// RTL-SDR radio.
ipcMain.handle('playbill.radio.listAdapters', forwardToController('radio.listAdapters'));
ipcMain.handle('playbill.radio.tune',         forwardToController('radio.tune',         (a) => a || {}));
ipcMain.handle('playbill.radio.stop',         forwardToController('radio.stop'));
ipcMain.handle('playbill.radio.getState',     forwardToController('radio.getState'));
ipcMain.handle('playbill.radio.scan',         forwardToController('radio.scan',         (a) => a || {}));
ipcMain.handle('playbill.radio.lookupScanner',forwardToController('radio.lookupScanner',(a) => a || {}));
ipcMain.handle('playbill.radio.listPresets',  forwardToController('radio.listPresets'));
ipcMain.handle('playbill.radio.setPresets',   forwardToController('radio.setPresets',   (a) => a || []));
ipcMain.handle('playbill.radio.probeTools',   forwardToController('radio.probeTools'));

// (mpv player handlers retired in Phase 7 — playback is owned by the
// controller daemon. Live TV calls controller.command transport.play
// directly with the dvbv5-zap TS path; YouTube routes the same way.)

app.whenReady().then(() => {
  createWindow();

  // Application menu — invisible because we run frame:false, BUT the
  // accelerators registered here still work (Ctrl+Q, Ctrl+W). This is the
  // standard Electron pattern for "no visible menu, but keyboard shortcuts work."
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Playbill',
      submenu: [
        {
          label: 'Quit',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => app.quit(),
        },
        {
          label: 'Toggle Fullscreen',
          accelerator: 'F11',
          click: () => {
            if (!mainWindow) return;
            mainWindow.setFullScreen(!mainWindow.isFullScreen());
          },
        },
        {
          label: 'Reload',
          accelerator: 'Ctrl+R',
          click: () => mainWindow && mainWindow.reload(),
        },
      ],
    },
  ]));

  // Global Super+Q (Wayland-friendly emergency exit). Registered globally so it
  // works even if the renderer captures Ctrl+Q for keyboard nav.
  globalShortcut.register('Super+Q', () => app.quit());
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // The GUI no longer owns any media subprocess. Radio (rtl_fm), Live TV
  // (dvbv5-zap), and mpv all live in the controller daemon and survive
  // GUI quit by design (architecture-v2 §2 reason 2). All we tear down
  // here is our IPC client to the controller.
  try { controller.stop(); } catch (_) {}
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
