/* Music — album grid view backed by the on-disk music library.

   Two screens, owned by this component:
     1. Album grid    — every album the user has ripped, sorted by
                        artist → year → title. Selecting an album drills
                        in.
     2. Album detail  — cover art + tracklist for one album. Selecting
                        a track plays it via transport.play; selecting
                        the album header plays the album from track 1.

   Library is read from the controller (music.libraryList scans the on-
   disk ~/Music/Playbill Library tree). We refresh on mount and whenever
   state.music.status transitions to 'done' so a freshly-ripped album
   shows up without a reload. Identical refresh discipline to LocalView. */

function MusicView() {
  const [albums, setAlbums] = useState([]);
  const [openId, setOpenId] = useState(null);   // null = grid; else absolute album path
  // Album-grid selection (keyboard/remote nav).
  const [gridIdx, setGridIdx] = useState(0);
  // Album-detail selection: -1 = the album-header "Play All", 0..N-1 = a track.
  const [trackIdx, setTrackIdx] = useState(-1);

  useEffect(() => {
    if (!window.playbill || !window.playbill.controller) return undefined;
    let mounted = true;
    const refresh = () => {
      window.playbill.controller.command({ action: 'music.libraryList' })
        .then((r) => { if (mounted && r) setAlbums(r.albums || []); })
        .catch(() => {});
    };
    refresh();
    let lastStatus = null;
    const unsub = window.playbill.controller.onState((s) => {
      const next = s && s.music && s.music.status;
      if (next === 'done' && lastStatus !== 'done') refresh();
      lastStatus = next;
    });
    return () => { mounted = false; if (unsub) unsub(); };
  }, []);

  // Currently-open album object (looked up by id).
  const openAlbum = openId ? albums.find((a) => a.id === openId) : null;

  // ─── Playback helpers ───────────────────────────────────────────────
  function playTrack(track, album) {
    if (!track || !track.url) return;
    if (!window.playbill || !window.playbill.controller) return;
    window.playbill.controller.command({
      action:    'transport.play',
      sourceId:  'local',
      url:       track.url,
      mediaType: 'audio',
      metadata: {
        title:      track.title,
        subtitle:   [track.artist || (album && album.artist), album && album.title].filter(Boolean).join(' · '),
        artworkUrl: (album && album.coverUrl) || null,
        sourceItemId: track.path,
      },
    }).catch((e) => console.warn('[music] transport.play failed:', e && e.message));
  }

  function playAlbum(album) {
    // Play the first track. A queue model lands when transport gains
    // one (mpv supports --playlist, but transport.play is single-item
    // today). For now, "Play All" plays track 1; the user can advance
    // with the remote's Next button.
    if (!album || !album.tracks || !album.tracks.length) return;
    playTrack(album.tracks[0], album);
  }

  // ─── Keyboard nav ───────────────────────────────────────────────────
  // We listen in CAPTURE phase so we run BEFORE app.jsx's bubble-phase
  // handler. For the keys we own (arrows used in grid/detail, Enter,
  // grid→library Back) we stopPropagation + preventDefault. Keys we
  // DON'T claim (Left at grid column 0; Home; Escape outside detail)
  // propagate to app.jsx so the universal contract (open SideNav,
  // go Home, go Back to apps) keeps working.
  useEffect(() => {
    function onKey(e) {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const consume = () => { e.stopPropagation(); e.preventDefault(); };

      if (openId) {
        // Detail screen.
        const tracks = (openAlbum && openAlbum.tracks) || [];
        if (e.key === 'ArrowDown') {
          setTrackIdx((i) => Math.min(tracks.length - 1, i + 1));
          consume();
        } else if (e.key === 'ArrowUp') {
          setTrackIdx((i) => Math.max(-1, i - 1));
          consume();
        } else if (e.key === 'Enter' || e.key === ' ') {
          if (trackIdx < 0) playAlbum(openAlbum);
          else              playTrack(tracks[trackIdx], openAlbum);
          consume();
        } else if (e.key === 'Escape' || e.key === 'Backspace') {
          // Back out of detail → grid. Without this, app.jsx's global
          // Back would jump us all the way to the apps grid.
          setOpenId(null);
          setTrackIdx(-1);
          consume();
        }
      } else {
        // Grid screen.
        const COLS = 6;
        if (e.key === 'ArrowRight') {
          setGridIdx((i) => Math.min(albums.length - 1, i + 1));
          consume();
        } else if (e.key === 'ArrowLeft') {
          // Left at column 0 falls through to app.jsx so the SideNav opens.
          if ((gridIdx % COLS) === 0) return;
          setGridIdx((i) => Math.max(0, i - 1));
          consume();
        } else if (e.key === 'ArrowDown') {
          setGridIdx((i) => Math.min(albums.length - 1, i + COLS));
          consume();
        } else if (e.key === 'ArrowUp') {
          setGridIdx((i) => Math.max(0, i - COLS));
          consume();
        } else if (e.key === 'Enter' || e.key === ' ') {
          const a = albums[gridIdx];
          if (a) { setOpenId(a.id); setTrackIdx(-1); }
          consume();
        }
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [openId, openAlbum, gridIdx, trackIdx, albums]);

  // ─── Render ─────────────────────────────────────────────────────────
  if (openAlbum) {
    return (
      <AlbumDetail
        album={openAlbum}
        trackIdx={trackIdx}
        onBack={() => { setOpenId(null); setTrackIdx(-1); }}
        onPlayAlbum={() => playAlbum(openAlbum)}
        onPlayTrack={(t) => playTrack(t, openAlbum)}
      />
    );
  }

  return (
    <div className="music-view">
      <div className="view-hdr" style={{display:'flex', justifyContent:'space-between', alignItems:'flex-end'}}>
        <div>
          <h2>Music</h2>
          <p>{albums.length} album{albums.length === 1 ? '' : 's'} in your offline library</p>
        </div>
      </div>

      {albums.length === 0 ? (
        <div className="music-empty">
          <ion-icon name="musical-notes-outline"></ion-icon>
          <h3>Your library is empty</h3>
          <p>Insert an audio CD and we'll offer to rip it. Albums you've ripped land here.</p>
        </div>
      ) : (
        <div className="poster-grid" style={{gridTemplateColumns: 'repeat(6, 1fr)'}}>
          {albums.map((album, i) => (
            <div
              key={album.id}
              className={'card square' + (gridIdx === i ? ' focused' : '')}
              style={{width: 'auto', cursor: 'pointer'}}
              onClick={() => { setOpenId(album.id); setTrackIdx(-1); }}
              role="button"
            >
              <div
                className={'thumb' + (album.coverUrl ? '' : ' no-poster')}
                style={{
                  backgroundImage: album.coverUrl ? `url(${album.coverUrl})` : 'none',
                  aspectRatio: '1',
                }}
              >
                {!album.coverUrl && (
                  <div className="no-poster-inner">
                    <ion-icon name="disc-outline"></ion-icon>
                    <div className="no-poster-title">{album.title}</div>
                  </div>
                )}
              </div>
              <div style={{padding: '10px 12px 12px'}}>
                <div className="title">{album.title}</div>
                <div className="meta">{album.artist}{album.year ? ` · ${album.year}` : ''}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AlbumDetail({ album, trackIdx, onBack, onPlayAlbum, onPlayTrack }) {
  const totalMin = album.totalDurationMs ? Math.round(album.totalDurationMs / 60000) : null;
  return (
    <div className="music-detail">
      <button className="music-back" onClick={onBack}>
        <ion-icon name="arrow-back-outline"></ion-icon>
        <span>Back to library</span>
      </button>

      <div className="music-detail-hero">
        <div
          className={'music-detail-cover' + (album.coverUrl ? '' : ' no-poster')}
          style={{ backgroundImage: album.coverUrl ? `url(${album.coverUrl})` : 'none' }}
        >
          {!album.coverUrl && <ion-icon name="disc-outline"></ion-icon>}
        </div>
        <div className="music-detail-body">
          <div className="music-detail-eyebrow">Album</div>
          <h2>{album.title}</h2>
          <div className="music-detail-meta">
            <span>{album.artist}</span>
            {album.year && <span>· {album.year}</span>}
            <span>· {album.trackCount} track{album.trackCount === 1 ? '' : 's'}</span>
            {totalMin && <span>· {totalMin} min</span>}
          </div>
          <button
            className={'music-play-all' + (trackIdx === -1 ? ' focused' : '')}
            onClick={onPlayAlbum}
          >
            <ion-icon name="play"></ion-icon>
            <span>Play album</span>
          </button>
        </div>
      </div>

      <div className="music-tracklist">
        {album.tracks.map((t, i) => (
          <div
            key={t.path}
            className={'music-track' + (trackIdx === i ? ' focused' : '')}
            onClick={() => onPlayTrack(t)}
            role="button"
          >
            <span className="music-track-num">{String(t.number).padStart(2, '0')}</span>
            <span className="music-track-title">{t.title}</span>
            <span className="music-track-dur">
              {t.durationMs ? formatTrackTime(t.durationMs) : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTrackTime(ms) {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

Object.assign(window, { MusicView });
