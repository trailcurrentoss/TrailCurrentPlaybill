/* Live TV — Hauppauge WinTV-dualHD model 01595 only (USB 2040:826d).

   Supported tuner is intentionally a single model: drivers (em28xx +
   em28xx-dvb + lgdt3306a + si2157 + tveeprom) come from the out-of-tree
   playbill-dvb-dkms package because the Radxa Q6A kernel ships no USB-DVB
   bridge drivers. See docs/app/live-tv.md for the rationale and the full
   driver chain. Adding another tuner means adding another module subtree
   to that DKMS package and updating its dkms.conf.

   NAV CONTRACT (docs/app/navigation.md): zone-root + zone-axis only. The
   FocusZones engine handles arrow motion + Enter/OK by clicking the focused
   element. There are zero `window.addEventListener('keydown')` calls. The
   focus prop is accepted for API symmetry with sibling views but is unused.

   Flow:
     1. On mount, ask the controller for adapters + cached channel list
        + tools probe (dvbv5-scan / dvbv5-zap presence).
     2. If no scan has been run, show the empty-state with a Rescan button.
     3. Render channels as focusable tiles (PSIP virtual ch # + station name),
        sorted by virtual channel number.
     4. OK on a tile → controller livetv.tune (kicks off dvbv5-zap into a
        TS file under RUNTIME_DIR) → controller transport.play on the TS
        file. mpv takes over the screen.
     5. Stop button (only visible when state.livetv.tuned) → livetv.stopTune
        + transport.stop, returns to the channel grid. */

