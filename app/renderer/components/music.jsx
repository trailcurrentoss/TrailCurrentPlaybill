/* Music — album grid view backed by the on-disk music library.

   Two screens, owned by this component:
     1. Album grid    — every album the user has ripped, sorted by
                        artist → year → title. Selecting an album drills
                        in.
     2. Album detail  — cover art + tracklist for one album. Selecting
                        a track plays it via transport.play; selecting
                        the album header plays the album from track 1.

   NAVIGATION CONTRACT (docs/app/navigation.md):
   This screen follows the three-pillar contract. It owns NO keyboard
   handler. Both the grid and the detail are tagged data-zone-root +
   data-zone-axis so FocusZones drives the d-pad. Buttons activate via
   their native onClick, which Enter triggers automatically.

   The one bit of hierarchy this screen owns is "Back inside the
   detail goes to the grid (not all the way out to the SideNav)." We
   register a global back-hook (window.PlaybillBackHook) that app.jsx's
   goBack consults BEFORE its universal logic. When the hook returns
   true, app.jsx stops. When it returns false (or no hook is
   registered), Back falls through to its normal "open SideNav at
   top-level" behavior. This is the canonical pattern any future screen
   with internal sub-states should follow — no per-screen keyboard
   handler, ever.

   Library is read from the controller (music.libraryList scans the on-
   disk ~/Music/Playbill Library tree). We refresh on mount and whenever
   state.music.status transitions to 'done' so a freshly-ripped album
   shows up without a reload. Identical refresh discipline to LocalView. */

function MusicView() {
  const [albums, setAlbums] = useState([]);
  const [openId, setOpenId] = useState(null);   // null = grid; else absolute album path

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

  // Register a back-hook so app.jsx's universal goBack steps out of the
  // detail BACK INTO the grid instead of jumping all the way to the
  // SideNav. Cleared on unmount so other screens don't inherit it.
  useEffect(() => {
    window.PlaybillBackHook = () => {
      if (openId) { setOpenId(null); return true; }
      return false;
    };
    return () => { if (window.PlaybillBackHook) delete window.PlaybillBackHook; };
  }, [openId]);

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
    if (!album || !album.tracks || !album.tracks.length) return;
    playTrack(album.tracks[0], album);
  }

  // ─── Render ─────────────────────────────────────────────────────────
  if (openAlbum) {
    return (
      <AlbumDetail
        album={openAlbum}
        onBack={() => setOpenId(null)}
        onPlayAlbum={() => playAlbum(openAlbum)}
        onPlayTrack={(t) => playTrack(t, openAlbum)}
      />
    );
  }

  return (
    <div
      className="music-view"
      data-zone-root
      data-zone="music"
      data-zone-axis="grid"
    >
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
        <div
          className="poster-grid"
          style={{gridTemplateColumns: 'repeat(6, 1fr)'}}
          data-zone="music.grid"
          data-zone-axis="grid"
        >
          {albums.map((album, i) => (
            <button
              key={album.id}
              type="button"
              className="card square music-album-card"
              onClick={() => setOpenId(album.id)}
              data-zone-default={i === 0 ? 'true' : undefined}
              aria-label={`${album.title} — ${album.artist}`}
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
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AlbumDetail({ album, onBack, onPlayAlbum, onPlayTrack }) {
  const totalMin = album.totalDurationMs ? Math.round(album.totalDurationMs / 60000) : null;
  return (
    <div
      className="music-detail"
      data-zone-root
      data-zone="music.detail"
      data-zone-axis="vertical"
    >
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
            className="music-play-all"
            onClick={onPlayAlbum}
            data-zone-default="true"
          >
            <ion-icon name="play"></ion-icon>
            <span>Play album</span>
          </button>
        </div>
      </div>

      <div className="music-tracklist" data-zone="music.detail.tracks" data-zone-axis="vertical">
        {album.tracks.map((t) => (
          <button
            key={t.path}
            type="button"
            className="music-track"
            onClick={() => onPlayTrack(t)}
            aria-label={t.title}
          >
            <span className="music-track-num">{String(t.number).padStart(2, '0')}</span>
            <span className="music-track-title">{t.title}</span>
            <span className="music-track-dur">
              {t.durationMs ? formatTrackTime(t.durationMs) : ''}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function formatTrackTime(ms) {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

Object.assign(window, { MusicView });
