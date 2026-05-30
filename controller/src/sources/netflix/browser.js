/* Brave kiosk supervisor — spawns brave-browser at netflix.com.

   Modelled on sources/cast/uxplay.js. One long-running Brave process per
   start(); stop() kills it. The kiosk window covers the Electron app via
   the compositor (same as UxPlay's GStreamer window).

   Why Brave specifically:
     * Google doesn't ship Chrome for ARM64 Linux at all (verified May 2026:
       dl.google.com only serves amd64; the direct-download arm64 .deb URL
       404s). Brave does ship an arm64 Linux .deb in their stable apt repo.
     * Chromium-based, so all the standard kiosk flags work.
     * Widevine on Brave is downloaded as a component on first access to a
       DRM site, transparent to the user. For Netflix this means the first
       launch may show a brief loading state while the CDM installs (~5MB);
       subsequent launches play immediately.
     * One Chromium-based binary covers future Disney+/Prime/Max sources.
   See image/rsdk/.../rootfs.jsonnet hook 3a for the install.

   Cookies / sign-in persist across runs in a dedicated user-data-dir under
   ~/.config/trailcurrent-playbill/sources/netflix/profile/. That dir is
   per-source so when we add Disney+, Hulu, etc. they each get isolated
   profiles (separate logins, separate cookie jars).

   We do NOT poll the page or parse stdout — Brave doesn't expose anything
   useful there. State is just {running, startedAt, lastError}. The renderer
   is responsible for showing "Launching Netflix…" → just "Running" once we
   confirm the process is alive. */

'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs   = require('fs');
const path = require('path');

const { SOURCES_DIR } = require('../../paths');

// The Brave .deb installs `brave-browser` (which on most systems is a symlink
// into /etc/alternatives/, then to `brave-browser-stable`). We prefer the
// stable symlink as it survives alternatives reconfiguration.
const BROWSER_CANDIDATES = ['/usr/bin/brave-browser', '/usr/bin/brave-browser-stable'];

const PROFILE_DIR = path.join(SOURCES_DIR, 'netflix', 'profile');
const NETFLIX_URL = 'https://www.netflix.com';

let session = null;
const events = new EventEmitter();

function isRunning() { return !!session; }

function getStatus() {
  if (!session) return { running: false, startedAt: null, lastError: null };
  return {
    running:   true,
    startedAt: session.startedAt,
    lastError: null,
  };
}

function findBrowserBinary() {
  for (const p of BROWSER_CANDIDATES) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) { /* try next */ }
  }
  return null;
}

// Brave ships without the Widevine CDM and gates the initial download on
// the user clicking an in-browser info-bar — which `--app=` kiosk mode
// hides. Pre-seeding `brave.widevine_opted_in: true` here does NOT
// bootstrap the CDM (verified May 2026, Brave 148: the opt-in is gated on
// the click event, not on the pref alone). The CDM has to be installed
// once interactively per device; see docs/netflix-setup.md for the
// procedure. After that, the CDM lives in PROFILE_DIR and the kiosk works.
//
// We still pre-seed the prefs here because once the CDM IS installed, the
// `protected_media_identifier: 1` content setting bypasses a separate per-
// site "this page wants to use protected content" prompt that would
// otherwise block playback the first time the kiosk hits netflix.com. The
// widevine_opted_in flag is harmless either way — it's the click that
// matters for the CDM download, but having the pref set keeps Brave from
// re-prompting after the bootstrap.
function ensureWidevinePrefs() {
  const prefsPath = path.join(PROFILE_DIR, 'Default', 'Preferences');
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true, mode: 0o700 });
  let prefs = {};
  if (fs.existsSync(prefsPath)) {
    try { prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')); }
    catch (_) { prefs = {}; }   // corrupt? start fresh
  }
  prefs.brave = prefs.brave || {};
  prefs.brave.widevine_opted_in = true;
  prefs.profile = prefs.profile || {};
  prefs.profile.default_content_setting_values =
    prefs.profile.default_content_setting_values || {};
  // 1 = ALLOW (matches the constant in Chromium's ContentSetting enum).
  prefs.profile.default_content_setting_values.protected_media_identifier = 1;
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));
}

/**
 * Start Brave in kiosk mode at netflix.com.
 *
 * Idempotent — calling start() while already running returns the existing
 * session's status instead of stacking processes (Brave would complain
 * about the user-data-dir lock anyway).
 */
