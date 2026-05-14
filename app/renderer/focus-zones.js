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
    // offsetParent is null for display:none and fixed elements with no
    // parent; for our purposes (focusable cards inside scrollable
    // panels) that's a good-enough visibility check.
    if (el.offsetParent === null && el.tagName !== 'BODY') return false;
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
    return document.querySelector('[data-zone-root]');
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
    // First keypress after screen mount: focus is on <body>. Land into the root.
    if (!active || active === document.body || !root.contains(active)) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
          e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
          e.key === 'Enter' || e.key === ' ') {
        enterZone(root);
        e.preventDefault();
        return true;
      }
      return false;
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
      // Inside a textarea, Enter inserts a newline — only intercept for
      // single-line inputs and buttons.
      if (active.tagName === 'TEXTAREA' && !synthetic) return false;
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
