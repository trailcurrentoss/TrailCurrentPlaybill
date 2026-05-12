/* UxPlay supervisor — spawns the AirPlay receiver on demand.

   Unlike mpv (services/player.js) which we re-spawn for each playback URL,
   UxPlay is a long-running daemon: once started it advertises an AirPlay
   service on the LAN and waits for phones to connect to *it*. We only
   start it when the user opens the Cast screen and stop it when they
   leave, so the device isn't permanently visible as an AirPlay target.

   The UxPlay process owns its own fullscreen GStreamer window. The
   Playbill Electron window stays open underneath; when UxPlay exits, the
   compositor returns focus to Electron naturally.

   We watch UxPlay's stdout for the client-connected / streaming markers
   and surface those as events so the renderer can show "Waiting for
   device" → "Connected to <name>" → "Streaming". Marker strings track
   UxPlay 1.68.x; if they change in a future release, the screen falls back
   to the basic "running" state and still works. */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

let session = null;
const events = new EventEmitter();

// The controller runs as a systemd USER service. GNOME's session imports
// WAYLAND_DISPLAY etc. into the user systemd manager via
// `systemctl --user import-environment` at gnome-session startup — but the
// controller may have been started BEFORE that import landed (boot race),
// so the process environ doesn't have it. UxPlay's GStreamer pipeline
// silently fails to open a glimagesink surface when WAYLAND_DISPLAY is
// missing: the AirPlay handshake completes, the iPhone shows Connected,
// and the receiver screen never lights up.
//
// Recover the env by inspecting $XDG_RUNTIME_DIR/wayland-* (the socket
// gnome-shell creates at session start). Falls back to /run/user/<uid>/
// when XDG_RUNTIME_DIR is also missing.
function resolveDisplayEnv() {
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  let waylandDisplay = process.env.WAYLAND_DISPLAY;
  if (!waylandDisplay) {
    try {
      const entries = fs.readdirSync(runtimeDir);
      const match = entries.find((e) => /^wayland-\d+$/.test(e));
      if (match) waylandDisplay = match;
    } catch (_) { /* runtime dir missing — caller's env is broken anyway */ }
  }
  return {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    ...(waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {}),
    // GStreamer-GL uses GDK's display backend hints. Forcing "wayland"
    // here keeps glimagesink from trying to fall back to X11/EGL via
    // XWayland when WAYLAND_DISPLAY happened to be set but the GL
    // platform autodetect picks the wrong path.
    ...(waylandDisplay ? { GDK_BACKEND: 'wayland' } : {}),
    // GST_DEBUG is intentionally NOT forced here. The `...process.env`
    // spread above carries through whatever the caller set, so a debugging
    // session can `GST_DEBUG=2,h264parse:5,waylandsink:5 systemctl --user
    // restart playbill-controller.service` and the next cast.start picks
    // it up. Default (no GST_DEBUG) keeps the journal quiet.
  };
}

function isRunning() { return !!session; }

function getStatus() {
  if (!session) return { running: false, state: 'idle', clientName: null };
  return {
    running:    true,
    state:      session.state,        // 'waiting' | 'connected' | 'streaming'
    clientName: session.clientName,
    startedAt:  session.startedAt,
  };
}

/**
 * Start UxPlay. `receiverName` is what shows up in the iOS AirPlay menu.
 *
 * Idempotent — calling start() while already running returns the existing
 * session's status instead of stacking processes.
 */
