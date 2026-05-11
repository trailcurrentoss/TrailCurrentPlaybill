# DBC additions for Playbill — landed

**Status:** **Landed in [`TrailCurrent.dbc`](../../../TrailCurrentDocumentation/TrailCurrent.dbc) on 2026-05-10.** Do not re-apply. The doc below is kept as the source-of-truth narrative for *why* the layout looks this way; if you want to see the actual definitions, read the DBC.

**What was applied:**

* `Playbill` appended to the `BU_` node list
* 30 `BO_` definitions added — three contiguous blocks (`0x100–0x109`, `0x110–0x119`, `0x120–0x129`), 10 messages per Playbill instance, names suffixed `0`/`1`/`2`
* 1 `CM_ BU_` describing the Playbill node
* 10 `CM_ BO_` describing each message type (instance 0; later instances share the same shape per existing convention)
* 13 `BA_ "CycleTime"` entries — Status @ 500–1000 ms, Presence heartbeat @ 60 000 ms
* 30 `VAL_` enum tables (NavKey, Action, SourceEnum, Band, ScreenEnum, SysAction, SubScreenEnum, VolAction × 3 instances)

The Playbill controller's runtime DBC codec ([`controller/src/dbc-codec.js`](../../controller/src/dbc-codec.js)) encodes/decodes against these same definitions. Codec self-test (10/10) passes locally and on the live board.

The CAN-bridge wiring on the Playbill side — actually subscribing to `can/inbound`, decoding frames into command-bus calls, and emitting `can/outbound` for status fan-out — is **not** yet implemented. That lands as part of Phase 3 (radio is the first end-to-end Class-A path) and Phase 4 (cold-wake / system commands). The DBC and the codec are now ready to back that work whenever the rest of the spine reaches it.

---

## 1 · Node addition

Add `Playbill` to the `BU_` line at the top of the DBC. Order is alphabetical by convention; insert between `Picket` and `Plateau`:

```
BU_: Bearing Torrent Tapper Solstice Borealis Headwaters Aftline Therma Picket Playbill Plateau Switchback Reservoir
```

---

## 2 · CAN ID allocation — three contiguous blocks

Mirrors the Switchback / Torrent multi-instance pattern: each Playbill instance owns its own block of 16 CAN IDs.

| Instance | Block         | Purpose            | Default name        |
|----------|---------------|--------------------|---------------------|
| 0        | `0x100–0x10F` | First Playbill     | "Living Room"       |
| 1        | `0x110–0x11F` | Second Playbill    | "Bedroom"           |
| 2        | `0x120–0x12F` | Third Playbill     | "Bunkhouse"         |

Within each block, the same 10 message types live at the same offset. Adding a fourth Playbill is a future expansion (`0x130–0x13F`); call it out before doing it.

Reserved offsets `+0xA … +0xF` are intentionally left empty so we can extend without renumbering. **Do not put unrelated messages in those slots.**

A Playbill that has `device.canInstance = null` in its settings (i.e., the user opted out of CAN bridging for that unit) does not consume any block; CAN-side senders will not reach it.

---

## 3 · Message definitions

Bit positions follow DBC convention: Motorola (big-endian) ordering, start bit specified as the MSB-first index of the byte's high nibble. All multi-byte unsigned integers are big-endian. Sizes listed below are payload size in bytes.

For each message I use `<N>` as the instance number (0, 1, or 2). The name in the DBC file is literal (`PlaybillNavCmd0` etc.); the receiver determines instance from the CAN ID.

### `+0x0` — `PlaybillNavCmd<N>` (size 1, → Playbill)

Remote-control D-pad. One byte of enum.

| Signal     | Bits | Range | Meaning |
|------------|------|-------|---------|
| `NavKey`   | 7\|8@0+ | 0–7 | enum |

**`NavKey` enum:**
```
0 = Up
1 = Down
2 = Left
3 = Right
4 = Select
5 = Back
6 = Home
7 = Menu
```

CAN IDs: `0x100` / `0x110` / `0x120`.

### `+0x1` — `PlaybillTransportCmd<N>` (size 5, → Playbill)

Playback transport control. Generic enum with optional 32-bit value (used by `Seek`).

| Signal   | Bits     | Range | Meaning |
|----------|----------|-------|---------|
| `Action` | 7\|8@0+  | 0–255 | enum |
| `Value`  | 15\|32@0+ | 0–4 294 967 295 | unit depends on action |

**`Action` enum:**
```
0 = Play
1 = Pause
2 = Stop
3 = Toggle      (play if paused, pause if playing)
4 = SeekRel     Value = signed-as-unsigned milliseconds (use 0x80000000 + delta_ms)
5 = SeekAbs     Value = absolute milliseconds
6 = Next
7 = Previous
```

Volume and mute are intentionally **not** here — they live in `PlaybillVolumeCmd<N>` (offset `+0x8`) so a hardware volume knob can wire to a single CAN ID without parsing transport semantics.

CAN IDs: `0x101` / `0x111` / `0x121`.

