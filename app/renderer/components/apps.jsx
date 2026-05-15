/* Apps grid view */

function AppCard({ app, focused, onLaunch }) {
  // Legacy div-based card — the Apps grid still uses the ROWS focus
  // schema in app.jsx (focus.row/col), so focus state is painted via
  // the `focused` prop rather than DOM :focus. Home's AppTile is the
  // zone-root equivalent.
  const inner = app.icon
    ? <ion-icon name={app.icon} style={{fontSize: 56, color: '#fff'}}></ion-icon>
    : (app.logo || app.label || '');
  return (
    <div
      className={'app-card' + (focused ? ' focused' : '')}
      style={{ background: app.bg }}
      onClick={() => onLaunch && onLaunch(app)}
      role="button"
      tabIndex={-1}
    >
      <div className="logo">{inner}</div>
    </div>
  );
}

function AppsView({ focus }) {
  const D = window.TV_DATA;
  const launch = window.TV_APPS && window.TV_APPS.launch;
  return (
    <div className="apps-view">
      <div className="view-hdr">
        <h2>Apps</h2>
        <p>Launch streaming services and RV tools</p>
      </div>

      <div className="row-sub" style={{marginBottom: 14}}>Featured</div>
      <div className="app-grid">
        {D.apps.slice(0, 6).map((app, i) => (
          <AppCard key={app.id} app={app} focused={focus.row === 'apps' && focus.col === i} onLaunch={launch} />
        ))}
      </div>

      {D.apps.length > 6 && <>
        <div className="row-sub" style={{marginBottom: 14}}>All Installed</div>
        <div className="app-grid">
          {D.apps.slice(6).map((app, i) => (
            <AppCard key={app.id} app={app} focused={focus.row === 'apps' && focus.col === (i + 6)} onLaunch={launch} />
          ))}
        </div>
      </>}
    </div>
  );
}

Object.assign(window, { AppsView, AppCard });
