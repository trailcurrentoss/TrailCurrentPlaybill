/* AM/FM radio service — driven by an RTL-SDR USB dongle (RTL2832U + R820T2
   for FM, R828D for AM/HF on the V4). Demodulation happens in software via
   `rtl_fm`; demodulated PCM is piped into PipeWire via `pw-cat`.

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
const { PRESETS_JSON, ensureDirs } = require('./paths');

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

function tune({ band = 'fm', frequencyHz, gain = 'auto' } = {}) {
  if (!frequencyHz) return Promise.reject(new Error('frequencyHz required'));
  return stop().then(() => new Promise((resolve, reject) => {
    const args = buildRtlFmArgs({ band, frequencyHz, gain });
    const rtl = spawn('rtl_fm', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // Pipe rtl_fm's raw PCM into PipeWire. pw-cat treats stdin as raw.
    const sinkArgs = buildSinkArgs({ band });
    const sink = spawn('pw-cat', sinkArgs, { stdio: ['pipe', 'inherit', 'pipe'] });

    rtl.stdout.pipe(sink.stdin);

    let rtlErr = '';
    rtl.stderr.on('data', (b) => { rtlErr += b.toString(); });
    rtl.on('error', reject);
    rtl.on('close', (code) => {
      if (session && session.rtl === rtl) session = null;
      try { sink.stdin.end(); } catch (_) {}
      if (!rtl.__playbillResolved && code !== 0) {
        reject(new Error(`rtl_fm exited ${code}: ${rtlErr.slice(-400)}`));
      }
    });
    sink.on('close', () => { try { rtl.kill('SIGTERM'); } catch (_) {} });

    // rtl_fm prints "Tuned to ..." within ~100ms; resolve once we see PCM
    // flowing rather than parsing stderr.
    rtl.stdout.once('data', () => {
      rtl.__playbillResolved = true;
      session = { rtl, sink, band, frequencyHz, gain };
      resolve({ band, frequencyHz, gain });
    });
    // 5s is enough for FM (~200ms PLL lock) and for AM direct-sampling
    // (~1–2s for the audio-rate buffer to fill).
    const TUNE_DEADLINE_MS = 5000;
    setTimeout(() => {
      if (!rtl.__playbillResolved) {
        try { rtl.kill('SIGKILL'); } catch (_) {}
        reject(new Error(`rtl_fm produced no audio within ${TUNE_DEADLINE_MS}ms: ${rtlErr.slice(-400)}`));
      }
    }, TUNE_DEADLINE_MS);
  }));
}

function buildRtlFmArgs({ band, frequencyHz, gain }) {
  const args = ['-f', String(frequencyHz)];
  if (gain && gain !== 'auto') args.push('-g', String(gain));
  if (band === 'fm') {
    // Wide-FM, 200 kHz sample rate, 48 kHz audio with US 75µs deemphasis.
    args.push('-M', 'wbfm', '-s', '200000', '-r', '48000', '-E', 'deemp', '-A', 'fast');
  } else if (band === 'am') {
    // AM mode, 12 kHz audio. R820T/R820T2/R828D tuners cannot tune below
    // ~24 MHz natively, so the medium-wave AM band (530–1700 kHz) is only
    // reachable via direct sampling on the I/Q ADC. `-E direct2` selects
    // the Q-branch direct-sampling path, which works for ALL R820-class
    // dongles (NESDR SMArt, V3, V4 — V4 also accepts direct1 in hardware
    // but direct2 is universally supported and harmless on V4).
    args.push('-M', 'am', '-s', '12000', '-r', '12000', '-E', 'direct2', '-A', 'fast');
  } else {
    throw new Error(`unknown band: ${band}`);
  }
  args.push('-');  // PCM to stdout
  return args;
}

function buildSinkArgs({ band }) {
  // pw-cat -p (play) reading raw S16_LE from stdin.
  const rate = band === 'fm' ? '48000' : '12000';
  return ['-p', '--format=s16', '--rate', rate, '--channels=1', '--raw', '-'];
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

function probeTools() {
  return new Promise((resolve) => {
    execFile('which', ['rtl_fm', 'rtl_test', 'pw-cat'], (err, stdout) => {
      const lines = (stdout || '').trim().split('\n').filter(Boolean);
      resolve({
        rtl_fm:   lines.some(l => l.endsWith('rtl_fm')),
        rtl_test: lines.some(l => l.endsWith('rtl_test')),
        pw_cat:   lines.some(l => l.endsWith('pw-cat')),
      });
    });
  });
}

module.exports = {
  listAdapters,
  tune,
  stop,
  getState,
  listPresets,
  setPresets,
  probeTools,
};