### `+0x2` — `PlaybillTransportStatus<N>` (size 8, ← Playbill)

What's playing right now, numeric form. Text titles, artwork URLs, etc. live on the MQTT-only `local/playbill/<id>/now-playing` topic — see [architecture-v2.md §4](architecture-v2.md#4--mqtt-topic-surface).

| Signal         | Bits      | Range | Meaning |
|----------------|-----------|-------|---------|
| `Paused`       | 7\|1@0+   | 0–1   | 1 if paused or stopped |
| `Muted`        | 6\|1@0+   | 0–1   | |
| `SourceEnum`   | 5\|6@0+   | 0–63  | enum below |
| `VolumePct`    | 15\|8@0+  | 0–100 | percent; 255 = unknown / not yet read |
| `PositionSec`  | 23\|24@0+ | 0–16777215 | current playback position in seconds |
| `DurationSec`  | 47\|24@0+ | 0–16777215 | total duration; 0 = live / unknown |

**`SourceEnum` (shared by TransportStatus and LaunchSourceCmd):**
```
0 = None        (idle, nothing playing)
1 = YouTube
2 = LiveTV
3 = Radio
4 = LocalLibrary
5 = Plex
6 = Spotify
7 = Netflix
... 8-63 reserved
```

CAN IDs: `0x102` / `0x112` / `0x122`.

### `+0x3` — `PlaybillRadioTuneReq<N>` (size 6, → Playbill)

Tune the RTL-SDR radio. Frequency in **kilohertz** as a 32-bit unsigned int — covers FM (88 000 – 108 000 kHz), AM (530 – 1700 kHz), and the public-safety scanner range (up to 1 GHz) without needing a separate band-multiplier signal.

| Signal         | Bits      | Range | Meaning |
|----------------|-----------|-------|---------|
| `Band`         | 7\|8@0+   | 0–2   | enum below |
| `FrequencyKHz` | 15\|32@0+ | 0–4294967295 | kHz |
| `Mode`         | 47\|8@0+  | 0–255 | reserved (e.g., NFM/WFM/AM modulation override) |

**`Band` enum:**
```
0 = FM
1 = AM
2 = Scanner    (public safety, derived from current ZIP via scanner-data.js)
```

CAN IDs: `0x103` / `0x113` / `0x123`.

### `+0x4` — `PlaybillRadioStatus<N>` (size 8, ← Playbill)

Current radio state.

| Signal         | Bits      | Range | Meaning |
|----------------|-----------|-------|---------|
| `Band`         | 7\|8@0+   | 0–2   | same enum as TuneReq |
| `FrequencyKHz` | 15\|32@0+ | 0–4294967295 | kHz |
| `SignalDbm`    | 47\|8@0-  | -128 to +127 | dBm, signed |
| `Tuned`        | 55\|1@0+  | 0–1   | 1 if currently tuned & demodulating |
| `Scanning`     | 54\|1@0+  | 0–1   | 1 if mid-scan |

CAN IDs: `0x104` / `0x114` / `0x124`.

### `+0x5` — `PlaybillScreenStatus<N>` (size 2, ← Playbill)

Which screen the GUI is on. Useful for a dash status LED or for the PWA to mirror current focus.

| Signal       | Bits     | Range | Meaning |
|--------------|----------|-------|---------|
| `ScreenEnum` | 7\|8@0+  | 0–255 | enum below |
| `GuiOpen`    | 15\|1@0+ | 0–1   | 1 = Electron window is on screen |

**`ScreenEnum`:**
```
0 = Home
1 = Apps
2 = Live
3 = Radio
4 = LocalLibrary
5 = Rig
6 = Settings
7 = NowPlaying  (full-screen player)
... 8-255 reserved
```

CAN IDs: `0x105` / `0x115` / `0x125`.

### `+0x6` — `PlaybillSystemCmd<N>` (size 1, → Playbill)

Global lifecycle commands.

| Signal      | Bits    | Range | Meaning |
|-------------|---------|-------|---------|
| `SysAction` | 7\|8@0+ | 0–255 | enum below |

**`SysAction`:**
```
0 = LaunchGui   (cold-wake — bring up the Electron window if it's closed)
1 = QuitGui     (close the window; controller stays running)
2 = Focus       (raise the existing window)
3 = Wake        (light up the display from screensaver)
4 = Sleep       (force screensaver / DPMS off)
... 5-255 reserved
```

CAN IDs: `0x106` / `0x116` / `0x126`.

### `+0x7` — `PlaybillLaunchSourceCmd<N>` (size 2, → Playbill)

"Open this source" — analogous to a hardware preset button on a stereo head unit. Implies LaunchGui + navigate.

| Signal          | Bits     | Range | Meaning |
|-----------------|----------|-------|---------|
| `SourceEnum`    | 7\|8@0+  | 0–63  | same enum as TransportStatus |
| `SubScreenEnum` | 15\|8@0+ | 0–255 | optional drill-down |

**`SubScreenEnum`:**
```
0 = Default     (source's default landing — usually browse-home)
1 = SignIn      (open the sign-in flow if applicable)
2 = Settings    (per-source settings panel)
3 = Search      (open search input)
... 4-255 reserved
```

