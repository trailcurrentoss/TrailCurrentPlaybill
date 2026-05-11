/* TV App — focus state, keyboard nav, view switching */

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
      // Form-heavy screens — let the browser's native focus handle Tab /
      // arrows / typing. We only intercept H (and only when no input is
      // focused, so the user can type "h" in the search box).
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
        return;
      }

      // Home key takes you to home screen from anywhere
      if (e.key === 'h' || e.key === 'H') { setScreen('home'); setFocus({row:'hero', col:0, rowY:0}); setSideNav({focused:false, hovered:false}); return; }
      if (e.key === 'Escape' || e.key === 'Backspace') { setScreen('home'); setFocus({row:'hero', col:0, rowY:0}); setSideNav({focused:false, hovered:false}); return; }

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
