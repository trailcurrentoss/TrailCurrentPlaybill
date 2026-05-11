# Playbill Architecture — v2 (controller daemon + MQTT)

**Status:** design proposal, not yet implemented.
**Supersedes:** [`architecture.md`](architecture.md), which describes the current Stage-1 monolithic Electron-only layout. v1 stays accurate for what's in `main/` today; v2 describes where we're moving and why.

This document is for review before implementation begins. Push back on any of it.

---

## 1 · Goals & non-negotiables

1. **Playbill speaks MQTT, never CAN.** Headwaters owns the CAN bus and is a wire-only passthrough between CAN frames and MQTT (no parsing, no per-CAN-ID logic). Endpoints — Bearing for GPS, Solstice for MPPT/shunt, Plateau for tilt, **Playbill for media** — encode and decode their own CAN payloads using the [`TrailCurrent.dbc`](../../../TrailCurrentDocumentation/TrailCurrent.dbc) definitions.

2. **Single source of truth = the device that owns the state.** When Playbill switches to FM 97.5, *Playbill* is the authority on "current radio frequency" and publishes it. Milepost touchscreens, the Headwaters PWA, an IR remote handled by an MCU — all observe via MQTT. This is the existing TrailCurrent state-engine pattern.

3. **Remote-controllable from cold.** A PWA tap or a CAN button press must be able to bring Playbill up. The control surface (the MQTT subscriber) is therefore a **separate Linux service** that's always running while the user is logged in; the Electron GUI is one of its clients.

4. **Build our own UI shell.** No embedded third-party web apps (no `youtube.com/tv`, no Netflix HTML5 webview, no Plex Web). Off-the-shelf surfaces have no remote-control hooks for the rest of the rig. Every source — YouTube, Live TV, Radio, Plex, Local Library — is a plugin into our own browse + play UI.

5. **DBC is the schema source of truth** for any message that should be reachable from a CAN MCU. Headwaters does not parse; Playbill encodes per DBC and emits raw frames into the MQTT↔CAN pipe.

6. **Multi-instance is a first-class concern.** A rig can have several Playbills — one in the living room, one in the bedroom, one in the bunkhouse — all on the same broker. Each has a stable `device.id` slug used in every topic; commands can be addressed to one Playbill, to all of them ("pause everything"), or implicitly broadcast for status. PWAs discover available Playbills by subscribing to retained presence messages.

---

## 2 · Process model

```
┌─ Linux user session (GNOME on Wayland, the user's logged-in desktop) ──────────┐
│                                                                                │
│  ┌──────────────────────────────────────────────────────────────────────┐      │
│  │  playbill-controller.service        (systemd --user, always running) │      │
│  │  ────────────────────────────────────────────────────────────────    │      │
│  │  • Plain Node.js daemon. No Electron, no Chromium.                   │      │
│  │  • Connects to mqtts://<headwaters-host>:8883 with the rig CA.       │      │
│  │  • Owns: state store, command bus, source plugins, mpv subprocess.   │      │
│  │  • Subscribes to local/playbill/+/command (and friends).             │      │
│  │  • Publishes local/playbill/+/status on every state change.          │      │
│  │  • Encodes/decodes CAN-bridgeable messages per DBC; emits/consumes   │      │
│  │    raw frames over can/inbound and can/outbound (Headwaters pipe).   │      │
│  │  • Hosts a local IPC socket for the GUI (UDS at $XDG_RUNTIME_DIR).   │      │
│  │  • Launches the GUI on demand when a command requires display.       │      │
│  └──────────────────────────────────────────────────────────────────────┘      │
│                                  ↕                                             │
│            local IPC (Unix domain socket, JSON line protocol)                  │
│                                  ↕                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐      │
│  │  playbill (Electron GUI)            (on-demand, user-launched or    │      │
│  │  ────────────────────────────────    spawned by controller)         │      │
│  │  • The 10ft React shell.                                             │      │
│  │  • Subscribes to controller state via IPC (snapshot + deltas).       │      │
│  │  • Sends user input as commands via IPC.                             │      │
│  │  • Renders the source-plugin browse UI generically — knows about     │      │
│  │    Items and Sources, never about YouTube or Plex specifically.      │      │
│  │  • On exit, controller continues running. Audio (radio) keeps        │      │
│  │    playing; the user just dismissed the screen.                      │      │
│  └──────────────────────────────────────────────────────────────────────┘      │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
                                  ↕
                        MQTT (TLS, port 8883)
                                  ↕
┌─ Headwaters (mosquitto container + CAN bridge) ────────────────────────────────┐
│  Pure passthrough between can0 and MQTT. No DBC parsing here.                  │
└────────────────────────────────────────────────────────────────────────────────┘
                                  ↕
                            MQTT + CAN
                                  ↕
   Headwaters PWA · Milepost dashboard · IR-remote MCU · other rig devices
```

