/* Radio command handlers — bridges the RTL-SDR radio service to the command
   bus and the state store. Same surface every transport-like feature will
   adopt later: register a handful of verbs against the bus, mutate state on
   success, and let the existing state→MQTT fan-out (index.js
   `installStateToMqttFanout`) publish on `local/playbill/<id>/radio/status`.

   Commands accepted (over IPC from the GUI, over MQTT from PWAs and CAN):

     { action: 'radio.tune',         value: { band, frequencyHz, gain?, modulation? } }
     { action: 'radio.stop' }
     { action: 'radio.getState' }
     { action: 'radio.scan',         value: { band } }
     { action: 'radio.listAdapters' }
     { action: 'radio.listPresets' }
     { action: 'radio.setPresets',   value: [...] }
     { action: 'radio.lookupScanner',value: { zip } }
     { action: 'radio.probeTools' }

   The handlers are deliberately UI-agnostic: they accept and return plain
   JSON, never reach into the GUI, and don't know whether the request came
   in via Unix-socket IPC or MQTT. */

'use strict';

const radio  = require('../services/radio');
const player = require('../services/player');
const livetv = require('../services/livetv');

function register({ bus, state }) {
  // Helper to write into state.radio in one place. `running:false` collapses
  // to a tidy paused-snapshot so observers don't have to special-case nulls.
  function setRadioState(patch) {
    const cur = state.get().radio || { running: false };
    const next = { ...cur, ...patch };
    state.patch({ radio: next });
    return next;
  }

  bus.register('radio.tune', async (cmd) => {
    const v = cmd.value || cmd;
    const { band, frequencyHz, gain, modulation } = v;
    if (!band)        throw new Error('radio.tune: band required');
    if (!frequencyHz) throw new Error('radio.tune: frequencyHz required');

    // Architecture rule (architecture.md §6): only one source plays at a
    // time. Stop mpv (YouTube/livetv playback) and any DVB tuner before
    // bringing up rtl_fm — otherwise audio mixes through the analog jack.
    // Idempotent: each stop() no-ops if that producer wasn't running.
    try { await player.stop(); state.patch({ nowPlaying: null }); }
    catch (e) { console.warn('[radio.tune] player.stop failed:', e.message); }
    try { await livetv.stopAll(); state.patch({ livetv: null }); }
    catch (e) { console.warn('[radio.tune] livetv.stopAll failed:', e.message); }

    const result = await radio.tune({ band, frequencyHz, gain, modulation });
    setRadioState({
      running:     true,
      band:        result.band,
      frequencyHz: result.frequencyHz,
      gain:        result.gain || gain || 'auto',
      modulation:  modulation || null,
      scanning:    false,
      lastTuneAt:  Date.now(),
    });
    state.patch({ source: 'radio' });
    return result;
  });

  bus.register('radio.stop', async () => {
    await radio.stop();
    setRadioState({ running: false, scanning: false });
    if (state.get().source === 'radio') state.patch({ source: null });
    return { ok: true };
  });

  bus.register('radio.getState', async () => {
    // Service is the authority — if it crashed/exited mid-run our cached
    // state.radio may be stale. Reconcile before returning.
    const live = radio.getState();
    const cur  = state.get().radio || {};
    if (live.running !== cur.running) setRadioState({ running: live.running });
    return { ...cur, ...live };
  });

  bus.register('radio.scan', async (cmd) => {
    const v = cmd.value || cmd;
    const band = v.band || 'fm';
    setRadioState({ scanning: true, scanBand: band, running: false });
    try {
      const stations = await radio.scan({ band });
      setRadioState({
        scanning:    false,
        lastScan:    { band, completedAt: Date.now(), stations },
      });
      return { band, stations };
    } catch (e) {
      setRadioState({
        scanning:  false,
        lastScan:  { band, completedAt: Date.now(), error: e.message },
      });
      throw e;
    }
  });

  bus.register('radio.listAdapters',  async () => radio.listAdapters());
  bus.register('radio.listPresets',   async () => radio.listPresets());
  bus.register('radio.setPresets',    async (cmd) => radio.setPresets(cmd.value || []));
  bus.register('radio.lookupScanner', async (cmd) => radio.lookupScanner(cmd.value || {}));
  bus.register('radio.probeTools',    async () => radio.probeTools());
}

module.exports = { register };
