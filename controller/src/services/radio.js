/* AM/FM radio service — driven by an RTL-SDR USB dongle (RTL2832U + R820T2
   for FM, R828D for AM/HF on the V4). Demodulation happens in software via
   `rtl_fm`; demodulated PCM is piped into the system's default audio device
   via `aplay`. The pipewire-pulse / pipewire-alsa compat layers route aplay
   through PipeWire to the WCD938x codec and out the 3.5 mm jack.
   (We tried `pw-cat` first — its `--raw` flag does not exist in upstream
   PipeWire 1.0.x; pw-cat treats `--raw` as a filename, fails to open it,
   prints help, and aborts. aplay handles raw PCM with -t raw natively.)

   Public surface (UI-agnostic — same calls reachable from local IPC and
   later from the Headwaters PWA over HTTP):

     listAdapters()                   → [{ index, name }]
     tune({ band, frequencyHz, gain }) → { band, frequencyHz }
     stop()                           → void
     getState()                       → { running, band, frequencyHz, gain }
     listPresets() / setPresets(arr)  → persistent FM/AM presets

   Bands:
     'fm'  → wide-FM at 200 kHz sample rate, deemphasis 75 µs (US)
     'am'  → AM at 12 kHz audio rate; uses RTL-SDR direct sampling on V4 */

const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { PRESETS_JSON, ensureDirs } = require('../paths');
const scannerData = require('./scanner-data');

let session = null; // { rtl, sink, band, frequencyHz, gain }

function listAdapters() {
  // rtl_test -t lists devices; we run with a timeout because rtl_test does
  // not have a "list and exit" mode — it streams forever otherwise. 3s is
  // generous: on the Radxa Q6A, librtlsdr takes ~1–2s to enumerate the
  // dongle and run the tuner self-test before printing the device line.
  return new Promise((resolve) => {
    execFile('rtl_test', ['-t'], { timeout: 3000, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        const txt = (stdout || '') + (stderr || '');
        const adapters = [];
        for (const line of txt.split(/\r?\n/)) {
          // Format: "  0:  Realtek, RTL2838UHIDIR, SN: 00000001"
          const m = line.match(/^\s*(\d+):\s+(.+)$/);
          if (m) adapters.push({ index: Number(m[1]), name: m[2].trim() });
        }
        resolve(adapters);
      });
  });
}

