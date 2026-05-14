/* Cross-source loudness balancing.

   Different sources arrive at wildly different reference levels:
   - FM broadcast is heavily compressed and mastered hot (loudness war)
   - DVD/Blu-ray (Library) is mixed to broadcast spec (~-23 LUFS)
   - YouTube normalizes to ~-14 LUFS but only when the uploader didn't beat it
   - AirPlay arrives at whatever level the iPhone sender chose
   - AM via rtl_fm is genuinely low-level (12 kHz mono PCM, no AGC tail)

   Switching between these one after another is jarring at constant system
   volume. Two knobs fix it:

     1. **Per-source trim (dB)** — a small calibrated offset applied at the
        source's player pipeline. Negative = quieter. Stored in settings so
        the user can fine-tune.

     2. **Real-time normalization** — for mpv-based sources we inject
        dynaudnorm into the audio filter chain. dynaudnorm tracks the
        recent loudness of the stream and pulls quiet passages up / loud
        passages down toward a target level. It's the right choice for live
        playback (loudnorm needs two passes for accurate measurement;
        loudnorm in single-pass mode pumps).

   The system master volume (wpctl on the default PipeWire sink) is the
   user-facing control and stays as the top of the chain. This module
   adjusts the per-source path INSIDE that, so 50% master always means
   roughly the same loudness regardless of what's playing.

   Pure functions — no state. Caller passes the settings snapshot in. */

'use strict';

/** Convert dB to a linear amplitude factor. -6 dB ≈ 0.501, 0 dB = 1, +6 dB ≈ 1.995 */
function dbToLinear(db) {
  if (!Number.isFinite(db)) return 1;
  return Math.pow(10, db / 20);
}

/** Convert dB to mpv's --volume value (100 = unity, 150 max in default profile). */
function dbToMpvVolume(db) {
  // mpv accepts up to 1000 with --volume-max set higher, but we cap at 200
  // (= +6 dB) to leave headroom for the system mixer. Clamp negative values
  // at 0 so we never go below mute.
  const v = 100 * dbToLinear(db);
  return Math.max(0, Math.min(200, Math.round(v * 10) / 10));
}

/** Pull the audio config out of a settings snapshot, applying defaults. */
function readConfig(settings) {
  const a = (settings && settings.audio) || {};
  const t = a.perSourceTrimDb || {};
  return {
    normalize: a.normalize !== false,
    trimDb: {
      library: t.library ?? 0,
      livetv:  t.livetv  ?? -3,
      youtube: t.youtube ?? -2,
      radioFm: t.radioFm ?? -8,
      radioAm: t.radioAm ?? 0,
      cast:    t.cast    ?? 0,
    },
  };
}

/** Get the trim (in dB) for a given source key. Returns 0 if unknown. */
function getTrimDb(settings, sourceKey) {
  const cfg = readConfig(settings);
  return cfg.trimDb[sourceKey] ?? 0;
}

/** Map a transport sourceId (used by source.resolve) → audio-fx source key.
 *
 *  Transport sources use ids like 'local', 'livetv', 'youtube', 'plex', etc.
 *  We collapse 'local' and 'plex' onto the 'library' trim because both are
 *  ripped/owned content with similar mastering. Radio splits FM vs AM (very
 *  different levels out of rtl_fm) so it isn't covered by this map — use
 *  trimForRadioBand() instead.
 */
function sourceKeyForTransport(sourceId) {
  switch (sourceId) {
    case 'local':
    case 'plex':
    case 'library': return 'library';
    case 'livetv':  return 'livetv';
    case 'youtube': return 'youtube';
    case 'cast':    return 'cast';
    default:        return 'library';  // sensible fallback (0 dB)
  }
}

/** Get the radio trim (dB) for a given band. */
function trimForRadioBand(settings, band) {
  const cfg = readConfig(settings);
  if (band === 'am')  return cfg.trimDb.radioAm;
  if (band === 'fm')  return cfg.trimDb.radioFm;
  // 'scanner' is narrow-FM, sits between AM and FM in raw level — split the
  // difference rather than picking one.
  return (cfg.trimDb.radioFm + cfg.trimDb.radioAm) / 2;
}

