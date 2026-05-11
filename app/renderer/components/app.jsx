/* TV App — focus state, keyboard nav, view switching */

// Apply remote-streamed text to the focused element. Used by the nav.text
// IPC event listener inside TVApp. Kept at module scope so the function
// reference is stable across renders.
//
// React's controlled <input>/<textarea> elements track value internally;
// setting el.value directly does NOT trigger React's onChange. The fix is
// to invoke the value setter on the prototype's descriptor — React's
// SyntheticEvent system listens for the bubbling native 'input' event and
// reconciles state from there.
function applyRemoteText(text) {
  const el = document.activeElement;
  const isInput = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.disabled && !el.readOnly;

  if (isInput) {
    // Walk the string and apply runs of printable text + handle specials.
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\b') {
        backspaceInput(el);
        i++;
      } else if (ch === '\n') {
        // Newline in a textarea inserts literally; in a single-line input
        // it means "submit". Both match how a real keyboard behaves.
        if (el.tagName === 'TEXTAREA') {
          insertAtCaret(el, '\n');
        } else {
          if (el.form && typeof el.form.requestSubmit === 'function') {
            el.form.requestSubmit();
          } else {
            const evtInit = { key: 'Enter', bubbles: true, cancelable: true };
            el.dispatchEvent(new KeyboardEvent('keydown', evtInit));
            el.dispatchEvent(new KeyboardEvent('keyup',   evtInit));
          }
        }
        i++;
      } else if (ch === '\t') {
        moveFocus(el, 1);
        i++;
      } else {
        let j = i;
        while (j < text.length && text[j] !== '\b' && text[j] !== '\n' && text[j] !== '\t') j++;
        insertAtCaret(el, text.slice(i, j));
        i = j;
      }
    }
    return;
  }

  // No real input focused — synthesize keydowns per character so screens
  // like radio's ZIP entry (which listens to window.keydown and accumulates
  // digits into state) react identically to a USB keyboard.
  for (const ch of text) {
    let key = ch;
    if (ch === '\b') key = 'Backspace';
    else if (ch === '\n') key = 'Enter';
    else if (ch === '\t') key = 'Tab';
    const evtInit = { key, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', evtInit));
    window.dispatchEvent(new KeyboardEvent('keyup',   evtInit));
  }
}

function reactValueSetter(el) {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  return desc && desc.set;
}

function insertAtCaret(el, chunk) {
  const start = el.selectionStart != null ? el.selectionStart : el.value.length;
  const end   = el.selectionEnd   != null ? el.selectionEnd   : start;
  const newVal = el.value.slice(0, start) + chunk + el.value.slice(end);
  const setter = reactValueSetter(el);
  if (setter) setter.call(el, newVal); else el.value = newVal;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const caret = start + chunk.length;
  try { el.selectionStart = el.selectionEnd = caret; } catch (_) { /* number inputs */ }
}

function backspaceInput(el) {
  const start = el.selectionStart != null ? el.selectionStart : el.value.length;
  const end   = el.selectionEnd   != null ? el.selectionEnd   : start;
  if (start === 0 && end === 0) return;
  const cutFrom = end > start ? start : start - 1;
  const newVal = el.value.slice(0, cutFrom) + el.value.slice(end);
  const setter = reactValueSetter(el);
  if (setter) setter.call(el, newVal); else el.value = newVal;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  try { el.selectionStart = el.selectionEnd = cutFrom; } catch (_) { /* noop */ }
}

function moveFocus(el, dir) {
  const focusable = Array.from(document.querySelectorAll(
    'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
  ));
  if (focusable.length === 0) return;
  const idx = focusable.indexOf(el);
  // When nothing focusable is currently active (e.g. focus is on <body>
  // because the screen just mounted), land on the first/last focusable
  // depending on direction. Without this, the very first D-pad press
  // from a remote on a form-heavy screen would no-op.
  const next = idx < 0
    ? (dir > 0 ? focusable[0] : focusable[focusable.length - 1])
    : focusable[(idx + dir + focusable.length) % focusable.length];
  if (next && typeof next.focus === 'function') next.focus();
}


