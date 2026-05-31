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

// Override file for two of mpv's default key bindings (ESC, BS → quit).
// See mpv-input.conf in this directory for the rationale.
const INPUT_CONF = path.join(__dirname, 'mpv-input.conf');

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
 * If `audioUrl` is provided, mpv loads it as a separate audio track via
 * --audio-file= and muxes the two streams in real time. This is what
 * yt-dlp returns for YouTube videos when bestvideo+bestaudio resolves
 * to two separate URLs (the only way to get >720p content from YouTube,
 * which only ships separate streams for the higher resolutions).
 *
 * @param {object} opts
 * @param {string} opts.url                 playable URL (file://, http://, hls, etc.)
 * @param {string} [opts.audioUrl]          optional separate audio track to mux in
 * @param {string} [opts.hwdec='auto-safe']
 * @param {object} [opts.headers]           passed to mpv as --http-header-fields
 * @param {string} [opts.mediaType='video'] 'video' or 'audio'
 * @param {object} [opts.metadata]          title/subtitle/artworkUrl/sourceItemId
 * @param {boolean} [opts.fullscreen=true]
 * @param {string[]} [opts.audioFxArgs]     extra mpv args from audio-fx
 *                                          (e.g. ['--af=...', '--volume=70']).
 *                                          Per-source loudness trim + dynaudnorm
 *                                          live here so all callers route through
 *                                          one balancing layer.
 */
// Q6A hwdec story (re-verified empirically 2026-05-30 on kernel 6.18.2-4-qcom,
// Mesa 25.2.8 — supersedes earlier claims in this comment that were based on
// misread mpv verbose output):
//
//   v4l2m2m-copy + --video-sync=display-resample : WORKS. Venus VPU hardware
//     decode delivers 0 dropped frames at 1080p60 H.264 with ~16% CPU (vs
//     ~39% for pure software). The earlier "88% drop rate" claim was an
//     artifact of mpv's default sync mode handling Venus' bursty late-frame
//     output badly. With display-resample, mpv's scheduler accommodates the
//     ~10–20ms per-frame firmware-RPC latency Venus has, and drops go to 0.
//
//   vulkan : DOES NOT DECODE in hardware. Mesa Turnip 25.2.8 does not advertise
//     VK_KHR_video_decode_queue on Adreno A643 (verified via ffmpeg log:
//     "Device does not support the VK_KHR_video_decode_queue extension!"
//     plus vulkaninfo queue-family enumeration — no VIDEO_DECODE_BIT). mpv
//     silently falls back to software decode. CPU spikes; no HW acceleration.
//
//   no : Pure software libavcodec. Fine for 1080p (~39% CPU). 4K VP9/AV1 is
//     beyond A78 capacity.
//
// Default is v4l2m2m-copy. The --video-sync=display-resample flag below is
// mandatory for venus to actually deliver smooth frames. Both are also set
// in /etc/mpv/mpv.conf as the system default.
function play({ url, audioUrl, hwdec = 'v4l2m2m-copy', headers, mediaType = 'video', metadata, fullscreen = true, audioFxArgs } = {}) {
  if (!url) return Promise.reject(new Error('player.play: url required'));
  ensureDirs();
  return stop().then(() => new Promise((resolve, reject) => {
    try { fs.unlinkSync(SOCK_PATH); } catch (_) { /* fresh socket */ }

    const args = [
      ...(fullscreen ? ['--fs'] : []),
      '--no-border', '--ontop', '--no-osc',
      // KEEP mpv's default key bindings — they're exactly the 10-foot
      // keyboard map we want: q quits, Space toggles pause, LEFT/RIGHT
      // seek, UP/DOWN volume, m mute, f fullscreen toggle. Earlier we
      // passed --no-input-default-bindings and inadvertently locked the
      // user inside mpv with no escape.
      //
      // The one override we ship (via --input-conf): ESC and BS quit
      // instead of toggling fullscreen off. The remote's Back delivers
      // KEY_ESC; mpv's default ESC handler (set fullscreen no) would
      // otherwise leave mpv windowed-and-playing while still holding
      // focus, stranding the user away from the GUI.
      `--input-conf=${INPUT_CONF}`,
      '--keep-open=no',
      `--hwdec=${hwdec}`,
      '--vo=' + (mediaType === 'audio' ? 'null' : 'gpu-next'),
      // Required for venus v4l2m2m-copy to deliver smooth playback —
      // see hwdec story comment above. Venus' ~10-20ms per-frame firmware
      // RPC latency causes mpv's default sync mode to drop ~20+ frames/sec
      // at 1080p60. display-resample makes mpv's scheduler accommodate
      // the bursty/late frames and brings drops to zero.
      '--video-sync=display-resample',
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

    // Separate audio track (the YouTube high-quality path). --audio-file
    // is mpv's way to mux a second source into the demuxer; the same
    // headers (User-Agent, etc.) apply to both connections, so we don't
    // need to re-pass them. --audio-file-auto=no stops mpv from also
    // side-loading any .mp3/.aac files in the CWD — irrelevant for our
    // remote URLs but defensive.
    if (audioUrl) {
      args.push(`--audio-file=${audioUrl}`);
      args.push('--audio-file-auto=no');
    }

    // Audio normalization + per-source trim from audio-fx. Pushed AFTER the
    // base args so user-configured trim overrides any default we set above
    // (mpv resolves later --volume= flags as authoritative).
    if (Array.isArray(audioFxArgs) && audioFxArgs.length) {
      args.push(...audioFxArgs);
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
