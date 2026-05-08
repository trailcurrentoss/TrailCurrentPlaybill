/* Home screen: Featured hero + content rows (Netflix/Apple TV style) */

function Hero({ item, focused }) {
  return (
    <div className="hero">
      <div className="hero-bg" style={{ backgroundImage: `url(${item.bg})` }}></div>
      <div className="hero-inner">
        <div className="hero-tag">
          <ion-icon name="star"></ion-icon> {item.tag}
        </div>
        <h1 className="hero-title">{item.title}</h1>
        <div className="hero-meta">
          <span className="rating">★ {item.rating}</span>
          {item.meta.map((m, i) => <span key={i} className="pill">{m}</span>)}
        </div>
        <p className="hero-desc">{item.desc}</p>
        <div className="hero-actions">
          <button className={'tv-btn primary' + (focused === 'hero-play' ? ' focused' : '')}>
            <ion-icon name="play"></ion-icon> Play
          </button>
          <button className={'tv-btn' + (focused === 'hero-list' ? ' focused' : '')}>
            <ion-icon name="add"></ion-icon> My List
          </button>
          <button className={'tv-btn' + (focused === 'hero-info' ? ' focused' : '')}>
            <ion-icon name="information-circle-outline"></ion-icon> More Info
          </button>
        </div>
      </div>
    </div>
  );
}

function ContentCard({ item, focused, variant = 'landscape' }) {
  return (
    <div className={'card ' + variant + (focused ? ' focused' : '')}>
      <div className="thumb" style={{ backgroundImage: `url(${item.img})` }}>
        <div className="overlay">
          {item.progress !== undefined && (
            <div style={{fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)'}}>
              Continue
            </div>
          )}
        </div>
        {item.progress !== undefined && (
          <div className="card-progress"><div className="fill" style={{width: item.progress + '%'}}></div></div>
        )}
      </div>
      <div style={{padding: '8px 10px 10px'}}>
        <div className="title">{item.title}</div>
        <div className="meta">{item.meta}</div>
      </div>
    </div>
  );
}

function AppCard({ app, focused }) {
  return (
    <div className={'app-card' + (focused ? ' focused' : '')} style={{ background: app.bg }}>
      <div className="logo">{app.logo}</div>
    </div>
  );
}

function Row({ title, sub, items, rowId, focusedRow, focusedCol, variant = 'landscape', isApps = false }) {
  const trackRef = useRef(null);
  useEffect(() => {
    if (focusedRow === rowId && trackRef.current) {
      const cardW = variant === 'square' ? 234 : variant === 'poster' ? 194 : isApps ? 234 : 314;
      const offset = Math.max(0, focusedCol * cardW - 120);
      trackRef.current.style.transform = `translateX(-${offset}px)`;
    }
  }, [focusedCol, focusedRow, rowId]);

  return (
    <div className="row">
      <div className="row-head">
        <div className="row-title">{title}</div>
        {sub && <div className="row-sub">{sub}</div>}
      </div>
      <div className="row-track" ref={trackRef}>
        {items.map((it, i) => (
          isApps ? (
            <AppCard key={it.id} app={it} focused={focusedRow === rowId && focusedCol === i} />
          ) : (
            <ContentCard
              key={it.id}
              item={it}
              variant={variant}
              focused={focusedRow === rowId && focusedCol === i}
            />
          )
        ))}
      </div>
    </div>
  );
}

function HomeView({ focus }) {
  const D = window.TV_DATA;
  const scrollRef = useRef(null);

  // Auto-scroll so focused row is visible
  useEffect(() => {
    if (!scrollRef.current) return;
    const rowHeights = { hero: 0, continue: 640, apps: 930, trails: 1160, movies: 1390 };
    const offset = rowHeights[focus.row] ?? 0;
    scrollRef.current.style.transform = `translateY(-${offset}px)`;
  }, [focus.row]);

  return (
    <div className="tv-view">
      <div ref={scrollRef} style={{transition: 'transform 0.35s cubic-bezier(.4,0,.2,1)'}}>
        <Hero item={D.featured} focused={focus.row === 'hero' ? ['hero-play','hero-list','hero-info'][focus.col] : null} />

        <Row title="Continue Watching" sub={D.continue.length ? `${D.continue.length} items` : 'Empty'} items={D.continue}
          rowId="continue" focusedRow={focus.row} focusedCol={focus.col} />

        <Row title="Your Apps" sub={D.apps.length ? 'Installed' : 'No apps yet'}
          items={D.apps.slice(0, 8)} isApps={true}
          rowId="apps" focusedRow={focus.row} focusedCol={focus.col} />

        <Row title="Trails Nearby" sub={D.rowTrails.length ? 'Near you' : 'No trail data'} items={D.rowTrails}
          rowId="trails" focusedRow={focus.row} focusedCol={focus.col} />

        <Row title="Offline Library — Movies" sub={D.movies.length ? `${D.movies.length} titles` : 'Library empty'} items={D.movies} variant="poster"
          rowId="movies" focusedRow={focus.row} focusedCol={focus.col} />
      </div>
    </div>
  );
}

Object.assign(window, { HomeView, Hero, Row, ContentCard, AppCard });
