/* Generic source dispatcher — fans bus actions to the named source plugin.

   Architecture-v2 §5: every source (YouTube, Plex, Spotify, the local
   library, the radio-as-source view) implements the same contract:
     id, displayName, icon, capabilities, list, search, resolve, ...

   Bus actions handled here:
     source.list      { sourceId, path }                → { path, items }
     source.search    { sourceId, query, limit? }      → { items }
     source.resolve   { sourceId, itemId | item }      → Playable
     source.launch    { sourceId, subScreen? }        → see notes
     source.list                                      (without sourceId →
                                                      list of registered sources)

   source.launch is intentionally a UI affordance, not a playback trigger:
   it tells the GUI "switch to this source's main browse screen" and, if
   the GUI isn't running, fires system.launchGui via the bus first. */

'use strict';

function register({ bus, state, sources }) {
  const byId = new Map(sources.map((s) => [s.id, s]));

  function pick(sourceId) {
    if (!sourceId) throw new Error('sourceId required');
    const s = byId.get(sourceId);
    if (!s) throw new Error(`unknown source "${sourceId}"`);
    return s;
  }

  bus.register('source.list', async (cmd) => {
    if (!cmd.sourceId) {
      // No sourceId → list registered sources (for the apps grid / PWA).
      return {
        path: '/',
        items: sources.map((s) => ({
          id: s.id, type: 'source', sourceId: s.id,
          title: s.displayName, icon: s.icon || null,
          capabilities: s.capabilities || [],
        })),
      };
    }
    const s = pick(cmd.sourceId);
    if (typeof s.list !== 'function') throw new Error(`source "${cmd.sourceId}" has no list()`);
    return s.list(cmd.path);
  });

  bus.register('source.search', async (cmd) => {
    const s = pick(cmd.sourceId);
    if (typeof s.search !== 'function') throw new Error(`source "${cmd.sourceId}" has no search()`);
    return s.search(cmd.query, cmd.limit);
  });

  bus.register('source.resolve', async (cmd) => {
    const s = pick(cmd.sourceId);
    if (typeof s.resolve !== 'function') throw new Error(`source "${cmd.sourceId}" has no resolve()`);
    return s.resolve(cmd.itemId || cmd.item);
  });

  bus.register('source.launch', async (cmd) => {
    const s = pick(cmd.sourceId);
    // For now, source.launch is a state-only signal — set state.source so
    // the GUI knows which screen to render. The GUI subscribes to state
    // and renders the source's browse hierarchy via its own source.list.
    state.patch({ source: s.id });
    // If the GUI isn't running and the bus has system.launchGui, dispatch
    // it so a PWA can wake the screen and select the source in one
    // round-trip.
    if (!state.get().gui || !state.get().gui.running) {
      if (bus.has('system.launchGui')) {
        try { await bus.dispatch({ action: 'system.launchGui' }, { from: 'source.launch' }); }
        catch (e) { console.warn('[source.launch] system.launchGui failed:', e.message); }
      }
    }
    return { ok: true, sourceId: s.id, subScreen: cmd.subScreen || 'default' };
  });
}

module.exports = { register };
