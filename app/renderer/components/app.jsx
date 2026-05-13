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

  // When changing to a zone-root screen (Settings / YouTube), drop focus
  // into the screen so the first remote press lands somewhere useful
  // instead of staying on <body>. Uses rAF so the new screen's DOM is
  // mounted before we look up its root.
  useEffect(() => {
    if (screen !== 'settings' && screen !== 'youtube' && screen !== 'rig' && screen !== 'explore') return;
    const id = requestAnimationFrame(() => {
      if (!window.FocusZones || !window.FocusZones.getRoot) return;
      const root = window.FocusZones.getRoot();
      if (root) window.FocusZones.enterZone(root);
    });
    return () => cancelAnimationFrame(id);
  }, [screen]);

  // ─── Navigation routing — two lanes ────────────────────────────────
  //
  // GLOBAL commands (home, back, menu, …) must always work regardless of
  // which screen is mounted or what element has DOM focus. They are
  // invoked directly via the helper fns below — they NEVER ride the
  // DOM KeyboardEvent path, so no per-screen listener can stop them. To
  // add a new global command (e.g. 'power'), wire it into the GLOBAL map
  // in the dpad subscriber below; every screen, current and future,
  // inherits the correct behavior with no extra work.
  //
  // CONTENT commands (up/down/left/right/select) DO ride the KeyboardEvent
  // path so per-screen focus engines (radio, live, the home grid) can
  // interpret them within their own row/col state. Per-screen handlers
  // are free to e.stopPropagation() these without breaking global nav.
  //
  // The keyboard onKey handler further down honors the same split — 'h'
  // and Escape call the helpers below, so a USB keyboard and a remote
  // dpad end up running the exact same code.

  // screenRef so the dpad subscriber (registered once on mount) always
  // sees the current screen when computing the back target.
  const screenRef = useRef(screen);
  useEffect(() => { screenRef.current = screen; }, [screen]);

  // Helper: Home from anywhere — resets the shell to its just-opened state.
  const goHome = () => {
    stopPlaybackIfRunning();
    setScreen('home');
    setFocus(initialFocusFor('home'));
    setSideNav({ focused: false, hovered: false });
  };
  // Helper: Back — exits the current screen to its parent. Settings/YouTube/
  // Cast all sit under Apps; everything else returns to the home grid.
  // (Cast doesn't go through transport.stop — the CastView's unmount effect
  // fires cast.stop on the controller, which kills UxPlay.)
  const goBack = () => {
    stopPlaybackIfRunning();
    const cur = screenRef.current;
    // Explore is reached from the side nav and has no logical "parent
    // screen," so Back goes home — same convention as Rig/Radio/Live.
    const parent = (cur === 'settings' || cur === 'youtube' || cur === 'cast') ? 'apps' : 'home';
    setScreen(parent);
    setFocus(initialFocusFor(parent));
    setSideNav({ focused: false, hovered: false });
  };
  // Helper: focus the SideNav at the current screen's row. Reached by
  // pressing Left from the leftmost zone of any screen — never by a
  // dedicated key. (The Argon Remote's Menu key is RESERVED; see
  // docs/app/navigation.md.)
  const openSideNavMenu = () => {
    setSideNav({ focused: true, hovered: true, focusIdx: screenToNavIdx(screenRef.current) });
  };

  useEffect(() => {
    if (!window.playbill || !window.playbill.controller ||
        typeof window.playbill.controller.onNavDpad !== 'function') return;

    // Per the contract (docs/app/navigation.md): only Home and Back are
    // global hierarchy keys. Menu is reserved for future contextual
    // options and is a no-op for now — drop it on the floor so we don't
    // accidentally tie behavior to it.
    const GLOBAL = {
      home: goHome,
      back: goBack,
      menu: () => { /* reserved — see docs/app/navigation.md */ },
    };
    const KEY_MAP = {
      up:     'ArrowUp',
      down:   'ArrowDown',
      left:   'ArrowLeft',
      right:  'ArrowRight',
      select: 'Enter',
    };

    const unsub = window.playbill.controller.onNavDpad(({ key } = {}) => {
      const handler = GLOBAL[key];
      if (handler) { handler(); return; }
      const domKey = KEY_MAP[key];
      if (!domKey) return;
      // Dispatch on the focused DOM node so React's delegated onKeyDown
      // handlers (YouTube's yt-card etc.) fire. Window-level listeners
      // (radio.jsx, app.jsx onKey below) still see it via the bubble path.
      const target = document.activeElement || document.body;
      const evtInit = { key: domKey, bubbles: true, cancelable: true };
      target.dispatchEvent(new KeyboardEvent('keydown', evtInit));
      target.dispatchEvent(new KeyboardEvent('keyup',   evtInit));
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
  // Latest nowPlaying mirrored into a ref so the keydown handler can call
  // transport.stop without re-registering on every state delta. We don't
  // want the keydown handler in ctrlState's dependency array — it patches
  // many times per second while a video plays.
  const nowPlayingRef = useRef(null);
  useEffect(() => {
    if (!window.playbill || !window.playbill.controller) return;
    let unsubState, unsubStatus;
    (async () => {
      try {
        const init = await window.playbill.controller.getState();
        setCtrlState(init.state);
        nowPlayingRef.current = init.state && init.state.nowPlaying || null;
        if (init.state && init.state.connection &&
            init.state.connection.status === 'unconfigured') {
          setScreen('settings');
        }
      } catch (_) { /* controller may not be up yet — Settings will show offline state */ }
      unsubState  = window.playbill.controller.onState((s)  => {
        setCtrlState(s);
        nowPlayingRef.current = s ? (s.nowPlaying || null) : null;
      });
      unsubStatus = window.playbill.controller.onStatus(({ connected }) => {
        if (!connected) { setCtrlState(null); nowPlayingRef.current = null; }
      });
    })();
    return () => { unsubState && unsubState(); unsubStatus && unsubStatus(); };
  }, []);

  // Helper: stop any in-flight playback before navigating Home/Back. Without
  // this, pressing Home or Back while a YouTube video is playing leaves
  // mpv running in the background (the Electron UI changes screen, but
  // audio/video keeps going). Fire-and-forget — the controller's
  // transport.stop is a no-op when nothing is playing, so an extra call on
  // every Back/Home press is cheap.
  function stopPlaybackIfRunning() {
    if (!nowPlayingRef.current) return;
    if (!window.playbill || !window.playbill.controller) return;
    window.playbill.controller.command({ action: 'transport.stop' })
      .catch((e) => console.warn('[app] transport.stop on nav-exit failed:', e && e.message));
  }
  const [sideNav, setSideNav] = useState({ focused: false, hovered: false });
  const [clock, setClock] = useState('');

  // Live clock — ticks every second so seconds advance visibly. The
  // displayed string includes seconds because we want the user to see
  // the rig is alive at a glance (no "stuck at 9:42 for ten minutes"
  // ambiguity). Source is JS Date(), which reads the system clock —
  // the time-sync handler keeps that disciplined against GNSS time
  // from the CAN bus.
  useEffect(() => {
    function tick() {
      const d = new Date();
      setClock(d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }));
    }
    tick();
    // Align the first tick to the next wall-clock second so the display
    // ticks at the same moment the seconds digit changes, not mid-second.
    let iv;
    const align = setTimeout(() => {
      tick();
      iv = setInterval(tick, 1000);
    }, 1000 - (Date.now() % 1000));
    return () => { clearTimeout(align); if (iv) clearInterval(iv); };
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
    // Rig uses the spatial focus engine (data-zone-root); no row schema needed.
  }), [appsCount]);

  const SIDE_IDS = ['nav-home','nav-apps','nav-live','nav-radio','nav-local','nav-explore','nav-rig','nav-search','nav-settings'];

  // Keyboard handler
  useEffect(() => {
    const onKey = (e) => {
      // Zone-root screens (Settings, YouTube, Rig — anything tagged with
      // data-zone-root). The spatial focus engine handles all d-pad
      // navigation per docs/app/navigation.md. This branch ONLY enforces
      // the universal contract that every screen inherits:
      //
      //   H              → Home
      //   Esc | Backspace→ Back   (both treated identically; the IR remote's
      //                            "Back" button delivers KEY_ESC, BUT the
      //                            keymap also accepts Backspace so a normal
      //                            keyboard works the same way)
      //   Left at edge   → open SideNav (after FocusZones decides it can't
      //                                  move further left within the tree)
      //
      // A new screen gets all of this for free by tagging its root with
      // data-zone-root + data-zone + data-zone-axis. Nothing else needed.
      if (window.FocusZones && window.FocusZones.getRoot && window.FocusZones.getRoot()) {
        const inField = e.target && /^(input|textarea|select)$/i.test(e.target.tagName);
        if ((e.key === 'h' || e.key === 'H') && !inField) { goHome(); e.preventDefault(); return; }
        if ((e.key === 'Escape' || e.key === 'Backspace') && !inField) {
          // Backspace inside an input is "delete a character" — only treat
          // it as Back when no text field is focused.
          goBack(); e.preventDefault(); return;
        }

        // Hand the directional/activate keys to the zone engine.
        const handled = window.FocusZones.handleKeydown(e);
        if (handled) return;

        // FocusZones declined. Two reasons:
        //  1. Real keyboard Left/Right in a text field — let the browser
        //     handle cursor movement.
        //  2. Directional move at the screen-root edge — Left here means
        //     "escape to the SideNav".
        const cursorEdit = inField && e.isTrusted &&
                           (e.key === 'ArrowLeft' || e.key === 'ArrowRight');
        if (cursorEdit) return;
        if (e.key === 'ArrowLeft') {
          openSideNavMenu();
          e.preventDefault();
        }
        return;
      }

      // Global navigation shortcuts — share goHome/goBack with the remote
      // dpad path so keyboard and remote behave identically.
      if (e.key === 'h' || e.key === 'H') { goHome(); return; }
      if (e.key === 'Escape' || e.key === 'Backspace') { goBack(); return; }
      // ContextMenu / remote Menu intentionally NOT handled here. The
      // Menu key is reserved for future contextual options per
      // docs/app/navigation.md — adding a handler now would re-introduce
      // the "too many ways to open the side nav" confusion.

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
    if (s === 'rig')   return { row: 'rig',     col: 0, rowY: 0 };
    if (s === 'explore') return { row: 'explore', col: 0, rowY: 0 };
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
        {screen === 'explore'  && <ExploreView />}
        {screen === 'settings' && <SettingsView focus={focus} />}
        {screen === 'youtube'  && <YoutubeView />}
        {screen === 'cast'     && <CastView />}
      </div>

      <NowPlayingBar />
      <RemoteHint />
      <DvdPrompt />
    </div>
  );
}

Object.assign(window, { TVApp });
