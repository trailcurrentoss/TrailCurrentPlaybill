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
    const result = await livetv.tune({ adapter, channel });
    setLivetvState({
      tuned:       true,
      adapter:     result.adapter,
      channel:     result.channel,
      tsPath:      result.tsPath,
      lastTuneAt:  Date.now(),
    });
    return result;
  });

  bus.register('livetv.stopTune', async (cmd) => {
    const v = cmd.value || cmd;
    await livetv.stopTune({ adapter: v.adapter });
    setLivetvState({ tuned: false, tsPath: null });
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

  bus.register('livetv.listChannels', async () => livetv.listChannels());
  bus.register('livetv.listAdapters', async () => livetv.listAdapters());
  bus.register('livetv.probeTools',   async () => livetv.probeTools());
}

module.exports = { register };
