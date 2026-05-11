# Playbill onboarding — mDNS + claim contract

**Status:** Both sides landed (Headwaters earlier; Playbill side 2026-05-11). Verified end-to-end on the Q6A development board: `_trailcurrent._tcp` advertised on port 80 while unconfigured, `POST /discovery/claim` accepts creds, persists `connection.json`/`ca.pem` at mode 0600, triggers `mqtt.reconfigure()`, returns 200 synchronously, then withdraws both mDNS and the HTTP listener. `connection.clear` re-advertises. The 400 (bad shape) and 409 (already configured) paths return correct codes; the 409 path is a race-window guard, since the listener stops on success.

**Implementation files (Playbill side):**
- [`controller/src/onboarding/mdns.js`](../../controller/src/onboarding/mdns.js) — `bonjour-service` wrapper.
- [`controller/src/onboarding/claim-server.js`](../../controller/src/onboarding/claim-server.js) — Node `http` listener on port 80, JSON-only.
- Wired in [`controller/src/index.js`](../../controller/src/index.js) — both start/stop reactively whenever `connection.json` presence flips.

**One-time install requirement on the board:**
```
sudo setcap 'cap_net_bind_service=+ep' /usr/bin/node
```
(Needed because the daemon runs as `--user` systemd and port 80 is privileged. Image build should add this.)

Brings a freshly imaged Playbill from "on the rig WiFi, no broker creds" to "connected to MQTT, visible in the PWA's Playbill page" without the user typing the broker password.

Two pieces of work on the Playbill controller:

1. Advertise an mDNS `_trailcurrent._tcp` service on first boot.
2. Expose an HTTP `POST /discovery/claim` endpoint that accepts broker credentials, persists them, and reconnects the MQTT bridge.

Both run inside the existing [`playbill-controller`](../../controller/) Node daemon — no new processes, no new systemd units.

## 1 · mDNS advertisement

