# Adding library artwork manually

Playbill's library views (Movies / Shows / Music) try to fetch artwork automatically when each title is ripped:

- **Movies and Shows** — poster comes from OMDb (the JPG that sits on Amazon's CDN) and is saved next to the rip.
- **Music** — front cover comes from the Cover Art Archive (CAA), looked up via the MusicBrainz release ID, and saved next to the album.

When the rig is off‑grid, or OMDb / CAA simply has nothing for that title, the library card renders with a fallback "no artwork" tile. This document explains how to drop in your own image so the card picks it up on the next scan — no rebuild, no restart, just a file copy.

> All paths are written relative to the user's home directory (`~`). On the Playbill device that's `/home/trailcurrent/`.

## TL;DR

| Item | Where it goes | Filename | Aspect ratio | Recommended size |
|---|---|---|---|---|
| Movie poster | `~/Playbill/Movies/<Title> (<Year>)/` | `<Title> (<Year>).jpg` | **2 : 3** (portrait) | 1000 × 1500 px, JPG |
| TV episode poster | `~/Playbill/Shows/<Show>/` | `<Show> - S<NN>E<MM>.jpg` | **2 : 3** | 1000 × 1500 px, JPG |
| Album cover | `~/Playbill/Music/<Artist>/<Album> (<Year>)/` | `cover.jpg` | **1 : 1** (square) | 1000 × 1000 px (or 1500 × 1500 px), JPG |

Drop the file at that exact path, with that exact filename, and it will be picked up the next time the library re-scans (re‑opening the view is enough; you don't need to restart Playbill).

---

## Movies

### Folder layout

A ripped movie lives at:

```
~/Playbill/Movies/<Title> (<Year>)/
    <Title> (<Year>).mkv
    <Title> (<Year>).json    ← sidecar (metadata)
    <Title> (<Year>).jpg     ← poster (optional; this is what you'd add)
```

Example:

```
~/Playbill/Movies/Example Movie (1999)/
    Example Movie (1999).mkv
    Example Movie (1999).json
    Example Movie (1999).jpg
```

The poster filename must match the `.mkv` basename **exactly**, just with `.jpg` instead of `.mkv`. The library scanner looks for that specific name when no `posterPath` is set in the sidecar.

### Image requirements

| Property | Value | Required vs Recommended |
|---|---|---|
| Aspect ratio | **2 : 3** (portrait) | **Required.** Non‑2:3 images are not cropped — they're stretched to fit the card and look distorted. |
| Format | JPG | **Required for the default filename.** PNG works only if you set `posterPath` in the sidecar (see below). |
| Dimensions | 1000 × 1500 px or larger (still 2:3) | **Recommended.** The card renders at ~260 × 390 px on a 1080p display but the same image is reused for the larger detail / now‑playing views, so don't go below 500 × 750 px. |
| File size | ≤ 5 MB | **Recommended.** No hard cap on locally‑placed files. The 10 MB cap in [dvd-poster.js](../controller/src/services/dvd-poster.js) only applies to auto‑downloads. Anything past a few MB just makes the renderer slower with no visual gain. |

### Pointing at a non‑default filename (optional)

If you'd rather keep the file at some other path inside the same folder — e.g. you have a PNG, or you want to keep multiple candidates around — open the sidecar JSON and add a `posterPath` field whose value is the filename **relative to the movie folder**:

```json
{
  "title": "Example Movie",
  "year": 1999,
  …existing fields…
  "posterPath": "poster-custom.png"
}
```

The scanner reads `posterPath` first, falls back to `<basename>.jpg`, then falls back to the remote `posterUrl`. Relative paths only — absolute paths break library portability (e.g. copying the folder to a NAS).

---

## TV Shows

### Folder layout

Episodes are grouped under a single show folder:

```
~/Playbill/Shows/<Show>/
    <Show> - S01E01.mkv
    <Show> - S01E01.json
    <Show> - S01E01.jpg     ← poster for this episode (optional)
    <Show> - S01E02.mkv
    <Show> - S01E02.json
    <Show> - S01E02.jpg
    …
```

Example:

```
~/Playbill/Shows/Example Series/
    Example Series - S01E01.mkv
    Example Series - S01E01.json
    Example Series - S01E01.jpg
```

Each episode has its own poster slot. A show‑level poster (e.g. one image for the whole series) is not currently a separate field — if you want the whole show to share one image, set the same JPG as every episode's poster, or use the sidecar `posterPath` trick to point every episode's JSON at a single shared file in the show folder.

### Image requirements

Same as movies — **2 : 3 portrait**, 1000 × 1500 px recommended, JPG by default. The library scanner uses identical logic for both `Movies/` and `Shows/`.

### Pointing at a non‑default filename

Same `posterPath` field in the episode's sidecar, relative to the show folder:

```json
{
  "title": "Example Series",
  "season": 1,
  "episode": 1,
  …existing fields…
  "posterPath": "season-1-shared-poster.jpg"
}
```

---

## Music albums

### Folder layout

```
~/Playbill/Music/<Artist>/<Album> (<Year>)/
    01 - Track 1 Title.flac
    02 - Track 2 Title.flac
    …
    album.json
    cover.jpg     ← album cover (optional; this is what you'd add)
```

Example:

```
~/Playbill/Music/Example Band/Example Album (1999)/
    01 - First Track Title.flac
    02 - Second Track Title.flac
    …
    album.json
    cover.jpg
```

The default cover filename is **always** `cover.jpg` — albums don't follow the "match the basename" rule that movies and shows use, because they have many `.flac` files instead of one named file.

### Image requirements

| Property | Value | Required vs Recommended |
|---|---|---|
| Aspect ratio | **1 : 1** (square) | **Required.** The album grid cards and the detail‑view hero (280 × 280 px) both render at 1:1, so non‑square covers either get letterboxed or cropped. |
| Format | JPG | **Required for the default filename.** PNG works only if you set `coverPath` in the sidecar. |
| Dimensions | 1000 × 1000 px or 1500 × 1500 px | **Recommended.** CAA's "front" endpoint typically serves images in the 1200 × 1200 – 1500 × 1500 range; matching that keeps things consistent. The 280 × 280 px hero benefits from 2× density on a 1080p display. Minimum useful: 500 × 500 px. |
| File size | ≤ 5 MB | **Recommended.** The auto‑download path enforces 20 MB in [cd-artwork.js](../controller/src/services/cd-artwork.js) but local files are unrestricted. Most CAA images are well under 3 MB. |

### Pointing at a non‑default filename (optional)

Edit `album.json` and add `coverPath`:

```json
{
  "title": "Example Album",
  "artist": "Example Band",
  "year": 1999,
  …existing fields…
  "coverPath": "front-custom.png"
}
```

Relative to the album folder.

---

## Verifying the change

1. Drop the image in place.
2. In Playbill, navigate **away** from the Library / Music view, then back. The view re-scans every time it's entered, so a fresh visit will pick up the new file. No restart needed.
3. If the card still shows the "no artwork" placeholder:
   - Confirm the file is at the **exact** path and filename listed above (case matters, spaces matter, the parenthesised year matters).
   - If you used a non‑default filename, confirm `posterPath` / `coverPath` in the sidecar JSON parses cleanly — a stray comma or missing quote will make the scanner drop the entire entry.
   - File a `journalctl --user -u trailcurrent-playbill.service` against the time you re‑entered the view; the scanner logs a line per scanned title.

## Where the resolution logic lives

If you need to tweak this behaviour at the code level, the relevant files are:

- Movies / shows: [controller/src/services/dvd-library.js](../controller/src/services/dvd-library.js)
- Music: [controller/src/services/cd-library.js](../controller/src/services/cd-library.js)
- Auto‑download (OMDb): [controller/src/services/dvd-poster.js](../controller/src/services/dvd-poster.js)
- Auto‑download (CAA): [controller/src/services/cd-artwork.js](../controller/src/services/cd-artwork.js)
- Renderer cards: [app/renderer/components/local.jsx](../app/renderer/components/local.jsx), [app/renderer/components/music.jsx](../app/renderer/components/music.jsx)
