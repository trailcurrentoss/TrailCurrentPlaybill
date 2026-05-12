/* DVD ripper — wraps HandBrakeCLI to extract the main feature off an
   optical disc into MKV with H.264 + AC3 passthrough. Emits 'progress'
   events as the rip walks through the disc so the GUI can show a
   percentage and ETA without polling.

   Why HandBrakeCLI over `dd` / `vobcopy` / `mkvtoolnix`:
     • produces a single, immediately-playable .mkv (the library viewer is
       mpv-backed; no re-mux step needed)
     • can re-encode oversize titles in one pass (DVDs are PAL/NTSC MPEG-2
       and the rest of our library is H.264 — keeping format consistent
       avoids playback codec surprises)
     • handles libdvdcss copy-protection transparently when libdvdcss2 is
       installed (most distros)
     • progress is emitted on stdout as "Encoding: task 1 of 1, X.XX %"
       lines so we can parse without a JSON layer

   The exact preset is "Fast 1080p30" — that's intentional:
     • DVD sources are 480p so "1080p" is the upper bound, not a target.
       HB will keep the source res when the source is smaller.
     • The Fast preset is x264 veryfast equivalent, finishes a ~2h movie
       in ~30min on a modern x86 box. That's a good "kick it off and go
       watch something else" experience.

   Output:  ~/Videos/Playbill Library/Movies/<Title (Year)>/<Title (Year)>.mkv
            ~/Videos/Playbill Library/Shows/<Show>/<Show> - S00E00.mkv
   Sidecar: <basename>.json containing the metadata payload the GUI
            collected (title, year, poster, plot, ...). The LocalView's
            library scanner reads sidecars for poster/year/etc. */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const LIBRARY_ROOT = path.join(os.homedir(), 'Videos', 'Playbill Library');
const HANDBRAKE_BIN = 'HandBrakeCLI';     // resolved via PATH