function tune({ band = 'fm', frequencyHz, gain = 'auto', modulation } = {}) {
  if (!frequencyHz) return Promise.reject(new Error('frequencyHz required'));
  return stop().then(() => new Promise((resolve, reject) => {
    const args = buildRtlFmArgs({ band, frequencyHz, gain, modulation });
    const rtl = spawn('rtl_fm', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // Pipe rtl_fm's raw PCM into the system audio device via aplay. aplay's
    // `-t raw` mode reads headerless PCM from stdin and hands it to ALSA, which
    // PipeWire's alsa-pcm plugin transparently forwards to the active sink.
    const sinkArgs = buildSinkArgs({ band });
    const sink = spawn('aplay', sinkArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    rtl.stdout.pipe(sink.stdin);

    // Stream EPIPE handlers — when stop() kills aplay, rtl_fm's next write to
    // the closed sink.stdin throws 'error' on rtl.stdout; conversely if aplay
    // exits early (bad PCM args, no audio device) sink.stdin emits 'error'.
    // Without these handlers, the unhandled error tears down Electron's main
    // process. We swallow EPIPE silently because the close path already cleans
    // both processes up via rtl.on('close') / sink.on('close').
    const swallowEpipe = (err) => { if (err && err.code !== 'EPIPE') console.warn('[radio] stream error:', err.message); };
    rtl.stdout.on('error', swallowEpipe);
    sink.stdin.on('error', swallowEpipe);

    let rtlErr = '';
    let sinkErr = '';
    rtl.stderr.on('data', (b) => { rtlErr += b.toString(); });
    sink.stderr.on('data', (b) => { sinkErr += b.toString(); });
    rtl.on('error', reject);
    sink.on('error', (e) => { console.warn('[radio] aplay spawn error:', e.message); });
    rtl.on('close', (code) => {
      if (session && session.rtl === rtl) session = null;
      try { sink.stdin.end(); } catch (_) {}
      if (!rtl.__playbillResolved && code !== 0) {
        reject(new Error(`rtl_fm exited ${code}: ${rtlErr.slice(-400)}`));
      }
    });
    sink.on('close', (code) => {
      try { rtl.kill('SIGTERM'); } catch (_) {}
      // If aplay exits with non-zero AND we never resolved tune(), surface
      // its stderr so the renderer toast tells us why (e.g. "audio open error:
      // No such file or directory" when the PCM device is missing).
      if (!rtl.__playbillResolved && code !== 0) {
        reject(new Error(`aplay exited ${code}: ${sinkErr.slice(-400) || '(no stderr)'}`));
      }
    });

    // rtl_fm starts writing PCM the moment its first sample buffer is full
    // (~100ms). aplay can fail noticeably later — the audio device open call
    // happens AFTER aplay has read its first chunk and parsed the format.
    // So we wait for rtl_fm's first data AND give aplay a 400ms grace period
    // to either prove it's alive (no exit) or fail loudly. Without this gate,
    // tune() resolves successfully, the renderer shows "On air", and the user
    // hears nothing because aplay died right after.
    let resolveTimer = null;
    rtl.stdout.once('data', () => {
      resolveTimer = setTimeout(() => {
        rtl.__playbillResolved = true;
        session = { rtl, sink, band, frequencyHz, gain };
        resolve({ band, frequencyHz, gain });
      }, 400);
    });
    // 5s is enough for FM (~200ms PLL lock) and for AM direct-sampling
    // (~1–2s for the audio-rate buffer to fill).
    const TUNE_DEADLINE_MS = 5000;
    setTimeout(() => {
      if (!rtl.__playbillResolved) {
        if (resolveTimer) { clearTimeout(resolveTimer); resolveTimer = null; }
        try { rtl.kill('SIGKILL'); } catch (_) {}
        reject(new Error(`rtl_fm produced no audio within ${TUNE_DEADLINE_MS}ms: ${rtlErr.slice(-400)}`));
      }
    }, TUNE_DEADLINE_MS);

    // If aplay dies during the 400ms grace, abort the pending resolution so
    // the user sees aplay's actual error instead of a false "On air".
    sink.once('exit', () => {
      if (resolveTimer) { clearTimeout(resolveTimer); resolveTimer = null; }
    });
  }));
}

function buildRtlFmArgs({ band, frequencyHz, gain, modulation }) {
  const args = ['-f', String(frequencyHz)];
  if (gain && gain !== 'auto') args.push('-g', String(gain));

  // Modulation: explicit `modulation` wins; otherwise default per band.
  // Valid: wbfm (broadcast FM), am (broadcast AM and aviation), nbfm
  // (narrow FM — weather, marine, ham, FRS/GMRS, scanner traffic).
  let mod = modulation;
  if (!mod) mod = band === 'fm' ? 'wbfm' : band === 'am' ? 'am' : 'nbfm';

  // R820T-class tuners can't go below ~24 MHz natively. Anything down
  // there has to use direct sampling, regardless of modulation. -E direct2
  // hits the Q branch which is the SMArt v5's HF path (per its datasheet).
  const needsDirectSampling = frequencyHz < 25000000;
  if (needsDirectSampling) args.push('-E', 'direct2');

  if (mod === 'wbfm') {
    // 200 kHz IF, 48 kHz audio out, US 75 µs deemphasis.
    args.push('-M', 'wbfm', '-s', '200000', '-r', '48000', '-E', 'deemp', '-A', 'fast');
  } else if (mod === 'am') {
    // For HF/MW AM use 250 kS/s IF (min legal for the chip). For aviation
    // AM at 118–137 MHz a 12 kHz IF is fine — the tuner does the down-
    // conversion and rtl_fm just demodulates.
    const sIf = needsDirectSampling ? '250000' : '12000';
    args.push('-M', 'am', '-s', sIf, '-r', '12000', '-A', 'fast');
  } else if (mod === 'nbfm') {
    // Narrow FM: 12 kHz IF rate, 12 kHz audio. Used for weather, marine,
    // ham simplex, FRS/GMRS, and most analog scanner traffic.
    args.push('-M', 'nbfm', '-s', '12000', '-r', '12000', '-A', 'fast');
  } else {
    throw new Error(`unknown modulation: ${mod}`);
  }
  args.push('-');  // PCM to stdout
  return args;
}

function buildSinkArgs({ band }) {
  // aplay reading headerless mono S16_LE from stdin. -q silences chatter
  // about underruns that we get when rtl_fm pauses briefly during retune.
  const rate = band === 'fm' ? '48000' : '12000';
  return ['-r', rate, '-f', 'S16_LE', '-c', '1', '-t', 'raw', '-q', '-'];
}

function stop() {
  if (!session) return Promise.resolve();
  const s = session;
  session = null;
  return new Promise((resolve) => {
    s.rtl.once('close', () => resolve());
    try { s.rtl.kill('SIGTERM'); } catch (_) {}
    try { s.sink.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => {
      try { s.rtl.kill('SIGKILL'); } catch (_) {}
      try { s.sink.kill('SIGKILL'); } catch (_) {}
    }, 500);
  });
}

function getState() {
  if (!session) return { running: false };
  return { running: true, band: session.band, frequencyHz: session.frequencyHz, gain: session.gain };
}

function listPresets() {
  if (!fs.existsSync(PRESETS_JSON)) return defaultPresets();
  try { return JSON.parse(fs.readFileSync(PRESETS_JSON, 'utf8')); }
  catch (_) { return defaultPresets(); }
}

function setPresets(arr) {
  ensureDirs();
  fs.writeFileSync(PRESETS_JSON, JSON.stringify(arr, null, 2));
  return arr;
}

function defaultPresets() {
  // Six empty FM slots + four empty AM slots — UI fills these as the user
  // saves stations. No baked-in defaults because broadcasters are regional.
  return [
    { slot: 1, band: 'fm', frequencyHz: null, label: '' },
    { slot: 2, band: 'fm', frequencyHz: null, label: '' },
    { slot: 3, band: 'fm', frequencyHz: null, label: '' },
    { slot: 4, band: 'fm', frequencyHz: null, label: '' },
    { slot: 5, band: 'fm', frequencyHz: null, label: '' },
    { slot: 6, band: 'fm', frequencyHz: null, label: '' },
    { slot: 7, band: 'am', frequencyHz: null, label: '' },
    { slot: 8, band: 'am', frequencyHz: null, label: '' },
    { slot: 9, band: 'am', frequencyHz: null, label: '' },
    { slot: 10, band: 'am', frequencyHz: null, label: '' },
  ];
}

function scan({ band = 'fm' } = {}) {
  // Sweep the band with rtl_power, parse the CSV, and return a list of
  // strong-signal stations snapped to the channel grid. Single-pass, ~6s
  // for FM and ~3s for AM. We stop any active tune first because rtl_power
  // and rtl_fm cannot share the dongle.
  const RANGES = {
    // NA FM allocations are on a 200 kHz grid anchored at 88.1 MHz (odd-tenth
    // channels: 88.1, 88.3, ... 107.9). Snapping a peak to the nearest 200
    // kHz multiple without that anchor produces invalid channels like 97.4 /
    // 97.6 / 97.8 from sidelobe energy of a strong 97.5 station.
    // NA AM allocations are on a 10 kHz grid anchored at 530 kHz (530, 540,
    // 550 ... 1700). 530 happens to be a multiple of 10000 so the anchor
    // here is purely defensive.
    fm: { min: 87500000, max: 108000000, step: 200000, channelStep: 200000, anchor: 88100000 },
    am: { min: 530000,   max: 1700000,   step: 10000,  channelStep: 10000,  anchor: 530000   },
  };
  const r = RANGES[band];
  if (!r) return Promise.reject(new Error(`unknown band: ${band}`));

  return stop()
    // libusb's release-then-reclaim takes a few hundred ms after rtl_fm exits;
    // launching rtl_power immediately races against that and the new process
    // gets `usb_claim_interface error -6 (LIBUSB_ERROR_BUSY)`, leaving the IPC
    // handler with a confusing "Failed to open rtlsdr device" reject. A short
    // settle wait avoids the race entirely.
    .then(() => new Promise((res) => setTimeout(res, 400)))
    .then(() => new Promise((resolve, reject) => {
      const args = [
        '-f', `${r.min}:${r.max}:${r.step}`,
        '-i', '3',                  // 3-second integration
        '-1',                       // single pass and exit
      ];
      if (band === 'am') {
        // R820T-class dongles need direct sampling for sub-24 MHz reception.
        // NOTE: rtl_power and rtl_fm use DIFFERENT flags for the same feature.
        //   rtl_fm:    `-E direct2`  (-E takes a string: direct, direct2, ...)
        //   rtl_power: `-D` bare flag (no arg; rtl_power chokes on `-E` with
        //              "invalid option -- 'E'" and exits 1, no CSV)
        // rtl_power's -D toggles I-branch direct sampling, which is enough
        // for the SMArt v5 to produce a usable MW spectrum here.
        args.unshift('-D');
      }
      let csv = '';
      let err = '';
      const proc = spawn('rtl_power', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stdout.on('data', (b) => { csv += b.toString(); });
      proc.stderr.on('data', (b) => { err += b.toString(); });
      proc.on('error', (e) => reject(new Error(`rtl_power spawn failed: ${e.message}`)));
      proc.on('close', (code, signal) => {
        // rtl_power with -1 self-terminates after one pass and prints "User
        // cancel, exiting..." even on success — don't treat that as failure.
        // What we actually care about is whether we collected CSV data.
        if (csv.trim().length === 0) {
          const tail = err.slice(-400) || `(exit ${code}, signal ${signal})`;
          // rtl_power prints "No supported devices found." to stderr and exits
          // when no RTL-SDR dongle is plugged in. Surface that as a friendly
          // message instead of the raw stderr tail.
          if (/No supported devices found/i.test(err)) {
            return reject(new Error(`Check ${band.toUpperCase()} tuner connection — USB radio dongle not detected`));
          }
          if (/usb_claim_interface|Failed to open rtlsdr/i.test(err)) {
            return reject(new Error(`scan: dongle busy — try again in a moment (${tail})`));
          }
          return reject(new Error(`scan: rtl_power produced no data: ${tail}`));
        }
        try {
          resolve(parseStations(csv, r));
        } catch (e) {
          reject(new Error(`scan: parse failed: ${e.message}`));
        }
      });
      // Cap scan time so a stuck dongle doesn't hang the IPC handler.
      setTimeout(() => { try { proc.kill('SIGTERM'); } catch (_) {} }, 30000);
    }));
}

function parseStations(csv, range) {
  // rtl_power CSV: date, time, Hz_low, Hz_high, Hz_step, samples, dB[0..N-1]
  // Multiple lines if the band exceeds one window of the dongle's sample
  // rate (FM band 20.5 MHz > ~2.4 MHz max, so 9+ windows). We flatten all
  // lines into one (freq → dB) map first.
  const bins = []; // { hz, db }
  for (const raw of csv.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 7) continue;
    const fLo   = Number(parts[2]);
    const fStep = Number(parts[4]);
    const dbs   = parts.slice(6).map(Number);
    for (let i = 0; i < dbs.length; i++) {
      const db = dbs[i];
      if (!Number.isFinite(db)) continue;
      bins.push({ hz: Math.round(fLo + i * fStep), db });
    }
  }
  if (bins.length === 0) return [];

  // Sanity check: a band with <4 dB total dynamic range across all bins is
  // not "weak reception", it's "no RF coupling at all" — for MW/HF this
  // means the antenna isn't capable of capturing the band (e.g. a 30 cm
  // telescopic whip on the 530–1700 kHz MW band, where one wavelength is
  // ~300 m). Surface this as a clear error so the renderer can tell the
  // user it's an antenna problem, not "no stations in your area."
  // Reference values measured on this device:
  //   FM 87.5–108 MHz (FM whip working):  ~26 dB range
  //   SW 5.8–15.8 MHz (FM whip, no HF):   ~6 dB range
  //   AM 530–1700 kHz (FM whip, no HF):   ~2 dB range
  const dbs = bins.map((b) => b.db);
  const minDb = Math.min(...dbs);
  const maxDb = Math.max(...dbs);
  const dynamicRange = maxDb - minDb;
  if (dynamicRange < 4) {
    // Engineering reasons we surface as a friendly message:
    //   (1) The included telescopic whip is for VHF/UHF — at AM band
    //       wavelengths (300 m at 1 MHz) a 30 cm whip catches ~no RF.
    //   (2) Even with a proper HF antenna, rtl_power's AM scan path is on
    //       the wrong ADC branch for the SMArt v5 (it sends HF to the Q
    //       branch; rtl_power -D forces I).
    // Either way the user fixes it the same way: get an upconverter.
    throw new Error(
      `AM reception isn't working with the included antenna. ` +
      `The Nooelec SMArt v5 needs a Ham It Up upconverter (or a long-wire HF antenna) to pick up AM stations — ` +
      `the antenna that came with it is for FM and VHF only.`
    );
  }

  // Median-based noise floor; threshold 6 dB above is a useful "this is a
  // station" cutoff for both FM and MW with a working antenna.
  const sorted = [...dbs].sort((a, b) => a - b);
  const noise = sorted[Math.floor(sorted.length / 2)];
  const threshold = noise + 6;

  // Walk the actual channel grid (anchored), and for each valid slot take the
  // max bin energy within ±channelStep/2. This avoids snapping sidelobes from
  // a strong station onto adjacent invalid channels (the previous round-to-
  // multiple approach reported 97.4 / 97.6 / 97.8 as separate "stations" when
  // the real signal was a single 97.5 broadcast bleeding into adjacent bins).
  const half = range.channelStep / 2;
  const stations = [];
  for (let f = range.anchor; f <= range.max; f += range.channelStep) {
    if (f < range.min) continue;
    let bestDb = -Infinity;
    for (const { hz, db } of bins) {
      if (Math.abs(hz - f) <= half && db > bestDb) bestDb = db;
    }
    if (bestDb >= threshold && bestDb > -Infinity) {
      stations.push({ frequencyHz: f, signalDb: Math.round(bestDb * 10) / 10 });
    }
  }
  return stations;
}

function probeTools() {
  return new Promise((resolve) => {
    execFile('which', ['rtl_fm', 'rtl_test', 'aplay'], (err, stdout) => {
      const lines = (stdout || '').trim().split('\n').filter(Boolean);
      resolve({
        rtl_fm:   lines.some(l => l.endsWith('rtl_fm')),
        rtl_test: lines.some(l => l.endsWith('rtl_test')),
        aplay:    lines.some(l => l.endsWith('aplay')),
      });
    });
  });
}

function lookupScanner({ zip } = {}) {
  // Resolve a US ZIP to a curated list of nationwide + regional frequencies.
  // Pure offline — no network calls. Always returns the universal list at
  // minimum; ZIP3 known to our seed map adds the place name; future REGIONAL
  // entries will add airport towers, NOAA NWR coverage maps, etc.
  const z = String(zip || '').trim();
  if (!/^\d{5}$/.test(z)) {
    return Promise.reject(new Error('Please enter a 5-digit US ZIP code.'));
  }
  const loc = scannerData.lookupZip(z) || scannerData.USA_CENTER;
  // Three sources merge into one list:
  //   1. UNIVERSAL — nationwide static (NOAA Weather, aviation, marine, ham,
  //      FRS/GMRS).
  //   2. REGIONAL  — future region-specific extras.
  //   3. PUBSAFETY — FCC ULS-derived per-ZIP3 analog police/fire/EMS that
  //      ship in pubsafety-by-zip3.json.gz.
  const universal = scannerData.stationsForLocation(loc);
  const pubsafety = scannerData.pubsafetyForZip(z);
  const stations  = [...universal, ...pubsafety].map((s) => ({
    frequencyHz: s.hz,
    modulation:  s.mod,
    label:       s.label,
    category:    s.cat,
  }));
  return Promise.resolve({
    zip: z,
    place: loc.place,
    lat: loc.lat,
    lon: loc.lon,
    stations,
  });
}

module.exports = {
  listAdapters,
  tune,
  stop,
  getState,
  scan,
  lookupScanner,
  listPresets,
  setPresets,
  probeTools,
};
