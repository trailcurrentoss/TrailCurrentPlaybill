# DVD — data surface

Command bus actions, state slice shape, MQTT topics, on-disk files for
the DVD-rip pipeline. Companion to [dvd.md](./dvd.md) (user-facing
walkthrough) and [dvd-rip-internals.md](./dvd-rip-internals.md)
(module internals).

## Command bus surface

All actions are validated against
`controller/src/schema/commands.schema.json` (Ajv strict mode) before
they hit a handler.

| Action | Value | Returns | Notes |
|---|---|---|---|
| `dvd.getStatus` | — | `state.dvd` snapshot | cheap |
| `dvd.refreshStatus` | — | `state.dvd` after a forced probe | useful when a disc was already in the drive at controller boot — the watcher's initial probe doesn't fire `inserted`, so the GUI can ask for one explicitly |
| `dvd.lookup` | `{ title, year? }` | `{ ok:true, metadata:{...} }` or `{ ok:false, reason:'no-api-key'\|'not-found' }` | OMDb HTTPS call; `year` must match `^(19\|20)\d{2}$` |
| `dvd.dismiss` | — | `{ ok:true }` | user clicked "Not now"; suppresses re-prompting for this disc until ejection |
| `dvd.startRip` | `{ metadata: { title, year?, kind, ... } }` | `{ ok:true, target }` | fire-and-forget; progress arrives via state patches |
| `dvd.cancelRip` | — | `{ ok:boolean, cancelled:boolean }` | SIGTERMs HandBrakeCLI |
| `dvd.eject` | — | `{ ok:boolean, error? }` | shells `eject /dev/sr0` |
| `dvd.libraryList` | — | `{ movies:[...], shows:[...], root }` | scans disk on every call. Each entry includes `posterUrl` (local `file://` if cached, else remote https), `posterUrlRemote` (the original URL), and `posterLocal:bool` |
| `dvd.refreshPosters` | — | `{ ok, attempted, downloaded, failed, skipped, total }` | walks the library and downloads any missing posters using the URL in each sidecar. Used to backfill after the rig comes back online. |
| `dvd.setOmdbKey` | `{ apiKey?:string }` | `{ ok:true, cleared? }` | empty / missing `apiKey` clears the stored key. Updates `state.dvd.omdbApiKeySet`. |
| `dvd.validateOmdbKey` | `{ apiKey?:string }` | `{ ok, kind?, error? }` | no-op OMDb lookup to confirm a key works. Used by Settings → Library before persisting. With no `value`, validates the currently-stored key. |

`dvd.startRip` metadata schema:

```json
{
  "title":     "Inception",      // required
  "year":      "2010",           // string, OMDb uses string
  "kind":      "movie",          // 'movie' | 'show'
  "show":      "Breaking Bad",   // shows only — show name
  "season":    1,                // shows only — integer
  "episode":   3,                // shows only — integer
  "plot":      "Cobb is a thief...",
  "posterUrl": "https://m.media-amazon.com/images/...",
  "rating":    "8.8",            // IMDb rating, string
  "runtime":   "148 min",        // OMDb string
  "imdbId":    "tt1375666",
  "source":    "omdb"            // where the metadata came from
}
```

## State slice — `state.dvd`

Mirrored to every connected GUI client via the IPC delta channel, and
to MQTT as `local/playbill/<id>/status/dvd` (retained, qos:1).

```js
state.dvd = {
  present: bool,                        // disc spun up in /dev/sr0
  device:  '/dev/sr0',                  // hardcoded today; future: multi-drive
  label:   'INCEPTION',                 // ISO-9660 volume label, may be empty
  fstype:  'iso9660' | 'udf' | ...,     // from lsblk
  prompt: {                             // populated when status === 'prompting'
    label:          'INCEPTION',
    suggestedTitle: 'Inception',        // heuristic title-cased
    yearHint:       null,
  } | null,
  status:  'idle'         |             // no disc, or disc dismissed
           'prompting'    |             // disc present, user hasn't decided
           'ripping'      |             // HandBrakeCLI running
           'done'         |             // rip finished, awaiting eject/ack
           'error',                     // see .error
  ripping: {                            // non-null only while status === 'ripping'
    percent:       12.34,
    etaSec:        754,
    currentTitle:  'Inception',
  } | null,
  lastRipped: {                         // populated on status === 'done'
    title: 'Inception',
    year:  '2010',
    path:  '/home/.../Inception (2010).mkv',
  } | null,
  error:     'HandBrakeCLI exited 1: ...' | null,
  dismissed: bool,                      // user clicked Not Now
  omdbApiKeySet: bool,                  // whether an OMDb API key is stored.
                                        // The Settings → Library tab reads
                                        // this to show "Key stored" + the
                                        // "Remove key" button. The key value
                                        // itself is never sent over IPC.
};
```

