/* mpv-based fullscreen player — owned by the controller daemon.

   Lifted from app/main/services/player.js as part of Phase 6. Moving mpv
   out of the Electron main process means audio playback survives the GUI
   closing — the user can dismiss the Playbill window while the radio (or
   a music-only YouTube video) keeps playing, per architecture-v2 §2 reason
   2 ("Audio keeps playing past the GUI's life").

   Hardware-accelerated decode is the whole point of this path:
     --hwdec=auto-safe   let mpv pick the best decoder mpv was built with
                         (V4L2-M2M / DRM Prime on the Q6A; VAAPI elsewhere)
     --vo=gpu-next       modern OpenGL/Vulkan video output
     --profile=fast      sane defaults for 1080p60 on constrained SoCs

   IPC: mpv exposes a JSON socket. We use it to issue stop / volume /
   mute / seek commands without restarting the player. We also subscribe
   to property changes (pause, time-pos, duration) so state.nowPlaying
   reflects mpv's reality, not just our last command. */

'use strict';

const fs   = require('fs');
const net  = require('net');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const { RUNTIME_DIR, ensureDirs } = require('../paths');

const SOCK_PATH = path.join(RUNTIME_DIR, 'mpv.sock');

// Single global session — only one playback at a time. Spec'd that way
// in architecture-v2 §6: switching from radio to YouTube stops the radio.
let session = null;
const events = new EventEmitter();

function isPlaying() { return !!session; }
function getMetadata() { return session ? session.metadata || null : null; }

/**
 * Start mpv on `url`. `metadata` is mirrored back into events as the
 * authoritative now-playing source for any subscribers (state-store, etc.)
 *
 * @param {object} opts
 * @param {string} opts.url               playable URL (file://, http://, hls, etc.)
 * @param {string} [opts.hwdec='auto-safe']
 * @param {object} [opts.headers]         passed to mpv as --http-header-fields
 * @param {string} [opts.mediaType='video']  'video' or 'audio'
 * @param {object} [opts.metadata]        title/subtitle/artworkUrl/sourceItemId
 * @param {boolean} [opts.fullscreen=true]
 */
function play({ url, hwdec = 'auto-safe', headers, mediaType = 'video', metadata, fullscreen = true } = {}) {
  if (!url) return Promise.reject(new Error('player.play: url required'));
  ensureDirs();
  return stop().then(() => new Promise((resolve, reject) => {
    try { fs.unlinkSync(SOCK_PATH); } catch (_) { /* fresh socket */ }

    const args = [
      ...(fullscreen ? ['--fs'] : []),
      '--no-border', '--ontop', '--no-osc',
      '--no-input-default-bindings',
      '--keep-open=no',
      `--hwdec=${hwdec}`,
      '--vo=' + (mediaType === 'audio' ? 'null' : 'gpu-next'),
      '--profile=fast',
      // Live MPEG-TS coming off dvbv5-zap is being written as we read; tell
      // mpv to follow the file rather than treat it as a finite asset.
      '--demuxer-lavf-o=fflags=+nobuffer,flags=+low_delay',
      '--cache=yes',
      '--cache-secs=2',
      '--demuxer-readahead-secs=1',
      `--input-ipc-server=${SOCK_PATH}`,
    ];

    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        args.push('--http-header-fields=' + k + ': ' + v);
      }
    }

    args.push(url);

    const proc = spawn('mpv', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      const wasUs = (session && session.proc === proc);
      session = null;
      if (wasUs) {
        events.emit('ended', { code, exitedClean: code === 0 });
      }
      if (proc.__resolved) return;
      reject(new Error(`mpv exited ${code} before becoming ready: ${stderr.slice(-400)}`));
    });

    // Wait for the IPC socket to appear, then resolve and start subscribing
    // to mpv property changes so we can mirror them into state.nowPlaying.
    const t0 = Date.now();
    const pollSocket = () => {
      if (fs.existsSync(SOCK_PATH)) {
        proc.__resolved = true;
        session = { proc, url, metadata: metadata || null, eventSocket: null };
        attachEventSocket();
        events.emit('started', { url, metadata: metadata || null });
        resolve({ ok: true, url, metadata: metadata || null });
        return;
      }
      if (Date.now() - t0 > 4000) {
        try { proc.kill('SIGKILL'); } catch (_) {}
        reject(new Error('mpv did not open IPC socket within 4s'));
        return;
      }
      setTimeout(pollSocket, 60);
    };
    pollSocket();
  }));
}

function stop() {
  if (!session) return Promise.resolve();
  const s = session;
  session = null;
  return new Promise((resolve) => {
    s.proc.once('close', () => resolve());
    try { s.proc.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { s.proc.kill('SIGKILL'); } catch (_) {} }, 600);
  });
}

/** Send a one-shot command over mpv's JSON IPC. */
function command(cmdArray) {
  if (!session) return Promise.reject(new Error('mpv is not running'));
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(session.eventSocket ? SOCK_PATH : SOCK_PATH);
    let buf = '';
    sock.on('connect', () => {
      sock.write(JSON.stringify({ command: cmdArray }) + '\n');
    });
    sock.on('data', (b) => {
      buf += b.toString();
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try { resolve(JSON.parse(buf.slice(0, nl))); }
        catch (e) { reject(e); }
        sock.end();
      }
    });
    sock.on('error', reject);
  });
}

const pause       = ()        => command(['set_property', 'pause', true]);
const resume      = ()        => command(['set_property', 'pause', false]);
const togglePause = ()        => command(['cycle', 'pause']);
const seekRelative = (deltaSec) => command(['seek', deltaSec, 'relative']);
const seekAbsolute = (posSec)   => command(['seek', posSec, 'absolute']);
const setVolume   = (v)       => command(['set_property', 'volume', Math.max(0, Math.min(150, v))]);
const setMute     = (m)       => command(['set_property', 'mute', !!m]);

function probeTools() {
  return new Promise((resolve) => {
    execFile('which', ['mpv'], (err, stdout) => {
      resolve({ mpv: !!(stdout || '').trim() });
    });
  });
}

// ── Subscription socket ───────────────────────────────────────────────
//
// mpv's IPC supports observe_property — it pushes events when a property
// changes. We open a long-lived socket alongside the per-command sockets,
// observe pause/time-pos/duration, and re-emit those as events so the
// state store can track playback live.
function attachEventSocket() {
  if (!session) return;
  const sock = net.createConnection(SOCK_PATH);
  session.eventSocket = sock;
  let buf = '';
  let nextId = 1;
  sock.on('connect', () => {
    const observe = (name) => sock.write(JSON.stringify({
      command: ['observe_property', nextId++, name],
    }) + '\n');
    observe('pause');
    observe('time-pos');
    observe('duration');
    observe('eof-reached');
  });
  sock.on('data', (b) => {
    buf += b.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.event === 'property-change') {
          events.emit('property', { name: msg.name, value: msg.data });
        }
      } catch (_) { /* ignore */ }
    }
  });
  sock.on('error', () => { /* socket dies when mpv exits — fine */ });
}

module.exports = {
  play, stop, isPlaying, getMetadata,
  pause, resume, togglePause, seekRelative, seekAbsolute,
  setVolume, setMute, command, probeTools,
  on: (...a) => events.on(...a),
  off: (...a) => events.off(...a),
};
