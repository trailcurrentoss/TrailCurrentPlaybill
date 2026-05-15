/* TrailCurrent Playbill — Electron main process.
   Single fullscreen Wayland-native window. NOT kiosk-locked; Playbill is a
   normal application launched from the GNOME dock that the user can quit,
   minimize, or alt-tab away from at any time. */

const { app, BrowserWindow, screen, nativeTheme, ipcMain, globalShortcut, Menu, Notification, session } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const ControllerClient = require('./ipc-client');

// ─── Headwaters TLS trust ──────────────────────────────────────────────────
//
// Electron's bundled Chromium does NOT consult the OS trust store, so the
// self-signed Headwaters certificate (`headwaters.local`, signed by the
// TrailCurrent CA the user pasted during Settings → Headwaters) fails TLS
// verification when the renderer hits the tile server. That's what makes
// the Explore screen render a black map: MapLibre's style.json fetch is
// rejected before any tiles can load.
//
// We narrow the trust to the configured Headwaters hostname so an attacker
// on the LAN can't spoof headwaters.local. The hostname comes from
// connection.json (~/.config/trailcurrent-playbill/connection.json), which
// the controller wrote when the user finished onboarding. If onboarding
// hasn't happened yet there's nothing to trust and we leave the default
// strict policy intact.

const CONFIG_DIR    = path.join(os.homedir(), '.config', 'trailcurrent-playbill');
const CONNECTION_JSON = path.join(CONFIG_DIR, 'connection.json');

function configuredHeadwatersHost() {
  try {
    const c = JSON.parse(fs.readFileSync(CONNECTION_JSON, 'utf8'));
    if (c && c.caCertProvided && c.brokerUrl) {
      return new URL(c.brokerUrl).hostname;
    }
  } catch (_) { /* not configured yet */ }
  return null;
}

// Fires when the renderer (or main) makes an HTTPS request and the cert
// fails strict verification. We accept the error iff the URL hostname
// matches the configured Headwaters host. Chrome's certificate chain has
// already been built; the user's CA established trust separately during
// onboarding (mqtts:// uses the same cert).
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  let target = null;
  try { target = new URL(url).hostname; } catch (_) { /* malformed url */ }
  const host = configuredHeadwatersHost();
  if (host && target && target === host) {
    event.preventDefault();
    callback(true);
    return;
  }
  // Default Electron behavior — reject. Callback expects a boolean.
  callback(false);
});

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

  // Mirror every renderer console.* call into /tmp/playbill-renderer.log so
  // we can see what's happening on the live board without rigging up remote
  // DevTools. The line prefix says [info|warn|err|debug] + the source file +
  // line, matching the format DevTools shows.
  try {
    const logFile = '/tmp/playbill-renderer.log';
    const fmt = (lvl, msg, line, srcId) => {
      const levels = ['debug', 'info', 'warn', 'err'];
      const tag = levels[lvl] || ('lvl' + lvl);
      const src = (srcId && srcId.split('/').slice(-1)[0]) || '?';
      return `[${new Date().toISOString()}] ${tag.padEnd(5)} ${src}:${line || '?'}  ${msg}\n`;
    };
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      try { fs.appendFileSync(logFile, fmt(level, message, line, sourceId)); } catch (_) { /* best effort */ }
    });
  } catch (e) { console.warn('[main] could not install console mirror:', e && e.message); }

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
// Main-process side-effects for specific controller events. Runs before
// (and in addition to) the renderer broadcast so things that can ONLY
// happen here (raising our own BrowserWindow under Wayland) still work
// when the renderer is unfocused, minimized, or behind another app.
function raiseOwnWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } catch (e) { console.warn('[main] raise failed:', e && e.message); }
}