function start({ receiverName = 'Playbill' } = {}) {
  if (session) {
    return Promise.resolve({ ok: true, alreadyRunning: true, ...getStatus() });
  }
  return new Promise((resolve, reject) => {
    const args = [
      '-n', receiverName,
      '-nh',                          // skip the "press any key" splash
      '-fs',                          // fullscreen
      // `waylandsink` talks the Wayland protocol natively (xdg_toplevel
      // including `set_fullscreen`) so Mutter actually fullscreens the
      // window when uxplay passes `-fs`. `glimagesink` decodes fine but
      // never requests fullscreen — the iPhone mirror renders into a
      // small toplevel sized by Mutter's defaults. `autovideosink` is
      // worse still: it picks xvimagesink (rank 256, primary) ahead of
      // both and routes through XWayland, where the handshake succeeds
      // but no frames reach the compositor.
      '-vs', 'waylandsink',
      '-as', 'pulsesink',             // PipeWire's pulse-shim — keeps the volume bar live
      // Force the libav software H.264 decoder. On the Q6A's current kernel,
      // `decodebin`'s rank-based picker selects `v4l2h264dec` (Qualcomm
      // Venus driver) which fails caps negotiation for iPhone streams —
      // capsfilter1 reports "could not transform video/x-h264 ... in anything
      // we support" and the pipeline collapses with not-negotiated (-4)
      // a few seconds after the iPhone shows "Connected". The A78 cores
      // decode 1080p H.264 in software comfortably; switch back to HW when
      // the Iris driver replaces Venus in kernel 6.18+.
      '-avdec',
    ];

    const env = resolveDisplayEnv();
    if (!env.WAYLAND_DISPLAY) {
      return reject(new Error(
        'uxplay needs a Wayland session but no WAYLAND_DISPLAY was found ' +
        `(checked ${env.XDG_RUNTIME_DIR}). Is GNOME running?`
      ));
    }

    let proc;
    try {
      proc = spawn('uxplay', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (e) {
      return reject(new Error(`uxplay failed to spawn: ${e.message}`));
    }

    session = {
      proc,
      state: 'waiting',
      clientName: null,
      startedAt: Date.now(),
    };

    let resolved = false;
    let stderrTail = '';

    // UxPlay logs its banner + "Initialized GStreamer video pipeline" within
    // ~300ms of start. Treat the first line of stdout (or a 500ms watchdog
    // expiry) as "ready, waiting for clients" — earlier than that and the
    // renderer would race the mDNS publish.
    const readyTimer = setTimeout(() => {
      if (resolved || !session) return;
      resolved = true;
      events.emit('state', getStatus());
      resolve({ ok: true, ...getStatus() });
    }, 500);

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      // Resolve on first stdout line so the renderer flips out of "starting"
      // immediately. Don't wait for the watchdog if UxPlay was already chatty.
      if (!resolved) {
        resolved = true;
        clearTimeout(readyTimer);
        events.emit('state', getStatus());
        resolve({ ok: true, ...getStatus() });
      }
      parseUxplayOutput(text);
      // Note: deliberately not mirroring stdout to console. UxPlay's stdout
      // is AirPlay lifecycle chatter which we already turn into state events;
      // echoing it verbatim filled the journal with redundant text. To bring
      // it back for a debug session, set GST_DEBUG before restarting the
      // controller and uxplay will be much louder via stderr anyway.
    });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      // Mirror ONLY error-class lines to console. UxPlay/GStreamer emit
      // routine "WARN" noise (v4l2 caps probes, Xlib DRI2 missing, etc.)
      // that's expected and not actionable. ERROR-class messages and our
      // own startup banner come through so genuine pipeline collapses
      // (not-negotiated, ENOMEM, etc.) still leave a trail in the journal.
      for (const line of text.split('\n')) {
        if (!line) continue;
        if (/\bERROR\b|FATAL|terminated|not-negotiated|Cannot|failed/i.test(line)) {
          process.stderr.write('[uxplay] ' + line + '\n');
        }
      }
      stderrTail = (stderrTail + text).slice(-800);
    });

    proc.on('error', (err) => {
      const wasSession = session;
      session = null;
      clearTimeout(readyTimer);
      if (!resolved) {
        resolved = true;
        reject(new Error(`uxplay error: ${err.message}`));
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
        reject(new Error(`uxplay exited ${code} before becoming ready${detail}`));
      } else if (wasSession) {
        events.emit('state', getStatus());
      }
    });
  });
}

/** Stop UxPlay. SIGTERM → 600ms grace → SIGKILL. */
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

// UxPlay 1.68.x emits human-readable lines on stdout. We pattern-match the
// ones that indicate client lifecycle and map them to our three states.
// These strings are observable surface; if a future UxPlay reformats them,
// the screen still shows "running" but loses the per-state detail. The
// receiver itself keeps working — only the status pill is affected.
function parseUxplayOutput(text) {
  if (!session) return;
  const lines = text.split('\n');
  let changed = false;
  for (const line of lines) {
    if (!line) continue;
    // "Accepted IPv4 client on socket ..." or "Client connected"
    if (/client connected|accepted .* client/i.test(line)) {
      session.state = 'connected';
      changed = true;
    }
    // Pair-verify carries the device name as `Device Name: <name>`
    const nameMatch = line.match(/Device Name:\s*(.+?)\s*$/i);
    if (nameMatch) {
      session.clientName = nameMatch[1];
      changed = true;
    }
    // Begin / start streaming
    if (/begin .* (mirroring|streaming)|start.* mirror/i.test(line)) {
      session.state = 'streaming';
      changed = true;
    }
    // Connection torn down — back to waiting (UxPlay keeps running)
    if (/connection closed|teardown|client disconnected|end of stream/i.test(line)) {
      session.state = 'waiting';
      session.clientName = null;
      changed = true;
    }
  }
  if (changed) events.emit('state', getStatus());
}

module.exports = {
  start, stop, isRunning, getStatus,
  on:  (...a) => events.on(...a),
  off: (...a) => events.off(...a),
};
