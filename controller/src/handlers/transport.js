/* Transport handlers — bridges mpv lifecycle (play/pause/stop/seek/etc.)
   to the bus and the state store. Volume + mute are deliberately NOT here
   (they live in handlers/volume.js because volume is a system-output
   property, not a content property — see commands.schema.json comments).

   transport.play is the interesting one: it accepts either a fully-resolved
   Playable (url + headers + metadata, the shape source.resolve returns), or
   a {sourceId, itemId} pair to resolve+play in one call. The PWA flow
   normally hands us {sourceId, itemId}; the GUI usually pre-resolves and
   passes the full Playable. */

'use strict';

const player  = require('../services/player');
const radio   = require('../services/radio');
const livetv  = require('../services/livetv');
const audioFx = require('../services/audio-fx');

function register({ bus, state, settings }) {

  // Mirror mpv property events into state.nowPlaying so subscribers (the
  // GUI, the MQTT fan-out, the eventual CAN-bridge for TransportStatus)
  // see the live state without polling.
  player.on('property', ({ name, value }) => {
    const cur = state.get().nowPlaying || {};
    const update = { ...cur };
    if (name === 'pause')        update.paused      = !!value;
    if (name === 'time-pos')     update.positionMs  = value == null ? null : Math.round(value * 1000);
    if (name === 'duration')     update.durationMs  = value == null ? null : Math.round(value * 1000);
    if (name === 'eof-reached' && value) update.paused = true;
    state.patch({ nowPlaying: update });
  });
  player.on('started', ({ url, metadata }) => {
    state.patch({ nowPlaying: { ...(metadata || {}), url, paused: false, positionMs: 0, durationMs: null } });
  });
  player.on('ended', () => {
    state.patch({ nowPlaying: null });
  });

  bus.register('transport.play', async (cmd) => {
    // Three shapes: (1) full Playable already resolved by source.resolve;
    // (2) {sourceId, itemId} — we look up the source, resolve, then play;
    // (3) no args — the dedicated Play button on a remote sends this. It
    // means "resume whatever is paused". If mpv is up, unpause it. If
    // nothing's playing, return ok:false rather than throwing — the Play
    // button shouldn't error the bus when there's nothing to resume.
    // Both URL/sourceId shapes can carry an `audioUrl` (yt-dlp returns
    // separate video + audio streams for bestvideo+bestaudio; player.js
    // mixes them in mpv via --audio-file=).
    let playable;
    if (cmd.url) {
      playable = {
        url:       cmd.url,
        audioUrl:  cmd.audioUrl,
        headers:   cmd.headers,
        mediaType: cmd.mediaType,
        metadata:  cmd.metadata,
      };
    } else if (cmd.sourceId && cmd.itemId) {
      const resolved = await bus.dispatch(
        { action: 'source.resolve', sourceId: cmd.sourceId, itemId: cmd.itemId },
        { from: 'transport.play' },
      );
      // resolved already includes audioUrl from yt-dlp.resolve when both
      // streams were available; pass it straight through.
      playable = resolved;
      // Caller-supplied metadata (from a search result) wins over what
      // resolve fabricated, because the search result has the channel/
      // duration the resolve didn't have time to fetch.
      if (cmd.metadata) playable.metadata = { ...(playable.metadata || {}), ...cmd.metadata };
    } else {
      // Resume-current: bare Play button from a remote.
      if (player.isPlaying()) {
        await player.resume();
        return { ok: true, resumed: true };
      }
      return { ok: false, reason: 'nothing-playing' };
    }

    // Architecture rule (architecture.md §6): only one source plays at a
    // time. Stop every other audio producer before starting the new one,
    // otherwise launching YouTube while the FM radio is on leaves both
    // streaming through the analog jack simultaneously. Each stop() is
    // idempotent and a no-op if that producer wasn't running.
    const newSource = cmd.sourceId || null;
    if (newSource !== 'radio') {
      try { await radio.stop(); state.patch({ radio: null }); }
      catch (e) { console.warn('[transport.play] radio.stop failed:', e.message); }
    }
    if (newSource !== 'livetv') {
      try { await livetv.stopAll(); state.patch({ livetv: null }); }
      catch (e) { console.warn('[transport.play] livetv.stopAll failed:', e.message); }
    }
    // player.play() itself stops any prior mpv before spawning a new one,
    // so we don't need to call player.stop() here.

    state.patch({ source: newSource || (state.get().source) || null });

    // Inject per-source loudness trim + (optionally) dynaudnorm before
    // handing off to mpv. The sourceId tells us which trim to apply; if
    // none was given (raw URL play), audio-fx falls back to the 'library'
    // bucket which is 0 dB by default — same as legacy behavior.
    const settingsSnap = settings ? settings.get() : null;
    const audioFxArgs = audioFx.mpvArgsForSource(settingsSnap, newSource);
    return player.play({ ...playable, audioFxArgs });
  });

  bus.register('transport.pause',   async () => player.pause());
  bus.register('transport.stop',    async () => {
    state.patch({ nowPlaying: null });
    // transport is mpv-driven (youtube, plex, livetv-via-tsPath). If source
    // was anything other than radio (which uses rtl_fm, not mpv), clear it.
    const cur = state.get().source;
    if (cur && cur !== 'radio') state.patch({ source: null });
    return player.stop();
  });
  bus.register('transport.toggle',  async () => player.togglePause());
  // No real queue concept yet — sources today are single-item (one YouTube
  // video, one livetv stream, one radio station). Until a queue exists,
  // map the remote's Next / Previous buttons to skip-ahead / instant-replay
  // semantics so the buttons actually do something useful during playback.
  // When a queue lands, promote these to track navigation and keep the seek
  // behavior on a different binding.
  const SKIP_AHEAD_SEC   =  30;
  const INSTANT_REPLAY_S = -10;
  bus.register('transport.next',    async () => {
    if (!player.isPlaying()) return { ok: false, reason: 'nothing-playing' };
    await player.seekRelative(SKIP_AHEAD_SEC);
    return { ok: true, skippedSec: SKIP_AHEAD_SEC };
  });
  bus.register('transport.previous',async () => {
    if (!player.isPlaying()) return { ok: false, reason: 'nothing-playing' };
    await player.seekRelative(INSTANT_REPLAY_S);
    return { ok: true, skippedSec: INSTANT_REPLAY_S };
  });

  bus.register('transport.seekRel', async (cmd) => {
    if (typeof cmd.deltaMs !== 'number') throw new Error('transport.seekRel: deltaMs required');
    return player.seekRelative(cmd.deltaMs / 1000);
  });
  bus.register('transport.seekAbs', async (cmd) => {
    if (typeof cmd.positionMs !== 'number') throw new Error('transport.seekAbs: positionMs required');
    return player.seekAbsolute(cmd.positionMs / 1000);
  });
}

module.exports = { register };
