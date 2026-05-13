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

const { useState, useEffect, useRef } = React;

// Map cycle — distinct enough zoom levels that one OK press visibly moves
// the user between "where am I in the country" / "what's the next town"
// / "what's around this block." Cycles back to overview from the deepest
// preset so the user can always retreat with the same key.
const ZOOM_PRESETS = [4, 9, 13, 17];

function ExploreView() {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const vehiclePosRef = useRef(null);

  const [host, setHost]               = useState(null);
  const [theme, setTheme]             = useState(document.documentElement.getAttribute('data-theme') || 'dark');
  const [vehiclePos, setVehiclePos]   = useState(null); // {lat, lng}
  const [followVehicle, setFollow]    = useState(true);
  const [error, setError]             = useState(null);
  const [zoomIdx, setZoomIdx]         = useState(0);    // index into ZOOM_PRESETS for OK-cycling

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
        try { setHost(new URL(broker).hostname); }
        catch (_) { /* leave host null — Explore will show an empty state */ }
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

    // Headwaters tileserver style names — match what the Headwaters PWA
    // uses (containers/frontend/public/js/components/map-display.js).
    const styleName = theme === 'dark' ? '3d-dark' : '3d';
    const styleUrl = `https://${host}/styles/${styleName}/style.json`;

    const seed = vehiclePosRef.current;
    const center = seed ? [seed.lng, seed.lat] : [-98.5795, 39.8283];
    const zoom   = seed ? ZOOM_PRESETS[2]      : ZOOM_PRESETS[0];
    setZoomIdx(seed ? 2 : 0);

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
      setError(e && e.message || String(e));
      return;
    }

    mapRef.current = map;
    setError(null);

    map.on('error', (e) => {
      const err = e && e.error;
      if (err && err.message) setError(err.message);
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
  }, [host, theme]);

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
      // Don't fight a focused real text field (none on this screen today;
      // belt-and-braces in case search lands here later).
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

      const map = mapRef.current;
      if (!map) return;

      const rect = el.getBoundingClientRect();
      // 30 % of the visible map per press — fast enough to traverse, slow
      // enough that you can stop on a landmark. Tuned by feel on 1080p.
      const dx = rect.width  * 0.30;
      const dy = rect.height * 0.30;

      let handled = true;
      switch (e.key) {
        case 'ArrowUp':    map.panBy([0, -dy]); setFollow(false); break;
        case 'ArrowDown':  map.panBy([0,  dy]); setFollow(false); break;
        case 'ArrowLeft':  map.panBy([-dx, 0]); setFollow(false); break;
        case 'ArrowRight': map.panBy([ dx, 0]); setFollow(false); break;
        case 'Enter':
        case ' ':
          cycleZoom(); break;
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
  function cycleZoom() {
    const map = mapRef.current;
    if (!map) return;
    setZoomIdx((idx) => {
      const next = (idx + 1) % ZOOM_PRESETS.length;
      const target = ZOOM_PRESETS[next];
      // Cycling always zooms toward the current map centre. If the user
      // has been panning around freely we don't want OK to jerk them
      // back to the rig — they can hit Recenter for that.
      map.easeTo({ zoom: target, duration: 350 });
      return next;
    });
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
        </div>

        {/* Mouse-only — tabindex=-1 keeps these out of the FocusZones leaf
            set so an arrow press on the canvas can never wander into the
            toolbar (which would strand the user with no way back to the
            map's d-pad mode). */}
        <div className="explore-tools">
          <button className="explore-tool-btn" tabIndex={-1} onClick={recenter} disabled={!vehiclePos} title="Center on rig">
            <ion-icon name="navigate-outline"></ion-icon>
          </button>
          <button className="explore-tool-btn" tabIndex={-1} onClick={() => zoomBy(+1)} title="Zoom in">
            <ion-icon name="add-outline"></ion-icon>
          </button>
          <button className="explore-tool-btn" tabIndex={-1} onClick={() => zoomBy(-1)} title="Zoom out">
            <ion-icon name="remove-outline"></ion-icon>
          </button>
        </div>

        <div className="explore-hint-bar">
          <span className="chip">↑↓←→ Pan</span>
          <span className="chip">⏎ Zoom</span>
          {vehiclePos && <span className="chip">R Recenter</span>}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ExploreView });
