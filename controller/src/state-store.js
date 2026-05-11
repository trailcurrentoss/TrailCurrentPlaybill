/* StateStore — single source of truth for runtime state.

   Single-writer (the controller). Many subscribers (the IPC server pushes
   to each connected GUI; the MQTT bridge publishes deltas; internal
   listeners may react too). Subscribers receive both the diff that changed
   and the new full state, so simple ones (MQTT publisher) can mechanically
   forward the diff and richer ones (IPC server) can decide whether the
   diff is interesting to a particular client.

   Patches are shallow at the top level. Nested categories (nowPlaying,
   radio, livetv, ui, ...) are atomic — replace the whole object rather
   than trying to deep-merge, because partial deep merges are the source
   of every "why didn't that field clear?" bug in this kind of store. */

'use strict';

class StateStore {
  constructor(initial = {}) {
    this._state = Object.freeze({ ...initial });
    this._subs = new Set();
  }

  get() {
    return this._state;
  }

  /**
   * Apply a shallow patch. Each top-level key in `patch` replaces the
   * corresponding key in state. Pass `null` to clear a key.
   */
  patch(patch) {
    if (!patch || typeof patch !== 'object') return;
    const prev = this._state;

    let changed = false;
    const next = { ...prev };
    for (const k of Object.keys(patch)) {
      if (next[k] !== patch[k]) { next[k] = patch[k]; changed = true; }
    }
    if (!changed) return;

    this._state = Object.freeze(next);
    const event = { patch, state: this._state, prev };
    for (const sub of this._subs) {
      try { sub(event); } catch (e) { console.error('[state-store] subscriber threw:', e); }
    }
  }

  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }
}

module.exports = StateStore;