function LiveView() {
  const [adapters, setAdapters]       = useState(null);   // null = loading
  const [channels, setChannels]       = useState(null);
  const [tools, setTools]             = useState(null);
  const [scanning, setScanning]       = useState(false);
  const [tuning, setTuning]           = useState(null);   // channel name being brought up
  const [error, setError]             = useState(null);
  const [livetv, setLivetv]           = useState(null);   // controller-owned state.livetv
  // Tracks a tune we asked for but whose IPC call rejected (most often
  // "controller command timed out"). When state.livetv subsequently flips
  // to tuned:true for this channel, the late-tune effect below fires
  // transport.play so mpv catches up. Cleared on a successful tune or on
  // a fresh user action. See watch() and the late-tune effect.
  const pendingChannelRef = useRef(null);

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

  // Subscribe to controller state.livetv so PWA / CAN-driven channel
  // changes (or another Playbill instance on the rig sharing a tuner via
  // Headwaters routing later) reflect in this UI immediately.
  useEffect(() => {
    if (!window.playbill || !window.playbill.controller) return;
    let unsub;
    (async () => {
      try {
        const init = await window.playbill.controller.getState();
        if (init && init.state) setLivetv(init.state.livetv);
      } catch (_) { /* controller may not be up yet */ }
      unsub = window.playbill.controller.onState((s) => { if (s) setLivetv(s.livetv); });
    })();
    return () => { if (unsub) unsub(); };
  }, []);

  // Late-scan self-heal. If rescan()'s IPC promise rejected with a
  // timeout but the controller's dvbv5-scan eventually finished,
  // state.livetv.lastScan.completedAt updates. We detect the change
  // here, reload the channels list, and clear the soft "Still
  // scanning…" notice — the UI heals without the user having to do
  // anything. Runs on first state arrival too (initial subscribe),
  // which is harmless: listChannels() is cheap and idempotent.
  useEffect(() => {
    if (!livetv || !livetv.lastScan) return;
    if (!livetv.lastScan.completedAt) return;
    (async () => {
      try {
        const list = await window.playbill.dvb.listChannels();
        setChannels(list || []);
        setScanning(false);
        // Clear only the "still scanning" placeholder; preserve any
        // real error already showing (e.g. tuner offline).
        setError((prev) => (prev && /still scanning/i.test(prev) ? null : prev));
      } catch (_) { /* noop */ }
    })();
  }, [livetv && livetv.lastScan ? livetv.lastScan.completedAt : null]);

  // Late-tune fallback. If watch() timed out at the IPC layer but the
  // controller's dvbv5-zap eventually locked, state.livetv flips to
  // { tuned: true, channel: <ours>, tsPath: ... } a few seconds later.
  // We catch that here and fire transport.play retroactively so mpv
  // catches up — otherwise the user would see "tuned" status but
  // nothing on screen and have to click the channel again, which kills
  // the freshly-locked frontend and starts the lock wait over.
  useEffect(() => {
    const pending = pendingChannelRef.current;
    if (!pending) return;
    if (!livetv || !livetv.tuned) return;
    if (livetv.channel !== pending) return;
    if (!livetv.tsPath) return;
    // Clear first to avoid re-firing on subsequent state deltas.
    pendingChannelRef.current = null;
    setError(null);
    (async () => {
      try {
        await window.playbill.controller.command({
          action:    'transport.play',
          sourceId:  'livetv',
          url:       livetv.tsPath,
          mediaType: 'video',
          metadata:  { title: pending, sourceItemId: pending },
        });
      } catch (e) {
        setError(String(e.message || e));
      }
    })();
  }, [livetv]);

  async function rescan() {
    setError(null); setScanning(true);
    try {
      // No adapter pinned — the controller's livetv.scan handler routes
      // through scanAuto() to fan the scan across every available demod
      // (the dualHD has two), roughly halving total time.
      //
      // Re-probe adapters too: a freshly-plugged tuner might have
      // appeared between the initial probe and the rescan click.
      const [a, scanResult] = await Promise.all([
        window.playbill.dvb.listAdapters(),
        window.playbill.dvb.scan({ country: 'US' }),
      ]);
      setAdapters(a);
      // controller livetv.scan returns { channels } (handlers/livetv.js); the
      // legacy IPC shim forwards the inner array. Tolerate both shapes.
      const list = Array.isArray(scanResult) ? scanResult : (scanResult && scanResult.channels) || [];
      setChannels(list);
    } catch (e) {
      // Don't surface the error if it's an IPC timeout — the late-scan
      // watcher below will pick up the channels once the controller-side
      // dvbv5-scan finishes. Set a soft note instead.
      const msg = String(e.message || e);
      setError(/timed out/i.test(msg)
        ? 'Still scanning… channel list will refresh when the tuner finishes.'
        : msg);
    } finally {
      setScanning(false);
    }
  }

  async function watch(ch) {
    setError(null); setTuning(ch.name);
    pendingChannelRef.current = ch.name;
    try {
      // Tune via the legacy playbill.dvb shim (forwards to controller
      // livetv.tune); playback goes straight to controller transport.play
      // so we don't depend on app/main/services/player.js (deleted in Phase 7).
      //
      // sourceId MUST be 'livetv' — otherwise transport.play's "stop every
      // other audio producer" guard fires livetv.stopAll() and kills the
      // dvbv5-zap capture we just started, before mpv opens the TS file.
      // The per-source audio trim (audio.perSourceTrimDb.livetv) also rides
      // on sourceId.
      // No adapter pinned — the controller's livetv.tune handler picks
      // whichever physical demod locks first (the WinTV-dualHD has two,
      // and on at least one unit adapter 0 is intermittently flaky).
      const { tsPath } = await window.playbill.dvb.tune({ channel: ch.name });
      pendingChannelRef.current = null;
      await window.playbill.controller.command({
        action:    'transport.play',
        sourceId:  'livetv',
        url:       tsPath,
        mediaType: 'video',
        metadata:  { title: ch.name, sourceItemId: ch.name },
      });
    } catch (e) {
      // The most common error here is "controller command timed out:
      // livetv.tune" — dvbv5-zap can take 60-90 s to acquire lock on a
      // marginal antenna and the IPC client's per-action cap fires
      // before the lock arrives. We leave pendingChannelRef set so the
      // late-tune effect below can fire transport.play if/when the
      // controller's state.livetv flips to tuned:true for this channel.
      //
      // We do NOT defensively call stopTune here. When two tune attempts
      // overlap (e.g. user clicks channel B while A's lock is still
      // resolving) the controller's tune(B) calls stopTune internally,
      // which SIGTERMs zap-A and makes tune-A reject with "exited null
      // before lock". The renderer landing here for the A error then
      // defensively-stop-tuning would kill zap-B that tune-B just
      // spawned, cascading kills across every rapid channel change.
      const msg = String(e.message || e);
      const isTimeout = /timed out/i.test(msg);
      if (!isTimeout) pendingChannelRef.current = null;
      setError(isTimeout
        ? `Still acquiring lock for ${ch.name}… (will play if signal comes in)`
        : msg);
    } finally {
      setTuning(null);
    }
  }

  async function stop() {
    setError(null);
    try {
      // Stop playback first so mpv releases the TS file, THEN kill dvbv5-zap.
      // Reverse order leaves mpv reading from a half-closed file for a beat.
      await window.playbill.controller.command({ action: 'transport.stop' });
      // No adapter specified — the handler kills any active tune session.
      await window.playbill.dvb.stopTune({});
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  async function stopScan() {
    // The user wanted out of the scan. Optimistically clear the local
    // scanning flag so the UI updates instantly; the rescan() promise
    // will resolve shortly (likely with an empty/partial channel list)
    // and re-set state from the result.
    setScanning(false);
    try {
      await window.playbill.dvb.stopScan();
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  const loading = adapters === null || channels === null || tools === null;
  const sortedChannels = sortByVirtualChannel(channels || []);
  const tunedName = livetv && livetv.tuned ? livetv.channel : null;

  return (
    <div
      data-zone-root
      data-zone="live"
      data-zone-axis="vertical"
      className="live-view"
    >
      <div className="view-hdr" style={{display:'flex', justifyContent:'space-between', alignItems:'flex-end'}}>
        <div>
          <h2>Live TV</h2>
          <p>{statusLine({ adapters, channels: sortedChannels, scanning, tools, tunedName })}</p>
        </div>
        <div data-zone="live.ctrl" data-zone-axis="horizontal" style={{display:'flex', gap:8}}>
          {tunedName && !scanning && (
            <button
              className="tv-btn"
              onClick={stop}
              title={`Stop ${tunedName}`}
            >
              <ion-icon name="stop-outline"></ion-icon>
              Stop
            </button>
          )}
          {scanning ? (
            <button
              className="tv-btn"
              data-zone-default="true"
              onClick={stopScan}
              title="Abort the channel scan and return to the previous channel list. The scan acquires the tuner exclusively, so tuning is blocked until it stops."
            >
              <ion-icon name="close-outline"></ion-icon>
              Stop Scan
            </button>
          ) : (
            <button
              className="tv-btn"
              onClick={rescan}
              disabled={tools && !tools.scan}
              title={tools && !tools.scan ? 'dvbv5-scan not installed' : 'Rescan ATSC frequency table'}
            >
              <ion-icon name="refresh-outline"></ion-icon>
              Rescan
            </button>
          )}
        </div>
      </div>

      {error && <div className="live-error">{error}</div>}

      {!loading && tools && !tools.scan && (
        <EmptyState
          icon="warning-outline"
          title="DVB tools not installed"
          body="Install dvb-tools (`apt install dvb-tools dtv-scan-tables`) to enable channel scanning and tuning."
        />
      )}

      {!loading && tools && tools.scan && adapters.length === 0 && (
        <EmptyState
          icon="hardware-chip-outline"
          title="No tuner connected"
          body="Plug in the Hauppauge WinTV-dualHD (model 01595, USB 2040:826d) and click Rescan. Other tuner models are not supported in this build."
        />
      )}

      {!loading && adapters.length > 0 && sortedChannels.length === 0 && !scanning && (
        <EmptyState
          icon="search-outline"
          title="No channels yet"
          body="Click Rescan to scan the antenna for ATSC broadcast channels in your area. A full scan takes a couple of minutes."
        />
      )}

      {!loading && sortedChannels.length > 0 && (
        <div
          data-zone="live.channels"
          data-zone-axis="grid"
          className="ch-grid"
          style={{marginTop: 18}}
        >
          {sortedChannels.map((ch) => {
            const isOnAir = tunedName === ch.name;
            // While dvbv5-scan is running it holds the frontend exclusively
            // — any tune attempt returns EBUSY. Disabling the tile here
            // both prevents that bad UX and signals to the user that the
            // scan is what's blocking them. The Stop Scan button is the
            // way out (controlled-focus default during scan).
            const disabled = scanning;
            return (
              <button
                key={ch.name}
                data-zone-default={isOnAir && !scanning ? 'true' : undefined}
                className={
                  'ch-tile' +
                  (tuning === ch.name ? ' tuning' : '') +
                  (isOnAir ? ' on-air' : '') +
                  (disabled ? ' disabled' : '')
                }
                onClick={disabled ? undefined : () => watch(ch)}
                disabled={disabled}
                title={disabled ? 'Channel scan in progress — Stop Scan to tune' : `Tune to ${ch.name}`}
              >
                <div className="ch-num">{formatChannelNumber(ch)}</div>
                <div className="ch-name">{ch.name}</div>
                <div className="ch-meta">{formatFreq(ch.frequency)} · {ch.modulation || 'ATSC'}</div>
                {tuning === ch.name && <div className="ch-tuning">Tuning…</div>}
                {isOnAir && tuning !== ch.name && <div className="ch-tuning ch-onair">On Air</div>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function statusLine({ adapters, channels, scanning, tools, tunedName }) {
  if (!tools) return 'Probing tuner…';
  if (tunedName) return `On air · ${tunedName}`;
  if (scanning) return 'Scanning ATSC frequency table…';
  if (!tools.scan) return 'OTA antenna · DVB tools missing';
  if (!adapters || adapters.length === 0) return 'OTA antenna · no tuner detected';
  const n = (channels || []).length;
  const adapterStr = adapters.length === 1 ? '1 tuner' : `${adapters.length} tuners`;
  return `OTA antenna · ${adapterStr} · ${n} channel${n === 1 ? '' : 's'}`;
}

// PSIP virtual channel parsing. dvbv5-scan stores ATSC PSIP info with two
// possible encodings depending on dtv-scan-tables version:
//   * SERVICE_ID = (major << 8) | minor    — older tables
//   * VCHANNEL = "5.1"                     — newer tables emit this directly
// Prefer VCHANNEL when present. Fall back to SERVICE_ID heuristic.
function virtualChannelTuple(ch) {
  const vch = ch.raw && ch.raw.VCHANNEL;
  if (vch && /^\d+\.\d+$/.test(vch)) {
    const [maj, min] = vch.split('.').map(Number);
    return [maj, min];
  }
  if (ch.serviceId && ch.serviceId > 255) {
    return [ch.serviceId >> 8, ch.serviceId & 0xff];
  }
  if (ch.serviceId) return [ch.serviceId, 0];
  return [9999, 0]; // unknown — sort to the end
}

function formatChannelNumber(ch) {
  const [maj, min] = virtualChannelTuple(ch);
  if (maj === 9999) return '—';
  return min ? `${maj}.${min}` : String(maj);
}

function sortByVirtualChannel(list) {
  return list.slice().sort((a, b) => {
    const [am, an] = virtualChannelTuple(a);
    const [bm, bn] = virtualChannelTuple(b);
    if (am !== bm) return am - bm;
    return an - bn;
  });
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
