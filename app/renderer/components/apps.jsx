/* Apps grid view */

function AppsView({ focus }) {
  const D = window.TV_DATA;
  const col = focus.col % 6, rowIdx = Math.floor(focus.col / 6);
  return (
    <div className="apps-view">
      <div className="view-hdr">
        <h2>Apps</h2>
        <p>Launch streaming services and RV tools</p>
      </div>

      <div className="row-sub" style={{marginBottom: 14}}>Featured</div>
      <div className="app-grid">
        {D.apps.slice(0, 6).map((app, i) => (
          <AppCard key={app.id} app={app} focused={focus.row === 'apps' && focus.col === i} />
        ))}
      </div>

      <div className="row-sub" style={{marginBottom: 14}}>All Installed</div>
      <div className="app-grid">
        {D.apps.slice(6).map((app, i) => (
          <AppCard key={app.id} app={app} focused={focus.row === 'apps' && focus.col === (i + 6)} />
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { AppsView });