Use [`mdns`](https://www.npmjs.com/package/mdns) or [`bonjour-service`](https://www.npmjs.com/package/bonjour-service) (preferred — fewer native deps), or shell out to `avahi-publish-service` if neither is acceptable on the Q6A image.

**Service:**
- Type: `_trailcurrent._tcp`
- Port: same port your claim HTTP listener binds to (recommended **`80`** to match the existing MCU pattern that Headwaters' `discovery-mdns.py` assumes — `http://<hostname>.local/...`). If port 80 is unavailable, advertise the actual port; the Headwaters Python proxy currently hardcodes the URL without a port so this means port 80. Update both sides if you change it.
- Hostname: the system hostname (lowercase, `.local` resolution).

**TXT records** (all strings):

| Key | Required | Value | Notes |
|---|---|---|---|
| `type` | yes | `playbill` | The Headwaters route accepts this as a non-MCU type; anything else gets ignored. |
| `fw` | yes | e.g. `0.1.0` | Controller daemon's `package.json` version. |
| `name` | no | e.g. `Living Room` | Settings `device.name`. Headwaters pre-renders this on the wizard card so the user knows which one they're claiming before it's even online. |
| `deviceId` | no | e.g. `playbill-bedroom` | Settings `device.id` — the slug that becomes the MQTT topic segment after claim. Lets a power-user pre-set the slug from the rig before claiming. |
| `canInstance` | no | `0`/`1`/`2` (or omit) | Pre-declared CAN block selection. |

Advertise:
- On boot, **only when `connection.json` is missing** (i.e. the Playbill is unconfigured). Once claimed, stop advertising so future browses don't list already-claimed Playbills.
- Also stop advertising if the user clears credentials via Settings → Connection → Forget. Re-advertise when credentials are cleared so the rig can re-claim.

Stop the service cleanly on `SIGTERM` so the daemon's restart doesn't leave a stale `_trailcurrent._tcp` record.

## 2 · `POST /discovery/claim`

Bind an HTTP listener (Node's built-in `http` is sufficient — no Express needed) on the same port advertised in mDNS. One route:

```
POST /discovery/claim
Content-Type: application/json
```

**Request body** (verified against the schema below before persisting):

```json
{
  "brokerUrl":       "mqtts://headwaters.local:8883",
  "username":        "trailcurrent",
  "password":        "...",
  "caCertPem":       "-----BEGIN CERTIFICATE-----\n...",
  "tlsCertHostname": "trailcurrent.local"
}
```

**Required:** `brokerUrl`, `username`, `password`.
**Optional:**
- `caCertPem` (only when `brokerUrl` starts with `mqtts://`)
- `tlsCertHostname` (TLS SAN override for self-signed rig certs)
- `deviceName` (1–64 chars; if present, persisted to `settings.device.name` so the user doesn't need to walk to the TV to name the Playbill — they typed it on the wizard card before clicking Claim. The user can rename later via Playbill's Settings → Device tab; this field is a pre-fill convenience, not the only path. Also accepted: `null` or omission, in which case the existing `device.name` survives.)

**brokerUrl normalization (since 2026-05-11):** the controller accepts hostname-only input (`headwaters.local`), full URLs (`mqtts://headwaters.local:8883`), or insecure URLs (`mqtt://headwaters.local`). All three normalize to strict `mqtts://host:port` (port defaults to 8883) before persistence — Playbill never connects insecurely. PWAs can keep sending whatever shape they like; the canonical form is what lands on disk.

**On receipt:**

1. Validate. Reject (`400`) on missing required fields, malformed `brokerUrl`, or empty username/password.
2. Refuse when **already configured** (`409 Conflict`) — `connection.json` already exists — UNLESS the request carries a header `X-Reclaim: true`. This prevents an arbitrary device on the LAN from overwriting an already-onboarded Playbill's broker creds. (Headwaters today never sets that header; manual recovery only.)
3. Persist atomically:
   - `~/.config/trailcurrent-playbill/connection.json` — `{brokerUrl, username, password, tlsCertHostname, caCertProvided: !!caCertPem}` at mode `0600`. Use the existing `SettingsStore.replace()` path so the file is schema-validated.
   - `~/.config/trailcurrent-playbill/ca.pem` — only when `caCertPem` present, mode `0600`.
4. Call `mqtt.reconfigure()` (the existing method that tears down and re-establishes the broker connection).
5. Return `200 {"ok": true}` synchronously — **don't** wait for MQTT to connect before responding. The Headwaters wizard observes broker presence on `local/playbill/<deviceId>/system/status` to confirm liveness independently.
6. Stop mDNS advertisement (the device is now onboarded).

**Other failure responses:**
- `400` — malformed JSON or missing fields, with `{error: "..."}`.
- `409` — already configured, no `X-Reclaim`.
- `500` — disk write failed, mqtt.reconfigure threw, etc. Include a sanitized error string.

**Security stance:** plain HTTP on the LAN is acceptable for v1 (closed RV WiFi, user trusts what's on the bus). The body contains an MQTT password in cleartext; that's the same trust boundary the existing CAN-broadcast WiFi credentials assume. HTTPS with a self-signed cert is a future hardening pass.

## 3 · End-to-end flow

```
┌──────────────┐                  ┌────────────────────────┐                ┌──────────────┐
│   Playbill   │                  │    Headwaters host     │                │    PWA       │
│  (new, no    │                  │  mDNS proxy + backend  │                │              │
│   creds)     │                  │                        │                │              │
└──────┬───────┘                  └────────────┬───────────┘                └──────┬───────┘
       │                                       │                                   │
       │ mDNS announce                         │                                   │
       │ _trailcurrent._tcp                    │                                   │
       │ type=playbill name=Bedroom            │                                   │
       │──────────────────────────────────────▶│                                   │
       │                                       │ user clicks Scan in wizard        │
       │                                       │◀──────────────────────────────────│
       │                                       │                                   │
       │                                       │ discovery/browse/found ─ MQTT ──▶ │
       │                                       │  payload onboard:"claim"          │
       │                                       │                                   │
       │                                       │              user clicks "Claim"  │
       │                                       │◀──────────────────────────────────│
       │                                       │                                   │
       │                                       │ POST /discovery/claim             │
       │                                       │  {brokerUrl, user, pass, ca}      │
       │◀──────────────────────────────────────│                                   │
       │ 200 {ok}                              │                                   │
       │──────────────────────────────────────▶│                                   │
       │                                       │ 200 → wizard shows "claimed"      │
       │                                       │──────────────────────────────────▶│
       │ persists creds, mqtt.reconfigure()    │                                   │
       │ connects to broker                    │                                   │
       │                                       │                                   │
       │ retained local/playbill/<id>/system/  │                                   │
       │   status {online:true,name,version}   │                                   │
       │──────────────────────────────────────▶│  mqtt.js cache → broadcast        │
       │                                       │  playbill_presence over WS ──────▶│
       │                                       │           device appears in       │
       │                                       │           Playbill page picker    │
```

## 4 · MQTT topics added on the Headwaters side (for reference)

These are already implemented in `mqtt.js` and `local_code/discovery-mdns.py`. The Playbill side never publishes on these — they're entirely between the backend and the host-side mDNS proxy:

- `discovery/claim/request` — backend → host proxy: `{hostname, creds: {…}}`
- `discovery/claim/response` — host proxy → backend: `{hostname, success, error?}`

The host proxy is the one that actually performs the HTTP POST against `<hostname>.local`; the backend never sees the Playbill directly because the Docker network can't resolve `.local`.

## 5 · What you DON'T need to do

- Don't add a `mcu_modules` entry to anything on the Headwaters side — Playbill is tracked by runtime MQTT presence, not the static module list.
- Don't add Playbill to `MCU_MODULES` in `routes/modules.js`. The discovery route accepts `playbill` via a separate `NON_MCU_TYPES` set.
- Don't use the existing `GET /discovery/confirm` MCU marker endpoint — Playbill onboarding is a write, not a read.
- Don't echo back the creds anywhere (logs, MQTT). The Python proxy already avoids logging the body.

## 6 · Testing

End-to-end smoke (after both sides implemented):

1. Wipe `~/.config/trailcurrent-playbill/connection.json` on the Playbill, restart `playbill-controller.service`. Verify `_trailcurrent._tcp` appears in `avahi-browse -a` on another machine on the same WiFi.
2. From the PWA: Wizard → Step 2 → Scan. The Playbill card appears with a "Claim" button (brand-info border).
3. Click Claim. Headwaters POSTs creds. Card flips to "Playbill claimed — credentials delivered" (success-green border), then fades after 4s.
4. Within seconds the Playbill appears under the Playbill nav icon with the volume widget enabled.
5. Re-running discovery doesn't list the claimed Playbill again (mDNS service stopped after claim).
