/* Navigation command handler — receives `nav.dpad` from the PWA, CAN
   button MCUs, IR remotes, etc., and forwards the keypress to the
   Electron GUI so the focused element acts on it.

   The controller doesn't synthesize keystrokes into the compositor
   itself — neither `wtype` (Wayland) nor `xdotool` (X11) ships on the
   Q6A image by default, and reaching across session boundaries from a
   systemd-user daemon is finicky. Instead we fan a one-shot IPC event
   to every connected GUI client and let the renderer (which already
   has DOM focus + KeyboardEvent constructors) dispatch a synthetic
   keystroke against `document.activeElement`. The renderer side of
   this contract lives in app/main/preload.js (`playbill.controller
   .onNavDpad`) and the renderer's chrome.jsx / app.jsx focus router.

   Schema (from commands.schema.json):
     { action: 'nav.dpad', key: 'up'|'down'|'left'|'right'|
                               'select'|'back'|'home'|'menu' }

   Key semantics (see docs/app/navigation.md for the full contract):
     up/down/left/right  Spatial focus movement. Never hierarchy.
     select              Activate focused element (click / submit).
     back                Previous screen.
     home                Home screen.
     menu                RESERVED — currently a no-op in the renderer.
                         Reserved for future contextual options
                         (Roku-Star pattern). Validation still accepts it
                         so the Argon Remote's ≡ button doesn't error. */

'use strict';

const VALID_KEYS = new Set(['up', 'down', 'left', 'right', 'select', 'back', 'home', 'menu']);
const TEXT_MAX = 1024;

function register({ bus, state, ipc }) {
  bus.register('nav.dpad', async (cmd, ctx) => {
    const key = cmd && cmd.key;
    if (!key || !VALID_KEYS.has(key)) {
      throw new Error(`nav.dpad: key must be one of ${[...VALID_KEYS].join(', ')}; got ${JSON.stringify(key)}`);
    }

    // Cold-start UX: when no GUI is connected, any nav press wakes the box.
    // Same pattern as source.launch — match it so a remote-style device with
    // only a D-pad doesn't need a separate "power" button. The GUI takes a
    // few seconds to attach to the IPC socket, so this press itself can't be
    // delivered; the user's second press lands as a navigation event. This
    // mirrors how Apple-TV-style remotes treat the first wake button.
    const guiUp = ipc && typeof ipc.hasClients === 'function' && ipc.hasClients();
    if (!guiUp && bus.has && bus.has('system.launchGui')) {
      try { await bus.dispatch({ action: 'system.launchGui' }, { from: 'nav.dpad' }); }
      catch (e) { console.warn('[nav.dpad] system.launchGui failed:', e.message); }
    }

    // Fan out to every connected IPC client (the Electron GUI). The
    // renderer turns this into a synthetic KeyboardEvent on the focused
    // element so the existing keyboard-nav logic in the TV shell drives
    // the experience — no special "remote" code path inside the GUI.
    if (guiUp && ipc && typeof ipc.publishEvent === 'function') {
      ipc.publishEvent('nav.dpad', { key, ts: Date.now(), from: (ctx && ctx.from) || 'unknown' });
    }

    // Record the last nav press in the UI slice. Useful for observers /
    // future "remote pressed Up just now" indicators; doesn't change
    // routing semantics. Cheap; one tiny patch per press.
    const cur = state.get().ui || {};
    state.patch({ ui: { ...cur, lastNav: { key, ts: Date.now() } } });

    return { ok: true, key, guiWasUp: guiUp };
  });

  // Text streaming from a remote PWA / soft keyboard. Same fan-out shape as
  // nav.dpad — the renderer subscribes via playbill.controller.onNavText and
  // either bulk-applies the string to the focused <input>/<textarea> or
  // synthesizes per-character keydown events for state-machine screens.
  // Special characters: '\b' Backspace, '\n' Enter/submit, '\t' Tab.
  bus.register('nav.text', async (cmd, ctx) => {
    const text = cmd && cmd.text;
    if (typeof text !== 'string') {
      throw new Error(`nav.text: text must be a string; got ${typeof text}`);
    }
    if (text.length > TEXT_MAX) {
      throw new Error(`nav.text: text too long (${text.length} > ${TEXT_MAX})`);
    }
    if (text.length === 0) return { ok: true, text: '', delivered: false };

    // Cold-start: mirror nav.dpad — any input from a remote wakes the box.
    const guiUp = ipc && typeof ipc.hasClients === 'function' && ipc.hasClients();
    if (!guiUp && bus.has && bus.has('system.launchGui')) {
      try { await bus.dispatch({ action: 'system.launchGui' }, { from: 'nav.text' }); }
      catch (e) { console.warn('[nav.text] system.launchGui failed:', e.message); }
    }

    if (guiUp && ipc && typeof ipc.publishEvent === 'function') {
      ipc.publishEvent('nav.text', { text, ts: Date.now(), from: (ctx && ctx.from) || 'unknown' });
    }

    const cur = state.get().ui || {};
    state.patch({ ui: { ...cur, lastNavText: { length: text.length, ts: Date.now() } } });

    return { ok: true, length: text.length, delivered: guiUp };
  });
}

module.exports = { register };
