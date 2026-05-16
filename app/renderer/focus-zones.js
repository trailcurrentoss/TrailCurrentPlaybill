/* Spatial focus zones — the universal d-pad navigation engine.
   See docs/app/navigation.md for the full contract.

   USAGE
     Tag the screen root and any inner region:
       <div data-zone-root data-zone="settings" data-zone-axis="horizontal">
         <div data-zone="settings.tabs"    data-zone-axis="vertical">…</div>
         <div data-zone="settings.content" data-zone-axis="vertical">
           <section data-zone="…"           data-zone-axis="vertical">…</section>
         </div>
       </div>

     Then route keydown events through FocusZones.handleKeydown(e). If it
     returns true, the event was handled (preventDefault has already been
     called) and the screen-level handler should bail.

   ALGORITHM
     Up/Down/Left/Right move focus to the nearest focusable neighbor inside
     the current zone (the deepest [data-zone-axis] ancestor of activeElement)
     using bounding-rect geometry. At the zone's edge, the move escapes to
     the parent zone: we find sibling zones of the current one and walk
     toward the requested direction, then enter that zone (restoring its
     last-focused child).

     The engine treats axis as a *filter*: a `vertical` zone ignores left/
     right within itself (left/right immediately escapes); same for
     `horizontal`. `grid` allows all four directions within. */

