/* livetv source — DVB / ATSC tuner. Hauppauge WinTV-dualHD (model 1595)
   and any other in-tree linux-dvb device. The kernel driver
   (`dvb_usb_cxusb` family) exposes adapters as
   /dev/dvb/adapterN/{frontend0, demux0, dvr0}.

   Lifted from app/main/services/dvb.js as part of Phase 5 — moved into the
   controller so a single tuner session is owned per device, MQTT and CAN
   senders can drive it, and the GUI is just one of several clients.

   Public surface (UI-agnostic):

     listAdapters()             → [{ index, frontend, name }]
     scan({ adapter, country }) → channels[]   (also written to channels.conf)
     listChannels()             → channels[]   (cached from disk)
     tune({ adapter, channel }) → { tsPath }   (TS capture started; mpv reads from tsPath)
     stopTune({ adapter })

   The TS capture writes to a normal file under RUNTIME_DIR. mpv consumes
   the file. Later, an HLS segmenter / HTTP restreamer can also tail the
   same file in parallel without changing this service. */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { CHANNELS_CONF, RUNTIME_DIR, ensureDirs } = require('../paths');

const DVB_ROOT = '/dev/dvb';
const tuneSessions = new Map(); // adapterIdx → { proc, tsPath, channel }

function listAdapters() {
  if (!fs.existsSync(DVB_ROOT)) return [];
  const out = [];
  for (const entry of fs.readdirSync(DVB_ROOT)) {
    const m = entry.match(/^adapter(\d+)$/);
    if (!m) continue;
    const idx = Number(m[1]);
    const frontend = path.join(DVB_ROOT, entry, 'frontend0');
    if (!fs.existsSync(frontend)) continue;
    out.push({ index: idx, frontend, name: readFrontendName(idx) });
  }
  return out.sort((a, b) => a.index - b.index);
}

function readFrontendName(idx) {
  // The driver exports a friendly name via /sys; fall back to a generic label.
  try {
    const p = `/sys/class/dvb/dvb${idx}.frontend0/device/uevent`;
    if (fs.existsSync(p)) {
      const txt = fs.readFileSync(p, 'utf8');
      const m = txt.match(/^DRIVER=(.+)$/m);
      if (m) return `Adapter ${idx} (${m[1]})`;
    }
  } catch (_) { /* noop */ }
  return `Adapter ${idx}`;
}

/* ATSC channel scan — runs dvbv5-scan against the installed US ATSC
   frequency table. Result is parsed and saved as DVBv5 channels.conf. */
function scan({ adapter = 0, country = 'US' } = {}) {
  ensureDirs();
  return new Promise((resolve, reject) => {
    const freqTable = locateFreqTable(country);
    if (!freqTable) {
      reject(new Error(`No ATSC frequency table found for ${country}. Install dvb-tools / dtv-scan-tables.`));
      return;
    }
    const args = [
      // Delivery system comes from the frequency table file itself (the
      // dtv-scan-tables ATSC table ships with DELIVERY_SYSTEM=ATSC entries).
      // Don't pass `-A` here — Ubuntu Noble's dvbv5-scan rejects it as
      // "invalid option" and fails the scan immediately.
      '-a', String(adapter),
      '-O', 'DVBv5',
      '-o', CHANNELS_CONF,
      freqTable,
    ];
    const proc = spawn('dvbv5-scan', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`dvbv5-scan exited ${code}: ${stderr.slice(-400)}`));
        return;
      }
      try { resolve(listChannels()); }
      catch (e) { reject(e); }
    });
  });
}

function locateFreqTable(country) {
  const candidates = [
    `/usr/share/dvb/atsc/us-Center-frequencies-8VSB`,
    `/usr/share/dvb/atsc/us-ATSC-center-frequencies-8VSB`,
    `/usr/share/dvb-tools/atsc/us-Center-frequencies-8VSB`,
    `/usr/share/dvbv5/atsc/us-Center-frequencies-8VSB`,
  ];
  if (country !== 'US') {
    // Future: CA, MX. Same 8VSB table works in practice for OTA in those markets.
  }
  return candidates.find(p => fs.existsSync(p)) || null;
}