CAN IDs: `0x107` / `0x117` / `0x127`.

### `+0x8` — `PlaybillVolumeCmd<N>` (size 2, → Playbill)

Volume + mute. Separate from `TransportCmd` so a hardware volume encoder or mute button can wire to a single CAN ID with no enum-parsing logic.

| Signal      | Bits    | Range | Meaning |
|-------------|---------|-------|---------|
| `VolAction` | 7\|8@0+ | 0–5   | enum below |
| `Value`     | 15\|8@0+ | 0–255 | meaning depends on action |

**`VolAction`:**
```
0 = Up           Value = step (default 5 if 0); valid 1-100
1 = Down         Value = step (default 5 if 0); valid 1-100
2 = Set          Value = absolute percent 0-100
3 = MuteOn       Value ignored
4 = MuteOff      Value ignored
5 = MuteToggle   Value ignored
```

CAN IDs: `0x108` / `0x118` / `0x128`.

### `+0x9` — `PlaybillPresence<N>` (size 6, ← Playbill)

Mirrors the `FirmwareVersionReport` shape (`0x004`). Sent once on startup and again every 60 s as a heartbeat. Lets a CAN consumer (a dash module, future status LED, etc.) discover what's online without subscribing to MQTT.

| Signal            | Bits     | Range | Meaning |
|-------------------|----------|-------|---------|
| `MacAddressByte4` | 7\|8@0+  | 0–255 | last three bytes of the host's primary NIC MAC |
| `MacAddressByte5` | 15\|8@0+ | 0–255 | |
| `MacAddressByte6` | 23\|8@0+ | 0–255 | |
| `VersionMajor`    | 31\|8@0+ | 0–255 | from controller package.json |
| `VersionMinor`    | 39\|8@0+ | 0–255 | |
| `VersionPatch`    | 47\|8@0+ | 0–255 | |

CAN IDs: `0x109` / `0x119` / `0x129`.

### `+0xA … +0xF` — RESERVED

Do not use. Future expansion within each instance block.

---

## 4 · Cross-cutting design notes

* **Endianness** is Motorola big-endian throughout, matching every existing TrailCurrent message in the DBC. There is no Intel/little-endian mixing.
* **`Vector__XXX` as transmitter** is used for `→ Playbill` messages because there's no single canonical sender — a touchscreen, a CAN button MCU, the Headwaters CAN bridge could all originate them.
* **Volume vs. transport** are split. A hardware volume encoder/mute button benefits from being a single CAN ID with a 1-byte action enum; folding it into TransportCmd would force every volume-button MCU to also implement the play/pause/seek vocabulary.
* **Frequency in kHz** (32-bit) covers FM/AM/scanner without a band-specific multiplier and leaves room for cellular/HF expansion.
* **Reserved enum and offset slots** are explicit because CAN IDs and enum values are forever — once a downstream device wires to `SysAction = 3 = Wake`, we cannot reuse value 3 for anything else.
* **Multi-instance addressing on CAN does not bleed into MQTT.** MQTT topics use the human-readable `device.id` slug; CAN uses the numeric `device.canInstance`. They are independent fields in `settings.json`.
* **Heartbeat cadence** for Presence: 60 s. Not aggressive; not slow enough to be worthless. Open to revising.

---

## 5 · Settings.json change

Add a single field under `device`:

```json
"device": {
  "id": "living-room",        // existing — MQTT slug
  "name": "Living Room",      // existing — display name
  "canInstance": 0            // NEW — 0, 1, 2, or null
}
```

* `null` = this Playbill is MQTT-only; do not engage the CAN bridge.
* `0` / `1` / `2` = bind to the corresponding CAN ID block.

Validation: must be unique across all Playbills on the same rig, but enforcing that is a runtime concern (the controller can publish a presence collision on MQTT if it sees another Playbill claiming its `canInstance`). The schema only enforces the value is in the valid range.

Auto-pick on first run: if `device.canInstance` is unset and no other Playbill is announcing presence on instance 0, pick `0`. If 0 is taken, try 1. If 1 is taken, try 2. If all three are taken, leave it as `null` and surface a warning in Settings — the user can manually override.

---

## 6 · Sign-off (resolved 2026-05-10)

All seven open questions were accepted as proposed:

1. **CAN ID block placement:** `0x100–0x12F` — accepted.
2. **Three instances** — accepted; `0x130+` reserved for future expansion.
3. **Reserved offsets `+0xA – +0xF`** — kept reserved.
4. **`PlaybillTransportCmd` `Value` 32 bits** — accepted.
5. **`PlaybillRadioStatus` `SignalDbm` signed 8-bit** — accepted.
6. **`PlaybillPresence` heartbeat 60 s** — accepted.
7. **Auto-pick logic for `canInstance` on first run** — accepted (claim 0 if free, else 1, else 2, else null + warn in Settings).

DBC edits applied. Codec implemented. Schema referenced. No further sign-off required for the original proposal; future additions get their own review pass.