### Why a daemon-and-GUI split?

Three reasons it has to be this shape, not just "Electron with MQTT bolted in":

1. **Cold-start remote control.** PWA says "play radio 97.5" while Playbill is closed. Something must be listening. An Electron app that's not running cannot listen. A systemd user service can.
2. **Audio keeps playing past the GUI's life.** User starts the radio, dismisses the screen to read on the couch — the radio keeps playing. Today this works because mpv is a child of Electron; if Electron exits, mpv dies. Moving mpv ownership to the always-running controller fixes that.
3. **Single source of truth survives GUI crashes.** GUI hot-reload during development should not lose now-playing state. Two GUI windows on two monitors should see the same state instantly. The state has to live below the renderer.

### IPC between controller and GUI

* **Transport:** Unix domain socket at `$XDG_RUNTIME_DIR/playbill-controller.sock` (e.g., `/run/user/1000/playbill-controller.sock`). Local-only, owner-only file mode. No TCP, no shared port.
* **Protocol:** newline-delimited JSON. Two message types only — `command` (request/response with id) and `state` (server-pushed snapshots and deltas). Cribbed directly from Kodi's notification model: client connects → receives one full `state.snapshot` → then incremental `state.delta`s on every change.
* **Why not MQTT for the local hop too?** It would work, but it puts every mouse click on the rig's broker. UDS is faster, requires no broker round-trip, and survives broker outages.

---

## 3 · State ownership rules

The state store in the controller is the canonical structure. Every field has exactly one writer.

```
state = {
  source:     'youtube' | 'livetv' | 'radio' | 'local' | null    // current selection
  nowPlaying: {
    title, subtitle, artworkUrl, sourceItemId,                    // text/URL — MQTT-only
    durationMs, positionMs, paused, volume, muted                 // numeric — DBC-bridgeable
  } | null
  radio:    { band, frequencyHz, signalDbm, rdsText } | null       // numeric DBC + text MQTT
  livetv:   { adapter, channelLogicalId, channelName } | null
  youtube:  { signedIn, accountName, lastBrowsePath } | null
  ui:       { screen, focusedRowId, focusedCol } | null            // GUI-only convenience
  device:   { id, name, hostname, version, uptime }                // id is the topic slug; name is user-friendly ("Living Room")
}
```

* The **controller** writes everything except `state.ui`.
* The **GUI** writes `state.ui` (and only `state.ui`); controller mirrors it back to other observers so a second GUI window sees the same focus position.
* Every write fan-outs through:
  * IPC `state.delta` to all connected GUI clients
  * MQTT publish to the matching `local/playbill/<feature>/status` topic (retained for snapshots; non-retained for high-frequency things like position)

---

## 4 · MQTT topic surface

Two classes of messages.

### Class A — CAN-bridgeable (defined in DBC)

These have a DBC entry and a defined CAN frame. Payload over MQTT is the **raw 8 bytes** (or fewer) the DBC would put on the wire, base64-encoded for JSON safety. Topic carries the CAN ID so consumers can route without parsing payloads.

```
can/inbound        ← Headwaters publishes raw frames received from can0
                     payload: {"id": "0x<canid>", "data": "<base64-bytes>", "ts": <ms>}
can/outbound       → Anyone (Playbill included) publishes raw frames for can0
                     payload: same shape
```

