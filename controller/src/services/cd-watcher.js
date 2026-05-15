/* Audio-CD watcher — detects audio Compact Disc insertion / removal.

   Lives alongside dvd-watcher (which probes for filesystem-bearing discs:
   DVD-Video, data DVDs, etc). Audio CDs have NO filesystem visible via
   lsblk — they're a sequence of Red Book CDDA tracks, not a file tree —
   so the dvd-watcher's `if (!fstype) return null` already filters them
   out. This watcher fills that gap by probing /dev/sr0 with `cd-info`
   (libcdio) and only firing 'inserted' when an audio CD is actually
   present.

   We emit:
     'inserted' { device, discid, ntracks, lengthSec, trackOffsetsLba }
     'removed'  { device }

   `discid` is the FreeDB/MusicBrainz disc identifier — a hash derived
   from the table-of-contents (track count + per-track LBA offsets +
   total length). It's the same key MusicBrainz uses to look up a CD,
   so we generate it once here and reuse it for metadata lookup. */

'use strict';

const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const DEFAULT_DEVICE = '/dev/sr0';
const POLL_INTERVAL_MS = 3000;

/**
 * Probe /dev/sr0 for an audio CD. Returns null if no disc, no audio
 * tracks, or the tool isn't installed. Returns { discid, ntracks,
 * trackOffsetsLba, lengthSec } on a hit.
 *
 * cd-discid output format:
 *   <discid> <ntracks> <track1_lba> <track2_lba> ... <leadout_sec>
 *
 * Example for a 12-track album:
 *   a30c7b0c 12 150 25435 49832 ... 257820 3439
 *
 * The last field is the disc length in SECONDS (not LBA). Everything
 * before that is a track-start LBA offset.
 */
function cdDiscidProbe(device) {
  return new Promise((resolve) => {
    execFile('cd-discid', [device], { timeout: 8000 }, (err, stdout) => {
      // cd-discid exits non-zero when the drive is empty or holds a
      // non-audio disc. That's "not an audio CD," not an error.
      if (err) { resolve(null); return; }
      const line = (stdout || '').trim();
      if (!line) { resolve(null); return; }
      const tokens = line.split(/\s+/);
      // Minimum sensible output: discid + ntracks + 1 track + leadout = 4 tokens
      if (tokens.length < 4) { resolve(null); return; }
      const discid = tokens[0];
      const ntracks = parseInt(tokens[1], 10);
      if (!ntracks || ntracks < 1) { resolve(null); return; }
      const trackOffsetsLba = tokens.slice(2, 2 + ntracks).map((t) => parseInt(t, 10));
      const lengthSec = parseInt(tokens[2 + ntracks], 10);
      if (!Number.isFinite(lengthSec)) { resolve(null); return; }
      resolve({ discid, ntracks, trackOffsetsLba, lengthSec });
    });
  });
}

class CdWatcher extends EventEmitter {
  constructor({ device = DEFAULT_DEVICE, intervalMs = POLL_INTERVAL_MS } = {}) {
    super();
    this._device   = device;
    this._interval = intervalMs;
    this._timer    = null;
    this._lastDiscid = null;
    this._present  = false;
  }

  getStatus() {
    return { device: this._device, present: this._present, discid: this._lastDiscid };
  }

  async probeOnce() {
    const info = await cdDiscidProbe(this._device);
    if (info) {
      if (!this._present || info.discid !== this._lastDiscid) {
        this._present = true;
        this._lastDiscid = info.discid;
        this.emit('inserted', { device: this._device, ...info });
      }
    } else if (this._present) {
      this._present = false;
      this._lastDiscid = null;
      this.emit('removed', { device: this._device });
    }
  }

  start() {
    if (this._timer) return;
    // Initial probe seeds state without emitting — a disc already loaded
    // at daemon start shouldn't re-prompt every restart.
    cdDiscidProbe(this._device).then((info) => {
      if (info) {
        this._present = true;
        this._lastDiscid = info.discid;
      }
    }).catch(() => {});
    this._timer = setInterval(() => {
      this.probeOnce().catch((e) => console.warn('[cd-watcher] probe failed:', e.message));
    }, this._interval);
    this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

module.exports = CdWatcher;
module.exports.DEFAULT_DEVICE = DEFAULT_DEVICE;
