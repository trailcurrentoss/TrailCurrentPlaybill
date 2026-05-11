/* System audio volume + mute — wraps WirePlumber's wpctl against the
   default PipeWire sink. System-wide, not per-source: a single Volume Up
   button on a steering-wheel MCU should affect whatever's playing,
   regardless of whether that's mpv on YouTube, rtl_fm on the radio, or
   GNOME's notification chime.

   Per-source volume layered on top is a future addition (the source
   plugin would expose its own volume control if needed); for now, all
   transport.volume* / transport.mute* commands go to the system sink.

   wpctl is the modern PipeWire CLI; it ships with WirePlumber (already
   installed on the Q6A image). pactl would also work but wpctl is more
   precise about which sink "default" means and tracks PipeWire node
   reassignments cleanly. */

'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const SINK = '@DEFAULT_AUDIO_SINK@';

/**
 * Probe the current sink's volume + mute state.
 * @returns {Promise<{volumePct: number, muted: boolean}>}
 *   volumePct is 0–100 (rounded; wpctl reports 0.0–1.0+).
 */
async function getState() {
  const { stdout } = await execFileP('wpctl', ['get-volume', SINK]);
  const m = stdout.match(/Volume:\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!m) throw new Error(`wpctl get-volume: unparseable output: ${stdout.trim()}`);
  return {
    volumePct: Math.round(parseFloat(m[1]) * 100),
    muted:     /\[MUTED\]/.test(stdout),
  };
}

/**
 * Set absolute volume (clamped 0–100).
 */
async function setVolume(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  await execFileP('wpctl', ['set-volume', SINK, `${clamped}%`]);
  return getState();
}

/**
 * Adjust volume by a signed step in percent. Uses wpctl's relative syntax
 * (`<n>%+` and `<n>%-`) so the kernel doesn't see a get-then-set race
 * with whatever else might be moving the slider.
 */
async function adjustVolume(deltaPct) {
  const sign = deltaPct >= 0 ? '+' : '-';
  const mag  = Math.abs(deltaPct);
  await execFileP('wpctl', ['set-volume', SINK, `${mag}%${sign}`]);
  return getState();
}

async function setMute(muted) {
  await execFileP('wpctl', ['set-mute', SINK, muted ? '1' : '0']);
  return getState();
}

async function toggleMute() {
  await execFileP('wpctl', ['set-mute', SINK, 'toggle']);
  return getState();
}

function probeTools() {
  return new Promise((resolve) => {
    execFile('which', ['wpctl'], (err, stdout) => {
      resolve({ wpctl: !!(stdout || '').trim() });
    });
  });
}

module.exports = { getState, setVolume, adjustVolume, setMute, toggleMute, probeTools };
