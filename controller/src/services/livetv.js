/* livetv source — DVB / ATSC tuner.

   Supported hardware: Hauppauge WinTV-dualHD, model 01595, USB ID 2040:826d
   ONLY. (Other DVB devices won't enumerate because the Q6A kernel ships no
   USB-DVB bridge drivers — we add the specific stack this one needs via the
   playbill-dvb-dkms package: em28xx + em28xx-dvb + lgdt3306a + si2157 +
   tveeprom. Earlier comments in this file claimed `dvb_usb_cxusb` — that
   was wrong; the 01595 actually uses the em28xx bridge, NOT cxusb.) The
   loaded drivers expose adapters as
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
const scanProcs = new Set(); // every in-flight dvbv5-scan (1 per adapter)

/* Poll-open the frontend device until it accepts an exclusive R/W open,
   or until timeout. After SIGTERMing dvbv5-scan the kernel needs a beat
   to fully release the frontend; tune() (via dvbv5-zap) fired immediately
   gets EBUSY. Callers (stopScan, scan-on-natural-completion) await this
   so when their promises resolve the frontend is actually tune-ready.

   100 ms poll interval, 5 s default cap. Returns true on free, false on
   timeout — callers can decide whether to surface or proceed regardless. */
async function waitForFrontendFree(adapter = 0, timeoutMs = 5000) {
  const fePath = path.join(DVB_ROOT, `adapter${adapter}`, 'frontend0');
  if (!fs.existsSync(fePath)) return false;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(fePath, fs.constants.O_RDWR);
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EBUSY') return false; // some other error — give up
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

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

/* Private worker — spawn one dvbv5-scan against the given freqTable +
   outputPath on the given adapter. Resolves on natural completion with
   the raw outputPath written to disk (caller parses or merges). Rejects
   on non-zero exit. SIGTERM/SIGKILL resolves successfully (caller-aborted)
   so scanAuto's Promise.all doesn't throw when stopScan() kills siblings. */
function _runScan({ adapter, freqTable, outputPath, tag = 'livetv.scan' }) {
  ensureDirs();
  return new Promise((resolve, reject) => {
    const args = [
      // Delivery system comes from the frequency table file itself (the
      // dtv-scan-tables ATSC table ships with DELIVERY_SYSTEM=ATSC entries).
      // Don't pass `-A` here — Ubuntu Noble's dvbv5-scan rejects it as
      // "invalid option" and fails the scan immediately.
      '-a', String(adapter),
      '-v',                  // verbose — emits per-channel progress on stderr
      '-O', 'DVBv5',
      '-o', outputPath,
      // -T multiplies userspace polling caps. The LGDT3306A driver has its
      // own ~10-15 s per-frequency lock-acquisition wait that ignores -T,
      // so this is mostly cosmetic — the real win came from trimming the
      // frequency table (see locateFreqTable / us-ATSC-modern-8VSB).
      '-T', '0.3',
      freqTable,
    ];
    const proc = spawn('dvbv5-scan', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    scanProcs.add(proc);
    let stderr = '';
    // Stream stderr to the controller journal a line at a time so an
    // operator running `journalctl --user -u playbill-controller -f`
    // sees real-time per-frequency lock progress. Without this, scan
    // looks indistinguishable from "hung" for several minutes.
    let logBuf = '';
    proc.stderr.on('data', (b) => {
      const s = b.toString();
      stderr += s;
      logBuf += s;
      let nl;
      while ((nl = logBuf.indexOf('\n')) >= 0) {
        const line = logBuf.slice(0, nl).trimEnd();
        logBuf = logBuf.slice(nl + 1);
        if (line) console.log(`[${tag} a${adapter}]`, line);
      }
    });
    proc.on('error', (err) => { scanProcs.delete(proc); reject(err); });
    proc.on('close', async (code, signal) => {
      scanProcs.delete(proc);
      if (logBuf) { console.log(`[${tag} a${adapter}]`, logBuf.trimEnd()); logBuf = ''; }
      // Wait for the frontend to fully release before resolving so a
      // subsequent tune doesn't see EBUSY.
      await waitForFrontendFree(adapter);
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        console.log(`[${tag} a${adapter}] aborted by signal`, signal);
        resolve({ aborted: true, outputPath });
        return;
      }
      if (code !== 0) {
        reject(new Error(`dvbv5-scan(a${adapter}) exited ${code}: ${stderr.slice(-400)}`));
        return;
      }
      resolve({ aborted: false, outputPath });
    });
  });
}

/* ATSC channel scan on a single adapter. Writes the canonical
   channels.conf. Used when the caller pinned a specific adapter. */
function scan({ adapter = 0, country = 'US' } = {}) {
  const freqTable = locateFreqTable(country);
  if (!freqTable) {
    return Promise.reject(new Error(
      `No ATSC frequency table found for ${country}. Install dvb-tools / dtv-scan-tables.`));
  }
  return _runScan({ adapter, freqTable, outputPath: CHANNELS_CONF })
    .then(() => { try { return listChannels(); } catch (e) { return []; } });
}

/* Parallel ATSC scan across every available adapter. Splits the
   frequency table into N equal-ish parts, spawns one dvbv5-scan per
   adapter (each on its own slice of the spectrum), then merges the
   per-adapter result files into the canonical channels.conf.

   On the Hauppauge WinTV-dualHD (two independent LGDT3306A demods on
   one USB bridge) this roughly halves scan time. Falls through to a
   single-adapter scan() if only one adapter exists or if any per-
   adapter scan fails — never strands the user without a list. */
async function scanAuto({ country = 'US' } = {}) {
  ensureDirs();
  const adapters = listAdapters();
  if (!adapters.length) {
    throw new Error('No DVB adapter present.');
  }
  if (adapters.length === 1) {
    return scan({ adapter: adapters[0].index, country });
  }
  const freqTable = locateFreqTable(country);
  if (!freqTable) {
    throw new Error(`No ATSC frequency table found for ${country}.`);
  }
  const entries = readFreqTableEntries(freqTable);
  if (entries.length === 0) {
    throw new Error(`Frequency table ${freqTable} contains no [CHANNEL] entries.`);
  }

  // Interleave entries across adapters so each gets a comparable mix of
  // VHF-high (fast lock) and high-UHF (often dead). A naive front/back
  // split would leave one adapter stuck on the dead high-UHF tail while
  // the other finished in 90 s.
  const chunks = adapters.map(() => []);
  entries.forEach((e, i) => chunks[i % adapters.length].push(e));

  const RUN = RUNTIME_DIR;
  const perAdapter = adapters.map((a, i) => {
    const tablePath  = path.join(RUN, `scan-table-a${a.index}.conf`);
    const outputPath = path.join(RUN, `scan-channels-a${a.index}.conf`);
    fs.writeFileSync(tablePath, chunks[i].join(''));
    try { fs.unlinkSync(outputPath); } catch (_) { /* fresh */ }
    return { adapter: a.index, tablePath, outputPath };
  });

  console.log(`[livetv.scanAuto] splitting ${entries.length} freqs across ${adapters.length} adapters`);

  let results;
  try {
    results = await Promise.all(perAdapter.map(p =>
      _runScan({ adapter: p.adapter, freqTable: p.tablePath, outputPath: p.outputPath, tag: 'livetv.scanAuto' })
    ));
  } finally {
    // Always clean up per-adapter temp tables.
    for (const p of perAdapter) {
      try { fs.unlinkSync(p.tablePath); } catch (_) {}
    }
  }

  // Merge per-adapter outputs into the canonical channels.conf. If a
  // scan was aborted (SIGTERM) its outputPath may be empty or missing;
  // skip it gracefully. We dedupe by [SectionName] header so a station
  // that happened to fall on the boundary frequency and was captured by
  // both adapters lands as one entry.
  const seen = new Set();
  const merged = [];
  for (const p of perAdapter) {
    let txt = '';
    try { txt = fs.readFileSync(p.outputPath, 'utf8'); }
    catch (_) { continue; }
    const blocks = txt.split(/\n(?=\[)/);
    for (let b of blocks) {
      const m = b.match(/^\s*\[([^\]]+)\]/);
      if (!m) continue;
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      if (!b.endsWith('\n')) b += '\n';
      merged.push(b);
    }
    try { fs.unlinkSync(p.outputPath); } catch (_) {}
  }
  fs.writeFileSync(CHANNELS_CONF, merged.join(''));
  console.log(`[livetv.scanAuto] merged ${merged.length} channels into ${CHANNELS_CONF}`);
  return listChannels();
}

/* Abort an in-progress scan. SIGTERM gives dvbv5-scan a chance to clean
   up the frontend; if it doesn't quit within a second we SIGKILL so the
   user isn't stuck. No-op when no scan is running.

   We do NOT manually waitForFrontendFree() here — the scan promise's
   close handler already does that before resolving. By the time the
   close event fires here, the same handler upstairs has already drained
   the frontend; we just wait for the close event. */
function stopScan() {
  if (scanProcs.size === 0) return Promise.resolve({ ok: true, wasRunning: false });
  // Take a snapshot — _runScan's close handler removes entries from the
  // set asynchronously, and we want to await every single one.
  const procs = [...scanProcs];
  return Promise.all(procs.map((proc) => new Promise((resolve) => {
    const onExit = async () => {
      // Defense-in-depth: also wait here, in case _runScan's close
      // handler hasn't finished its waitForFrontendFree() yet.
      await waitForFrontendFree(0);
      resolve();
    };
    proc.once('close', onExit);
    try { proc.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 1000);
  }))).then(() => ({ ok: true, wasRunning: true }));
}

function locateFreqTable(country) {
  // Prefer our bundled trimmed US ATSC table — modern post-2017 plan,
  // 30 entries (RF ch 7-36) vs the upstream dtv-scan-tables 68-entry
  // table. The LGDT3306A driver has an irreducible ~10-15 s per-
  // frequency lock-acquisition wait, so cutting the table in half cuts
  // scan time roughly in half (with no real-world impact — we omit
  // VHF-low and the 614-698 MHz post-auction-cleared band where no
  // US ATSC stations broadcast).
  const bundled = path.join(__dirname, '..', '..', 'data', 'us-ATSC-modern-8VSB');
  const candidates = [
    bundled,
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

/* Read an 8VSB frequency table file and return one string per [CHANNEL]
   entry (full block, header+body, ready to concat back into a child
   table). Used by scanAuto() to split work across adapters. */
function readFreqTableEntries(filePath) {
  const txt = fs.readFileSync(filePath, 'utf8');
  const entries = [];
  let cur = null;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine;
    const trimmed = line.trim();
    if (/^\[CHANNEL\]/i.test(trimmed)) {
      if (cur) entries.push(cur);
      cur = line + '\n';
      continue;
    }
    if (trimmed.startsWith('#') || trimmed === '') {
      // Drop comments/blanks — keep entries clean for re-emission.
      if (cur) cur += line + '\n';
      continue;
    }
    if (cur) cur += line + '\n';
  }
  if (cur) entries.push(cur);
  return entries;
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
    const spawnedAt = Date.now();
    console.log(`[livetv.tune] spawning dvbv5-zap for "${channel}" on adapter ${adapter}`);
    // Stream stderr to the journal a line at a time so an operator can see
    // lock progression (Carrier(0x03)... Lock(0x1f)) without needing to
    // strace the running process. Mirrors the scan() pattern. Without this
    // a slow lock looks like "the controller is hung" — until the IPC
    // timeout fires, the user gets no feedback at all.
    let logBuf = '';
    proc.stderr.on('data', (b) => {
      const s = b.toString();
      stderr += s;
      logBuf += s;
      let nl;
      while ((nl = logBuf.indexOf('\n')) >= 0) {
        const line = logBuf.slice(0, nl).trimEnd();
        logBuf = logBuf.slice(nl + 1);
        if (line) console.log('[livetv.tune]', line);
      }
      // dvbv5-zap prints "Lock   (0x1f)" when the frontend has signal.
      if (!lockSeen && /Lock\s*\(/i.test(s)) {
        lockSeen = true;
        const lockMs = Date.now() - spawnedAt;
        console.log(`[livetv.tune] lock acquired for "${channel}" after ${lockMs} ms`);
        // After Lock, wait until the TS file has enough data for mpv to
        // find a PAT/PMT and at least one keyframe — otherwise mpv opens
        // a near-empty file, can't parse a program, and either renders
        // nothing or exits with "mpv exited 2 before becoming ready".
        // 256 KB of ATSC TS (~330 ms at 6 Mbps) reliably contains the
        // initial PAT and at least one PMT pass. Hard ceiling at 2 s
        // even if the file isn't growing as fast as expected so a
        // marginal signal can't hold the renderer indefinitely.
        const MIN_BYTES = 256 * 1024;
        const MAX_WAIT_MS = 2000;
        const waitStart = Date.now();
        const pollFile = () => {
          if (resolved) return;
          let size = 0;
          try { size = fs.statSync(tsPath).size; } catch (_) { size = 0; }
          if (size >= MIN_BYTES) {
            console.log(`[livetv.tune] TS file has ${size} bytes — resolving`);
            resolved = true;
            resolve({ tsPath, channel, adapter });
            return;
          }
          if (Date.now() - waitStart >= MAX_WAIT_MS) {
            console.warn(`[livetv.tune] TS only ${size} bytes after ${MAX_WAIT_MS} ms — resolving anyway`);
            resolved = true;
            resolve({ tsPath, channel, adapter });
            return;
          }
          setTimeout(pollFile, 80);
        };
        setTimeout(pollFile, 80);
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      tuneSessions.delete(adapter);
      if (logBuf) { console.log('[livetv.tune]', logBuf.trimEnd()); logBuf = ''; }
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

/* tuneAuto — iterate every adapter the Hauppauge WinTV-dualHD exposes
   (two independent LGDT3306A demods sharing a single USB bridge), trying
   each with a short per-adapter timeout, and return the first one that
   achieves Lock. Use when the caller doesn't care which physical demod
   ends up backing the session — i.e. always in the single-output Playbill
   UI.

   Field-observed motivation: one of our test units has a flaky LGDT3306A
   on adapter 0 — it reports Carrier(0x03) at ~-82 dBm but never advances
   to VITERBI/SYNC/LOCK, while adapter 1 on the SAME antenna locks
   instantly at -65 dBm / 21 dB C/N. Without failover the renderer is
   stuck pointing at the dead demod, so every tune times out and the
   occasional fragile lock leaves mpv showing nothing because the TS is
   corrupt. With failover we try adapter 0 briefly, fall over to adapter 1
   when it doesn't lock fast, and the user sees a working channel.

   perAdapterTimeoutMs defaults to 15 s — generous enough that a healthy
   demod with a marginal antenna will still acquire lock, tight enough
   that a dead demod doesn't burn the user's whole patience budget. */
async function tuneAuto({ channel, perAdapterTimeoutMs = 15000 } = {}) {
  if (!channel) throw new Error('channel name required');
  const adapters = listAdapters();
  if (!adapters.length) throw new Error('no DVB adapter present');
  let lastErr = null;
  for (const a of adapters) {
    console.log(`[livetv.tuneAuto] trying adapter ${a.index} for "${channel}"`);
    let timer;
    const timeoutPromise = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(
        `adapter ${a.index} did not lock within ${perAdapterTimeoutMs} ms`)), perAdapterTimeoutMs);
    });
    try {
      const result = await Promise.race([
        tune({ adapter: a.index, channel }),
        timeoutPromise,
      ]);
      clearTimeout(timer);
      console.log(`[livetv.tuneAuto] adapter ${a.index} locked for "${channel}"`);
      return result;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      console.warn(`[livetv.tuneAuto] adapter ${a.index} failed: ${e.message}`);
      // Ensure this adapter's dvbv5-zap is killed so the next iteration
      // (or any later tune call) doesn't see EBUSY. stopTune is async
      // and waits for the frontend to release.
      try { await stopTune({ adapter: a.index }); } catch (_) { /* noop */ }
    }
  }
  throw lastErr || new Error('no adapter locked');
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
  scanAuto,
  stopScan,
  listChannels,
  tune,
  tuneAuto,
  stopTune,
  stopAll,
  probeTools,
};
