/* YouTube screen — landing page + drill-down + search + play.
 *
 * NAVIGATION CONTRACT (docs/app/navigation.md):
 * Zone-root with three child zones — `youtube.search` (horizontal, input
 * + Search button), `youtube.tiles` (vertical, landing-page tiles), and
 * `youtube.results` (vertical, video result cards). Only one of tiles
 * or results is mounted at a time depending on the current path.
 *
 * Items are produced by the controller's source plugin via
 * source.list({sourceId:'youtube', path}). The controller decides which
 * tiles to surface (it gates Subscriptions/Your Videos/Liked Videos/
 * Playlists on isSignedIn()), so the renderer is dumb about it — if the
 * tile shows up here, it's because the controller said the user should
 * see it.
 *
 * Internal back stack: drilling from / → /subscriptions → /channel/X
 * pushes onto history; Back pops. PlaybillBackHook is registered when
 * we're not at '/' so the shell's goBack() lets us handle it first.
 *
 * Search special-cases: the search box at the top is always visible.
 * Submitting it sets path to /search/<encoded query>; the controller's
 * yt-dlp path returns results. No sign-in is required for search OR
 * playback. */

const YoutubeResultCard = React.forwardRef(function YoutubeResultCard(
  { item, onPlay, busy }, ref
) {
  const dur = item.duration ? formatDuration(item.duration) : null;
  return (
    <button
      ref={ref}
      type="button"
      className={'yt-card' + (busy ? ' busy' : '')}
      aria-label={`Play ${item.title}`}
      disabled={busy}
      onClick={() => onPlay(item)}
    >
      <div className="yt-thumb" style={{ backgroundImage: item.thumbnail ? `url(${item.thumbnail})` : '' }}>
        {dur && <div className="yt-dur">{dur}</div>}
      </div>
      <div className="yt-meta">
        <div className="yt-title">{item.title}</div>
        <div className="yt-channel">{item.channel || '—'}</div>
        {item.viewCount != null && (
          <div className="yt-views">{formatViews(item.viewCount)}</div>
        )}
      </div>
      <div className="yt-card-cta">
        <ion-icon name={busy ? 'sync' : 'play'}></ion-icon>
        <span>{busy ? 'Loading…' : 'Play'}</span>
      </div>
    </button>
  );
});

// Browse-mode tile (Subscriptions, Your Videos, channel-in-subscription-list, etc).
// Square-ish card with optional thumbnail + title + subtitle. The first one
// in a zone gets data-zone-default so initial focus lands here.
const YoutubeTile = React.forwardRef(function YoutubeTile(
  { item, onOpen, isDefault }, ref
) {
  return (
    <button
      ref={ref}
      type="button"
      className="yt-tile"
      aria-label={item.title}
      onClick={() => onOpen(item)}
      data-zone-default={isDefault ? 'true' : undefined}
    >
      <div className="yt-tile-thumb"
           style={{ backgroundImage: item.thumbnail ? `url(${item.thumbnail})` : '' }}>
        {!item.thumbnail && <ion-icon name={tileIconFor(item)}></ion-icon>}
      </div>
      <div className="yt-tile-title">{item.title}</div>
      {item.subtitle && <div className="yt-tile-sub">{item.subtitle}</div>}
    </button>
  );
});

function tileIconFor(item) {
  // Best-effort default icon for landing tiles that don't have a thumbnail.
  switch (item.id) {
    case 'subscriptions': return 'people-outline';
    case 'uploads':       return 'cloud-upload-outline';
    case 'likes':         return 'heart-outline';
    case 'playlists':     return 'list-outline';
    default:              return 'folder-outline';
  }
}