// Strip filesystem-hostile characters but keep spaces and Unicode letters
// readable. Used for the on-disk folder/file name.
function safeName(s) {
  return String(s || 'Untitled')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function libraryPathFor(metadata) {
  const kind = metadata.kind === 'show' ? 'Shows' : 'Movies';
  const titleYear = metadata.year
    ? `${safeName(metadata.title)} (${metadata.year})`
    : safeName(metadata.title);
  if (metadata.kind === 'show') {
    const show = safeName(metadata.show || metadata.title);
    const s = String(metadata.season || 1).padStart(2, '0');
    const e = String(metadata.episode || 1).padStart(2, '0');
    const base = `${show} - S${s}E${e}`;
    return {
      dir:  path.join(LIBRARY_ROOT, kind, show),
      file: path.join(LIBRARY_ROOT, kind, show, base + '.mkv'),
      json: path.join(LIBRARY_ROOT, kind, show, base + '.json'),
      base,
    };
  }
  return {
    dir:  path.join(LIBRARY_ROOT, kind, titleYear),
    file: path.join(LIBRARY_ROOT, kind, titleYear, titleYear + '.mkv'),
    json: path.join(LIBRARY_ROOT, kind, titleYear, titleYear + '.json'),
    base: titleYear,
  };
}

/** Best-effort: returns true iff the HandBrakeCLI binary is on PATH. */
function probeHandbrake() {
  return new Promise((resolve) => {
    execFile('which', [HANDBRAKE_BIN], (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

class DvdRipper extends EventEmitter {
  constructor() {
    super();
    this._proc = null;
    this._currentTarget = null;     // resolved library paths for the in-flight rip
    this._currentMetadata = null;
    this._lastProgress = null;
  }

  isRipping() { return !!this._proc; }
  getProgress() { return this._lastProgress; }
  getCurrent() { return this._currentMetadata; }

  /**
   * Begin a rip. Throws if a rip is already in progress.
   *
   * @param {object} opts
   * @param {string} opts.device   /dev/sr0
   * @param {object} opts.metadata Title/year/kind/etc. See libraryPathFor.
   * @returns {Promise<{path:string}>} resolves when HandBrake exits 0.
   */
  start({ device, metadata }) {
    if (this._proc) throw new Error('rip already in progress');
    if (!metadata || !metadata.title) throw new Error('metadata.title required');

    const target = libraryPathFor(metadata);
    fs.mkdirSync(target.dir, { recursive: true });

    // Sidecar first — even if the rip is interrupted, the metadata we
    // already collected is preserved alongside whatever partial .mkv
    // HandBrake leaves behind. The library scanner ignores .mkv files
    // without a sidecar, so a half-written file won't appear as a broken
    // entry.
    const sidecar = {
      ...metadata,
      rippedFromDevice: device,
      rippedAt: new Date().toISOString(),
      file: path.basename(target.file),
    };
    fs.writeFileSync(target.json, JSON.stringify(sidecar, null, 2));

    // HandBrake args:
    //   -i <device>            source
    //   -o <out>               target file
    //   --preset "Fast 1080p30"  H.264 Fast, keeps DVD's 480p
    //   --main-feature         pick the longest title automatically
    //   -m                     embed chapter markers
    //   -E copy --audio-copy-mask ac3,eac3,aac,mp3
    //                          passthrough common audio codecs; falls
    //                          back to AAC encode if the source is DTS.
    //   --subtitle scan,1      include first subtitle track + forced subs
    const args = [
      '-i', device,
      '-o', target.file,
      '--preset', 'Fast 1080p30',
      '--main-feature',
      '-m',
      '-E', 'copy',
      '--audio-copy-mask', 'ac3,eac3,aac,mp3',
      '--audio-fallback', 'aac',
      '--subtitle', 'scan,1',
    ];

    this._currentTarget = target;
    this._currentMetadata = metadata;
    this._lastProgress = { percent: 0, etaSec: null, currentTitle: metadata.title };

    return new Promise((resolve, reject) => {
      const child = spawn(HANDBRAKE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this._proc = child;

      let stderrTail = '';
      let stdoutBuf = '';

      // Progress format from HandBrake (varies by version, but the common
      // shape is):
      //   Encoding: task 1 of 1, 12.34 %
      //   Encoding: task 1 of 1, 47.23 % (84.95 fps, avg 86.10 fps, ETA 00h12m34s)
      // We pull percent + ETA out and emit a 'progress' event. Throttle
      // emits to once per second to avoid swamping subscribers.
      let lastEmit = 0;
      const PERCENT_RE = /(\d+(?:\.\d+)?)\s*%/;
      const ETA_RE     = /ETA\s+(\d+)h(\d+)m(\d+)s/;
      const handleChunk = (buf) => {
        stdoutBuf += buf.toString('utf8');
        const lines = stdoutBuf.split(/[\r\n]/);
        stdoutBuf = lines.pop() || '';
        for (const ln of lines) {
          if (!ln.includes('Encoding:')) continue;
          const pm = ln.match(PERCENT_RE);
          if (!pm) continue;
          const percent = parseFloat(pm[1]);
          const em = ln.match(ETA_RE);
          const etaSec = em ? (parseInt(em[1],10)*3600 + parseInt(em[2],10)*60 + parseInt(em[3],10)) : null;
          const progress = { percent, etaSec, currentTitle: metadata.title };
          this._lastProgress = progress;
          const now = Date.now();
          if (now - lastEmit >= 1000) {
            lastEmit = now;
            this.emit('progress', progress);
          }
        }
      };
      child.stdout.on('data', handleChunk);
      child.stderr.on('data', (chunk) => {
        // Keep just the last ~4 KB of stderr so failures show a useful tail.
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096);
      });

      child.on('error', (e) => {
        this._proc = null;
        this._currentTarget = null;
        this._currentMetadata = null;
        this._lastProgress = null;
        reject(new Error(`HandBrakeCLI spawn failed: ${e.message}`));
      });

      child.on('exit', (code, signal) => {
        const finishedTarget = this._currentTarget;
        this._proc = null;
        this._currentTarget = null;
        this._currentMetadata = null;
        // Final progress = 100% on success, then null so the GUI clears
        // its progress bar.
        if (code === 0) {
          this._lastProgress = { percent: 100, etaSec: 0, currentTitle: metadata.title };
          this.emit('progress', this._lastProgress);
          this.emit('finished', { path: finishedTarget.file, metadata, sidecar: finishedTarget.json });
          this._lastProgress = null;
          resolve({ path: finishedTarget.file, sidecar: finishedTarget.json });
        } else {
          this._lastProgress = null;
          // If we were SIGTERM-ed, surface that as a cancellation rather
          // than a HandBrake fault — different UX in the GUI.
          if (signal === 'SIGTERM' || signal === 'SIGINT') {
            this.emit('cancelled', { metadata });
            reject(new Error('rip cancelled'));
          } else {
            this.emit('failed', { metadata, code, stderr: stderrTail });
            reject(new Error(`HandBrakeCLI exited ${code}: ${stderrTail.split('\n').slice(-3).join(' | ')}`));
          }
        }
      });
    });
  }

  /** Stop the in-flight rip. Returns false if nothing was running. */
  cancel() {
    if (!this._proc) return false;
    try { this._proc.kill('SIGTERM'); } catch (_) {}
    return true;
  }
}

const singleton = new DvdRipper();
module.exports = singleton;
module.exports.LIBRARY_ROOT = LIBRARY_ROOT;
module.exports.libraryPathFor = libraryPathFor;
module.exports.probeHandbrake = probeHandbrake;
module.exports.safeName = safeName;