function handleControllerEvent(channel, payload) {
  if (channel === 'system.focus') {
    // Remote/CAN Power → raise our own window. Wayland blocks third-party
    // raise, but Electron is allowed to raise its OWN window.
    raiseOwnWindow();
  } else if (channel === 'cd.detected') {
    // Audio CD just spun up. Pop the same style of notification as the
    // DVD path — body line names the disc by its track count + runtime,
    // since audio CDs don't carry a useful volume label.
    if (Notification && Notification.isSupported && Notification.isSupported()) {
      const ntracks = (payload && payload.ntracks) || '?';
      const minutes = payload && payload.lengthSec ? Math.round(payload.lengthSec / 60) : null;
      const sub = minutes ? `${ntracks}-track CD · ${minutes} min` : `${ntracks}-track CD`;
      const n = new Notification({
        title: 'Audio CD detected — add to your music library?',
        body:  `${sub}. Click to look up the album and rip to your library.`,
        icon:  path.join(__dirname, '..', 'packaging', 'icons', '512x512.png'),
        urgency: 'normal',
        silent: false,
      });
      n.on('click', () => { raiseOwnWindow(); });
      n.show();
    } else {
      raiseOwnWindow();
    }
  } else if (channel === 'dvd.detected') {
    // A disc just spun up. Pop a libnotify-backed desktop Notification.
    // The body line is the suggested title we got from the volume label;
    // clicking the notification raises the Playbill window so the renderer
    // (which subscribes to state.dvd) can present the confirm/rip modal.
    //
    // Using Electron's Notification rather than `notify-send` because:
    //   • notification still appears even if libnotify-bin isn't installed
    //     (Electron bundles its own libnotify shim)
    //   • we can call raiseOwnWindow() on click without spawning a child
    //     process + parsing its exit code
    //   • the icon is the bundled app icon — branding is consistent with
    //     the rest of the Playbill UX
    if (Notification && Notification.isSupported && Notification.isSupported()) {
      const suggested = (payload && payload.suggestedTitle) || (payload && payload.label) || 'New disc';
      const n = new Notification({
        title: 'Disc detected — add to your library?',
        body:  `"${suggested}" is in the drive. Click to confirm, look up details, and rip.`,
        icon:  path.join(__dirname, '..', 'packaging', 'icons', '512x512.png'),
        urgency: 'normal',
        silent: false,
      });
      n.on('click', () => {
        raiseOwnWindow();
        // The renderer reads state.dvd.prompt to decide whether to show
        // the modal. The disc state was already patched before the event
        // fired, so the modal will be there waiting when we raise.
      });
      n.show();
    } else {
      // No notification daemon — still raise the window so the user sees
      // the in-app prompt overlay.
      raiseOwnWindow();
    }
  }
  broadcastControllerEvent(channel, payload);
}
controller.on('state',         broadcastControllerState);
controller.on('connected',     () => broadcastControllerStatus(true));
controller.on('disconnected',  () => broadcastControllerStatus(false));
controller.on('event',         handleControllerEvent);
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
  // Headwaters tileserver responses don't ship CORS headers, and the
  // Playbill renderer is loaded over file:// — so MapLibre's style.json /
  // sprite / glyph / vector-tile fetches in the Explore screen would be
  // blocked by Chromium's same-origin policy even though the certificate
  // verifies. Inject permissive CORS headers on every response from the
  // configured Headwaters host so the renderer can consume them. Scoped
  // to the Headwaters host only — third-party hosts keep strict CORS.
  try {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const host = configuredHeadwatersHost();
      if (!host) { callback({}); return; }
      let target = null;
      try { target = new URL(details.url).hostname; } catch (_) { /* malformed */ }
      if (target !== host) { callback({}); return; }
      const responseHeaders = { ...(details.responseHeaders || {}) };
      // Replace (case-insensitively) so we don't end up with both 'Access-…'
      // and 'access-…' on the same response — Chromium then ignores both.
      const stripped = {};
      for (const [k, v] of Object.entries(responseHeaders)) {
        if (!/^access-control-/i.test(k)) stripped[k] = v;
      }
      stripped['Access-Control-Allow-Origin']      = ['*'];
      stripped['Access-Control-Allow-Methods']     = ['GET, HEAD, OPTIONS'];
      stripped['Access-Control-Allow-Headers']     = ['*'];
      callback({ responseHeaders: stripped });
    });
  } catch (e) {
    console.warn('[main] failed to install Headwaters CORS shim:', e && e.message);
  }

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
