/* Home screen — Continue Watching / Apps / Offline Library rows.
 *
 * NAV CONTRACT: this screen uses the zone-root spatial focus engine. The
 * root sits on the vertical axis (rows stack top-to-bottom) and each row
 * is a horizontal child zone. Tiles are real <button> elements so the
 * engine can focus them and Enter activates click handlers automatically.
 * Do not add per-screen keyboard logic here — see
 * docs/app/navigation.md and the feedback memory titled "Playbill nav
 * contract — never write per-screen keyboard code."
 */

function ContentTile({ item, variant = 'landscape' }) {
  // Rendered as <button> so FocusZones can land focus and Enter fires the
  // onClick handler without per-screen keyboard plumbing.
  return (
    <button
      type="button"
      className={'card ' + variant}
      onClick={() => window.PLAYBACK && window.PLAYBACK.playLocal(item)}
    >
      <div
        className={'thumb' + (item.img ? '' : ' no-poster')}
        style={item.img ? { backgroundImage: `url(${item.img})` } : null}
      >
        {!item.img && (
          <div className="no-poster-inner">
            <ion-icon name="film-outline"></ion-icon>
            <div className="no-poster-title">{item.title}</div>
          </div>
        )}
        {item.progress !== undefined && (
          <div className="card-progress"><div className="fill" style={{width: item.progress + '%'}}></div></div>
        )}
      </div>
      <div style={{padding: '8px 10px 10px'}}>
        <div className="title">{item.title}</div>
        <div className="meta">{item.meta}</div>
      </div>
    </button>
  );
}

function AppTile({ app }) {
  const inner = app.icon
    ? <ion-icon name={app.icon} style={{fontSize: 56, color: '#fff'}}></ion-icon>
    : (app.logo || app.label || '');
  return (
    <button
      type="button"
      className="app-card"
      style={{ background: app.bg }}
      onClick={() => window.TV_APPS && window.TV_APPS.launch(app)}
      aria-label={app.label}
    >
      <div className="logo">{inner}</div>
    </button>
  );
}

function MoreTile({ label, sublabel, onClick }) {
  return (
    <button type="button" className="card landscape more-tile" onClick={onClick}>
      <div className="thumb more-thumb">
        <ion-icon name="arrow-forward-circle-outline"></ion-icon>
      </div>
      <div style={{padding: '8px 10px 10px'}}>
        <div className="title">{label}</div>
        <div className="meta">{sublabel}</div>
      </div>
    </button>
  );
}

function EmptyTile({ icon, title, body }) {
  // Non-focusable placeholder — keeps the row from collapsing visually when
  // empty without trapping focus on something the user can't activate.
  return (
    <div className="card landscape empty-tile" aria-hidden="true">
      <div className="thumb empty-thumb">
        <ion-icon name={icon || 'time-outline'}></ion-icon>
      </div>
      <div style={{padding: '8px 10px 10px'}}>
        <div className="title">{title}</div>
        <div className="meta">{body}</div>
      </div>
    </div>
  );
}

function HomeRow({ title, sub, zoneName, children }) {
  return (
    <section className="home-row">
      <div className="home-row-head">
        <div className="home-row-title">{title}</div>
        {sub && <div className="home-row-sub">{sub}</div>}
      </div>
      <div className="home-row-track" data-zone={zoneName} data-zone-axis="horizontal">
        {children}
      </div>
    </section>
  );
}

