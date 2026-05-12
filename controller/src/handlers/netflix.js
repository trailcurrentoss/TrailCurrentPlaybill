/* netflix.* command handlers — Brave kiosk lifecycle.

   Netflix has no list/search/resolve (it's a DRM-locked web app we just
   launch), so the generic source dispatcher in handlers/source.js doesn't
   apply. These dedicated actions own the Brave process lifecycle:

     netflix.start      → spawn brave-browser --kiosk --app=netflix.com
     netflix.stop       → SIGTERM the running Brave process
     netflix.getStatus  → snapshot of the kiosk state

   State surface mirrored into state.netflix:
     {
       running:   bool
       startedAt: ms-since-epoch | null
       lastError: string | null
     } */

'use strict';

const browser = require('../sources/netflix/browser');

function register({ bus, state }) {

  function publish(extra = {}) {
    const s = browser.getStatus();
    const cur = state.get().netflix || {};
    state.patch({
      netflix: {
        running:   s.running,
        startedAt: s.startedAt || null,
        lastError: extra.lastError !== undefined ? extra.lastError : (cur.lastError || null),
      },
    });
  }

  // Seed state.netflix so subscribers see a real snapshot on first connect.
  publish();

  // Fan Chrome lifecycle events into state so the Netflix screen reflects
  // a Chrome crash (user closed the window with Alt+F4 etc.) without polling.
  browser.on('state', () => publish());

  bus.register('netflix.start', async () => {
    try {
      const r = await browser.start();
      publish({ lastError: null });
      // Mark this as the active source so other UIs (PWAs, NowPlayingBar)
      // know what the device is doing.
      state.patch({ source: 'netflix' });
      return r;
    } catch (e) {
      publish({ lastError: e.message });
      throw e;
    }
  });

  bus.register('netflix.stop', async () => {
    const r = await browser.stop();
    publish({ lastError: null });
    // Clear source attribution if netflix was active. Don't clobber a
    // different source that may have been set in the meantime.
    if (state.get().source === 'netflix') state.patch({ source: null });
    return r;
  });

  bus.register('netflix.getStatus', async () => browser.getStatus());
}

module.exports = { register };
