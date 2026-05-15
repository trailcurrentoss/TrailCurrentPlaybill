/* Live TV (DVB / ATSC) command handlers — bridges the Hauppauge tuner
   service to the command bus and the state store. Same pattern as
   handlers/radio.js: register a handful of verbs, mutate state on success,
   let the existing state→MQTT fan-out (index.js installStateToMqttFanout)
   publish on local/playbill/<id>/livetv/status.

   Commands accepted (over IPC from the GUI, over MQTT from PWAs and CAN):

     { action: 'livetv.tune',         value: { adapter?, channel } }
     { action: 'livetv.stopTune',     value: { adapter? } }
     { action: 'livetv.scan',         value: { adapter?, country? } }
     { action: 'livetv.listChannels' }
     { action: 'livetv.listAdapters' }
     { action: 'livetv.probeTools' }

   The handlers are deliberately UI-agnostic: they accept and return plain
   JSON, never reach into the GUI, and don't know whether the request came
   in via Unix-socket IPC or MQTT. */

'use strict';

const livetv = require('../services/livetv');
const radio  = require('../services/radio');
const player = require('../services/player');

function register({ bus, state }) {
  // Helper to write into state.livetv in one place. Mirrors handlers/radio's
  // setRadioState shape so observers can treat both the same way.
  function setLivetvState(patch) {
    const cur = state.get().livetv || { tuned: false };
    const next = { ...cur, ...patch };
    state.patch({ livetv: next });
    return next;
  }

  bus.register('livetv.tune', async (cmd) => {
    const v = cmd.value || cmd;
    const { adapter, channel } = v;
    if (!channel) throw new Error('livetv.tune: channel required');

    // Architecture rule (architecture.md §6): only one source plays at a
    // time. Stop radio + any prior mpv before the dvbv5-zap capture starts
    // (player.play below will be invoked separately by the caller — for
    // example live.jsx — to actually play the resulting tsPath; that
    // player.play replaces any prior mpv, so we don't stop player here).
    try { await radio.stop(); state.patch({ radio: null }); }
    catch (e) { console.warn('[livetv.tune] radio.stop failed:', e.message); }

    const result = await livetv.tune({ adapter, channel });
    setLivetvState({
      tuned:       true,
      adapter:     result.adapter,
      channel:     result.channel,
      tsPath:      result.tsPath,
      lastTuneAt:  Date.now(),
    });
    state.patch({ source: 'livetv' });
    return result;
  });

  bus.register('livetv.stopTune', async (cmd) => {
    const v = cmd.value || cmd;
    await livetv.stopTune({ adapter: v.adapter });
    setLivetvState({ tuned: false, tsPath: null });
    if (state.get().source === 'livetv') state.patch({ source: null });
    return { ok: true };
  });

  bus.register('livetv.scan', async (cmd) => {
    const v = cmd.value || cmd || {};
    setLivetvState({ scanning: true, scanAdapter: v.adapter ?? 0 });
    try {
      const channels = await livetv.scan(v);
      setLivetvState({
        scanning:   false,
        lastScan:   { completedAt: Date.now(), channelCount: channels.length },
      });
      return { channels };
    } catch (e) {
      setLivetvState({
        scanning: false,
        lastScan: { completedAt: Date.now(), error: e.message },
      });
      throw e;
    }
  });

  bus.register('livetv.stopScan', async () => {
    // Abort an in-progress dvbv5-scan. The scan handler above will
    // resolve naturally with whatever channels.conf had (often empty
    // or partial) once dvbv5-scan exits, so we don't need to mutate
    // state here — just signal the process and return.
    const result = await livetv.stopScan();
    // Mark scanning false right away so the renderer's button state
    // updates without waiting for the scan promise to resolve. The
    // livetv.scan handler will overwrite lastScan with the partial
    // result once the close event lands.
    const cur = state.get().livetv || {};
    if (cur.scanning) state.patch({ livetv: { ...cur, scanning: false } });
    return result;
  });

  bus.register('livetv.listChannels', async () => livetv.listChannels());
  bus.register('livetv.listAdapters', async () => livetv.listAdapters());
  bus.register('livetv.probeTools',   async () => livetv.probeTools());
}

module.exports = { register };
