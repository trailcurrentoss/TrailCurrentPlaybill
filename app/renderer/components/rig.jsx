/* Rig View — live Headwaters telemetry mirrored onto the TV.

   Reads state.telemetry (populated by controller/src/handlers/telemetry.js
   from the Headwaters MQTT broker + /api/lights). Renders a responsive
   tile grid: location, energy, water, climate, air quality, and a per-
   light toggle row. Layout uses CSS Grid auto-fit so it scales from a
   1080p TV down to a small portrait panel without breaking.

   Light names come from Headwaters configuration (modules/lights are
   admin-named in the PWA); renaming a light there reflects here on the
   next REST poll (30 s).

   Toggling a light dispatches telemetry.lights.set on the controller,
   which issues PUT /api/lights/:id to Headwaters; the resulting MQTT
   broadcast flows back through state, so we don't depend on an
   optimistic-update path. */

function RigView() {
  const [telemetry, setTelemetry] = useState(null);
  const [busyLightId, setBusyLightId] = useState(null);

  useEffect(() => {
    if (!window.playbill || !window.playbill.controller) return;
    let unsub;
    (async () => {
      try {
        const init = await window.playbill.controller.getState();
        if (init && init.state) setTelemetry(init.state.telemetry || null);
      } catch (_) { /* controller may not be up yet */ }
      unsub = window.playbill.controller.onState((s) => {
        if (s) setTelemetry(s.telemetry || null);
      });
    })();
    return () => { if (unsub) unsub(); };
  }, []);

  const t = telemetry || {};

  async function toggleLight(light) {
    if (!light) return;
    setBusyLightId(light.id);
    try {
      await window.playbill.controller.command({
        action: 'telemetry.lights.set',
        value:  { id: light.id, state: light.state ? 0 : 1 },
      });
    } catch (e) {
      console.warn('[rig] toggle light failed:', e && e.message);
    } finally {
      setBusyLightId(null);
    }
  }

  async function setAllLights(state) {
    try {
      await window.playbill.controller.command({
        action: 'telemetry.lights.setAll',
        value: { state },
      });
    } catch (e) {
      console.warn('[rig] setAll failed:', e && e.message);
    }
  }

  const lights = Array.isArray(t.lights) ? t.lights : [];
  const hasAnyData = !!(t.energy || t.water || t.climate || t.air || t.location || lights.length);

  return (
    <div className="rig-view" data-zone-root data-zone="rig" data-zone-axis="grid">
      <div className="view-hdr">
        <h2>Rig</h2>
        <p>Live telemetry from Headwaters</p>
      </div>

      {!hasAnyData && (
        <div className="rig-empty">
          <ion-icon name="cellular-outline"></ion-icon>
          <div className="t">Waiting for Headwaters</div>
          <div className="b">No telemetry has arrived yet. Confirm Headwaters is online and the API key is saved in Settings.</div>
        </div>
      )}

      <div className="rig-tiles">
        <LocationTile  data={t.location} />
        <EnergyTile    data={t.energy} />
        <WaterTile     data={t.water} />
        <ClimateTile   climate={t.climate} air={t.air} />
        <LightsTile
          lights={lights}
          busyLightId={busyLightId}
          onToggle={toggleLight}
          onAllOn={() => setAllLights(1)}
          onAllOff={() => setAllLights(0)}
        />
      </div>
    </div>
  );
}

/* ─── Number helpers ───────────────────────────────────────────────── */

function fmt(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (typeof value !== 'number') return String(value);
  return value.toFixed(digits);
}

function fmtInt(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Math.round(value).toString();
}

