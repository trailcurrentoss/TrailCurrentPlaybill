/* TrailCurrent Playbill — Electron main process.
   Single fullscreen Wayland-native window. NOT kiosk-locked; Playbill is a
   normal application launched from the GNOME dock that the user can quit,
   minimize, or alt-tab away from at any time. */

const { app, BrowserWindow, screen, nativeTheme, ipcMain, globalShortcut, Menu } = require('electron');
const path = require('path');

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

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
