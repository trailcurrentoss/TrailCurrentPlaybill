/* Live TV — Hauppauge WinTV-dualHD (or any in-tree linux-dvb device).

   Flow:
     1. On mount, ask main for adapters + cached channel list.
     2. If no scan has been run yet, show the empty-state with a Rescan button.
     3. Render channels as focusable tiles (PSIP virtual ch # + station name).
     4. Enter on a tile → main starts dvbv5-zap and mpv (fullscreen overlay,
        hardware-decoded). Renderer hides itself behind the player.
     5. mpv exits or user presses Escape → renderer regains the screen and
        the channel grid is refocused. */

function LiveView({ focus }) {
  const [adapters, setAdapters]       = useState(null);   // null = loading
  const [channels, setChannels]       = useState(null);
  const [tools, setTools]             = useState(null);
  const [scanning, setScanning]       = useState(false);
  const [tuning, setTuning]           = useState(null);   // channel name being brought up
  const [error, setError]             = useState(null);

  // Initial probe: tools available? Adapters present? Channels cached?
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, a, ch] = await Promise.all([
          window.playbill.dvb.probeTools(),
          window.playbill.dvb.listAdapters(),
          window.playbill.dvb.listChannels(),
        ]);
        if (cancelled) return;
        setTools(t); setAdapters(a); setChannels(ch);
      } catch (e) {
        if (!cancelled) setError(String(e.message || e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function rescan() {
    setError(null); setScanning(true);
    try {
      const ch = await window.playbill.dvb.scan({ adapter: 0, country: 'US' });
      setChannels(ch);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setScanning(false);
    }
  }

  async function watch(ch) {
    setError(null); setTuning(ch.name);
    try {
      const { tsPath } = await window.playbill.dvb.tune({ adapter: 0, channel: ch.name });
      await window.playbill.player.play({ source: tsPath });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setTuning(null);
    }
  }

  // Enter from focus engine → tune the focused channel.
  useEffect(() => {
    function onKey(e) {
      if (focus.row !== 'epg') return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const ch = (channels || [])[focus.rowY];
      if (ch) watch(ch);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus, channels]);

  const loading = adapters === null || channels === null || tools === null;

  return (
    <div className="live-view">
      <div className="view-hdr" style={{display:'flex', justifyContent:'space-between', alignItems:'flex-end'}}>
        <div>
          <h2>Live TV</h2>
          <p>{statusLine({ adapters, channels, scanning, tools })}</p>
        </div>
        <div style={{display:'flex', gap:8}}>
          <button
            className={'tv-btn' + (focus.row === 'live-ctrl' && focus.col === 0 ? ' focused' : '')}
            onClick={rescan}
            disabled={scanning || (tools && !tools.scan)}
          >
            <ion-icon name={scanning ? 'sync-outline' : 'refresh-outline'}></ion-icon>
            {scanning ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
      </div>

      {error && <div className="live-error">{error}</div>}

      {!loading && tools && !tools.scan && (
        <EmptyState
          icon="warning-outline"
          title="DVB tools not installed"
          body="Install dvb-tools (`apt install dvb-tools`) to enable channel scanning and tuning."
        />
      )}

      {!loading && tools && tools.scan && adapters.length === 0 && (
        <EmptyState
          icon="hardware-chip-outline"
          title="No tuner connected"
          body="Plug in the Hauppauge WinTV-dualHD (or compatible linux-dvb tuner) and click Rescan."
        />
      )}

      {!loading && adapters.length > 0 && channels.length === 0 && !scanning && (
        <EmptyState
          icon="search-outline"
          title="No channels yet"
          body="Click Rescan to scan the antenna for ATSC broadcast channels in your area."
        />
      )}

      {!loading && channels.length > 0 && (
        <div className="ch-grid" style={{marginTop: 18}}>
          {channels.map((ch, idx) => (
            <button
              key={ch.name}
              className={
                'ch-tile' +
                (focus.row === 'epg' && focus.rowY === idx ? ' focused' : '') +
                (tuning === ch.name ? ' tuning' : '')
              }
              onClick={() => watch(ch)}
            >
              <div className="ch-num">{formatChannelNumber(ch)}</div>
              <div className="ch-name">{ch.name}</div>
              <div className="ch-meta">{formatFreq(ch.frequency)} · {ch.modulation || 'ATSC'}</div>
              {tuning === ch.name && <div className="ch-tuning">Tuning…</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function statusLine({ adapters, channels, scanning, tools }) {
  if (!tools) return 'Probing tuner…';
  if (scanning) return 'Scanning ATSC frequency table…';
  if (!tools.scan) return 'OTA antenna · DVB tools missing';
  if (!adapters || adapters.length === 0) return 'OTA antenna · no tuner detected';
  const n = (channels || []).length;
  const adapterStr = adapters.length === 1 ? '1 tuner' : `${adapters.length} tuners`;
  return `OTA antenna · ${adapterStr} · ${n} channel${n === 1 ? '' : 's'}`;
}

function formatChannelNumber(ch) {
  // ATSC PSIP encodes major/minor in a 16-bit service ID. dvbv5-scan stores
  // it as `SERVICE_ID = (major << 8) | minor` in some firmware revisions.
  // Until we wire a richer scan parser, just show the service id if present.
  if (!ch.serviceId) return '—';
  // Heuristic: many ATSC tables encode (major*256+minor); above 255 = real PSIP.
  if (ch.serviceId > 255) {
    const major = ch.serviceId >> 8;
    const minor = ch.serviceId & 0xff;
    return `${major}.${minor}`;
  }
  return String(ch.serviceId);
}

function formatFreq(hz) {
  if (!hz) return '';
  return `${(hz / 1e6).toFixed(0)} MHz`;
}

function EmptyState({ icon, title, body }) {
  return (
    <div className="live-empty">
      <ion-icon name={icon}></ion-icon>
      <div className="t">{title}</div>
      <div className="b">{body}</div>
    </div>
  );
}

Object.assign(window, { LiveView });
