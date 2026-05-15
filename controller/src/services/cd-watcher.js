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
// Wait at least this long with stable "cd-discid succeeds + lsblk empty"
// before firing the audio-CD prompt. DVD drives can take 6+ seconds to
// expose a filesystem header via lsblk, while cd-discid happily returns
// a TOC immediately on some discs. The stability window suppresses the
// "CD modal flashes for a few seconds before DVD modal appears" race.
const PENDING_STABLE_MS = 8000;

/**
 * Quick check: does the disc have a filesystem? Pure audio CDs have NO
 * filesystem and lsblk reports an empty FSTYPE. DVDs/Blu-rays expose
 * `udf` or `iso9660`. Hybrid Enhanced CDs (audio tracks + a data
 * session) ALSO expose a filesystem — we treat those as "not a pure
 * audio CD" so the DVD-watcher's prompt wins. Without this gate,
 * cd-discid happily returns a TOC for hybrids and DVDs whose firmware
 * exposes an audio TOC, and the user sees BOTH the DVD modal AND the
 * audio-CD modal stacked on the same disc (regression caught 2026-05-15).
 */
function hasFilesystemProbe(device) {
  return new Promise((resolve) => {
    execFile('lsblk', ['-no', 'FSTYPE', device], { timeout: 4000 }, (err, stdout) => {
      if (err) { resolve(false); return; }
      const fstype = (stdout || '').trim();
      resolve(fstype.length > 0);
    });
  });
}

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
    // Pending audio-CD detection — used to suppress the race where the
    // drive's TOC is readable BEFORE its filesystem header is. On first
    // sighting we stash the discid and wait one poll cycle. Only on the
    // SECOND consecutive "cd-discid succeeds + lsblk shows no FSTYPE"
    // observation do we fire the 'inserted' event. That gives the DVD-
    // watcher's lsblk probe time to read the filesystem header on a
    // spin-up that initially returned empty.
    this._pendingInfo = null;
  }

  getStatus() {
    return { device: this._device, present: this._present, discid: this._lastDiscid };
  }

  async probeOnce() {
    // First gate: pure audio CDs have NO filesystem. If lsblk reports
    // any fstype, this is a DVD / Blu-ray / hybrid Enhanced CD — defer
    // to the DVD-watcher and DO NOT fire the audio-CD prompt.
    const hasFs = await hasFilesystemProbe(this._device);
    if (hasFs) {
      this._pendingInfo = null;        // suppress any pending audio-CD detection
      if (this._present) {
        this._present = false;
        this._lastDiscid = null;
        this.emit('removed', { device: this._device });
      }
      return;
    }
    const info = await cdDiscidProbe(this._device);
    if (!info) {
      this._pendingInfo = null;
      if (this._present) {
        this._present = false;
        this._lastDiscid = null;
        this.emit('removed', { device: this._device });
      }
      return;
    }
    // Already firing for this disc — don't re-emit.
    if (this._present && info.discid === this._lastDiscid) return;

    // Stability window: require the same disc to keep showing "no
    // filesystem + valid TOC" for at least PENDING_STABLE_MS before firing.
    // The 3-second poll interval alone wasn't enough — some DVD drives
    // take 6+ seconds to spin up far enough for lsblk to read the
    // filesystem header, and during that window cd-discid is already
    // happily returning a TOC. The timestamp gate forces us to wait
    // long enough for lsblk to catch up. The trade-off is that a
    // genuine pure audio CD takes a couple poll cycles to surface;
    // acceptable for the use case (user inserts disc, waits).
    if (!this._pendingInfo || this._pendingInfo.discid !== info.discid) {
      this._pendingInfo = { ...info, firstSeenAt: Date.now() };
      return;
    }
    if (Date.now() - this._pendingInfo.firstSeenAt < PENDING_STABLE_MS) {
      // Still in the stability window — keep waiting. Another probe of
      // hasFs at the top of the next probeOnce() may yet clear this.
      return;
    }

    // Stable + still no filesystem — fire.
    this._present = true;
    this._lastDiscid = info.discid;
    this._pendingInfo = null;
    this.emit('inserted', { device: this._device, ...info });
  }

  start() {
    if (this._timer) return;
    // Initial probe seeds state without emitting — a disc already loaded
    // at daemon start shouldn't re-prompt every restart. Same filesystem
    // gate as probeOnce: never seed if lsblk shows a filesystem (would
    // mean a DVD/Blu-ray is loaded, not a pure audio CD).
    hasFilesystemProbe(this._device).then((hasFs) => {
      if (hasFs) return;
      return cdDiscidProbe(this._device).then((info) => {
        if (info) {
          this._present = true;
          this._lastDiscid = info.discid;
        }
      });
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
