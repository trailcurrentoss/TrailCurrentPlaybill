/* TV chrome: top bar, side nav, now-playing, remote hints */

const { useState, useEffect, useRef, useMemo } = React;

function TopBar({ clock }) {
  // Live mirror of state.telemetry — same MQTT-fed slice that the Rig
  // view consumes. The sysinfo strip is a glance-level summary; the
  // Rig screen is the full readout.
  const [telemetry, setTelemetry] = useState(null);
  useEffect(() => {
    if (!window.playbill || !window.playbill.controller) return;
    let unsub;
    (async () => {
      try {
        const init = await window.playbill.controller.getState();
        if (init && init.state) setTelemetry(init.state.telemetry || null);
      } catch (_) { /* controller may not be up */ }
      unsub = window.playbill.controller.onState((s) => {
        if (s) setTelemetry(s.telemetry || null);
      });
    })();
    return () => { if (unsub) unsub(); };
  }, []);

  const t = telemetry || {};
  const energy = t.energy || {};
  const climate = t.climate || {};
  const air = t.air || {};

  const soc = (typeof energy.battery_percent === 'number') ? Math.round(energy.battery_percent) : null;
  const solar = (typeof energy.solar_watts === 'number') ? Math.round(energy.solar_watts) : null;
  const charging = energy.charge_type && energy.charge_type !== 'off' && energy.charge_type !== 'fault';
  const tempF = (typeof climate.tempInF === 'number') ? climate.tempInF.toFixed(0) : null;

  const battTone = soc === null ? 'muted'
    : soc >= 50 ? 'good'
    : soc >= 20 ? 'warn'
    : 'low';
  const battIcon = soc === null ? 'battery-dead-outline'
    : charging ? 'battery-charging-outline'
    : soc >= 70 ? 'battery-full-outline'
    : soc >= 30 ? 'battery-half-outline'
    : 'battery-dead-outline';

  return (
    <div className="tv-topbar">
      <div className="brand">
        <span className="brand-dot"></span>
        TrailCurrent Playbill
      </div>
      <div className="sysinfo">
        <span className={'battery battery-' + battTone}>
          <ion-icon name={battIcon}></ion-icon>
          <span className="sysinfo-val">{soc === null ? '—' : soc + '%'}</span>
        </span>
        {solar !== null && solar > 0 && (
          <span className="solar">
            <ion-icon name="sunny-outline"></ion-icon>
            <span className="sysinfo-val">{solar}W</span>
          </span>
        )}
        {tempF !== null && (
          <span>
            <ion-icon name="thermometer-outline"></ion-icon>
            <span className="sysinfo-val">{tempF}°F</span>
          </span>
        )}
        {typeof air.eco2_ppm === 'number' && air.eco2_ppm >= 1000 && (
          <span className={air.eco2_ppm >= 2000 ? 'air-danger' : 'air-warn'} title={'eCO₂ ' + Math.round(air.eco2_ppm) + ' ppm'}>
            <ion-icon name="leaf-outline"></ion-icon>
            <span className="sysinfo-val">{Math.round(air.eco2_ppm)}</span>
          </span>
        )}
        <span className="clock">{clock}</span>
      </div>
    </div>
  );
}

function SideNav({ active, onSelect, focusId, expanded, onHover }) {
  const items = [
    { id: 'nav-home',    icon: 'home',            label: 'Home' },
    { id: 'nav-apps',    icon: 'apps',            label: 'Apps' },
    { id: 'nav-live',    icon: 'tv-outline',      label: 'Live TV' },
    { id: 'nav-radio',   icon: 'radio-outline',   label: 'Radio' },
    { id: 'nav-local',   icon: 'albums-outline',  label: 'Library' },
    { id: 'nav-music',   icon: 'musical-notes-outline', label: 'Music' },
    { id: 'nav-explore', icon: 'map-outline',     label: 'Explore' },
    { id: 'nav-rig',     icon: 'videocam-outline',label: 'Rig View' },
    { id: 'nav-search',  icon: 'search-outline',  label: 'Search' },
  ];
  return (
    <div
      className={'tv-sidenav' + (expanded ? ' expanded' : '')}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      {items.map(it => (
        <button
          key={it.id}
          className={
            'nav-btn' +
            (active === it.id.replace('nav-', '') ? ' active' : '') +
            (focusId === it.id ? ' focused' : '')
          }
          onClick={() => onSelect(it.id.replace('nav-', ''))}
        >
          <ion-icon name={it.icon}></ion-icon>
          <span className="l">{it.label}</span>
        </button>
      ))}
      <div className="spacer"></div>
      <button
        className={
          'nav-btn' +
          (active === 'settings' ? ' active' : '') +
          (focusId === 'nav-settings' ? ' focused' : '')
        }
        onClick={() => onSelect('settings')}
      >
        <ion-icon name="settings-outline"></ion-icon>
        <span className="l">Settings</span>
      </button>
    </div>
  );
}

function NowPlayingBar() {
  // Stage 1: nothing playing yet — return null so the bar doesn't render.
  // Stage 2 wires in the actual now-playing state from the audio service.
  return null;
}

function RemoteHint() {
  // Reflects the Argon Remote / virtual-remote vocabulary documented in
  // docs/app/navigation.md. Eight semantic keys; everything else (Menu,
  // Vol +/-, Power) is either reserved or handled at a lower layer.
  return (
    <div className="remote-hint">
      <span className="chip">←↑→↓ Navigate</span>
      <span className="chip">⏎ OK</span>
      <span className="chip">Esc Back</span>
      <span className="chip">H Home</span>
    </div>
  );
}

Object.assign(window, { TopBar, SideNav, NowPlayingBar, RemoteHint });