function TVApp() {
  const [screen, setScreen] = useState('home');
  // Initial focus lands on the first installed app rather than the hero.
  // Until Headwaters / Continue Watching data wires up there is no real
  // hero content to highlight — landing on the apps row means a launchable
  // tile (YouTube, etc.) is pre-focused and Enter immediately works.
  const [focus, setFocus] = useState({ row: 'apps', col: 0, rowY: 0 });

  // App-tile launches dispatch a 'playbill:navigate' CustomEvent (see
  // data.js TV_APPS.launch) and we route here. Keeps screen state owned
  // by the App component without prop-drilling into deep child cards.
  useEffect(() => {
    function onNavigate(e) {
      const target = e && e.detail && e.detail.screen;
      if (!target) return;
      setScreen(target);
      setFocus(initialFocusFor(target));
      setSideNav({ focused: false, hovered: false });
    }
    window.addEventListener('playbill:navigate', onNavigate);
    return () => window.removeEventListener('playbill:navigate', onNavigate);
  }, []);

  // nav.dpad events from the controller (CAN/MQTT/PWA remote) → synthetic
  // DOM KeyboardEvents on window. Every screen in the shell already listens
  // for keydown to drive focus, so funneling through the keyboard path
  // means there is exactly one code path for navigation regardless of
  // whether the input comes from a USB keyboard, a local IR remote, or a
  // remote-style CAN device on the rig bus. Mapping:
  //   up/down/left/right → Arrow* (handled by app.jsx + per-screen handlers)
  //   select             → Enter
  //   back               → Escape (returns to home from any screen)
  //   home               → 'h'    (existing global Home handler)
  //   menu               → ContextMenu (new case below opens the side nav)
  useEffect(() => {
    if (!window.playbill || !window.playbill.controller ||
        typeof window.playbill.controller.onNavDpad !== 'function') return;
    const KEY_MAP = {
      up:     'ArrowUp',
      down:   'ArrowDown',
      left:   'ArrowLeft',
      right:  'ArrowRight',
      select: 'Enter',
      back:   'Escape',
      home:   'h',
      menu:   'ContextMenu',
    };
    const unsub = window.playbill.controller.onNavDpad(({ key } = {}) => {
      const domKey = KEY_MAP[key];
      if (!domKey) return;
      // Mirror a real keyboard press: keydown → keyup. Bubble + cancelable
      // so per-screen window listeners (radio.jsx etc.) see it identically
      // to a USB keyboard event.
      const evtInit = { key: domKey, bubbles: true, cancelable: true };
      window.dispatchEvent(new KeyboardEvent('keydown', evtInit));
      window.dispatchEvent(new KeyboardEvent('keyup',   evtInit));
    });
    return () => { try { unsub && unsub(); } catch (_) { /* noop */ } };
  }, []);

  // nav.text — bulk text from a remote soft keyboard (PWA). Two delivery
  // modes depending on what's focused:
  //   • Real <input>/<textarea>  → set the value through the prototype's
  //     value setter and dispatch a bubbling 'input' event so React's
  //     controlled inputs pick it up. Bulk apply, one re-render.
  //   • Anything else (radio ZIP, etc.) → synthesize a keydown per char so
  //     state-machine screens react identically to a USB keyboard.
  // Special characters: '\b' Backspace, '\n' Enter/submit, '\t' Tab.
  useEffect(() => {
    if (!window.playbill || !window.playbill.controller ||
        typeof window.playbill.controller.onNavText !== 'function') return;
    const unsub = window.playbill.controller.onNavText(({ text } = {}) => {
      if (typeof text !== 'string' || text.length === 0) return;
      applyRemoteText(text);
    });
    return () => { try { unsub && unsub(); } catch (_) { /* noop */ } };
  }, []);

  // First-run gate: subscribe to controller state. While the controller
  // is unconfigured (no MQTT credentials yet), force the user to Settings
  // before showing the home grid. Once configured, the user can navigate
  // freely and may visit Settings via the side nav.
  const [ctrlState, setCtrlState] = useState(null);
  useEffect(() => {
    if (!window.playbill || !window.playbill.controller) return;
    let unsubState, unsubStatus;
    (async () => {
      try {
        const init = await window.playbill.controller.getState();
        setCtrlState(init.state);
        if (init.state && init.state.connection &&
            init.state.connection.status === 'unconfigured') {
          setScreen('settings');
        }
      } catch (_) { /* controller may not be up yet — Settings will show offline state */ }
      unsubState  = window.playbill.controller.onState((s)  => setCtrlState(s));
      unsubStatus = window.playbill.controller.onStatus(({ connected }) => {
        if (!connected) setCtrlState(null);
      });
    })();
    return () => { unsubState && unsubState(); unsubStatus && unsubStatus(); };
  }, []);
  const [sideNav, setSideNav] = useState({ focused: false, hovered: false });
  const [clock, setClock] = useState('');

  // Clock
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setClock(d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    };
    tick();
    const iv = setInterval(tick, 30000);
    return () => clearInterval(iv);
  }, []);

  // Row schema per screen — defines nav bounds. App-row widths track the
  // actual data length so we don't strand focus on empty tiles.
  const appsCount = (window.TV_DATA && window.TV_DATA.apps && window.TV_DATA.apps.length) || 0;
  const ROWS = useMemo(() => ({
    home: [
      { id: 'hero',     cols: 3 },
      { id: 'continue', cols: 5 },
      { id: 'apps',     cols: Math.max(1, Math.min(8, appsCount)) },
      { id: 'trails',   cols: 7 },
      { id: 'movies',   cols: 9 },
    ],
    apps: [
      { id: 'apps', cols: Math.max(1, appsCount) },
    ],
    live: [
      { id: 'live-ctrl', cols: 1 },
      { id: 'epg',       cols: 1, vertical: 64 }, // channel grid is vertical
    ],
    radio: [
      { id: 'radio-band',    cols: 4 },    // FM, AM, Scanner, Scan
      { id: 'radio-dial',    cols: 1 },    // FM/AM dial OR Scanner ZIP entry
      { id: 'radio-scan',    cols: 60 },   // FM/AM scan results OR scanner station list
      { id: 'radio-presets', cols: 10 },
    ],
    local: [
      { id: 'lib-filter', cols: 5 },
      { id: 'lib-grid',   cols: 7 },
    ],
    rig: [
      { id: 'cams', cols: 4 },
    ],
  }), [appsCount]);

  const SIDE_IDS = ['nav-home','nav-apps','nav-live','nav-radio','nav-local','nav-rig','nav-search','nav-settings'];

  // Keyboard handler
  useEffect(() => {
    const onKey = (e) => {
      // Form-heavy screens — for a real keyboard, the browser's native
      // focus handles Tab / arrows / typing. We only intercept H (and only
      // when no input is focused, so the user can type "h" in the search
      // box). For the remote, synthetic KeyboardEvents have isTrusted=false
      // and the browser will NOT walk Tab focus or activate buttons on
      // Enter from them — and the remote has no Tab key anyway. So when
      // the event is synthetic, translate D-pad arrows into focus walking
      // and Enter into a click/submit on the active element.
      if (screen === 'settings' || screen === 'youtube') {
        const inField = e.target && /^(input|textarea|select|button)$/i.test(e.target.tagName);
        if ((e.key === 'h' || e.key === 'H') && !inField) {
          setScreen('home');
          setSideNav({focused:false, hovered:false});
        }
        if (e.key === 'Escape' && !inField) {
          setScreen('apps');
          setSideNav({focused:false, hovered:false});
        }
        if (e.key === 'ContextMenu') {
          setSideNav({ focused: true, hovered: true, focusIdx: screenToNavIdx(screen) });
          e.preventDefault();
        }
        if (!e.isTrusted) {
          const active = document.activeElement;
          if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
            moveFocus(active, 1);
            e.preventDefault();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
            moveFocus(active, -1);
            e.preventDefault();
          } else if (e.key === 'Enter') {
            if (active && active.tagName === 'BUTTON') {
              active.click();
              e.preventDefault();
            } else if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
                       && active.form && typeof active.form.requestSubmit === 'function') {
              active.form.requestSubmit();
              e.preventDefault();
            }
          }
        }
        return;
      }

      // Home key takes you to home screen from anywhere
      if (e.key === 'h' || e.key === 'H') { setScreen('home'); setFocus({row:'hero', col:0, rowY:0}); setSideNav({focused:false, hovered:false}); return; }
      if (e.key === 'Escape' || e.key === 'Backspace') { setScreen('home'); setFocus({row:'hero', col:0, rowY:0}); setSideNav({focused:false, hovered:false}); return; }
      // Remote 'menu' button → open the side nav focused. The side nav IS
      // the global menu in this UI; mapping menu to it gives a remote user
      // one-press access to every screen.
      if (e.key === 'ContextMenu') {
        setSideNav({ focused: true, hovered: true, focusIdx: screenToNavIdx(screen) });
        e.preventDefault();
        return;
      }

      // Side nav navigation
      if (sideNav.focused) {
        if (e.key === 'ArrowUp') {
          setSideNav(s => ({ ...s, focusIdx: Math.max(0, (s.focusIdx ?? 0) - 1) }));
        } else if (e.key === 'ArrowDown') {
          setSideNav(s => ({ ...s, focusIdx: Math.min(SIDE_IDS.length - 1, (s.focusIdx ?? 0) + 1) }));
        } else if (e.key === 'ArrowRight') {
          setSideNav({ focused: false, hovered: false });
        } else if (e.key === 'Enter' || e.key === ' ') {
          const target = SIDE_IDS[sideNav.focusIdx ?? 0].replace('nav-', '');
          if (target !== 'search') {
            setScreen(target);
            setFocus(initialFocusFor(target));
            setSideNav({ focused: false, hovered: false });
          }
        }
        e.preventDefault();
        return;
      }

      // Content navigation
      const schema = ROWS[screen];
      if (!schema) return;
      const curIdx = schema.findIndex(r => r.id === focus.row);
      const curRow = schema[curIdx] || schema[0];

      if (e.key === 'ArrowLeft') {
        if (focus.col === 0) {
          // Open side nav
          setSideNav({ focused: true, hovered: true, focusIdx: screenToNavIdx(screen) });
        } else {
          setFocus(f => ({ ...f, col: Math.max(0, f.col - 1) }));
        }
      } else if (e.key === 'ArrowRight') {
        setFocus(f => ({ ...f, col: Math.min(curRow.cols - 1, f.col + 1) }));
      } else if (e.key === 'ArrowDown') {
        if (curRow.vertical) {
          setFocus(f => ({ ...f, rowY: Math.min(curRow.vertical - 1, f.rowY + 1) }));
        } else if (curIdx < schema.length - 1) {
          const next = schema[curIdx + 1];
          setFocus(f => ({
            row: next.id,
            col: Math.min(next.cols - 1, f.col),
            rowY: 0,
          }));
        }
      } else if (e.key === 'ArrowUp') {
        if (curRow.vertical && focus.rowY > 0) {
          setFocus(f => ({ ...f, rowY: f.rowY - 1 }));
        } else if (curIdx > 0) {
          setFocus(f => ({ row: schema[curIdx - 1].id, col: Math.min(schema[curIdx - 1].cols - 1, f.col), rowY: 0 }));
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        // Launch the focused app card. Same dispatch from both screens —
        // home shows the first 8 apps in a strip, apps screen shows them all
        // in a grid; index into D.apps in both cases.
        if ((screen === 'home' || screen === 'apps') && focus.row === 'apps') {
          const app = (window.TV_DATA && window.TV_DATA.apps || [])[focus.col];
          if (app && window.TV_APPS && window.TV_APPS.launch) {
            window.TV_APPS.launch(app);
          }
        }
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus, screen, sideNav, ROWS]);

  function initialFocusFor(s) {
    if (s === 'home')  return { row: 'apps',    col: 0, rowY: 0 };
    if (s === 'apps')  return { row: 'apps',    col: 0, rowY: 0 };
    if (s === 'live')  return { row: 'epg',     col: 0, rowY: 0 };
    if (s === 'radio') return { row: 'radio-band', col: 0, rowY: 0 };
    if (s === 'local') return { row: 'lib-filter', col: 0, rowY: 0 };
    if (s === 'rig')   return { row: 'cams',    col: 0, rowY: 0 };
    if (s === 'settings') return { row: 'settings', col: 0, rowY: 0 };
    return { row: 'hero', col: 0, rowY: 0 };
  }
  function screenToNavIdx(s) { return SIDE_IDS.findIndex(id => id === 'nav-' + s); }

  const focusedNavId = sideNav.focused ? SIDE_IDS[sideNav.focusIdx ?? 0] : null;

  return (
    <div className="tv-screen">
      <TopBar clock={clock} />
      <SideNav
        active={screen}
        onSelect={(s) => { setScreen(s); setFocus(initialFocusFor(s)); setSideNav({focused:false, hovered:false}); }}
        focusId={focusedNavId}
        expanded={sideNav.focused || sideNav.hovered}
        onHover={(v) => setSideNav(s => ({ ...s, hovered: v }))}
      />

      <div className="tv-content" style={{ left: (sideNav.focused || sideNav.hovered) ? 260 : 96 }}>
        {screen === 'home'     && <HomeView     focus={focus} />}
        {screen === 'apps'     && <AppsView     focus={focus} />}
        {screen === 'live'     && <LiveView     focus={focus} />}
        {screen === 'radio'    && <RadioView    focus={focus} setFocus={setFocus} />}
        {screen === 'local'    && <LocalView    focus={focus} />}
        {screen === 'rig'      && <RigView      focus={focus} />}
        {screen === 'settings' && <SettingsView focus={focus} />}
        {screen === 'youtube'  && <YoutubeView />}
      </div>

      <NowPlayingBar />
      <RemoteHint />
    </div>
  );
}

Object.assign(window, { TVApp });
