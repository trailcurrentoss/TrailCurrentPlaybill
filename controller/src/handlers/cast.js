/* cast.* command handlers — AirPlay receiver lifecycle.

   The cast source itself has no list/search/resolve methods (there's
   nothing to enumerate on the receiver side), so the generic source
   dispatcher in handlers/source.js wouldn't dispatch anything useful for
   it. These dedicated actions own UxPlay's lifecycle instead:

     cast.start      → spawn uxplay if not already running
     cast.stop       → SIGTERM the running uxplay process
     cast.getStatus  → snapshot of the receiver state

   State surface mirrored into state.cast:
     {
       running:    bool
       state:      'idle' | 'waiting' | 'connected' | 'streaming'
       clientName: string | null
       startedAt:  ms-since-epoch | null
       lastError:  string | null
     } */

'use strict';

const uxplay = require('../sources/cast/uxplay');

function register({ bus, state, settings }) {

  function publish(extra = {}) {
    const s = uxplay.getStatus();
    const cur = state.get().cast || {};
    state.patch({
      cast: {
        running:    s.running,
        state:      s.state,
        clientName: s.clientName,
        startedAt:  s.startedAt || null,
        lastError:  extra.lastError !== undefined ? extra.lastError : (cur.lastError || null),
      },
    });
  }

  // Seed state.cast so subscribers see a real snapshot on first connect.
  publish();

  // Fan UxPlay lifecycle events into state so the Cast screen reflects
  // connect/disconnect without polling.
  uxplay.on('state', () => publish());

  bus.register('cast.start', async () => {
    // The receiver name in the iOS AirPlay menu defaults to the device's
    // configured display name (Settings → Device → Name). Falls back to
    // 'Playbill' if settings aren't loaded.
    const cur = settings ? settings.get() : null;
    const receiverName = (cur && cur.device && cur.device.name) || 'Playbill';
    try {
      const r = await uxplay.start({ receiverName });
      publish({ lastError: null });
      // Mark this as the active source so other UIs (PWAs, NowPlayingBar)
      // know what the device is doing.
      state.patch({ source: 'cast' });
      return r;
    } catch (e) {
      publish({ lastError: e.message });
      throw e;
    }
  });

  bus.register('cast.stop', async () => {
    const r = await uxplay.stop();
    publish({ lastError: null });
    // Clear source attribution if cast was active. Don't clobber a
    // different source that may have been set in the meantime.
    if (state.get().source === 'cast') state.patch({ source: null });
    return r;
  });

  bus.register('cast.getStatus', async () => uxplay.getStatus());
}

module.exports = { register };