This matches the existing Headwaters `can/inbound|outbound` topics and pushes encoding/decoding to endpoints.

**Playbill's CAN-bridgeable messages — to be added to TrailCurrent.dbc** (full proposal with bit layouts in [`dbc-additions.md`](dbc-additions.md)):

| Offset | Name (instance N)              | Purpose                                              | Direction     |
|--------|--------------------------------|------------------------------------------------------|---------------|
| `+0x0` | `PlaybillNavCmd<N>`            | D-pad: up/down/left/right/select/back/home/menu      | → Playbill    |
| `+0x1` | `PlaybillTransportCmd<N>`      | Play / pause / stop / toggle / seek-rel / next / prev | → Playbill   |
| `+0x2` | `PlaybillTransportStatus<N>`   | Numeric: paused, muted, source, volume, pos, dur     | ← Playbill    |
| `+0x3` | `PlaybillRadioTuneReq<N>`      | Set band + frequency                                 | → Playbill    |
| `+0x4` | `PlaybillRadioStatus<N>`       | Current band, freq, signal level                     | ← Playbill    |
| `+0x5` | `PlaybillScreenStatus<N>`      | Current screen enum + GUI-open flag                  | ← Playbill    |
| `+0x6` | `PlaybillSystemCmd<N>`         | Wake-from-cold / focus-window / quit-gui             | → Playbill    |
| `+0x7` | `PlaybillLaunchSourceCmd<N>`   | Launch source by enum (yt/dvb/fm/...)                | → Playbill    |
| `+0x8` | `PlaybillVolumeCmd<N>`         | Up / Down / Set / MuteOn / MuteOff / MuteToggle      | → Playbill    |
| `+0x9` | `PlaybillPresence<N>`          | MAC suffix + version (mirrors 0x004 firmware report) | ← Playbill    |

CAN IDs assigned per the multi-instance allocation above (`0x100`/`0x110`/`0x120` base + offset). `+0xA – +0xF` reserved for future expansion within each block.

### Class B — MQTT-only (text-bearing media metadata)

Things that don't fit in 8 bytes and that no MCU consumes. JSON payloads, no DBC entry.

```
local/playbill/source/<source_id>/list/request    → {path, query?}
local/playbill/source/<source_id>/list/response   ← {path, items: [...]}
local/playbill/source/<source_id>/resolve/request → {itemId}
local/playbill/source/<source_id>/resolve/response ← {url, headers, ...}
local/playbill/source/<source_id>/status          ← signedIn, account, etc.
local/playbill/now-playing                        ← title, artist, artworkUrl, sourceItemId  (retained)
local/playbill/radio/now-playing                  ← rdsText, currentSong, station name (retained)
local/playbill/livetv/now-playing                 ← channelName, programTitle, programGuide
```

All retained where appropriate so a late joiner gets current state on subscribe.

> **Decided:** the DBC is for CAN bus messages only. A message goes in the DBC **iff** it actually crosses CAN. MQTT-only messages do not get DBC entries. Dual-class is the rule, not a compromise.

### Topic naming inside the `local/playbill/` namespace

Mirrors Headwaters convention but adds a per-device segment so multiple Playbills on one rig can coexist:

```
local/playbill/<device_id>/<feature>/<verb>
```

* `<device_id>` is a stable slug (e.g. `living-room`, `bedroom`, `playbill-7a3f`). Auto-generated from hostname on first run; user-renameable in Settings; the slug itself never changes once chosen so subscriptions don't break.
* The literal `all` is reserved as a broadcast target — every controller subscribes to `local/playbill/all/+/command` in addition to its own ID. Use it for "pause everything" or "shut down all screens at bedtime."
* Verb is `command` or `status` (matches Headwaters convention).

Examples:

```
local/playbill/living-room/transport/command   → JSON {action: "play"|"pause"|"stop"|"seek", value?}
local/playbill/living-room/transport/status    ← retained, numeric nowPlaying state
local/playbill/living-room/system/status       ← retained + LWT, {online, guiOpen, currentScreen, name, hostname, version}
local/playbill/bedroom/system/status           ← second Playbill, separate retained presence
local/playbill/all/transport/command           → broadcast: every Playbill responds
local/playbill/+/system/status                 ← PWA subscribes here to discover all Playbills
```