function HomeView() {
  const rootRef = useRef(null);
  const [recent, setRecent] = useState(() => (window.PLAYBACK ? window.PLAYBACK.recent() : []));
  const [library, setLibrary] = useState({ movies: [], shows: [] });

  // Pull library from the controller. Refresh whenever the DVD pipeline
  // transitions into 'done' so a freshly-ripped title shows up without a
  // reload. Mirrors the pattern in local.jsx so home and Library stay in
  // sync via the same source of truth.
  useEffect(() => {
    if (!window.playbill || !window.playbill.controller) return undefined;
    let mounted = true;
    const refresh = () => {
      window.playbill.controller.command({ action: 'dvd.libraryList' })
        .then((r) => { if (mounted && r) setLibrary({ movies: r.movies || [], shows: r.shows || [] }); })
        .catch(() => {});
    };
    refresh();
    let lastStatus = null;
    const unsub = window.playbill.controller.onState((s) => {
      const next = s && s.dvd && s.dvd.status;
      if (next === 'done' && lastStatus !== 'done') refresh();
      lastStatus = next;
    });
    return () => { mounted = false; if (unsub) unsub(); };
  }, []);

  // PLAYBACK.playLocal broadcasts this event whenever the recent list
  // mutates (from any screen — local.jsx, home, future detail views).
  useEffect(() => {
    function onChange() { setRecent(window.PLAYBACK ? window.PLAYBACK.recent() : []); }
    window.addEventListener('playbill:recentPlayback', onChange);
    return () => window.removeEventListener('playbill:recentPlayback', onChange);
  }, []);

  // Pull the focused tile into view on every focus change. FocusZones
  // already calls .focus() on the new element; this turns that into a
  // smooth scroll for both axes so off-screen rows/tiles slide in. This
  // is the universal replacement for the old fixed translateY offset
  // table that had to be hand-tuned per row.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    function onFocus(e) {
      const target = e.target;
      if (!target || !root.contains(target)) return;
      try {
        target.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      } catch (_) { /* old browsers — non-fatal */ }
    }
    root.addEventListener('focusin', onFocus);
    return () => root.removeEventListener('focusin', onFocus);
  }, []);

  const apps = (window.TV_DATA && window.TV_DATA.apps) || [];
  const movies = library.movies.slice(0, 5);
  const hasMoreMovies = library.movies.length > 5;
  const recentItems = recent.slice(0, 5);

  const goLibrary = () => {
    window.dispatchEvent(new CustomEvent('playbill:navigate', { detail: { screen: 'local' } }));
  };

  return (
    <div
      ref={rootRef}
      className="home-view"
      data-zone-root
      data-zone="home"
      data-zone-axis="vertical"
    >
      <HomeRow
        title="Continue Watching"
        sub={recentItems.length ? `${recentItems.length} recent` : 'Nothing yet'}
        zoneName="home.continue"
      >
        {recentItems.length === 0 ? (
          <EmptyTile
            icon="time-outline"
            title="Nothing in progress"
            body="Play a movie or show to see it here."
          />
        ) : recentItems.map((it) => (
          <ContentTile key={it.id} item={it} variant="landscape" />
        ))}
      </HomeRow>

      <HomeRow
        title="Your Apps"
        sub={apps.length ? `${apps.length} available` : 'No apps yet'}
        zoneName="home.apps"
      >
        {apps.map((app) => (
          <AppTile key={app.id} app={app} />
        ))}
      </HomeRow>

      <HomeRow
        title="Offline Library — Movies"
        sub={library.movies.length ? `${library.movies.length} titles` : 'Library empty'}
        zoneName="home.movies"
      >
        {movies.length === 0 ? (
          <EmptyTile
            icon="film-outline"
            title="Library empty"
            body="Insert a DVD to rip a title into your offline library."
          />
        ) : (
          <>
            {movies.map((m) => (
              <ContentTile
                key={m.id}
                item={{ ...m, img: m.posterUrl, meta: [m.year, m.runtime].filter(Boolean).join(' · ') }}
                variant="poster"
              />
            ))}
            {hasMoreMovies && (
              <MoreTile
                label="See all"
                sublabel={`${library.movies.length} titles`}
                onClick={goLibrary}
              />
            )}
          </>
        )}
      </HomeRow>
    </div>
  );
}

Object.assign(window, { HomeView, ContentTile, AppTile, MoreTile });