function YoutubeView() {
  // Hooks ALWAYS above any early-return — see feedback memory.
  const [path, setPath]         = useState('/');
  const [history, setHistory]   = useState([]);   // stack of prior paths for Back
  const [items, setItems]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [query, setQuery]       = useState('');
  const [searching, setSearching] = useState(false);
  const [playingId, setPlayingId] = useState(null);
  const [nowPlaying, setNowPlaying] = useState(null);
  const inputRef       = useRef(null);
  const firstTileRef   = useRef(null);
  const firstResultRef = useRef(null);
  // Map of tile targetPath → DOM button, used to restore focus when the
  // user navigates back. Populated by each YoutubeTile's ref callback.
  // The zone engine's own focus-memory keys on DOM element identity, and
  // those elements are recreated when the item list rerenders — so we
  // have to do this ourselves keyed by stable item identity.
  const tileRefs       = useRef(Object.create(null));
  // When goBack() pops, this holds the path we're returning FROM so the
  // post-load focus effect can find the matching tile and restore focus
  // there instead of grabbing the first tile.
  const returnFromPath = useRef(null);
  // The path that the currently-loaded `items` belong to. Updated inside
  // the fetch's .then() when new items land. The focus effect bails out
  // while this disagrees with `path`, because that disagreement means we
  // just navigated and the OLD page's items + refs are still in scope.
  // Without this gate, an rAF-deferred focus call still fires against
  // the stale items before React's setLoading(true) re-render commits.
  const itemsPath      = useRef('/');

  // Refetch items whenever the path changes. Drop stale tile refs from
  // the prior page so the focus-restore lookup can't latch onto a
  // detached DOM node that React already removed.
  useEffect(() => {
    let cancelled = false;
    tileRefs.current = Object.create(null);
    setLoading(true); setError(null);
    (async () => {
      try {
        const r = await window.playbill.controller.command({
          action: 'source.list', sourceId: 'youtube', path,
        });
        if (cancelled) return;
        // Mark items as belonging to THIS path BEFORE calling setItems
        // so the focus effect, which reads itemsPath synchronously,
        // sees the match in the very next render.
        itemsPath.current = path;
        setItems((r && r.items) || []);
      } catch (e) {
        if (cancelled) return;
        itemsPath.current = path;
        setError(String(e.message || e));
        setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [path]);

  // After items load, autofocus the appropriate element. Three cases:
  //   1. Returning from a drill-down (goBack just fired) → restore focus
  //      onto the tile we drilled in from, keyed by its targetPath.
  //   2. Forward into a video list → first result card.
  //   3. Forward into a directory list (or the landing page) → first tile.
  // We deliberately do NOT autofocus the search box; the first tile is
  // a better default because pressing Enter on the search box opens the
  // on-screen keyboard, which isn't what most visits to YouTube want.
  // Up from the first tile still reaches the search input via the
  // sibling-zone escape in focus-zones.js.
  // Defer focus work to the next animation frame and cancel any pending
  // one when the effect re-runs. Reason: when path changes, this effect
  // fires multiple times in rapid succession — first with stale items
  // and stale refs (the previous page's DOM hasn't unmounted yet),
  // again when loading flips to true, and finally with the new items.
  // Without the rAF + cancel guard, the stale-state run clears
  // returnFromPath and focuses a soon-to-be-unmounted element; by the
  // time the real items are present, there's nothing left to restore.
  // rAF lets all React commits settle, and the cleanup cancellation
  // ensures only the LAST scheduled frame actually runs.
  useEffect(() => {
    if (loading) return;
    // Bail out while the items we're showing belong to a different path.
    // This happens for ~one render after every navigation: path has the
    // new value, but the old page's items + refs haven't been swapped
    // out yet because the fetch hasn't resolved.
    if (itemsPath.current !== path) return;
    const id = requestAnimationFrame(() => {
      const ret = returnFromPath.current;
      if (ret && tileRefs.current[ret]) {
        returnFromPath.current = null;
        tileRefs.current[ret].focus();
        return;
      }
      if (firstResultRef.current) {
        returnFromPath.current = null;
        firstResultRef.current.focus();
        return;
      }
      if (firstTileRef.current) {
        returnFromPath.current = null;
        firstTileRef.current.focus();
        return;
      }
    });
    return () => cancelAnimationFrame(id);
  }, [loading, items, path]);

  // Internal back navigation — when we're below '/', register a back
  // hook so the shell's goBack() pops our stack before falling through
  // to the SideNav. Routed through goBack() so the focus-restore path
  // works whether Back came from the remote or the on-screen button.
  useEffect(() => {
    if (path === '/') return;
    window.PlaybillBackHook = () => { goBack(); return true; };
    return () => { window.PlaybillBackHook = null; };
  }, [path, history]);

  // Subscribe to controller state for live now-playing updates.
  useEffect(() => {
    if (!window.playbill || !window.playbill.controller) return;
    let unsub;
    (async () => {
      const init = await window.playbill.controller.getState();
      if (init && init.state) setNowPlaying(init.state.nowPlaying || null);
      unsub = window.playbill.controller.onState((s) => {
        setNowPlaying(s ? (s.nowPlaying || null) : null);
      });
    })();
    return () => { if (unsub) unsub(); };
  }, []);

  function navigate(targetPath) {
    setHistory((h) => [...h, path]);
    setPath(targetPath);
  }

  function openItem(item) {
    if (item.type === 'directory') {
      if (item.targetPath) navigate(item.targetPath);
    } else {
      play(item);
    }
  }

  async function doSearch(e) {
    if (e) e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    navigate('/search/' + encodeURIComponent(q));
    // setSearching cleared by the path-change useEffect below — guard so
    // the spinner doesn't linger if list() throws fast.
    setTimeout(() => setSearching(false), 50);
  }

  async function play(item) {
    setError(null); setPlayingId(item.id);
    try {
      await window.playbill.controller.command({
        action: 'transport.play',
        sourceId: 'youtube',
        itemId: item.id,
        metadata: {
          sourceItemId: item.id,
          title: item.title,
          subtitle: item.channel,
          artworkUrl: item.thumbnail,
          durationMs: item.duration ? item.duration * 1000 : null,
        },
      });
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setPlayingId(null);
    }
  }

  async function stop() {
    try { await window.playbill.controller.command({ action: 'transport.stop' }); }
    catch (e) { setError(String(e.message || e)); }
  }

  async function pauseToggle() {
    try { await window.playbill.controller.command({ action: 'transport.toggle' }); }
    catch (e) { setError(String(e.message || e)); }
  }

  function goBack() {
    const prev = history.length ? history[history.length - 1] : '/';
    // Stash the path we're leaving so the post-load focus effect can
    // light up the matching tile on the page we're returning to.
    returnFromPath.current = path;
    setHistory((h) => h.slice(0, -1));
    setPath(prev);
  }

  // Split items into directories (tile grid) and videos (result cards).
  // A given path returns one or the other in practice — Subscriptions
  // gives directories (channels), /uploads gives videos — but we sort
  // them anyway in case a future route mixes them.
  const dirItems  = items.filter((it) => it.type === 'directory');
  const playItems = items.filter((it) => it.type !== 'directory');

  return (
    <div
      data-zone-root
      data-zone="youtube"
      data-zone-axis="vertical"
      className="yt-view"
    >
      <div data-zone="youtube.search" data-zone-axis="horizontal" className="yt-header">
        {path !== '/' && (
          <button type="button" className="tv-btn yt-back" onClick={goBack} aria-label="Back">
            <ion-icon name="chevron-back"></ion-icon>
          </button>
        )}
        <h1>
          <ion-icon name="logo-youtube" style={{color:'#FF0000', verticalAlign:'middle'}}></ion-icon>{' '}
          {titleForPath(path, query)}
        </h1>
        <form className="yt-search" onSubmit={doSearch}>
          <ion-icon name="search"></ion-icon>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search YouTube…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={searching}
            data-osk="text"
            data-osk-submit
            data-osk-title="Search YouTube"
          />
          <button type="submit" className="tv-btn primary" disabled={searching || !query.trim()}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </form>
      </div>

      {nowPlaying && (
        <div className="yt-nowplaying">
          <div className="yt-np-title">
            {nowPlaying.paused ? <ion-icon name="pause-circle"></ion-icon> : <ion-icon name="play-circle" style={{color:'#52a441'}}></ion-icon>}
            <strong>{nowPlaying.title || 'Playing'}</strong>
            {nowPlaying.subtitle && <span style={{color:'rgba(255,255,255,0.5)'}}> — {nowPlaying.subtitle}</span>}
          </div>
          <div className="yt-np-actions">
            <button type="button" className="tv-btn" onClick={pauseToggle}>
              <ion-icon name={nowPlaying.paused ? 'play' : 'pause'}></ion-icon>
              {nowPlaying.paused ? 'Resume' : 'Pause'}
            </button>
            <button type="button" className="tv-btn" onClick={stop}>
              <ion-icon name="stop"></ion-icon> Stop
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="yt-error">
          <ion-icon name="alert-circle"></ion-icon> {error}
        </div>
      )}

      {loading && (
        <div className="yt-empty">
          <ion-icon name="sync-outline" style={{fontSize: 36, opacity: 0.4, animation:'spin 1s linear infinite'}}></ion-icon>
          <p>Loading…</p>
        </div>
      )}

      {!loading && !error && dirItems.length === 0 && playItems.length === 0 && (
        <div className="yt-empty">
          <ion-icon name={path === '/' ? 'search-outline' : 'folder-open-outline'}
                    style={{fontSize: 48, opacity: 0.3}}></ion-icon>
          <p>{path === '/' ? 'Enter a search term above and press Enter.'
                            : 'Nothing here yet.'}</p>
        </div>
      )}

      {!loading && dirItems.length > 0 && (
        <div data-zone="youtube.tiles" data-zone-axis="grid" className="yt-tiles">
          {dirItems.map((it, i) => (
            <YoutubeTile
              key={(it.id || '') + '|' + (it.targetPath || i)}
              ref={(el) => {
                if (i === 0) firstTileRef.current = el;
                if (it.targetPath) {
                  if (el) tileRefs.current[it.targetPath] = el;
                  else delete tileRefs.current[it.targetPath];
                }
              }}
              item={it}
              onOpen={openItem}
              isDefault={i === 0}
            />
          ))}
        </div>
      )}

      {!loading && playItems.length > 0 && (
        <div data-zone="youtube.results" data-zone-axis="vertical" className="yt-results">
          {playItems.map((it, i) => (
            <YoutubeResultCard
              key={it.id + '|' + i}
              ref={i === 0 ? firstResultRef : null}
              item={it}
              onPlay={play}
              busy={playingId === it.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function titleForPath(path, query) {
  if (path === '/')                     return 'YouTube';
  if (path === '/subscriptions')        return 'Subscriptions';
  if (path === '/uploads')              return 'Your Videos';
  if (path === '/likes')                return 'Liked Videos';
  if (path === '/playlists')            return 'Playlists';
  if (path.startsWith('/playlist/'))    return 'Playlist';
  if (path.startsWith('/channel/'))     return 'Channel';
  if (path.startsWith('/search/')) {
    const q = decodeURIComponent(path.slice('/search/'.length));
    return q ? `Search: ${q}` : 'Search';
  }
  return 'YouTube';
}

function formatDuration(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

function formatViews(n) {
  if (n < 1000) return `${n} views`;
  if (n < 1_000_000) return `${(n/1000).toFixed(n < 10000 ? 1 : 0)}K views`;
  if (n < 1_000_000_000) return `${(n/1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M views`;
  return `${(n/1_000_000_000).toFixed(1)}B views`;
}

Object.assign(window, { YoutubeView });
