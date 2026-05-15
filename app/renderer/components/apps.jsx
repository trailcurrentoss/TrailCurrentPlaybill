/* Apps grid view.
 *
 * NAVIGATION CONTRACT (docs/app/navigation.md):
 * Zone-root with two grid sub-zones (Featured + All Installed). Each tile
 * is a <button> so FocusZones drives focus and native onClick fires on
 * Enter. No `focus` prop, no `focused` className — DOM :focus does the
 * visual highlight. */

function AppCard({ app, onLaunch, isDefault }) {
  const inner = app.icon
    ? <ion-icon name={app.icon} style={{fontSize: 56, color: '#fff'}}></ion-icon>
    : (app.logo || app.label || '');
  return (
    <button
      type="button"
      className="app-card"
      style={{ background: app.bg }}
      onClick={() => onLaunch && onLaunch(app)}
      data-zone-default={isDefault ? 'true' : undefined}
      aria-label={app.label}
    >
      <div className="logo">{inner}</div>
    </button>
  );
}

function AppsView() {
  const D = window.TV_DATA;
  const launch = window.TV_APPS && window.TV_APPS.launch;
  const featured = D.apps.slice(0, 6);
  const rest     = D.apps.slice(6);
  return (
    <div
      className="apps-view"
      data-zone-root
      data-zone="apps"
      data-zone-axis="vertical"
    >
      <div className="view-hdr">
        <h2>Apps</h2>
        <p>Launch streaming services and RV tools</p>
      </div>

      <div className="row-sub" style={{marginBottom: 14}}>Featured</div>
      <div className="app-grid" data-zone="apps.featured" data-zone-axis="grid">
        {featured.map((app, i) => (
          <AppCard
            key={app.id}
            app={app}
            onLaunch={launch}
            isDefault={i === 0}
          />
        ))}
      </div>

      {rest.length > 0 && <>
        <div className="row-sub" style={{marginBottom: 14}}>All Installed</div>
        <div className="app-grid" data-zone="apps.all" data-zone-axis="grid">
          {rest.map((app) => (
            <AppCard key={app.id} app={app} onLaunch={launch} />
          ))}
        </div>
      </>}
    </div>
  );
}

Object.assign(window, { AppsView, AppCard });