/* Parse DVBv5 channels.conf into a structured list.
   Format is INI-like — `[Channel Name]` headers with key=value bodies. */
function listChannels() {
  if (!fs.existsSync(CHANNELS_CONF)) return [];
  const txt = fs.readFileSync(CHANNELS_CONF, 'utf8');
  const channels = [];
  let cur = null;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const head = line.match(/^\[(.+)\]$/);
    if (head) {
      if (cur) channels.push(finalizeChannel(cur));
      cur = { name: head[1], props: {} };
      continue;
    }
    if (!cur) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    cur.props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  if (cur) channels.push(finalizeChannel(cur));
  return channels;
}

function finalizeChannel(c) {
  const p = c.props;
  // PSIP virtual channel (e.g. "5.1") if scan recorded it; otherwise fall back.
  const major = p.SERVICE_ID ? Number(p.SERVICE_ID) : null;
  return {
    name:      c.name,
    frequency: p.FREQUENCY ? Number(p.FREQUENCY) : null,
    modulation: p.MODULATION || null,
    serviceId: major,
    raw: p,
  };
}

/* Start TS capture for a channel. Uses dvbv5-zap, which tunes the frontend,
   demuxes the program's PES streams, and writes a clean MPEG-TS to the
   given path. mpv (or, later, an HLS segmenter) consumes that file. */
function tune({ adapter = 0, channel }) {
  ensureDirs();
  if (!channel) return Promise.reject(new Error('channel name required'));
  // Stop any prior capture on this adapter — only one program at a time.
  return stopTune({ adapter }).then(() => new Promise((resolve, reject) => {
    const tsPath = path.join(RUNTIME_DIR, `tuner${adapter}.ts`);
    try { fs.unlinkSync(tsPath); } catch (_) { /* fresh file */ }
    const args = [
      '-c', CHANNELS_CONF,
      '-a', String(adapter),
      '-P',                  // capture all PIDs of the selected program
      '-r',                  // record mode (no audio playback by zap)
      '-o', tsPath,
      channel,
    ];
    const proc = spawn('dvbv5-zap', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let lockSeen = false;
    let resolved = false;
    proc.stderr.on('data', (b) => {
      const s = b.toString();
      stderr += s;
      // dvbv5-zap prints "Lock   (0x1f)" when the frontend has signal.
      if (!lockSeen && /Lock\s*\(/i.test(s)) {
        lockSeen = true;
        // Wait one short beat for the file to start growing, then resolve.
        setTimeout(() => {
          if (!resolved) { resolved = true; resolve({ tsPath, channel, adapter }); }
        }, 250);
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      tuneSessions.delete(adapter);
      if (!resolved) {
        resolved = true;
        reject(new Error(`dvbv5-zap exited ${code} before lock: ${stderr.slice(-400)}`));
      }
    });
    tuneSessions.set(adapter, { proc, tsPath, channel });
  }));
}

function stopTune({ adapter = 0 } = {}) {
  const sess = tuneSessions.get(adapter);
  if (!sess) return Promise.resolve();
  return new Promise((resolve) => {
    const onExit = () => resolve();
    sess.proc.once('close', onExit);
    sess.proc.kill('SIGTERM');
    // Hard kill if it doesn't quit promptly.
    setTimeout(() => { try { sess.proc.kill('SIGKILL'); } catch (_) {} }, 800);
  });
}

function stopAll() {
  return Promise.all([...tuneSessions.keys()].map((a) => stopTune({ adapter: a })));
}

/* Capability probe — does the host even have DVB userspace tools installed?
   Helps the UI distinguish "no hardware connected" from "tools missing". */
function probeTools() {
  return new Promise((resolve) => {
    execFile('which', ['dvbv5-scan', 'dvbv5-zap'], (err, stdout) => {
      const lines = (stdout || '').trim().split('\n').filter(Boolean);
      resolve({
        scan: lines.some(l => l.endsWith('dvbv5-scan')),
        zap:  lines.some(l => l.endsWith('dvbv5-zap')),
      });
    });
  });
}

module.exports = {
  listAdapters,
  scan,
  listChannels,
  tune,
  stopTune,
  stopAll,
  probeTools,
};
