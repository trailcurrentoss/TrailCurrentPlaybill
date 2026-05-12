/* DVD watcher — detects optical disc insertion / removal.

   Polls `lsblk -no LABEL,FSTYPE,TYPE /dev/sr0` every few seconds. A poll
   is cheap (microseconds) and works without udev/UDisks2 dependencies,
   which keeps the controller a single-process Node daemon with no
   privileged D-Bus access. The poll period (3s) is short enough that a
   user inserting a disc sees the notification appear in a few seconds —
   the bottleneck for a DVD becoming readable is the drive's spin-up,
   not our detection interval.

   We emit two events:
     'inserted' { device, label, fstype }   disc just appeared
     'removed'  { device }                  tray emptied (or ejected)

   `label` may be the empty string for unlabelled discs (rare; commercial
   DVDs almost always set ISO-9660 volume ID). FSTYPE is typically
   'iso9660' (DVD-Video), 'udf' (DVD-Video / data DVD), or 'auto' on a
   blank disc — anything truthy means a readable medium is present. */

'use strict';

const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const DEFAULT_DEVICE = '/dev/sr0';
const POLL_INTERVAL_MS = 3000;

function lsblkProbe(device) {
  return new Promise((resolve) => {
    execFile('lsblk', ['-no', 'LABEL,FSTYPE', device], { timeout: 4000 }, (err, stdout) => {
      // lsblk returns non-zero when the device file doesn't exist (no drive
      // attached). That's "no disc present", not an error worth surfacing.
      if (err) { resolve(null); return; }
      const line = (stdout || '').trim();
      if (!line) { resolve(null); return; }
      // Output is "LABEL FSTYPE" with multiple spaces. Splitting on /\s+/
      // and grabbing the LAST token gives us FSTYPE robustly even when
      // the label contains spaces (rare on DVDs but possible).
      const tokens = line.split(/\s+/);
      const fstype = tokens.length >= 2 ? tokens[tokens.length - 1] : '';
      const label  = tokens.length >= 2 ? tokens.slice(0, -1).join(' ') : line;
      if (!fstype) { resolve(null); return; }
      resolve({ label, fstype });
    });
  });
}

class DvdWatcher extends EventEmitter {
  constructor({ device = DEFAULT_DEVICE, intervalMs = POLL_INTERVAL_MS } = {}) {
    super();
    this._device   = device;
    this._interval = intervalMs;
    this._timer    = null;
    this._lastKey  = null;     // 'label\0fstype' so a re-insert of the same disc
                               // doesn't fire twice but a disc swap does.
    this._present  = false;
  }

  /** Latest probed status. Cheap; reads cached field. */
  getStatus() {
    return { device: this._device, present: this._present, key: this._lastKey };
  }

  /** Force a probe right now (e.g., immediately after start). */
  async probeOnce() {
    const info = await lsblkProbe(this._device);
    if (info) {
      const key = `${info.label || ''}\0${info.fstype}`;
      if (!this._present || key !== this._lastKey) {
        this._present = true;
        this._lastKey = key;
        this.emit('inserted', { device: this._device, label: info.label || '', fstype: info.fstype });
      }
    } else if (this._present) {
      this._present = false;
      this._lastKey = null;
      this.emit('removed', { device: this._device });
    }
  }

  start() {
    if (this._timer) return;
    // Initial probe — don't fire on first tick for a disc that was already
    // in the drive before the daemon started; that would re-prompt every
    // time the controller restarts. Set `_present` from the first probe
    // without emitting.
    lsblkProbe(this._device).then((info) => {
      if (info) {
        this._present = true;
        this._lastKey = `${info.label || ''}\0${info.fstype}`;
      }
    }).catch(() => {});
    this._timer = setInterval(() => {
      this.probeOnce().catch((e) => console.warn('[dvd-watcher] probe failed:', e.message));
    }, this._interval);
    this._timer.unref();   // don't pin the event loop
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

module.exports = DvdWatcher;
module.exports.DEFAULT_DEVICE = DEFAULT_DEVICE;
