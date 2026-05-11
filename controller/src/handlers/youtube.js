/* youtube.* command handlers — sign-in lifecycle + per-source settings.

   These are YouTube-specific commands that don't fit the generic
   source.list/search/resolve dispatcher (which is plugin-agnostic).
   Sign-in flow needs UI-driven steps (start → poll → success) so it gets
   its own actions; per-source settings (clientId/clientSecret) likewise.

   State surface mirrored into state.youtube:
     {
       configured:    true if both clientId+clientSecret are set
       signedIn:      true once tokens persist
       account:       { title, channelId, thumbnail }  (after signIn + refresh)
       pending:       { user_code, verification_url, expires_at, interval } | null
     }

   The Settings UI (Phase 6c.2) reads state.youtube to decide what to show:
     not configured → fields for clientId+clientSecret + Save
     configured, not signedIn → Sign In button
     signedIn → "Signed in as <title>" + Sign Out
     signing in → big Code + URL + countdown */

'use strict';

const auth    = require('../sources/youtube/auth');
const dataApi = require('../sources/youtube/data-api');

let pollTimer = null;

function register({ bus, state }) {

  // Convenience to keep state.youtube up to date in one place.
  async function refreshState() {
    const cur = state.get().youtube || {};
    const settings = await auth.getSettings();
    let account = cur.account || null;
    if (auth.isSignedIn() && !account) {
      try { account = await dataApi.getMyChannel(); }
      catch (e) { console.warn('[youtube] getMyChannel failed:', e.message); }
    }
    if (!auth.isSignedIn()) account = null;

    state.patch({
      youtube: {
        configured:    settings.clientIdSet && settings.clientSecretSet,
        clientIdSet:   settings.clientIdSet,
        clientSecretSet: settings.clientSecretSet,
        signedIn:      auth.isSignedIn(),
        account,
        pending:       auth.pendingState(),
      },
    });
  }

  // Initialize state.youtube on startup so subscribers see a real snapshot.
  refreshState().catch((e) => console.warn('[youtube] initial state refresh failed:', e.message));

  // ─── Settings ─────────────────────────────────────────────────────

  bus.register('youtube.getSettings', async () => auth.getSettings());

  bus.register('youtube.setSettings', async (cmd) => {
    const v = cmd.value || {};
    const r = await auth.setSettings(v);
    await refreshState();
    return r;
  });

  // ─── Sign-in flow ─────────────────────────────────────────────────

  bus.register('youtube.signInStart', async () => {
    if (auth.isSignedIn()) return { status: 'already-signed-in' };
    const started = await auth.start();
    await refreshState();
    // Auto-poll in the background so the GUI doesn't have to. Timer uses
    // the interval Google handed back; we patch state.youtube on every
    // status flip so subscribers see live progress.
    startBackgroundPoll();
    return started;
  });

  bus.register('youtube.signInPoll', async () => {
    const r = await auth.poll();
    if (r.status === 'success') {
      stopBackgroundPoll();
      await refreshState();
    } else if (r.status === 'expired' || r.status === 'denied' || r.status === 'error') {
      stopBackgroundPoll();
      await refreshState();
    }
    return r;
  });

  bus.register('youtube.signInCancel', async () => {
    auth.cancel();
    stopBackgroundPoll();
    await refreshState();
    return { ok: true };
  });

  bus.register('youtube.signOut', async () => {
    const r = await auth.signOut();
    await refreshState();
    return r;
  });

  bus.register('youtube.getAccount', async () => {
    if (!auth.isSignedIn()) return null;
    return dataApi.getMyChannel();
  });

  // ─── Background polling ───────────────────────────────────────────

  function startBackgroundPoll() {
    stopBackgroundPoll();
    const tick = async () => {
      const cur = auth.pendingState();
      if (!cur) { stopBackgroundPoll(); return; }
      try {
        const r = await auth.poll();
        if (r.status === 'success' || r.status === 'expired' ||
            r.status === 'denied'  || r.status === 'error') {
          stopBackgroundPoll();
          await refreshState();
          return;
        }
      } catch (e) {
        console.warn('[youtube] background poll error:', e.message);
      }
      // Re-arm with the (possibly updated) interval.
      const cur2 = auth.pendingState();
      if (cur2) pollTimer = setTimeout(tick, cur2.interval);
    };
    const cur = auth.pendingState();
    pollTimer = setTimeout(tick, (cur && cur.interval) || 5000);
  }

  function stopBackgroundPoll() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }
}

module.exports = { register };
