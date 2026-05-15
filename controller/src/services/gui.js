/* GUI lifecycle — spawn / quit the Electron app from the controller.

   The Electron binary lives at /opt/trailcurrent-playbill/trailcurrent-playbill
   (per the image's hook 5; see image/rsdk/src/share/rsdk/build/rootfs.jsonnet).
   Wayland flags are mandatory — without --ozone-platform=wayland Electron
   defaults to X11 in this image, fails platform init, and exits silently.

   Cold-wake flow:
     1. PWA publishes  local/playbill/<id>/system/command  {action:'system.launchGui'}
     2. mqtt-bridge dispatches via the bus
     3. handlers/system.js calls gui.launch()
     4. We spawn the binary detached so the daemon doesn't tether the GUI's
        lifetime to its own
     5. The new GUI process opens its IPC client, connects to the controller's
        UDS socket, and IpcServer fires 'first-client' → state.gui.running=true

   Quit:
     pkill against the binary path (covers GUI-launched-from-GNOME-dock case
     where we don't have the PID). SIGTERM lets Electron clean up its
     Chromium child processes; SIGKILL would orphan them.

   Wake / Sleep:
     GNOME Screensaver is a session D-Bus service. SetActive(true) blanks +
     locks; SetActive(false) wakes. We shell out to dbus-send rather than
     pulling in a node-dbus dependency for two calls. */

'use strict';

const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const execFileP = promisify(execFile);

const BIN = '/opt/trailcurrent-playbill/trailcurrent-playbill';
const ARGS = [
  '--no-sandbox',
  '--ozone-platform=wayland',
  '--enable-features=UseOzonePlatform,WaylandWindowDecorations',
];

let lastSpawnedPid = null;

async function isRunning() {
  try {
    const { stdout } = await execFileP('pgrep', ['-f', BIN]);
    return stdout.trim().length > 0;
  } catch (e) {
    // pgrep exits 1 when no matches — that's "not running", not an error.
    if (e.code === 1) return false;
    throw e;
  }
}

/* Build the env we want to hand to the spawned Electron.
 *
 * The controller runs as a systemd USER service. systemd inherits
 * XDG_RUNTIME_DIR + DBUS_SESSION_BUS_ADDRESS from logind, but it does NOT
 * inherit WAYLAND_DISPLAY — that variable is set by gnome-session AFTER
 * the user instance starts, then exported only into the graphical-session
 * target via `systemctl --user import-environment`. Whether that runs
 * reliably across distros / GDM versions is, kindly, a coin flip.
 *
 * When WAYLAND_DISPLAY is missing the Ozone Wayland backend can't find a
 * compositor and Electron exits during platform init in <1s, silently —
 * which is exactly the "Power button doesn't launch anymore" symptom.
 *
 * We patch that here: if the variable isn't in our env, scan
 * $XDG_RUNTIME_DIR for `wayland-N` socket files and pick the lowest one.
 * That matches what gnome-session would have set anyway (usually
 * wayland-0). Same logic for DISPLAY (X11) and DBUS_SESSION_BUS_ADDRESS
 * as a belt-and-braces fallback.
 */
function sessionEnv() {
  const env = { ...process.env };
  const xdg = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid && process.getuid()}`;

  if (!env.WAYLAND_DISPLAY && xdg) {
    try {
      const sock = fs.readdirSync(xdg)
        .filter((n) => /^wayland-\d+$/.test(n))
        .sort()[0];
      if (sock) env.WAYLAND_DISPLAY = sock;
    } catch (_) { /* no readable runtime dir — fall through */ }
  }
  if (!env.DBUS_SESSION_BUS_ADDRESS && xdg) {
    const busPath = path.join(xdg, 'bus');
    if (fs.existsSync(busPath)) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${busPath}`;
  }
  if (!env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = xdg;
  // Don't reach for DISPLAY — we explicitly run Electron with
  // --ozone-platform=wayland and an X11 fallback isn't desired.
  return env;
}

async function launch() {
  if (await isRunning()) return { ok: true, alreadyRunning: true };

  const env = sessionEnv();
  console.log(`[gui] launching ${BIN} (WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY || 'unset'})`);
  const child = spawn(BIN, ARGS, {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.on('error', (e) => {
    console.error('[gui] spawn error:', e.message);
  });
  child.unref();   // don't keep the controller alive on the GUI
  lastSpawnedPid = child.pid;
  return { ok: true, pid: child.pid, launched: true };
}

async function quit() {
  // pkill matches every process running the binary path. -TERM (default)
  // gives Electron time to close cleanly and reap its sandbox children;
  // -KILL would orphan them.
  try {
    await execFileP('pkill', ['-f', BIN]);
  } catch (e) {
    // Exit 1 = no matches (already not running). That's success.
    if (e.code !== 1) throw e;
  }
  lastSpawnedPid = null;
  return { ok: true };
}

/** Wake / sleep the screen via GNOME Screensaver D-Bus. */
async function setScreensaver(active) {
  // Need the user's session bus. systemd user services inherit
  // DBUS_SESSION_BUS_ADDRESS via XDG_RUNTIME_DIR/bus.
  await execFileP('dbus-send', [
    '--session', '--type=method_call',
    '--dest=org.gnome.ScreenSaver',
    '/org/gnome/ScreenSaver',
    'org.gnome.ScreenSaver.SetActive',
    `boolean:${active ? 'true' : 'false'}`,
  ]);
  return { ok: true, screensaverActive: active };
}

const wake  = () => setScreensaver(false);
const sleep = () => setScreensaver(true);

/**
 * Best-effort focus. Wayland forbids third-party apps from raising another
 * window, so the most we can do is launch if not running. Returns
 * `focused:false, reason:'wayland-no-raise'` if the GUI was already up
 * (so a PWA can decide whether to show the user a "GUI was already
 * running, we couldn't raise it" hint).
 */
async function focus() {
  if (await isRunning()) {
    return { ok: true, focused: false, reason: 'wayland-no-raise' };
  }
  return launch();
}

module.exports = { isRunning, launch, quit, focus, wake, sleep };
module.exports.BIN = BIN;