function fmtDuration(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '—';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/* ─── Tile shell ───────────────────────────────────────────────────── */

function RigTile({ title, icon, span, children, accent }) {
  const style = {};
  if (span) style.gridColumn = `span ${span}`;
  return (
    <section className="rig-tile" style={style} data-accent={accent}>
      <header className="rig-tile-hdr">
        {icon && <ion-icon name={icon}></ion-icon>}
        <span>{title}</span>
      </header>
      <div className="rig-tile-body">{children}</div>
    </section>
  );
}

function Stat({ label, value, unit, accent }) {
  return (
    <div className="rig-stat" data-accent={accent}>
      <div className="rig-stat-label">{label}</div>
      <div className="rig-stat-value">
        <span className="rig-stat-num">{value}</span>
        {unit && <span className="rig-stat-unit">{unit}</span>}
      </div>
    </div>
  );
}

/* ─── Location ─────────────────────────────────────────────────────── */

function LocationTile({ data }) {
  const d = data || {};
  const sats = d.numberOfSatellites;
  const lat = d.latitude;
  const lon = d.longitude;
  const elev = d.altitudeFeet;
  const fix = sats === undefined || sats === null
    ? 'No fix'
    : sats === 0 ? 'No fix' : (sats < 4 ? 'Acquiring' : 'Locked');
  const fixAccent = fix === 'Locked' ? 'success' : (fix === 'Acquiring' ? 'warning' : 'muted');

  return (
    <RigTile title="Location" icon="navigate-outline" span={2} accent="info">
      <div className="rig-row-stats">
        <Stat label="Latitude"  value={lat !== undefined ? fmt(lat, 5) : '—'} unit="°" />
        <Stat label="Longitude" value={lon !== undefined ? fmt(lon, 5) : '—'} unit="°" />
        <Stat label="Elevation" value={elev !== undefined ? fmtInt(elev) : '—'} unit="ft" />
        <Stat label="Satellites" value={fmtInt(sats)} accent={fixAccent} />
      </div>
      <div className="rig-pill" data-accent={fixAccent}>
        <span className="rig-pill-dot"></span>
        GNSS {fix}
      </div>
    </RigTile>
  );
}

/* ─── Energy ───────────────────────────────────────────────────────── */

function EnergyTile({ data }) {
  const d = data || {};
  const soc = d.battery_percent;
  const volts = d.battery_voltage;
  const solar = d.solar_watts;
  const consumption = d.consumption_watts;
  const remaining = d.time_remaining_minutes;
  const chargeType = d.charge_type;

  const socAccent = soc === undefined ? 'muted'
    : soc >= 50 ? 'success'
    : soc >= 20 ? 'warning'
    : 'danger';
  const charging = chargeType && chargeType !== 'off' && chargeType !== 'fault';

  return (
    <RigTile title="Energy" icon="flash-outline" span={2} accent="success">
      <div className="rig-soc">
        <Gauge percent={soc} accent={socAccent} />
        <div className="rig-soc-meta">
          <div className="rig-soc-label">State of Charge</div>
          <div className="rig-soc-status">
            {charging
              ? <span className="rig-pill" data-accent="success"><span className="rig-pill-dot"></span>Charging · {chargeType}</span>
              : <span className="rig-pill" data-accent="muted"><span className="rig-pill-dot"></span>Idle</span>}
          </div>
          <div className="rig-soc-runtime">{fmtDuration(remaining)} remaining</div>
        </div>
      </div>
      <div className="rig-row-stats rig-row-stats-energy">
        <Stat label="Solar In"    value={fmtInt(solar)}       unit="W" accent="solar" />
        <Stat label="Consumption" value={fmtInt(consumption)} unit="W" accent="info" />
        <Stat label="Voltage"     value={fmt(volts, 1)}       unit="V" />
      </div>
    </RigTile>
  );
}

function Gauge({ percent, accent }) {
  const p = (typeof percent === 'number') ? Math.max(0, Math.min(100, percent)) : null;
  // Use SVG so the ring scales with the tile.
  const stroke = 10;
  const size = 110;
  const r = (size - stroke) / 2;
  const c = Math.PI * 2 * r;
  const offset = p === null ? c : c * (1 - p / 100);

  const color = `var(--rig-accent-${accent || 'success'})`;

  return (
    <div className="rig-gauge">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke}/>
        <circle
          cx={size/2} cy={size/2} r={r}
          fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size/2} ${size/2})`}
          style={{ transition: 'stroke-dashoffset 600ms ease' }}
        />
      </svg>
      <div className="rig-gauge-value">
        <span className="rig-gauge-num">{p === null ? '—' : Math.round(p)}</span>
        <span className="rig-gauge-unit">%</span>
      </div>
    </div>
  );
}

/* ─── Water ────────────────────────────────────────────────────────── */

function WaterTile({ data }) {
  const d = data || {};
  return (
    <RigTile title="Water" icon="water-outline" span={2} accent="info">
      <div className="rig-tanks">
        <Tank label="Fresh" pct={d.fresh} accent="fresh" inverse={false}/>
        <Tank label="Grey"  pct={d.grey}  accent="grey"  inverse={true}/>
        <Tank label="Black" pct={d.black} accent="black" inverse={true}/>
      </div>
    </RigTile>
  );
}

function Tank({ label, pct, accent, inverse }) {
  const p = (typeof pct === 'number') ? Math.max(0, Math.min(100, pct)) : null;
  // For grey/black, full = bad; for fresh, full = good.
  const tone = p === null ? 'muted'
    : inverse
      ? (p >= 80 ? 'danger' : p >= 50 ? 'warning' : 'success')
      : (p >= 50 ? 'success' : p >= 20 ? 'warning' : 'danger');
  return (
    <div className="rig-tank" data-accent={accent}>
      <div className="rig-tank-meter">
        <div className="rig-tank-fill" data-accent={accent} style={{ height: (p === null ? 0 : p) + '%' }}>
          <div className="rig-tank-wave"></div>
        </div>
        <div className="rig-tank-pct" data-tone={tone}>
          <span className="rig-stat-num">{p === null ? '—' : Math.round(p)}</span>
          <span className="rig-stat-unit">%</span>
        </div>
      </div>
      <div className="rig-tank-label">{label}</div>
    </div>
  );
}

/* ─── Climate + Air Quality ────────────────────────────────────────── */

function ClimateTile({ climate, air }) {
  const c = climate || {};
  const a = air || {};
  const temp = c.tempInF;
  const humidity = c.humidity;
  const tvoc = a.tvoc_ppb;
  const eco2 = a.eco2_ppm;

  const tvocTone = tvoc === undefined ? 'muted'
    : tvoc < 220 ? 'success'
    : tvoc < 660 ? 'warning'
    : 'danger';
  const eco2Tone = eco2 === undefined ? 'muted'
    : eco2 < 1000 ? 'success'
    : eco2 < 2000 ? 'warning'
    : 'danger';

  return (
    <RigTile title="Climate & Air" icon="thermometer-outline" span={2} accent="cooling">
      <div className="rig-climate">
        <div className="rig-climate-temp">
          <span className="rig-stat-num">{fmt(temp, 1)}</span>
          <span className="rig-stat-unit">°F</span>
        </div>
        <div className="rig-climate-side">
          <Stat label="Humidity" value={humidity !== undefined ? fmtInt(humidity) : '—'} unit="%RH" accent="info" />
          <Stat label="TVOC"     value={fmtInt(tvoc)} unit="ppb" accent={tvocTone} />
          <Stat label="eCO₂"     value={fmtInt(eco2)} unit="ppm" accent={eco2Tone} />
        </div>
      </div>
    </RigTile>
  );
}

/* ─── Lights ───────────────────────────────────────────────────────── */

function LightsTile({ lights, busyLightId, onToggle, onAllOn, onAllOff }) {
  if (!lights || lights.length === 0) {
    return (
      <RigTile title="Lights" icon="bulb-outline" span={4} accent="solar">
        <div className="rig-empty-tile">
          <ion-icon name="bulb-outline"></ion-icon>
          <span>No lights configured in Headwaters yet.</span>
        </div>
      </RigTile>
    );
  }

  const anyOn = lights.some((l) => l.state);

  return (
    <RigTile title="Lights" icon="bulb-outline" span={4} accent="solar">
      <div className="rig-lights-toolbar" data-zone="rig.lights.bulk" data-zone-axis="horizontal">
        <button className="rig-bulk-btn" onClick={onAllOn}  type="button">
          <ion-icon name="sunny-outline"></ion-icon>
          <span>All on</span>
        </button>
        <button className="rig-bulk-btn" onClick={onAllOff} type="button" disabled={!anyOn}>
          <ion-icon name="moon-outline"></ion-icon>
          <span>All off</span>
        </button>
      </div>
      <div className="rig-lights" data-zone="rig.lights" data-zone-axis="grid">
        {lights.map((l, i) => (
          <LightButton
            key={l.id}
            light={l}
            busy={busyLightId === l.id}
            onToggle={() => onToggle(l)}
            isDefault={i === 0}
          />
        ))}
      </div>
    </RigTile>
  );
}

function LightButton({ light, busy, onToggle, isDefault }) {
  const on = !!light.state;
  return (
    <button
      type="button"
      className={'rig-light' + (on ? ' on' : '') + (busy ? ' busy' : '')}
      onClick={onToggle}
      disabled={busy}
      data-zone-default={isDefault ? 'true' : undefined}
      title={light.name || `Light ${light.id}`}
    >
      <span className="rig-light-glow"></span>
      <span className="rig-light-icon">
        <ion-icon name={on ? 'bulb' : 'bulb-outline'}></ion-icon>
      </span>
      <span className="rig-light-name">{light.name || `Light ${light.id}`}</span>
      <span className="rig-light-state">{on ? 'On' : 'Off'}</span>
    </button>
  );
}

Object.assign(window, { RigView });
