/* Explore View — vector-tile map served by the Headwaters tile server.
   Lets the user pan and zoom around the world (or their immediate
   surroundings if a GPS fix has come through on telemetry) using only
   the remote's D-pad.

   Tile / style / sprite / font fetches all land on the Headwaters host
   (whichever hostname is configured in connection.brokerUrl):

     GET https://<host>/styles/<style>/style.json   (referenced sprites/fonts/tile URLs all anchor here)
     GET https://<host>/data/<source>/{z}/{x}/{y}…  (tile payloads)
     GET https://<host>/fonts/…                     (glyph PBFs)
     GET https://<host>/sprites/…                   (icon atlas)

   None of those routes go through the bearer-token auth middleware
   (see containers/frontend/nginx.conf — only /api/ is gated), so we
   don't need to attach the saved API key to map requests. The
   Authorization header would only break browser cache + add CORS
   surprises.

   D-pad mode (the canvas is the exception to the universal zone
   contract, same way the fullscreen video player is — see
   docs/app/navigation.md):

     ▲▼◀▶ → pan
     OK   → step through zoom presets (overview → regional → street)
     Back → exit screen (handled globally by app.jsx)

   Keyboard niceties for desk usage:
     + / =  zoom in by 1
     - / _  zoom out by 1
     r / R  recenter on the rig's current GPS fix */

// Hooks (useState/useEffect/useRef) come from react-globals.js — re-
// declaring them here would `SyntaxError: already declared` because every
// component script shares one global lexical environment with chrome.js,
// which already binds the same identifiers.

// Map cycle — distinct enough zoom levels that one OK press visibly moves
// the user between "where am I in the country" / "what's the next town"
// / "what's around this block." Cycles back to overview from the deepest
// preset so the user can always retreat with the same key.
const ZOOM_PRESETS = [4, 9, 13, 17];

