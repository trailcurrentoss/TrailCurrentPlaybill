/* Volume command handlers — bridges PipeWire volume control to the bus.

   Six bus actions (matching commands.schema.json transport.* and DBC
   PlaybillVolumeCmd):

     transport.volumeUp     value: { step?: 1-100 }   default step 5
     transport.volumeDown   value: { step?: 1-100 }   default step 5
     transport.volumeSet    value: { percent: 0-100 }
     transport.muteOn
     transport.muteOff
     transport.muteToggle

   Each handler runs the wpctl call, fetches the resulting state, mirrors
   it into state.audio (top-level — separate from nowPlaying because volume
   is a property of the audio output stage, not the content), and returns
   the new state to the caller. The state→MQTT fan-out in index.js
   publishes the change on local/playbill/<id>/volume/status. */

'use strict';

const volume = require('../services/volume');

const DEFAULT_STEP = 5;

function register({ bus, state }) {
  function commit(snap) {
    state.patch({ audio: snap });
    return snap;
  }

  bus.register('transport.volumeUp', async (cmd) => {
    const step = (cmd && cmd.step) || DEFAULT_STEP;
    return commit(await volume.adjustVolume(+step));
  });

  bus.register('transport.volumeDown', async (cmd) => {
    const step = (cmd && cmd.step) || DEFAULT_STEP;
    return commit(await volume.adjustVolume(-step));
  });

  bus.register('transport.volumeSet', async (cmd) => {
    if (typeof cmd.percent !== 'number') {
      throw new Error('transport.volumeSet: percent (0-100) required');
    }
    return commit(await volume.setVolume(cmd.percent));
  });

  bus.register('transport.muteOn',     async () => commit(await volume.setMute(true)));
  bus.register('transport.muteOff',    async () => commit(await volume.setMute(false)));
  bus.register('transport.muteToggle', async () => commit(await volume.toggleMute()));
}

module.exports = { register };
