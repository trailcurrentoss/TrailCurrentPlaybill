/* mpv-based fullscreen video player.

   Spawned as a separate borderless, fullscreen, undecorated window over the
   Electron UI. We do NOT attempt to embed mpv inside the Electron BrowserWindow
   (Wayland makes that messy and we lose hardware decode acceleration when
   Chromium tries to handle the surface). Instead, mpv owns its own toplevel
   window for the duration of playback, then exits → user is back in the UI.

   Hardware-accelerated decode is the whole point of this path:
     --hwdec=auto-safe        let mpv pick the best decoder mpv was built with
                              (V4L2-M2M / DRM Prime on the Q6A; VAAPI elsewhere)
     --vo=gpu-next            modern OpenGL/Vulkan video output
     --profile=fast           sane defaults for 1080p60 on constrained SoCs

   IPC: mpv exposes a JSON socket; we use it to issue stop / volume / mute
   commands without restarting the player. The socket path is also reachable
   later from the eventual HTTP remote-control surface (Headwaters PWA). */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { execFile } = require('child_process');
const { RUNTIME_DIR, ensureDirs } = require('./paths');

let session = null; // { proc, ipcPath, source }

function play({ source, hwdec = 'auto-safe' } = {}) {
  if (!source) return Promise.reject(new Error('source required'));
  ensureDirs();
  return stop().then(() => new Promise((resolve, reject) => {
    const ipcPath = path.join(RUNTIME_DIR, 'mpv.sock');
    try { fs.unlinkSync(ipcPath); } catch (_) { /* fresh socket */ }
    const args = [
      '--fs',
      '--no-border',
      '--ontop',
      '--no-osc',
      '--no-input-default-bindings',
      '--keep-open=no',
      `--hwdec=${hwdec}`,
      '--vo=gpu-next',
      '--profile=fast',
      // Live MPEG-TS coming off dvbv5-zap is being written as we read; tell
      // mpv to follow the file rather than treat it as a finite asset.
      '--demuxer-lavf-o=fflags=+nobuffer,flags=+low_delay',
      '--cache=yes',
      '--cache-secs=2',
      '--demuxer-readahead-secs=1',
      `--input-ipc-server=${ipcPath}`,
      source,
    ];
    const proc = spawn('mpv', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      session = null;
      // Resolve happens before close (on socket-ready); close just clears state.
      // If we somehow got here without resolving, reject.
      if (proc.__playbillResolved) return;
      reject(new Error(`mpv exited ${code} before becoming ready: ${stderr.slice(-400)}`));
    });

    // Wait for the IPC socket to appear, then resolve.
    const t0 = Date.now();
    const pollSocket = () => {
      if (fs.existsSync(ipcPath)) {
        proc.__playbillResolved = true;
        session = { proc, ipcPath, source };
        resolve({ ipcPath });
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
    s.proc.kill('SIGTERM');
    setTimeout(() => { try { s.proc.kill('SIGKILL'); } catch (_) {} }, 600);
  });
}

function isPlaying() { return !!session; }

function command(cmdArray) {
  if (!session) return Promise.reject(new Error('mpv is not running'));
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(session.ipcPath);
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

const setVolume   = (v)    => command(['set_property', 'volume', Math.max(0, Math.min(150, v))]);
const setMute     = (m)    => command(['set_property', 'mute',   !!m]);

function probeTools() {
  return new Promise((resolve) => {
    execFile('which', ['mpv'], (err, stdout) => {
      resolve({ mpv: !!(stdout || '').trim() });
    });
  });
}

module.exports = { play, stop, isPlaying, setVolume, setMute, command, probeTools };
