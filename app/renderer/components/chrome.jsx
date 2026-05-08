/* TV chrome: top bar, side nav, now-playing, remote hints */

const { useState, useEffect, useRef, useMemo } = React;

function TopBar({ clock }) {
  return (
    <div className="tv-topbar">
      <div className="brand">
        <span className="brand-dot"></span>
        TrailCurrent Playbill
      </div>
      <div className="sysinfo">
        <span className="battery"><ion-icon name="battery-charging-outline"></ion-icon> 87%</span>
        <span><ion-icon name="sunny-outline"></ion-icon> 412W</span>
        <span><ion-icon name="wifi-outline"></ion-icon> Starlink</span>
        <span><ion-icon name="thermometer-outline"></ion-icon> 68°F</span>
        <span className="clock">{clock}</span>
      </div>
    </div>
  );
}

function SideNav({ active, onSelect, focusId, expanded, onHover }) {
  const items = [
    { id: 'nav-home',   icon: 'home',            label: 'Home' },
    { id: 'nav-apps',   icon: 'apps',            label: 'Apps' },
    { id: 'nav-live',   icon: 'tv-outline',      label: 'Live TV' },
    { id: 'nav-local',  icon: 'albums-outline',  label: 'Library' },
    { id: 'nav-rig',    icon: 'videocam-outline',label: 'Rig View' },
    { id: 'nav-search', icon: 'search-outline',  label: 'Search' },
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
        className={'nav-btn' + (focusId === 'nav-settings' ? ' focused' : '')}
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
  return (
    <div className="remote-hint">
      <span className="chip">←↑→↓ Navigate</span>
      <span className="chip">⏎ Select</span>
      <span className="chip">⌫ Back</span>
      <span className="chip">H Home</span>
    </div>
  );
}

Object.assign(window, { TopBar, SideNav, NowPlayingBar, RemoteHint });
