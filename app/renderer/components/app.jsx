/* TV App — focus state, keyboard nav, view switching */

function TVApp() {
  const [screen, setScreen] = useState('home');
  const [focus, setFocus] = useState({ row: 'hero', col: 0, rowY: 0 });
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

  // Row schema per screen — defines nav bounds
  const ROWS = useMemo(() => ({
    home: [
      { id: 'hero',     cols: 3 },
      { id: 'continue', cols: 5 },
      { id: 'apps',     cols: 8 },
      { id: 'trails',   cols: 7 },
      { id: 'movies',   cols: 9 },
    ],
    apps: [
      { id: 'apps', cols: 12 }, // 2 rows of 6
    ],
    live: [
      { id: 'live-ctrl', cols: 2 },
      { id: 'epg', cols: 4, vertical: 6 }, // 6 channels × 4 shows
    ],
    local: [
      { id: 'lib-filter', cols: 5 },
      { id: 'lib-grid',   cols: 7 },
    ],
    rig: [
      { id: 'cams', cols: 4 },
    ],
  }), []);

  const SIDE_IDS = ['nav-home','nav-apps','nav-live','nav-local','nav-rig','nav-search','nav-settings'];

  // Keyboard handler
  useEffect(() => {
    const onKey = (e) => {
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
          if (target !== 'settings' && target !== 'search') {
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
        // Noop — focus ring is what we show
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus, screen, sideNav, ROWS]);

  function initialFocusFor(s) {
    if (s === 'home')  return { row: 'hero',    col: 0, rowY: 0 };
    if (s === 'apps')  return { row: 'apps',    col: 0, rowY: 0 };
    if (s === 'live')  return { row: 'epg',     col: 0, rowY: 0 };
    if (s === 'local') return { row: 'lib-filter', col: 0, rowY: 0 };
    if (s === 'rig')   return { row: 'cams',    col: 0, rowY: 0 };
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
        {screen === 'home'  && <HomeView  focus={focus} />}
        {screen === 'apps'  && <AppsView  focus={focus} />}
        {screen === 'live'  && <LiveView  focus={focus} />}
        {screen === 'local' && <LocalView focus={focus} />}
        {screen === 'rig'   && <RigView   focus={focus} />}
      </div>

      <NowPlayingBar />
      <RemoteHint />
    </div>
  );
}

Object.assign(window, { TVApp });