// Extract host from a broker URL. `mqtts://` is a non-special scheme under
// WHATWG URL — Chromium parses it with an opaque path, so
// `new URL("mqtts://host:port").hostname` returns "" in the renderer (it
// works in Node, which is why the regression wasn't caught upstream). We
// normalize to https:// before parsing so .hostname always populates.
function parseBrokerHost(brokerUrl) {
  if (!brokerUrl || typeof brokerUrl !== 'string') return null;
  try {
    return new URL(brokerUrl.replace(/^[a-z]+:\/\//i, 'https://')).hostname || null;
  } catch (_) { return null; }
}

function ExploreView() {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const vehiclePosRef = useRef(null);

  const [host, setHost]               = useState(null);
  const [theme, setTheme]             = useState(document.documentElement.getAttribute('data-theme') || 'dark');
  // Map theme is independent of the GNOME shell theme — see comment near
  // the style URL build. Defaults to light because that's easier to read at
  // a glance from across a rig cabin. Persists via localStorage so the
  // user's choice survives reloads and reboots.
  const [mapTheme, setMapTheme]       = useState(() => {
    try { return localStorage.getItem('playbill.explore.mapTheme') || 'light'; }
    catch (_) { return 'light'; }
  });
  const [vehiclePos, setVehiclePos]   = useState(null); // {lat, lng}
  const [followVehicle, setFollow]    = useState(true);
  const [error, setError]             = useState(null);
  // D-pad mode: 'pan' (arrows move the map) or 'zoom' (up/right zoom in,
  // down/left zoom out). OK on the remote (Enter on a keyboard) toggles
  // between them — a single button that switches the whole d-pad
  // interpretation is the simplest "one-handed" map control we can give
  // someone driving a remote. Persisted so the user's preferred default
  // sticks across launches.
  const [navMode, setNavMode]         = useState(() => {
    try { return localStorage.getItem('playbill.explore.navMode') || 'pan'; }
    catch (_) { return 'pan'; }
  });
  // Keep the latest navMode in a ref so the canvas-local keydown handler
  // (bound once at mount) always reads the current value without rebinding.
  const navModeRef = useRef(navMode);
  useEffect(() => { navModeRef.current = navMode; }, [navMode]);

  // Contextual popup menu, opened by the remote's reserved Menu button or
  // keyboard `m`/`ContextMenu`. While open the d-pad navigates the menu
  // (↑↓ move selection, Enter activates, Esc/Back/Menu close) and the map
  // pan/zoom handlers no-op. Closing returns control to the map.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIdx,  setMenuIdx]  = useState(0);
  const menuOpenRef = useRef(menuOpen);
  const menuIdxRef  = useRef(menuIdx);
  useEffect(() => { menuOpenRef.current = menuOpen; }, [menuOpen]);
  useEffect(() => { menuIdxRef.current  = menuIdx;  }, [menuIdx]);

  // Keep a ref of vehiclePos so the OK→recenter handler has a stable read
  // without re-binding on every GPS tick.
  useEffect(() => { vehiclePosRef.current = vehiclePos; }, [vehiclePos]);

  // ─── Pull controller state: broker host + live GPS ────────────────
  useEffect(() => {
    if (!window.playbill || !window.playbill.controller) return;
    let unsub;
    function apply(s) {
      if (!s) return;
      const broker = s.connection && s.connection.brokerUrl;
      if (broker) {
        const h = parseBrokerHost(broker);
        if (h) setHost(h);
      }
      const loc = s.telemetry && s.telemetry.location;
      if (loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
        setVehiclePos({ lat: loc.latitude, lng: loc.longitude });
      }
    }
    (async () => {
      try {
        const init = await window.playbill.controller.getState();
        apply(init && init.state);
      } catch (_) { /* controller may not be up yet */ }
      unsub = window.playbill.controller.onState(apply);
    })();
    return () => { if (unsub) unsub(); };
  }, []);

  // Follow GNOME's light/dark preference live — match the rest of the
  // shell. data-theme is patched on <html> by bootstrap-theme.js.
  useEffect(() => {
    const obs = new MutationObserver(() => {
      const nt = document.documentElement.getAttribute('data-theme') || 'dark';
      setTheme(nt);
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  // ─── Init the MapLibre instance ───────────────────────────────────
  // Re-runs when the host or theme changes. We tear down + rebuild
  // because setStyle on an in-flight map can flash and break sources.
  useEffect(() => {
    if (!host) return;
    if (!window.maplibregl) { setError('MapLibre failed to load'); return; }
    if (!containerRef.current) return;

    // setWorkerUrl can only be called once per page load. Wrap in a
    // try/catch so a second mount (after navigating away and back) is
    // a no-op rather than a fatal error.
    try { maplibregl.setWorkerUrl('vendor/maplibre/maplibre-gl-csp-worker.js'); }
    catch (_) { /* already set */ }

    // Headwaters tileserver style names. The map's own theme is independent
    // of GNOME's light/dark preference — a dark UI shell can still want a
    // light basemap (and vice versa) because Explore is primarily a "where
    // am I" map, not a styled UI surface. User toggles via the toolbar;
    // the choice persists in localStorage across launches.
    const styleName = mapTheme === 'dark' ? '3d-dark' : '3d';
    const styleUrl = `https://${host}/styles/${styleName}/style.json`;
    console.log(`[explore] init map host=${host} style=${styleUrl}`);

    const seed = vehiclePosRef.current;
    const center = seed ? [seed.lng, seed.lat] : [-98.5795, 39.8283];
    const zoom   = seed ? ZOOM_PRESETS[2]      : ZOOM_PRESETS[0];

    let map;
    try {
      map = new maplibregl.Map({
        container:           containerRef.current,
        style:               styleUrl,
        center, zoom,
        attributionControl:  { compact: true, customAttribution: '© OpenStreetMap' },
        // Disable handlers that don't make sense on a TV. Touch* are
        // gated behind a real touchscreen which Playbill never has.
        keyboard:            false,   // we own keys via the canvas-local listener
        dragRotate:          false,
        pitchWithRotate:     false,
        boxZoom:             false,
        cooperativeGestures: false,
      });
    } catch (e) {
      console.error('[explore] map ctor threw:', e);
      setError(e && e.message || String(e));
      return;
    }

    mapRef.current = map;
    setError(null);

    map.on('error', (e) => {
      const err = e && e.error;
      const msg = (err && (err.message || err.status || (err.target && err.target.responseURL))) || (e && e.type) || 'unknown';
      const url = (err && err.url) || (err && err.target && err.target.responseURL) || '';
      console.warn('[explore] map.error:', msg, url ? `url=${url}` : '');
      setError(url ? `${msg} (${url})` : String(msg));
    });
    // Echo every source-data event so the renderer log shows the exact tile
    // URL MapLibre is trying — invaluable for diagnosing silent fetches that
    // never trip the 'error' event. Disabled once Explore is reliable.
    map.on('sourcedata', (e) => {
      if (!e.isSourceLoaded && !e.tile) return;
      const what = e.tile ? `tile ${e.tile.tileID && e.tile.tileID.canonical && [e.tile.tileID.canonical.z, e.tile.tileID.canonical.x, e.tile.tileID.canonical.y].join('/')}` : `source ${e.sourceId}`;
      console.log(`[explore] sourcedata ${what} loaded=${!!e.isSourceLoaded}`);
    });
    map.on('styledata', () => console.log('[explore] styledata'));
    map.on('load', () => {
      console.log('[explore] map loaded');
      // Diagnose blank-canvas issues: dump container + canvas dimensions
      // + WebGL capability so the renderer log tells us whether the canvas
      // is too small to paint (a 0×0 box loads tiles fine but renders to
      // nothing visible) and which GL version we ended up on.
      try {
        const c = containerRef.current;
        const cnv = c && c.querySelector('canvas');
        const gl = cnv && (cnv.getContext('webgl2') || cnv.getContext('webgl'));
        // Walk up the parent chain so we can pinpoint exactly where the
        // height collapses. Each entry is `<tag>.<class>=<clientH>x<clientW>`.
        const chain = [];
        let n = c;
        while (n && chain.length < 8) {
          const cls = (n.className && n.className.toString().split(/\s+/)[0]) || '';
          chain.push(`${n.tagName}.${cls}=${n.clientHeight}x${n.clientWidth}`);
          n = n.parentElement;
        }
        const info = {
          container_w: c ? c.clientWidth : null,
          container_h: c ? c.clientHeight : null,
          canvas_w:    cnv ? cnv.width : null,
          canvas_h:    cnv ? cnv.height : null,
          canvas_style_w: cnv ? cnv.style.width : null,
          canvas_style_h: cnv ? cnv.style.height : null,
          gl_version:  gl ? gl.getParameter(gl.VERSION) : null,
          parent_chain: chain,
          window:      `${window.innerWidth}x${window.innerHeight}`,
        };
        console.warn('[explore] post-load diagnostics ' + JSON.stringify(info));
      } catch (e) {
        console.warn('[explore] diagnostics threw: ' + (e && e.message));
      }
      // Force a resize one tick later — covers the case where the container
      // grew between map init and first paint (e.g. side-nav animation).
      setTimeout(() => { try { map.resize(); } catch (_) {} }, 200);
    });
    // Any drag from a mouse user means "stop following the rig." Pan
    // commands from the d-pad set this flag explicitly too.
    map.on('dragstart', () => setFollow(false));

    // Add a "you are here" puck on top of the basemap once the style
    // has finished its initial load. Mirrors the styling used by the
    // Headwaters PWA so the look is familiar.
    map.on('load', () => {
      try {
        map.addSource('rig-location', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: 'rig-pulse',
          type: 'circle',
          source: 'rig-location',
          paint: { 'circle-radius': 16, 'circle-color': '#52a441', 'circle-opacity': 0.3 },
        });
        map.addLayer({
          id: 'rig-dot',
          type: 'circle',
          source: 'rig-location',
          paint: {
            'circle-radius':       8,
            'circle-color':        '#52a441',
            'circle-stroke-width': 3,
            'circle-stroke-color': '#ffffff',
          },
        });
        // Seed the puck immediately if we already have a fix.
        const cur = vehiclePosRef.current;
        if (cur) {
          map.getSource('rig-location').setData({
            type: 'FeatureCollection',
            features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [cur.lng, cur.lat] }, properties: {} }],
          });
        }
      } catch (e) {
        console.warn('[explore] adding rig puck failed:', e && e.message);
      }
    });

    return () => {
      try { map.remove(); } catch (_) { /* noop */ }
      mapRef.current = null;
    };
  }, [host, theme, mapTheme]);

  // ─── Keep the rig puck synced to the live GPS ─────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !vehiclePos) return;
    const apply = () => {
      const src = map.getSource('rig-location');
      if (!src) return;
      src.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [vehiclePos.lng, vehiclePos.lat] },
          properties: {},
        }],
      });
    };
    if (map.loaded()) apply(); else map.once('load', apply);
    if (followVehicle) {
      map.easeTo({ center: [vehiclePos.lng, vehiclePos.lat], duration: 400 });
    }
  }, [vehiclePos, followVehicle]);

  // ─── Canvas-local key handler (this is the screen's bespoke d-pad
  // mode, the same kind of exception the fullscreen video player has).
  // Bound as a native listener on the canvas DOM node so stopPropagation
  // actually reaches all the way up — React's onKeyDown synthetic system
  // does not reliably stop the native bubble past document/window.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function onKey(e) {
      // TEMP DIAG — log every key the canvas receives so we can confirm
      // the IR Menu button is reaching this handler.
      console.log('[explore-key] key=' + e.key + ' code=' + e.code + ' menuOpen=' + menuOpenRef.current);
      // Don't fight a focused real text field (none on this screen today;
      // belt-and-braces in case search lands here later).
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

      // ── Menu mode: when the contextual popup is open the d-pad drives
      // the menu instead of the map. Escape/Back/Menu close without doing
      // anything; Enter activates the selected item.
      if (menuOpenRef.current) {
        let menuHandled = true;
        switch (e.key) {
          case 'ArrowUp':
            setMenuIdx((i) => (i - 1 + MENU_COUNT) % MENU_COUNT);
            break;
          case 'ArrowDown':
            setMenuIdx((i) => (i + 1) % MENU_COUNT);
            break;
          case 'Enter':
          case ' ':
            activateMenuItem(menuIdxRef.current);
            break;
          case 'Escape':
          case 'Backspace':
            setMenuOpen(false);
            refocusCanvas();
            break;
          // INTENTIONAL: 'm' / 'M' / 'ContextMenu' do NOT close the menu
          // while it's open. The IR remote's Menu button maps to KEY_M
          // (see playbill.toml), and rapid taps used to TOGGLE the menu
          // — open, close, open, close — so the user saw nothing settle.
          // Only Esc/Backspace dismisses the menu now. The open-on-m
          // path below is unchanged.
          default:
            menuHandled = false;
        }
        if (menuHandled) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      // ── Menu trigger: open the popup. Same effect from the remote's
      // reserved Menu button (synthesized as a ContextMenu key by app.jsx)
      // or from a keyboard `m`/`M`.
      if (e.key === 'ContextMenu' || e.key === 'm' || e.key === 'M') {
        setMenuOpen(true);
        setMenuIdx(0);
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // GLOBAL escape hatches — always let these bubble to the shell's
      // window-level handler so the user can leave the screen. The map's
      // d-pad-as-pan mode must never trap the user.
      //   Escape | Backspace → Back
      //   h | H              → Home
      // The shell's app.jsx handles them via goBack()/goHome(); the same
      // path is also used by the remote's nav.dpad → onNavDpad subscriber.
      if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'h' || e.key === 'H') {
        return;  // no preventDefault / stopPropagation; let it bubble
      }

      const map = mapRef.current;
      if (!map) return;

      const rect = el.getBoundingClientRect();
      // 30 % of the visible map per press — fast enough to traverse, slow
      // enough that you can stop on a landmark. Tuned by feel on 1080p.
      const dx = rect.width  * 0.30;
      const dy = rect.height * 0.30;

      const mode = navModeRef.current;   // 'pan' | 'zoom'
      let handled = true;
      switch (e.key) {
        case 'ArrowUp':
          if (mode === 'zoom') zoomBy(+1);
          else { map.panBy([0, -dy]); setFollow(false); }
          break;
        case 'ArrowDown':
          if (mode === 'zoom') zoomBy(-1);
          else { map.panBy([0,  dy]); setFollow(false); }
          break;
        case 'ArrowLeft':
          if (mode === 'zoom') zoomBy(-1);
          else { map.panBy([-dx, 0]); setFollow(false); }
          break;
        case 'ArrowRight':
          if (mode === 'zoom') zoomBy(+1);
          else { map.panBy([ dx, 0]); setFollow(false); }
          break;
        case 'Enter':
        case ' ':
          toggleNavMode(); break;
        case '+': case '=': zoomBy(+1); break;
        case '-': case '_': zoomBy(-1); break;
        case 'r': case 'R': recenter(); break;
        default: handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    }

    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);  // handlers below close over refs/state setters; stable for the life of the screen

  // ─── Map operations ───────────────────────────────────────────────
  // After any toolbar click the browser focuses the BUTTON we clicked,
  // which yanks the canvas-local keydown listener out of play. Return
  // focus to the map so the next arrow press immediately pans.
  function refocusCanvas() {
    const el = containerRef.current;
    if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
  }
  function zoomBy(step) {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ zoom: map.getZoom() + step, duration: 250 });
    refocusCanvas();
  }
  // ─── Menu items ───────────────────────────────────────────────────
  // The visible menu definition is built inline at render time so labels
  // can vary with state (e.g. "Switch to dark basemap" vs "Switch to light
  // basemap"). The action functions are stable, so the keydown handler
  // can dispatch by index via activateMenuItem. MENU_COUNT must match the
  // length of the array built in render.
  const MENU_COUNT = 5;
  function activateMenuItem(idx) {
    switch (idx) {
      case 0: recenter(); break;
      case 1: zoomBy(+1); break;
      case 2: zoomBy(-1); break;
      case 3: toggleMapTheme(); break;
      case 4: exitScreen(); break;
    }
    setMenuOpen(false);
    refocusCanvas();
  }
  function toggleMapTheme() {
    setMapTheme((cur) => {
      const next = cur === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('playbill.explore.mapTheme', next); } catch (_) {}
      return next;
    });
  }
  function toggleNavMode() {
    setNavMode((cur) => {
      const next = cur === 'pan' ? 'zoom' : 'pan';
      try { localStorage.setItem('playbill.explore.navMode', next); } catch (_) {}
      return next;
    });
    refocusCanvas();
  }
  // Exit the screen — synthesize an Escape keydown on the window so the
  // shell's universal Back handler in app.jsx runs (same code path as the
  // hardware-remote nav.dpad 'back' key and the keyboard Esc). Avoids
  // duplicating goBack logic here.
  function exitScreen() {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  }
  function recenter() {
    const cur = vehiclePosRef.current;
    const map = mapRef.current;
    if (!cur || !map) return;
    setFollow(true);
    map.easeTo({
      center:   [cur.lng, cur.lat],
      zoom:     Math.max(map.getZoom(), ZOOM_PRESETS[2]),
      duration: 500,
    });
    refocusCanvas();
  }

  const showEmpty = !host;
  const showError = !!error;

  return (
    <div className="explore-view" data-zone-root data-zone="explore" data-zone-axis="horizontal">
      <div className="explore-canvas-wrap">
        {/* The canvas is the ONLY focusable leaf in the screen's zone tree.
            The toolbar buttons are mouse-only — they're not in the zone path,
            so arrows on the canvas never wander into them. data-zone-default
            on the canvas means the FocusZones engine lands here on entry. */}
        <div
          ref={containerRef}
          className="explore-canvas"
          tabIndex={0}
          data-zone-default="true"
        ></div>

        {showEmpty && (
          <div className="explore-overlay explore-empty">
            <ion-icon name="map-outline"></ion-icon>
            <div className="t">Waiting for Headwaters</div>
            <div className="b">Maps load once Settings is connected to a rig.</div>
          </div>
        )}
        {showError && !showEmpty && (
          <div className="explore-overlay explore-error">
            <ion-icon name="alert-circle-outline"></ion-icon>
            <div className="t">Map didn't load</div>
            <div className="b">{error}</div>
          </div>
        )}

        <div className="explore-hud-tl">
          <div className={'explore-hud-chip' + (followVehicle ? ' active' : '')}>
            <ion-icon name={followVehicle ? 'locate' : 'locate-outline'}></ion-icon>
            <span>{followVehicle ? 'Following rig' : 'Free pan'}</span>
          </div>
          {/* Mode indicator — same chip vocabulary as the follow chip. The
              `active` class gives it the green-tinted look so it's obvious
              at a glance that a mode is engaged (pan or zoom, either way). */}
          <div className="explore-hud-chip active" title="OK toggles between pan and zoom">
            <ion-icon name={navMode === 'zoom' ? 'search-outline' : 'move-outline'}></ion-icon>
            <span>{navMode === 'zoom' ? 'Zoom mode' : 'Pan mode'}</span>
          </div>
        </div>

        {/* Diagnostic overlay — large fixed banner that can't be cut off by
            anything else in the shell. Removed once Explore is reliable. */}
        <div style={{
          position: 'absolute', bottom: 110, left: '50%', transform: 'translateX(-50%)',
          maxWidth: '80%', padding: '10px 16px', borderRadius: 10,
          background: 'rgba(0,0,0,0.78)', border: '1px solid rgba(255,255,255,0.18)',
          color: '#fff', font: '13px ui-monospace, monospace',
          whiteSpace: 'normal', wordBreak: 'break-all', textAlign: 'center',
          pointerEvents: 'none', zIndex: 1000,
        }}>
          host={host || '∅'} · {error ? `err=${error}` : 'ok'}
        </div>

        {/* Mouse-only — tabindex=-1 keeps these out of the FocusZones leaf
            set so an arrow press on the canvas can never wander into the
            toolbar (which would strand the user with no way back to the
            map's d-pad mode). Recenter / zoom / theme moved into the
            contextual popup menu (Menu button / `m`); the toolbar only
            keeps Exit + Menu — the two universally-available actions. */}
        <div className="explore-tools">
          <button className="explore-tool-btn" tabIndex={-1} onClick={exitScreen} title="Exit (Back)">
            <ion-icon name="close-outline"></ion-icon>
          </button>
          <button className="explore-tool-btn" tabIndex={-1}
                  onClick={() => { setMenuOpen((o) => !o); setMenuIdx(0); refocusCanvas(); }}
                  title="Open menu (or press the Menu button)">
            <ion-icon name="ellipsis-vertical-outline"></ion-icon>
          </button>
        </div>

        {/* Contextual popup menu. Mounted only while open so the focus +
            keystroke logic doesn't have to guard against stale state.
            Items are kept in sync with MENU_COUNT and activateMenuItem
            (both above) — touch them together. */}
        {menuOpen && (() => {
          const items = [
            { icon: 'navigate-outline', label: 'Center on rig',
              disabled: !vehiclePos,
              hint: vehiclePos ? null : 'Waiting for GPS fix' },
            { icon: 'add-outline',      label: 'Zoom in' },
            { icon: 'remove-outline',   label: 'Zoom out' },
            { icon: mapTheme === 'dark' ? 'sunny-outline' : 'moon-outline',
              label: mapTheme === 'dark' ? 'Switch to light basemap' : 'Switch to dark basemap' },
            { icon: 'close-outline',    label: 'Exit Explore' },
          ];
          return (
            <div className="explore-menu" role="menu" aria-label="Map menu">
              <div className="explore-menu-title">Map</div>
              {items.map((it, i) => (
                <button
                  key={i}
                  className={'explore-menu-item' + (i === menuIdx ? ' focused' : '') + (it.disabled ? ' disabled' : '')}
                  role="menuitem"
                  tabIndex={-1}
                  onMouseEnter={() => setMenuIdx(i)}
                  onClick={() => activateMenuItem(i)}
                  disabled={it.disabled}
                >
                  <ion-icon name={it.icon}></ion-icon>
                  <span className="explore-menu-label">{it.label}</span>
                  {it.hint && <span className="explore-menu-hint">{it.hint}</span>}
                </button>
              ))}
              <div className="explore-menu-foot">↑↓ Select · ⏎ Activate · Menu/Esc Close</div>
            </div>
          );
        })()}

        <div className="explore-hint-bar">
          {navMode === 'zoom'
            ? <span className="chip">↑→ Zoom in · ↓← Zoom out</span>
            : <span className="chip">↑↓←→ Pan</span>}
          <span className="chip">⏎ {navMode === 'zoom' ? 'Pan mode' : 'Zoom mode'}</span>
          <span className="chip">≡ Menu</span>
          <span className="chip">Esc Back</span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ExploreView });
