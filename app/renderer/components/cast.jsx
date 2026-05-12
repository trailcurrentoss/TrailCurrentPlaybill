/* Cast screen — AirPlay receiver host UI.

   When this screen mounts we ask the controller to start UxPlay; UxPlay
   takes over the display with its own GStreamer fullscreen window once
   a phone connects. This screen is what the user sees BEFORE that — a
   big informational card with the receiver name and how-to text. When
   the user presses Back / Home, app.jsx unmounts this view and the
   useEffect cleanup fires cast.stop, which kills UxPlay and returns the
   compositor to Playbill.

   State source of truth is state.cast on the controller — we subscribe
   so the status pill reflects connect/disconnect in real time without
   polling. */

function CastView() {
  // Local snapshot of state.cast. Initial values match the controller's
  // seed (handlers/cast.js publish()) so the empty render doesn't flash
  // "Disconnected" before the first state arrives.
  const [castState, setCastState] = useState({
    running:    false,
    state:      'starting',
    clientName: null,
    lastError:  null,
  });
  const [receiverName, setReceiverName] = useState('Playbill');

  // Start UxPlay on mount, stop on unmount. The controller side is
  // idempotent so a quick mount/unmount/mount cycle doesn't pile up
  // processes.
  useEffect(() => {
    if (!window.playbill || !window.playbill.controller) return undefined;

    let cancelled = false;

    (async () => {
      try {
        const init = await window.playbill.controller.getState();
        if (cancelled) return;
        const name = init.state && init.state.settings &&
                     init.state.settings.device && init.state.settings.device.name;
        if (name) setReceiverName(name);
        if (init.state && init.state.cast) setCastState(init.state.cast);
      } catch (_) { /* controller may not be up — UI shows offline state */ }

      try {
        await window.playbill.controller.command({ action: 'cast.start' });
      } catch (e) {
        if (cancelled) return;
        setCastState((s) => ({ ...s, lastError: e && e.message }));
      }
    })();

    const unsubState = window.playbill.controller.onState((s) => {
      if (!s) return;
      if (s.cast) setCastState(s.cast);
      const name = s.settings && s.settings.device && s.settings.device.name;
      if (name) setReceiverName(name);
    });

    return () => {
      cancelled = true;
      if (unsubState) unsubState();
      // Fire-and-forget. Don't await — React's cleanup must be synchronous
      // and the controller handler is idempotent, so the worst case is a
      // duplicate stop on an already-dead process.
      window.playbill.controller.command({ action: 'cast.stop' })
        .catch((e) => console.warn('[cast] cast.stop on unmount failed:', e && e.message));
    };
  }, []);

  const status = castState && castState.state;
  let statusLabel, statusTone;
  if (castState && castState.lastError) {
    statusLabel = 'Receiver failed to start';
    statusTone  = 'error';
  } else if (status === 'streaming') {
    statusLabel = castState.clientName ? `Streaming from ${castState.clientName}` : 'Streaming';
    statusTone  = 'live';
  } else if (status === 'connected') {
    statusLabel = castState.clientName ? `Connected to ${castState.clientName}` : 'Connected';
    statusTone  = 'live';
  } else if (status === 'waiting' || (castState && castState.running)) {
    statusLabel = 'Ready · waiting for a device';
    statusTone  = 'ready';
  } else {
    statusLabel = 'Starting receiver…';
    statusTone  = 'pending';
  }

  return (
    <div className="tv-view cast-view">
      <div className="cast-card">
        <div className="cast-glyph">
          <ion-icon name="phone-portrait-outline"></ion-icon>
        </div>

        <div className="cast-name">{receiverName}</div>

        <div className={'cast-status ' + statusTone}>
          {statusTone === 'live' && <span className="cast-dot"></span>}
          {statusLabel}
        </div>

        {castState && castState.lastError && (
          <div className="cast-error">{castState.lastError}</div>
        )}

        <div className="cast-howto">
          <div className="cast-howto-title">From an iPhone or iPad</div>
          <ol>
            <li>Open Control Center</li>
            <li>Tap <strong>Screen Mirroring</strong></li>
            <li>Choose <strong>{receiverName}</strong></li>
          </ol>
          <div className="cast-howto-note">
            DRM-protected content (Netflix, Disney+, etc.) will mirror as a black frame —
            that's an Apple restriction. Everything else, including Safari, YouTube,
            photos, and games, streams normally.
          </div>
        </div>

        <div className="cast-hint">Press <strong>Back</strong> on the remote to stop the receiver</div>
      </div>
    </div>
  );
}

Object.assign(window, { CastView });
