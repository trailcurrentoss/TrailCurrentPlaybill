/* Turn raw network / TLS / protocol errors into user-friendly messages
   the Settings UI can show without exposing implementation details.

   We classify into a small set of `kind`s so the UI can pick an icon and
   colour, and a `message` written for a non-technical user that names the
   specific thing they should check or fix. Both MQTT and HTTP failures
   flow through here so the wording stays consistent across the two
   "Save & Connect" / "Save API key" paths.

   Kinds:
     dns       — couldn't resolve the Headwaters hostname
     refused   — host reachable but port refused
     network   — generic network failure (no route, interface down)
     timeout   — host didn't respond in time
     tls       — certificate validation failed (CA missing / wrong / expired)
     auth      — credentials rejected (MQTT password OR API key)
     http      — unexpected HTTP status (API path only)
     unknown   — none of the above; passes the raw message through */

'use strict';

/**
 * @param {Error|object} err   raw error from mqtt.js / https.request / fetch
 * @param {object}       ctx
 * @param {string}       ctx.host        hostname being contacted (interpolated into the message)
 * @param {'mqtt'|'http'} ctx.protocol   how to interpret auth-like errors
 * @param {number}       [ctx.statusCode]  HTTP status if available
 * @returns {{kind: string, message: string}}
 */
function classify(err, ctx = {}) {
  const host = ctx.host || 'Headwaters';
  const protocol = ctx.protocol || 'http';
  const code = (err && err.code) || '';
  const msg  = (err && err.message) || String(err || '');

  // ─── HTTP-layer auth — must come before generic checks so a 401 is
  // labelled clearly rather than passed through as "unknown".
  if (protocol === 'http' && ctx.statusCode === 401) {
    return { kind: 'auth',
             message: `Headwaters rejected the API key. Verify the key in Headwaters → Settings → API Keys, then paste it again here.` };
  }
  if (protocol === 'http' && typeof ctx.statusCode === 'number' && ctx.statusCode >= 400) {
    return { kind: 'http',
             message: `Headwaters returned HTTP ${ctx.statusCode}. This usually means the API server is reachable but the request itself was wrong.` };
  }

  // ─── DNS — getaddrinfo failures, mDNS not resolving
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo/i.test(msg)) {
    return { kind: 'dns',
             message: `Can't find ${host} on the network. Make sure Headwaters is powered on and on the same Wi-Fi (or wired LAN) as this Playbill.` };
  }

  // ─── Connection refused — host responding at IP layer but the service
  // isn't listening (broker down, API server not yet up).
  if (code === 'ECONNREFUSED') {
    return { kind: 'refused',
             message: `${host} refused the connection. Headwaters is reachable, but the ${protocol === 'mqtt' ? 'MQTT broker' : 'API server'} on it isn't running.` };
  }

  // ─── Unreachable network — no route, interface down
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return { kind: 'network',
             message: `Can't reach ${host}. Check that this Playbill is connected to Wi-Fi or Ethernet.` };
  }

  // ─── Timeout — host alive but nothing answered
  if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) {
    return { kind: 'timeout',
             message: `${host} didn't respond in time. Check the network between this Playbill and Headwaters.` };
  }

  // ─── TLS / cert validation
  // Node's TLS errors come through both as `code` (CERT_HAS_EXPIRED etc.)
  // and as message text. Match either.
  if (/^(ERR_TLS|CERT|UNABLE_TO|SELF_SIGNED|DEPTH_ZERO|EPROTO)/.test(code) ||
      /certificate|self.signed|hostname.*cert|altnames|verify the first cert/i.test(msg)) {
    if (/altnames|hostname/i.test(msg)) {
      return { kind: 'tls',
               message: `The Headwaters TLS certificate is valid but wasn't issued for ${host}. The CA you pasted matches a different hostname.` };
    }
    if (/expired/i.test(code) || /expired/i.test(msg)) {
      return { kind: 'tls',
               message: `The Headwaters TLS certificate has expired. Regenerate it on Headwaters and paste the new CA in the Broker section.` };
    }
    return { kind: 'tls',
             message: `This Playbill doesn't trust the Headwaters TLS certificate. Paste the Headwaters CA certificate in the Broker section and save again.` };
  }

  // ─── MQTT auth — broker returns CONNACK with a "Connection refused: …"
  // reason string. Several variants depending on broker.
  if (protocol === 'mqtt' && /not authoriz|bad user.?name or password|authentication/i.test(msg)) {
    return { kind: 'auth',
             message: `Headwaters rejected the broker username or password. Double-check both fields and save again.` };
  }
  if (protocol === 'mqtt' && /server unavailable|identifier rejected|unacceptable protocol/i.test(msg)) {
    return { kind: 'refused',
             message: `Headwaters' broker refused the connection (${msg}). Check the broker is healthy on Headwaters.` };
  }

  return { kind: 'unknown', message: msg };
}

module.exports = { classify };