`nav/command` and `transport/command` and `radio/command` are all Class-A: they also exist as DBC messages, and the controller publishes the equivalent CAN-bridged version too if it received the command from a CAN-side initiator.

### Multi-instance on CAN — contiguous ID blocks per instance

CAN doesn't have topic wildcards; the existing TrailCurrent convention for nodes that can have multiple physical instances on a rig (Switchback, Torrent, etc.) is to allocate **contiguous CAN IDs per instance**. A rig can run up to **three Playbills** on CAN simultaneously, each owning its own block of IDs:

```
0x100–0x10F   Playbill instance 0   (e.g. Living Room)
0x110–0x11F   Playbill instance 1   (e.g. Bedroom)
0x120–0x12F   Playbill instance 2   (e.g. Bunkhouse)
```

Each block defines the same 10 message types at the same offsets. To send a nav command to Playbill instance 1, a CAN sender transmits on `0x100 + 0x10 + 0x00 = 0x110`. The Playbill assigned `canInstance: 1` in its settings listens on `0x110-0x11F`. Settings.json gains a `device.canInstance` field (0–2, or `null` to opt out of CAN bridging entirely — Playbills the user only ever drives over MQTT don't need a CAN slot).

The `device.id` MQTT slug and `device.canInstance` are **independent**. The slug is for human-readable topic addressing; the instance is a numeric slot in the CAN address space. A user can rename their Playbill ("Bunkhouse" → "Office") without changing its CAN instance and breaking dash-mounted physical button mappings.

---

## 5 · Source plugin model

Borrowed from Kodi but typed and trimmed. Every source is a Node module under `controller/sources/<id>/index.js` that exports:

```js
module.exports = {
  id:           'youtube',                          // stable string id
  displayName:  'YouTube',
  icon:         'logo-youtube',                     // ionicon name
  capabilities: ['browse', 'search', 'signin'],     // optional features

  // Browse hierarchy — UI calls list('/'), navigates by passing the path
  // back into list(). Same pattern Kodi's plugin URL routing uses, just
  // typed instead of stringly-routed.
  async list(path) {
    return { path, items: [/* DirectoryItem | PlayableItem | ActionItem */] };
  },

  // Resolve a PlayableItem → something mpv can play. URLs only; no embeds,
  // no players-within-players.
  async resolve(item) {
    return { url: 'https://...', headers: {...}, mediaType: 'video', metadata: {...} };
  },

  // Optional
  async search(query, limit) { return { items: [...] }; },
  async signIn() { /* device-flow OAuth, persists token; returns user info */ },
  async signOut() { /* drops token */ },
  settingsSchema: { /* JSON Schema for settings UI */ },
  async getSettings() { ... },
  async setSettings(patch) { ... },
};
```

The UI never imports a source module. It calls `controller.list('youtube', '/')` or `controller.search('youtube', 'red rocks')` over IPC, and renders whatever items come back.

**Initial sources to plan:**

| id        | Notes                                                                 |
|-----------|-----------------------------------------------------------------------|
| `radio`   | wraps existing `services/radio.js` (RTL-SDR, FM/AM/Scanner)           |
| `livetv`  | wraps existing `services/dvb.js` (Hauppauge tuner)                    |
| `local`   | local NAS / Headwaters media library — file walker + ffprobe          |
| `youtube` | InnerTube device-flow OAuth + yt-dlp resolver → `Playable` for mpv    |
| `plex`    | (later) Plex auth + library + transcode endpoint                      |

---

## 6 · Player abstraction

Already mostly in place via `services/player.js` (mpv subprocess + JSON IPC socket). Moves verbatim into the controller. One small change: **only one source plays at a time**, and the controller enforces it. Switching from radio to a YouTube video stops the radio and starts mpv on the new URL.

The player exposes:

```js
play(playable)         // Playable from a source's resolve()
pause() / resume() / stop()
seek(ms)
setVolume(0-150) / setMute(bool)
getState()             // {paused, positionMs, durationMs, volume, muted, eofReached}
on('state-change', fn) // emitted on mpv property changes
```

The state-change callback is what feeds `state.nowPlaying.positionMs` into the state store and onward to MQTT (throttled — we don't publish position 30 times a second; once a second is plenty).

---

## 7 · Command bus

Single dispatcher in the controller. Three input sources fan in; one execution path:

```
┌── Local GUI (IPC) ──────┐
│                         ↓
├── MQTT (local/.../cmd) ─→  CommandBus.dispatch(cmd) → handler → state mutation
│                         ↑                                          │
└── Internal (timers,  ───┘                                          ↓
    auto-resume, etc.)                                       state-store fan-out
                                                              (IPC + MQTT publish)
```

Every command is a typed object:

```ts
type Command =
  | { action: 'transport.play';    sourceId: string; itemId?: string }
  | { action: 'transport.pause' }
  | { action: 'transport.stop' }
  | { action: 'transport.seek';    deltaMs: number }
  | { action: 'transport.setVolume'; value: number }
  | { action: 'radio.tune';        band: 'fm'|'am'; frequencyHz: number }
  | { action: 'nav.dpad';          key: 'up'|'down'|'left'|'right'|'select'|'back'|'home' }
  | { action: 'source.list';       sourceId: string; path: string }
  | { action: 'source.resolve';    sourceId: string; itemId: string }
  | { action: 'system.launchGui' }
  | { action: 'system.quit' }
  // ...
```

Each command is one of two shapes: those that have a DBC mirror (Class A) and those that don't (Class B). The dispatcher doesn't care; the codegen step does.

---

## 8 · Schema & codegen

Single source file: a JSON `commands.schema.json` lives in the controller and:

1. Generates TypeScript types for the controller, the GUI, and the Headwaters PWA (shared via npm-link or a small published package — to be decided).
2. Generates a runtime validator (Ajv) so MQTT commands from outside are validated before dispatch.
3. For Class-A commands, references the corresponding DBC message name; a build step verifies that the MQTT command shape and the DBC frame layout agree (so a `radio.tune` JSON command can round-trip to the `PlaybillRadioTuneRequest` CAN frame).

A small DBC parser library (probably `dbc-parser` or hand-rolled subset) generates encode/decode functions per DBC message. This is the same library every TrailCurrent endpoint will eventually use; recommend lifting it into a new shared package `TrailCurrentCANLibrary` (a sibling of which already exists in `Product/TrailCurrentCANLibrary/`).

---

## 9 · Directory layout (target)

```
TrailCurrentPlaybill/
├── controller/                    NEW — daemon, runs as systemd user service
│   ├── package.json               separate package.json from the GUI app
│   ├── src/
│   │   ├── index.js               daemon entry, plumbing
│   │   ├── mqtt.js                broker connection, topic constants, publishers
│   │   ├── ipc-server.js          UDS server for the GUI client
│   │   ├── command-bus.js         dispatcher + handler registry
│   │   ├── state-store.js         single-writer state, deltas, fan-out
│   │   ├── player.js              moved from app/main/services/player.js
│   │   ├── dbc-codec.js           DBC encode/decode helpers (or import shared lib)
│   │   ├── schema/
│   │   │   ├── commands.schema.json
│   │   │   ├── state.schema.json
│   │   │   └── topics.js          generated topic constants
│   │   └── sources/
│   │       ├── radio/index.js     wraps existing radio service
│   │       ├── livetv/index.js    wraps existing dvb service
│   │       ├── local/index.js     local media browser
│   │       └── youtube/
│   │           ├── index.js       source contract impl
│   │           ├── innertube.js   YouTube internal API client
│   │           ├── auth.js        device-flow OAuth + token persistence
│   │           └── resolve.js     yt-dlp wrapper for stream URL extraction
│   └── systemd/
│       └── playbill-controller.service    user unit file
│
├── app/                           the Electron GUI — keeps its name; what's
│   ├── main/                      already there mostly stays. mpv-related
│   │   ├── main.js                code moves out (lives in controller now).
│   │   ├── preload.js             keeps the IPC bridge but it now talks to
│   │   ├── ipc-client.js          NEW — UDS client, autoreconnects to controller
│   │   └── services/              shrinks: only GUI-specific bits remain
│   │       ├── theme.js           GNOME theme bridge stays here
│   │       └── window.js          window lifecycle stays here
│   ├── renderer/                  React shell — refactored to consume state
│   │   └── components/            via subscriptions instead of one-shot IPC calls
│   └── package.json
│
└── docs/app/
    ├── architecture.md            v1, current code (kept for history)
    └── architecture-v2.md         this file
```

---

## 10 · Lifecycle

* **System install:** the .deb (electron-builder output) drops:
  * `/usr/bin/playbill-controller` — Node daemon
  * `/usr/bin/playbill` — Electron GUI launcher
  * `/usr/lib/systemd/user/playbill-controller.service` — user unit
  * `/usr/share/applications/trailcurrent-playbill.desktop` — GUI entry in GNOME launcher
* **First user login:** `systemctl --user enable --now playbill-controller.service` runs (either by post-install hook or by a one-shot helper at first login). Daemon comes up in the **unconfigured** state — no MQTT creds yet, nothing on the bus, no remote control possible. Its only job is to hold the IPC socket open so the GUI can configure it.
* **First GUI launch (out-of-box setup):** the Settings → Connection screen shows. User enters or accepts the auto-discovered broker URL, types the rig's MQTT username and password, and pastes/uploads the CA cert. The GUI sends a `system.setMqttConfig` command over IPC. The controller persists, connects, announces itself with a retained `local/playbill/system/status`, and the screen flips to a green "Connected" indicator.
* **Steady state:** controller stays connected. If credentials change later (rig CA rotated, password reset), Settings → Connection lets the user re-enter; controller atomically swaps and reconnects.
* **PWA "open YouTube":** publishes `local/playbill/system/command` with `{action: 'launch-gui'}` plus the desired source. Controller spawns `playbill` GUI; GUI connects to controller; controller forwards the queued navigation command. UI lands on YouTube browse.
* **Audio-only:** PWA publishes `local/playbill/transport/play` with a `radio.tune` parameter. Controller starts mpv (or rtl_fm + pw-cat for radio). No GUI launched. Audio plays. Status published continuously.
* **GUI close:** user dismisses the window. Controller stays up, audio keeps playing, state intact.
* **Logout / shutdown:** systemd user manager stops the controller cleanly. Controller publishes a final `local/playbill/system/status` with `guiOpen: false, online: false` (LWT — see below).
* **Last-will:** controller's MQTT connection sets a retained LWT on `local/playbill/system/status` so a hard crash or network drop is observable to other devices.

---

## 10b · Configuration & secrets

**All configuration is done from the Playbill GUI.** No env vars in the systemd unit, no hand-edited config files. The user installs the package and from that point on, every setting — MQTT broker, MQTT credentials, TLS CA, hostname override, YouTube account, radio presets, theme, behavior toggles — is reachable from a Settings screen.

### Storage layout

Per-user, under `~/.config/trailcurrent-playbill/`:

```
~/.config/trailcurrent-playbill/
├── connection.json             MQTT broker URL, username, password, hostname override
├── ca.pem                      pasted/uploaded CA cert (file mode 0600)
├── settings.json               app-level settings (theme, behavior, defaults)
├── radio-presets.json          (already exists — keeps current shape)
├── channels.conf               (already exists — DVB scan output)
└── sources/
    ├── youtube/
    │   ├── tokens.json         OAuth refresh + access token (file mode 0600)
    │   └── settings.json       per-source: region, restricted-mode, etc.
    └── plex/
        └── ...
```

Files are owned by the user, mode 0600 on anything containing a secret. Same security posture as `~/.netrc` and `~/.ssh/`. We can optionally promote MQTT password and OAuth tokens to libsecret/Secret Service (GNOME Keyring) in a later phase if the user prefers; not v1.

### Settings UI surface

A new top-level screen reachable from the side nav. Categories:

| Category    | What's there                                                                 |
|-------------|------------------------------------------------------------------------------|
| Connection  | MQTT broker URL, username, password, CA cert paste/upload, TLS hostname override, "Test connection" button, last-error display |
| Sources     | One sub-screen per source plugin. YouTube: device-flow sign-in / sign-out, account info. Radio: presets manager. Live TV: tuner scan + channel manager. |
| Hardware    | DVB adapter selection, RTL-SDR adapter selection, audio output device |
| Display     | Theme (auto / light / dark), idle-screen timeout, default home screen behavior |
| About       | Version, controller status, GUI status, rig hostname, "Restart controller" button |

### Where settings physically live

* **Schema** in `controller/src/schema/settings.schema.json` (JSON Schema). One source of truth. The GUI auto-renders the form from the schema (no per-setting React code). Same approach Kodi uses for add-on `settings.xml`, but with JSON Schema and React forms.
* **Read/write** is exclusively through the controller's command bus — `settings.get(path)` / `settings.set(path, value)` / `settings.subscribe(path)`. Never read the JSON files directly from the GUI.
* **Validation** at write time using Ajv against the schema, before persisting and before applying.

### Auto-discovery (proposed)

Headwaters publishes itself over mDNS (it has `discovery-mdns.service`). On first run, the controller can mDNS-browse for `_trailcurrent._tcp` and pre-populate the broker URL field. The user still has to type the password (we never publish that), but everything else can come from discovery. Stretch: a "claim this device" handshake that fetches credentials from Headwaters after a short pairing code displayed on the rig's main display — same pattern as Apple TV pairing or smart-TV setup. Not v1; flagged for later.

### What the daemon does in the unconfigured state

* Holds the IPC socket open (so the GUI can configure it).
* Refuses to start any source (no broker → no command surface → no point).
* Publishes nothing.
* Logs a single "awaiting configuration via GUI Settings → Connection" line.
* The GUI, when it connects, sees `state.connection.status === 'unconfigured'` and routes the user straight to the Settings → Connection screen instead of showing the home grid.

---

## 11 · YouTube specifically

Once the spine above is in place, YouTube is just one source plugin. Its work:

* **Auth:** Google's TV/limited-input device flow. Display the youtube.com/activate code in our own UI. Persist tokens at `~/.config/trailcurrent-playbill/sources/youtube/tokens.json`. Refresh in the background.
* **Browse:** InnerTube (the unofficial YouTube internal protobuf-over-JSON API) for subscriptions, trending, search, channel pages, playlists, watch later. Pure HTTP from the controller — no embedded webview anywhere.
* **Resolve:** `yt-dlp --get-url` (or libavformat directly via mpv with `--ytdl=yes`) for stream URLs. mpv plays them. Same playback path as a local mp4.
* **State:** signed-in user, current playlist/queue, watch progress reported back on `local/playbill/source/youtube/status`.

InnerTube is a moving target — same maintenance treadmill the Kodi YouTube addon lives on. yt-dlp absorbs that pain better than we can. Recommend pinning yt-dlp as a system dep and `apt install`ing it on the image.

---

## 12 · Open questions for your review

1. ~~Dual-class messages OK?~~ **Decided.** DBC = CAN bus only. MQTT-only messages do not go in the DBC.
2. **Topic naming for raw CAN frames:** keep current `can/inbound`/`can/outbound` with `{id, data, ts}` envelope, or switch to per-CAN-ID topics (`can/0x101`, `can/0x102`, etc.) to let consumers subscribe selectively?
3. **Shared DBC library:** lift into a new package under `Product/TrailCurrentCANLibrary/` (or wherever) so Playbill, Milepost, Headwaters all share the same encoder/decoder? Or vendor a copy per project for now?
4. **Controller process language:** Node.js (matches existing TrailCurrent backend stack)? Or something else? Node lets us share TS types with the GUI without a build step.
5. **CAN ID range for Playbill:** request a reserved block in the DBC (`0x100–0x10F`?) so future media-related additions don't collide.
6. **systemd unit scope:** user service (per-logged-in-user) or system service (runs even at GDM)? User service is simpler and matches the desktop-app nature; system service would let us pre-warm before login. Recommend user service.
7. **GUI ↔ controller IPC:** UDS + JSON line protocol as proposed, or use a real RPC framework (gRPC, tRPC, msgpack-rpc)? UDS+JSON has zero deps and is debuggable with `socat`. Recommend the simple version.
8. **"Wake from cold" UX:** when the PWA wakes Playbill, the GUI takes a beat to spawn. Is a brief "Launching Playbill…" state on the PWA acceptable, or does the controller need to publish an "I'm waking" intermediate state?
9. **Secret storage:** plain JSON at file mode 0600 to start, with libsecret/GNOME Keyring as a later-phase opt-in? Or insist on Keyring from day one?
10. **mDNS auto-discovery of Headwaters:** worth wiring in v1 so first-run only asks for username + password, or defer to a later phase and start with a manual broker-URL field?
11. **Pairing handshake to fetch credentials from Headwaters:** stretch goal — would let the user enter a 6-digit code shown on the Headwaters main display instead of typing a password. Defer or include?

---

## 13 · Implementation roadmap (proposed phasing)

I'll do these in order; each phase ends in a runnable, verifiable state.

| Phase | Deliverable | Verifiable by |
|-------|-------------|---------------|
| **0** | Tear out youtube.com/tv embed (done in this turn) | App builds; YouTube tile present but no-ops on launch |
| **1** | `controller/` skeleton: daemon entry, command bus, state store, IPC server (UDS), settings store + `settings.schema.json`. Daemon comes up unconfigured (no MQTT yet). | `playbill-controller` runs; `socat - UNIX-CONNECT:/run/user/1000/playbill-controller.sock` shows `state.connection.status: 'unconfigured'` |
| **1b** | GUI **Settings → Connection** screen (auto-rendered from `settings.schema.json`). Controller's MQTT client wires up — connects when settings.connection is valid, disconnects on change, publishes presence. | User opens GUI, lands on Settings, types broker URL + creds + pastes CA, clicks Test → green; controller publishes retained `local/playbill/system/status` |
| **2** | `commands.schema.json` + topic constants generator + Ajv runtime validator. Mirror the radio commands as DBC messages (proposal first, edit DBC second). | Schema-validated bad commands rejected; DBC roundtrip test for `PlaybillRadioTuneRequest` passes |
| **3** | Move `radio.js` and `player.js` into the controller; refactor as the first sources. Wire GUI to controller via IPC for radio. | Radio works end-to-end via IPC. PWA-equivalent (mosquitto_pub on the command line) tunes the radio. Status visible via mosquitto_sub. |
| **4** | systemd user unit + install hooks. Cold-start launch flow: PWA-style command → controller spawns GUI. | `systemctl --user start playbill-controller`; `mosquitto_pub` "launch GUI" → window opens |
| **5** | Move DVB into the controller as `livetv` source. Refactor live.jsx onto the source-plugin browse interface. | Live TV works through the new spine |
| **6** | YouTube source: device-flow OAuth + InnerTube browse + yt-dlp resolve + native browse UI in the GUI. | Sign in via youtube.com/activate code shown in our UI; play a video |
| **7** | Replace v1 `architecture.md`. Delete the old preload IPC handlers that have moved to controller IPC. Tidy. | One architecture doc, no dead handlers |

Each phase is a checkpoint to push back on direction. I'm planning to do phases 1–3 in the next sit-down once you've signed off on the shape.


## 14 Discovery
Similar to MCU's Playbill can have multiple instances. Therefore it should follow a similar pattern to Fireside another WiFi based device that gets "Discovered" the discovery process is key to storing centralized configuration information. For example the "Name" of each playbill. That name is important to be centrally stored so that Peregrine voice commands can be directed towards a specific device. Similarly touch screen displays can be configured to interact with each unique playbill instance.