function start() {
  if (session) {
    return Promise.resolve({ ok: true, alreadyRunning: true, ...getStatus() });
  }

  const browserBin = findBrowserBinary();
  if (!browserBin) {
    return Promise.reject(new Error(
      'brave-browser not installed. The Playbill image installs it via apt ' +
      'in image hook 3a; if this is a dev box, `sudo apt-get install ' +
      'brave-browser` after adding the Brave signing key + repo.'
    ));
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  ensureWidevinePrefs();

  return new Promise((resolve, reject) => {
    const args = [
      '--kiosk',
      '--app=' + NETFLIX_URL,
      '--user-data-dir=' + PROFILE_DIR,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=TranslateUI,Vulkan',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-pinch',
      '--overscroll-history-navigation=0',
      '--start-fullscreen',
      // GPU acceleration on Q6A (Mesa Freedreno + Turnip on Adreno 643).
      // Verified 2026-05-30: without these, Brave consults its hardcoded
      // GPU blocklist, marks Freedreno-on-Linux-ARM as "untested", falls
      // back to SwiftShader software rendering, and pegs ~240 % CPU at
      // 1080p with frame drops. With the blocklist overridden + ANGLE
      // pointed at GLES (the only ANGLE backend usable on Adreno-Mesa
      // since Vulkan is incompatible with Wayland Ozone in Chromium),
      // brave drops to ~138 % CPU and the GPU process stays alive.
      // Netflix tops out at 720p anyway (Widevine L3 cap on ARM Linux)
      // so software decode is fine; the win is the GPU compositor path.
      '--ozone-platform=wayland',
      '--ignore-gpu-blocklist',
      '--use-angle=gles',
      '--enable-features=UseSkiaRenderer',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      '--enable-hardware-overlays',
      // Use an on-disk plaintext password store instead of libsecret/gnome-
      // keyring. Without this, Brave/Chromium prompts the user to unlock the
      // default keyring at every launch — it tries to store its own profile
      // encryption keys there. We don't care about Brave's password manager
      // (the user signs into Netflix once and the cookie persists via the
      // user-data-dir), and the kiosk has no way to type a keyring password
      // anyway. `basic` is the documented Chromium flag for this case.
      '--password-store=basic',
      // Suppress the "restore pages?" bubble after an unclean exit (always
      // happens when we SIGTERM the browser on stop). It otherwise eats the
      // first remote keypress when the user comes back to Netflix later.
      '--hide-crash-restore-bubble',
    ];

    let proc;
    try {
      proc = spawn(browserBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new Error(`brave-browser failed to spawn: ${e.message}`));
    }

    session = {
      proc,
      startedAt: Date.now(),
    };

    let resolved = false;
    let stderrTail = '';

    // Chrome's own readiness signals are noisy and version-dependent. Use a
    // short watchdog — if the process is still alive after 500ms, it's up
    // enough to flip the renderer out of "starting". Compositor will surface
    // the window when GPU init completes.
    const readyTimer = setTimeout(() => {
      if (resolved || !session) return;
      resolved = true;
      events.emit('state', getStatus());
      resolve({ ok: true, ...getStatus() });
    }, 500);

    proc.stdout.on('data', () => { /* Brave stdout is usually empty */ });
    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-1200);
    });

    proc.on('error', (err) => {
      const wasSession = session;
      session = null;
      clearTimeout(readyTimer);
      if (!resolved) {
        resolved = true;
        reject(new Error(`brave-browser error: ${err.message}`));
      } else if (wasSession) {
        events.emit('state', getStatus());
      }
    });

    proc.on('close', (code) => {
      const wasSession = session;
      session = null;
      clearTimeout(readyTimer);
      if (!resolved) {
        resolved = true;
        const detail = stderrTail ? ` — ${stderrTail.split('\n').slice(-3).join(' | ')}` : '';
        reject(new Error(`brave-browser exited ${code} before becoming ready${detail}`));
      } else if (wasSession) {
        events.emit('state', getStatus());
      }
    });
  });
}

/** Stop Brave. SIGTERM → 600ms grace → SIGKILL. */
function stop() {
  if (!session) return Promise.resolve({ ok: true, alreadyStopped: true });
  const s = session;
  session = null;
  return new Promise((resolve) => {
    s.proc.once('close', () => {
      events.emit('state', getStatus());
      resolve({ ok: true });
    });
    try { s.proc.kill('SIGTERM'); } catch (_) { /* already gone */ }
    setTimeout(() => { try { s.proc.kill('SIGKILL'); } catch (_) {} }, 600);
  });
}

module.exports = {
  start, stop, isRunning, getStatus,
  on:  (...a) => events.on(...a),
  off: (...a) => events.off(...a),
};