State transitions:

```
                                     dvd.dismiss
                                  ┌──────────────┐
                                  │              │
                                  ▼              │
   disc inserted                ┌─────────────────────┐
   ──────────────▶  prompting ──┤                     │
                    │           │     idle            │
                    │           │  (no disc, or       │
                    │           │   user dismissed)   │
                    │ user      │                     │
                    │ confirms  └─────────────────────┘
                    ▼                       ▲    ▲
                  ripping                   │    │
                  │   │                     │    │
              done│   │failed               │    │
                  │   ▼                     │    │
                  │  error  ────────────────┘    │
                  ▼                              │
                  done ──── dvd.dismiss ─────────┘
                            (or eject + insert next disc
                             which re-enters prompting)
```

## MQTT topics

Published by the controller's state→MQTT fan-out
(`controller/src/index.js`, `installStateToMqttFanout`).

| Topic | Direction | Payload | Notes |
|---|---|---|---|
| `local/playbill/<id>/status/dvd` | controller → broker | full `state.dvd` shape | retained, qos:1; re-published on every state change AND on every broker (re)connect |
| `local/playbill/<id>/command/dvd/<action>` | broker → controller | command value (matches the bus schema's `value` field) | for remote control from a PWA — e.g. publish `{"metadata":{"title":"...","kind":"movie"}}` to `command/dvd/startRip` to start a rip from a phone |

(The `command/<feature>/<action>` → bus.dispatch fan-in is the
generic MQTT bridge behaviour, not DVD-specific — see
`mqtt-bridge.js`.)

## On-disk files

| Path | Owner | What |
|---|---|---|
| `~/Videos/Playbill Library/Movies/<Title (Year)>/<Title (Year)>.mkv` | user | the ripped movie |
| `~/Videos/Playbill Library/Movies/<Title (Year)>/<Title (Year)>.jpg` | user | cached poster (off-grid playback). Absent if rip happened off-grid — backfill via `dvd.refreshPosters`. |
| `~/Videos/Playbill Library/Movies/<Title (Year)>/<Title (Year)>.json` | user | metadata sidecar |
| `~/Videos/Playbill Library/Shows/<Show>/<Show> - SnnEnn.mkv` | user | one ripped episode |
| `~/Videos/Playbill Library/Shows/<Show>/<Show> - SnnEnn.jpg` | user | cached poster |
| `~/Videos/Playbill Library/Shows/<Show>/<Show> - SnnEnn.json` | user | metadata sidecar |
| `~/.config/trailcurrent-playbill/headwaters.json` | user, mode 0600 | shared with the Headwaters integration; carries `omdbApiKey` alongside the existing `apiKey` |

Sidecar shape (`<title>.json`):

```json
{
  "title":       "Inception",
  "year":        "2010",
  "kind":        "movie",
  "plot":        "Cobb is a thief who...",
  "posterUrl":   "https://m.media-amazon.com/...",
  "posterPath":  "Inception (2010).jpg",
  "posterBytes": 184232,
  "rating":      "8.8",
  "runtime":     "148 min",
  "imdbId":      "tt1375666",
  "source":      "omdb",
  "rippedAt":         "2026-05-12T19:23:14.000Z",
  "rippedFromDevice": "/dev/sr0",
  "file":             "Inception (2010).mkv"
}
```

`posterPath` is relative (not absolute) so a backup / copy / NAS-move
of the title folder still resolves correctly. The library scanner uses
the sidecar's `posterPath` first, and if it's absent falls back to
looking for `<basename>.jpg` next to the `.mkv` (so a manually-dropped
poster works too).

## Filename sanitisation

The folder + file names are computed by `libraryPathFor()` in
`controller/src/services/dvd-ripper.js`. The sanitiser strips
filesystem-hostile characters (`< > : " / \ | ? * \x00-\x1f`) but keeps
spaces and Unicode letters. So a title like `Pinocchio (2002)` lands
on disk as exactly `Pinocchio (2002).mkv` — no underscoring, no slug
conversion. Mounted on a non-Linux filesystem (NTFS/exFAT) you'll be
fine; on a network share you may hit Windows reserved names like
`CON` / `PRN` — file a bug if you ever rip a movie named `Con Air`.
