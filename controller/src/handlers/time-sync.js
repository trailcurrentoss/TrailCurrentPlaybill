/* time-sync.* — discipline the local clock from GNSS time on the CAN bus.

   The rig's GNSS module (Picket / Aftline) decodes UTC time from satellite
   fix and a CAN-to-MQTT bridge fans it onto `local/gps/time` as
   `{year, month, day, hour, minute, second}` once per second. Off-grid
   rigs have no NTP reachable, so this is the only authoritative time
   source available. On-grid rigs also benefit — GNSS is faster to reach
   "second-accurate" than chronyd hunting through pool servers, and it
   keeps working when the LTE link drops.

   How:
     1. Subscribe to local/gps/time.
     2. Parse the payload into a UTC epoch.
     3. Sanity-check (post-2024, before now+30 days — guards against the
        common "GPS reports 0000-00-00 before fix" startup glitch).
     4. If the local clock drifts more than TOLERANCE_MS from GNSS time,
        and we're not in the cooldown window, set the system clock via
        timedatectl. We disable NTP first because timedatectl refuses to
        set time while NTP is active.
     5. After a successful set, cool down for COOLDOWN_MS so we don't
        thrash on every 1 Hz message. Drift checks continue; resync only
        if drift re-exceeds tolerance after the cooldown.

   Permissions:
     This handler is intentionally NOT registered in index.js — see the
     comment block there. It remains here for the day GNSS time-sync is
     wired back in.

     If/when it IS re-enabled, sudo is NOT passwordless on the production
     image (was removed for security — well-known default password + open
     sudo = trivial privesc). A narrow sudoers drop-in for the
     trailcurrent user limited to `/usr/bin/timedatectl set-time` and
     `set-ntp` would be the right way to grant the two specific commands
     without re-opening sudo wholesale. Today this code's `sudo -n …`
     calls will fail at runtime — that's fine, the handler isn't loaded. */

'use strict';

const { spawn } = require('child_process');

const SUBSCRIBE_TOPIC = 'local/gps/time';
const TOLERANCE_MS = 5_000;        // 5 s drift threshold
const COOLDOWN_MS  = 10 * 60 * 1000; // 10 min between successful sets
const SANITY_MIN_YEAR = 2024;
const SANITY_MAX_FUTURE_MS = 30 * 24 * 60 * 60 * 1000; // ~30 days

function tsFromPayload(p) {
  if (!p || typeof p !== 'object') return null;
  const { year, month, day, hour, minute, second } = p;
  // All six fields must be numbers. GNSS reports them as ints.
  if ([year, month, day, hour, minute, second].some((v) => typeof v !== 'number')) return null;
  if (year < SANITY_MIN_YEAR) return null;
  // Date.UTC is 0-indexed for month (Jan = 0). The CAN payload is
  // 1-indexed (Jan = 1, per ISO).
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

function fmtForTimedatectl(ms) {
  // timedatectl expects "YYYY-MM-DD HH:MM:SS" in the system's local time
  // zone. Use UTC to avoid TZ ambiguity — set-time accepts any zone if we
  // pass --utc. systemd 252+ supports `--utc`; older versions don't, so
  // we format as UTC string and pass --utc only if available. To keep it
  // simple here we just format as UTC and pass --utc; if --utc is rejected
  // we fall back to local-time formatting on the retry.
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (b) => { stdout += b.toString(); });
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('error', (err) => resolve({ code: -1, stdout: '', stderr: err.message }));
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function register({ bus, state, mqtt }) {
  let lastSetAt = 0;
  let ntpDisabled = false;     // once-per-process flag
  let lastWarnAt = 0;
  let lastReceivedAt = null;

  async function disableNtpOnce() {
    if (ntpDisabled) return true;
    const r = await runCmd('sudo', ['-n', '/usr/bin/timedatectl', 'set-ntp', 'false']);
    if (r.code === 0) {
      ntpDisabled = true;
      console.log('[time-sync] disabled systemd-timesyncd NTP so GNSS can discipline the clock');
      return true;
    }
    if (Date.now() - lastWarnAt > 60_000) {
      lastWarnAt = Date.now();
      console.warn(`[time-sync] timedatectl set-ntp false failed (code ${r.code}): ${r.stderr.trim()}`);
    }
    return false;
  }

  async function setSystemClockTo(ms) {
    if (!(await disableNtpOnce())) return false;
    const stamp = fmtForTimedatectl(ms);
    let r = await runCmd('sudo', ['-n', '/usr/bin/timedatectl', 'set-time', stamp, '--utc']);
    if (r.code !== 0) {
      // Older timedatectl rejects --utc; retry without it (the stamp is
      // already UTC numerically, which is identical to local-time if TZ=UTC,
      // but we'll trust the system's TZ — there's no portable middle ground).
      r = await runCmd('sudo', ['-n', '/usr/bin/timedatectl', 'set-time', stamp]);
    }
    if (r.code === 0) {
      console.log(`[time-sync] set system clock from GNSS → ${stamp} UTC`);
      return true;
    }
    if (Date.now() - lastWarnAt > 60_000) {
      lastWarnAt = Date.now();
      console.warn(`[time-sync] timedatectl set-time failed (code ${r.code}): ${r.stderr.trim()}`);
    }
    return false;
  }

  mqtt.subscribeTopic(SUBSCRIBE_TOPIC, async (_topic, payload) => {
    const gnssMs = tsFromPayload(payload);
    if (gnssMs === null) return;

    // Sanity: don't accept anything more than 30 days in the future.
    if (gnssMs > Date.now() + SANITY_MAX_FUTURE_MS) return;

    lastReceivedAt = Date.now();
    const drift = Math.abs(Date.now() - gnssMs);

    // Stamp telemetry.location.gnssTimeMs so the UI can show a GNSS-locked
    // pill instead of relying solely on system clock.
    const cur = state.get().telemetry || {};
    const loc = cur.location || {};
    if (loc.gnssTimeMs !== gnssMs) {
      state.patch({ telemetry: { ...cur, location: { ...loc, gnssTimeMs: gnssMs, ts: Date.now() } } });
    }

    if (drift <= TOLERANCE_MS) return;
    if (Date.now() - lastSetAt < COOLDOWN_MS) return;

    const ok = await setSystemClockTo(gnssMs);
    if (ok) lastSetAt = Date.now();
  });

  bus.register('time-sync.status', async () => ({
    ntpDisabled,
    lastSetAt,
    lastReceivedAt,
    cooldownRemainingMs: Math.max(0, COOLDOWN_MS - (Date.now() - lastSetAt)),
  }));
}

module.exports = { register };