(function () {
  'use strict';

  // ─── Element predicates ─────────────────────────────────────────────

  function isVisible(el) {
    if (!el) return false;
    if (el === document.body) return true;
    // Computed-style check catches display:none and visibility:hidden
    // for both normal-flow and fixed-positioned elements.
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    // For NON-fixed elements, offsetParent === null also means hidden
    // (in a display:none ancestor). For position:fixed elements,
    // offsetParent is ALWAYS null even when visible — so we must NOT
    // use offsetParent as a proxy for fixed elements. This caught us
    // 2026-05-15: the DVD/CD prompt modals were correctly tagged with
    // data-zone-root but getRoot() rejected them as "not visible"
    // because offsetParent was null (fixed positioning), and the d-pad
    // fell through to the screen behind the modal.
    if (cs.position !== 'fixed' && el.offsetParent === null) return false;
    return true;
  }

  function isFocusable(el) {
    if (!el || !isVisible(el)) return false;
    if (el.disabled) return false;
    const t = el.tagName;
    if (t === 'BUTTON' || t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || t === 'A') return true;
    const ti = el.getAttribute && el.getAttribute('tabindex');
    return ti != null && ti !== '-1';
  }

  function isTextField(el) {
    if (!el) return false;
    const t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA';
  }

  function getZone(el) {
    if (!el || !el.closest) return null;
    return el.closest('[data-zone-axis]');
  }

  function getParentZone(zone) {
    if (!zone || !zone.parentElement) return null;
    return zone.parentElement.closest('[data-zone-axis]');
  }

  function getRoot() {
    // Return the LAST [data-zone-root] in document order so a modal /
    // overlay (DVD prompt, CD prompt, dialog, future popups) wins over
    // the screen underneath it. Modals are rendered after the main shell
    // in app.jsx, so in DOM order they come last. This is the canonical
    // tvOS / react-focus-lock pattern: the topmost zone-root owns the
    // d-pad until it's dismissed. Without this, a modal can't capture
    // focus — querySelector returns the main screen's root, the modal
    // is invisible to FocusZones, and the d-pad still drives the screen
    // underneath.
    const nodes = document.querySelectorAll('[data-zone-root]');
    if (!nodes.length) return null;
    // Filter to visible roots only so a conditionally-rendered-null modal
    // doesn't accidentally claim the d-pad when it's actually off-screen.
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (isVisible(nodes[i])) return nodes[i];
    }
    return nodes[nodes.length - 1];
  }

  // ─── DOM traversal ──────────────────────────────────────────────────

  // Focusable leaves OWNED BY this zone (i.e. not inside a nested zone).
  function leavesIn(zone) {
    const out = [];
    function walk(node) {
      for (const child of node.children) {
        // Nested zone — stop descending; its children belong to it.
        if (child.hasAttribute && child.hasAttribute('data-zone-axis')) continue;
        if (isFocusable(child)) out.push(child);
        walk(child);
      }
    }
    walk(zone);
    return out;
  }

  // Direct child zones (the next zone boundary inside `zone`).
  function childZones(zone) {
    const out = [];
    function walk(node) {
      for (const child of node.children) {
        if (child.hasAttribute && child.hasAttribute('data-zone-axis')) {
          out.push(child);
        } else {
          walk(child);
        }
      }
    }
    walk(zone);
    return out;
  }

  // ─── Geometry ───────────────────────────────────────────────────────

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: r };
  }

  function isInDirection(from, to, dir) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const t = 1;  // tolerance — anything within 1 px is "same axis"
    if (dir === 'left')  return dx < -t;
    if (dir === 'right') return dx >  t;
    if (dir === 'up')    return dy < -t;
    if (dir === 'down')  return dy >  t;
    return false;
  }

  // Distance: along-axis movement weighted lower than perpendicular drift,
  // so an item directly to the right beats one that's right-and-far-down.
  function directionDistance(from, to, dir) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const along = (dir === 'left' || dir === 'right') ? Math.abs(dx) : Math.abs(dy);
    const perp  = (dir === 'left' || dir === 'right') ? Math.abs(dy) : Math.abs(dx);
    return along + perp * 3;
  }

  function nearestInDirection(fromEl, candidates, dir) {
    if (!candidates.length) return null;
    const from = centerOf(fromEl);
    let best = null, bestDist = Infinity;
    for (const c of candidates) {
      if (c === fromEl) continue;
      if (!isVisible(c)) continue;
      const to = centerOf(c);
      if (!isInDirection(from, to, dir)) continue;
      const d = directionDistance(from, to, dir);
      if (d < bestDist) { best = c; bestDist = d; }
    }
    return best;
  }

  // ─── Zone memory ────────────────────────────────────────────────────

  // Remember the last-focused descendant of each zone. Stored as an
  // expando on the zone element so it survives React re-renders as long
  // as the node identity is preserved.

  function rememberFocus(zone, el) {
    if (!zone || !el) return;
    zone.__zoneLastFocus = el;
    // Also bubble up — each ancestor zone gets the same memory so re-entry
    // from any level restores the deepest landing.
    const parent = getParentZone(zone);
    if (parent) rememberFocus(parent, el);
  }

  function lastFocusOf(zone) {
    const el = zone && zone.__zoneLastFocus;
    if (!el || !document.contains(el) || !isFocusable(el)) return null;
    return el;
  }

  // ─── Focus operations ───────────────────────────────────────────────

  // Drop focus into a zone, preferring last-known position, then
  // data-zone-default, then first focusable, then recurse into the
  // first child zone.
  function enterZone(zone) {
    if (!zone) return false;
    const last = lastFocusOf(zone);
    if (last) { last.focus(); return true; }
    const def = zone.querySelector('[data-zone-default]');
    if (def && isFocusable(def)) { def.focus(); return true; }
    const leaves = leavesIn(zone);
    if (leaves.length) { leaves[0].focus(); return true; }
    const kids = childZones(zone);
    for (const k of kids) if (enterZone(k)) return true;
    return false;
  }

  // Try to move focus in `dir` starting from `el`. Returns true if focus
  // changed. Bubbles up through zone hierarchy when at edge.
  function moveFromElement(el, dir) {
    let zone = getZone(el);
    if (!zone) return false;
    const axis = zone.getAttribute('data-zone-axis');
    const axisAllowed =
      axis === 'grid' ||
      ((axis === 'vertical')   && (dir === 'up'   || dir === 'down')) ||
      ((axis === 'horizontal') && (dir === 'left' || dir === 'right'));

    if (axisAllowed) {
      const candidates = leavesIn(zone);
      const target = nearestInDirection(el, candidates, dir);
      if (target) {
        rememberFocus(zone, target);
        target.focus();
        return true;
      }
    }

    // Escape to a sibling zone in the parent.
    let cursor = zone;
    while (cursor) {
      const parent = getParentZone(cursor);
      if (!parent) {
        // We're at the screen root — let the screen-level handler decide
        // (e.g. open SideNav on Left, or no-op). Returning false lets the
        // event bubble back to app.jsx.
        return false;
      }
      const siblings = childZones(parent).filter(z => z !== cursor);
      const target = nearestInDirection(cursor, siblings, dir);
      if (target) {
        rememberFocus(parent, target);
        return enterZone(target);
      }
      cursor = parent;
    }
    return false;
  }

  // ─── Activation ─────────────────────────────────────────────────────

  function activate(el) {
    if (!el) return false;
    const t = el.tagName;
    if (t === 'BUTTON' || t === 'A') { el.click(); return true; }
    // data-osk inputs pop the on-screen keyboard on activation instead of
    // submitting their form. The OSK is the primary entry path for remote
    // users; pressing Enter on an empty field with a real keyboard also
    // brings it up, which is harmless (the user can dismiss with Back and
    // press Enter again to submit). The OSK itself has its own "Submit"
    // key for data-osk-submit inputs that should also fire form.submit on
    // close. See app/renderer/components/osk.jsx for the receiver side.
    if ((t === 'INPUT' || t === 'TEXTAREA') && el.hasAttribute &&
        el.hasAttribute('data-osk')) {
      const layout = el.getAttribute('data-osk') || 'text';
      window.dispatchEvent(new CustomEvent('playbill:osk-open', {
        detail: { target: el, layout },
      }));
      return true;
    }
    if ((t === 'INPUT' || t === 'TEXTAREA') &&
        el.form && typeof el.form.requestSubmit === 'function') {
      el.form.requestSubmit();
      return true;
    }
    if (t === 'INPUT' || t === 'TEXTAREA') {
      // No form — just dispatch a click for elements that use onClick.
      el.click();
      return true;
    }
    return false;
  }

  // ─── Public API ─────────────────────────────────────────────────────

  // Handle a keydown event when the active element is inside a zone-root.
  // Returns true if the event was handled (and preventDefault called).
  function handleKeydown(e) {
    const root = getRoot();
    if (!root) return false;

    let active = document.activeElement;
    // Focus watchdog. Two cases land here:
    //   (1) First keypress after screen mount — focus is on <body>.
    //   (2) Focus was LOST mid-session because the previously-focused element
    //       was unmounted/remounted by a re-render (data refresh, async load).
    // Either way, restore focus into the current zone-root, then CONTINUE
    // handling the key — so one keypress both recovers focus and acts on it.
    // Without this, a screen that re-renders frequently (Rig telemetry, etc.)
    // silently swallows every directional press to re-enter focus while the
    // user perceives "nothing is happening."
    if (!active || active === document.body || !root.contains(active)) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' &&
          e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' &&
          e.key !== 'Enter' && e.key !== ' ') {
        return false;
      }
      if (!enterZone(root)) return false; // empty screen; let app.jsx handle
      active = document.activeElement;
      if (!active || active === document.body || !root.contains(active)) {
        // enterZone reported success but nothing actually took focus — bail.
        return false;
      }
      // Fall through to the normal direction-handling path on the new element.
    }

    const synthetic = !e.isTrusted;
    const inText = isTextField(active);

    // Text-field escape policy.
    //
    // We CAN NOT use isTrusted to discriminate "remote" from "real keyboard"
    // events as the contract docs originally proposed. IR-remote keys reach
    // Electron through the kernel input layer (gpio-ir-receiver → evdev →
    // libinput → Wayland → DOM) and arrive with isTrusted === true,
    // indistinguishable from a USB keyboard. So we rely purely on caret
    // position + key semantics:
    //
    //   ArrowUp / ArrowDown  → ALWAYS escape the field (single-line inputs
    //                          have no vertical motion; in a textarea this
    //                          escapes when the caret can't move further
    //                          up/down — see below)
    //   ArrowLeft            → cursor moves left until caret is at the
    //                          start, then escape
    //   ArrowRight           → cursor moves right until caret is at the
    //                          end, then escape
    //   Escape               → blur the field and let the central handler
    //                          process Esc as Back on the next dispatch
    //
    // "Escape" here means: try to move focus out of the input via the
    // zone engine (moveFromElement). If the engine can't find a target,
    // blur the input — that pushes activeElement back to <body> and the
    // next press will trigger enterZone(root) at the top of this function.
    if (inText && e.key === 'ArrowUp') {
      // Textareas allow vertical motion within the field; defer to native
      // unless the caret is already at the top.
      if (active.tagName === 'TEXTAREA') {
        const beforeNewline = active.value.lastIndexOf('\n', Math.max(0, (active.selectionStart || 0) - 1));
        if (beforeNewline >= 0) return false;
      }
      if (moveFromElement(active, 'up')) { e.preventDefault(); return true; }
      try { active.blur(); } catch (_) {}
      e.preventDefault();
      return true;
    }
    if (inText && e.key === 'ArrowDown') {
      if (active.tagName === 'TEXTAREA') {
        const v = active.value || '';
        const idx = (active.selectionStart || 0);
        if (v.indexOf('\n', idx) >= 0) return false;
      }
      if (moveFromElement(active, 'down')) { e.preventDefault(); return true; }
      try { active.blur(); } catch (_) {}
      e.preventDefault();
      return true;
    }
    if (inText && e.key === 'ArrowLeft') {
      // Caret at very start → escape; otherwise cursor passthrough.
      const atStart = (active.selectionStart || 0) === 0 && (active.selectionEnd || 0) === 0;
      if (!atStart) return false;
      if (moveFromElement(active, 'left')) { e.preventDefault(); return true; }
      try { active.blur(); } catch (_) {}
      // Return false here so app.jsx's "left at root → SideNav" fallback
      // gets a chance to run (the blur happened, activeElement is now body,
      // and the central handler treats body-left as "open side nav").
      return false;
    }
    if (inText && e.key === 'ArrowRight') {
      const len = (active.value || '').length;
      const atEnd = (active.selectionStart || 0) === len && (active.selectionEnd || 0) === len;
      if (!atEnd) return false;
      if (moveFromElement(active, 'right')) { e.preventDefault(); return true; }
      try { active.blur(); } catch (_) {}
      return true;
    }
    if (inText && e.key === 'Escape') {
      try { active.blur(); } catch (_) {}
      e.preventDefault();
      return true;
    }

    // Map keys to directions (non-text-field path).
    const dirMap = {
      ArrowUp:    'up',
      ArrowDown:  'down',
      ArrowLeft:  'left',
      ArrowRight: 'right',
    };
    const dir = dirMap[e.key];
    if (dir) {
      const moved = moveFromElement(active, dir);
      if (moved) { e.preventDefault(); return true; }
      return false;  // let app.jsx handle the edge case (e.g. left at root → SideNav)
    }

    if (e.key === 'Enter' || e.key === ' ') {
      // Inside any text field, Enter and Space must be left to the browser:
      //   - Space inserts a literal space character (was the YouTube search
      //     box bug — Space was being interpreted as "click the focused
      //     button" because activate() falls through to .click() on inputs).
      //   - Enter inserts a newline in <textarea>; in <input type=text>
      //     Enter submits the enclosing form natively.
      // synthetic dispatches from the controller bus are still able to
      // activate a non-input element — they just can't punch through a
      // focused text field, which is the right behavior.
      //
      // EXCEPTION: an input tagged with `data-osk` is a remote-friendly
      // text field whose Enter/Select should pop the on-screen keyboard
      // (see app/renderer/components/osk.jsx). For those we route Enter
      // through activate(), which dispatches `playbill:osk-open`. Space
      // still falls through to the browser so a USB keyboard's literal
      // space character lands in the field unchanged.
      if (inText && e.key === 'Enter' && active.hasAttribute &&
          active.hasAttribute('data-osk')) {
        if (activate(active)) { e.preventDefault(); return true; }
      }
      if (inText) return false;
      if (activate(active)) { e.preventDefault(); return true; }
    }

    return false;
  }

  window.FocusZones = {
    handleKeydown,
    enterZone,
    moveFromElement,
    activate,
    getRoot,
  };
})();