/**
 * Build mpv command-line args for the audio path.
 * Returns an array suitable for spreading into spawn() args.
 *
 *   --af=lavfi=[dynaudnorm=...]  applied when settings.audio.normalize is on
 *                                AND the source is content (not user-controlled
 *                                level like cast)
 *   --volume=N                   per-source trim baked in as mpv's input gain
 *
 * dynaudnorm parameters chosen for live playback:
 *   f=200    200ms frames — short enough for snappy dialogue/scene leveling
 *   g=15     15-frame smoothing window (~3s) — avoids pumping on transients
 *   r=0.5    target peak after compression (mid-loud, leaves system mixer headroom)
 *   p=0.95   max gain factor cap — prevents amplifying near-silence to noise
 */
function mpvArgsForSource(settings, sourceId, { skipNormalize = false } = {}) {
  const key = sourceKeyForTransport(sourceId);
  const trimDb = getTrimDb(settings, key);
  const cfg = readConfig(settings);

  const args = [];
  if (cfg.normalize && !skipNormalize) {
    args.push('--af=lavfi=[dynaudnorm=f=200:g=15:r=0.5:p=0.95]');
  }
  // Always pass --volume so trim takes effect even when normalize is off.
  // mpv's default is 100 (unity) — we override per-source.
  args.push(`--volume=${dbToMpvVolume(trimDb)}`);
  return args;
}

/**
 * Build sox filter args for the radio (rtl_fm → sox → aplay) pipeline.
 * Returns `null` when sox isn't available or no processing is needed.
 *
 * FM benefits from a touch of dynamic-range compression too — broadcast
 * compression is already aggressive on station side, but stations vary
 * widely; a soft compand keeps quieter ones audible without distorting
 * the louder ones. AM gets straight gain (no companding) because the
 * narrow-band signal is already heavily processed.
 */
function soxFilterForBand(settings, band) {
  const db = trimForRadioBand(settings, band);
  if (band === 'fm' || band === 'scanner') {
    // vol applied first (digital headroom), then compand for soft RMS leveling.
    // compand params (attack, decay, transfer function, gain, initial-volume,
    // delay): a fast attack so loud commercials don't hit the ceiling, slow
    // decay so quiet passages aren't pumped, transfer function compresses
    // -50..-20 dB upward and leaves -20..0 alone.
    return [
      'vol', String(db), 'dB',
      'compand', '0.05,0.3', '-50,-50,-30,-15,-5,-5', '-3', '-90', '0.1',
    ];
  }
  // AM: gain only.
  return ['vol', String(db), 'dB'];
}

/**
 * GStreamer audio-sink pipeline tail for uxplay's `-as` flag.
 * Returns a single string that uxplay slots in as the audio chain.
 *
 * audioconvert handles sample-format conversion (uxplay's RAOP decoder emits
 * F32LE planar; volume + pulsesink want interleaved). The volume element
 * applies a linear gain factor; we convert the configured dB trim. pulsesink
 * routes to PipeWire's pulse-shim — keeps the system volume bar live.
 */
function uxplayAudioPipeline(settings) {
  const db = getTrimDb(settings, 'cast');
  // 0 dB → pass-through; return the bare sink so the pipeline is byte-for-
  // byte identical to the pre-trim behavior when the user hasn't tuned it.
  if (Math.abs(db) < 0.01) return 'pulsesink';
  const linear = dbToLinear(db);
  const safe = Math.max(0, Math.min(4, linear));
  return `audioconvert ! volume volume=${safe.toFixed(4)} ! pulsesink`;
}

module.exports = {
  dbToLinear,
  dbToMpvVolume,
  readConfig,
  getTrimDb,
  sourceKeyForTransport,
  trimForRadioBand,
  mpvArgsForSource,
  soxFilterForBand,
  uxplayAudioPipeline,
};
