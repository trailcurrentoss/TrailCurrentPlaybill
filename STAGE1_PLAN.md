# TrailCurrent Playbill — Stage 1 Plan

## Context

The Radxa Dragon Q6A (Qualcomm QCS6490) running this image is **a full Linux desktop** — Ubuntu Noble 24.04 with GNOME on Wayland, branded TrailCurrent throughout (boot splash, login, wallpaper, theme). It is used as a normal desktop computer for everyday work.

**TrailCurrent Playbill is one application installed on that desktop.** When work is done in the evening, the user clicks the Playbill icon in the GNOME dock and the app opens fullscreen, turning the desktop into a 10-foot, remote-driven entertainment center. The user can quit, minimize, Alt+Tab, or switch workspaces away at any time — Playbill is a standard desktop application, not a kiosk lockdown.

The R&D prototype at `/media/dave/extstorage/TrailCurrent/RandD/trailcurrent-tv/` is a working React/JSX + plain-CSS playable mockup at 1920×1080 with full keyboard focus navigation across Home / Apps / Live TV / Library / Rig screens. We use it as the renderer for the Electron app verbatim — no rewrite, no TypeScript port. (The R&D directory keeps its original `trailcurrent-tv` filesystem name; the productized name everywhere downstream is **TrailCurrent Playbill**.)

In later stages Playbill connects to the Headwaters NAS (media library), the rig CAN bus (telemetry, cameras), an OTA antenna tuner, and external streaming apps. Stage 1 just stands up the desktop and proves the app launches with the empty TV shell.

**Hard constraints (applied throughout):**
- **JavaScript only — no TypeScript anywhere** (app, tooling, electron-builder configs, build scripts).
- **Kernel updates must not break GPU acceleration or WiFi** — the recurring Q6A pain point. Solved by `apt-mark hold` on kernel + Mesa + linux-firmware.
- **This is a full Linux desktop, not an appliance.** No kiosk autostart, no forced-password first-login wizard, no masked unattended-upgrades. Standard Ubuntu desktop UX. (See project memory `project_playbill_is_a_desktop_app.md`.)
- **Input is keyboard + mouse for the desktop, plus arrow keys / IR or Bluetooth remote for the Playbill TV shell.** Not a touchscreen device.
- **Audio output is the Radxa Q6A's built-in 3.5mm headphone jack** — not HDMI, not USB DAC, not Bluetooth. WCD938x codec + ALSA UCM profile must be working in the image. (See project memory `project_audio_3p5mm_jack.md`.)
- **Both light and dark color schemes are first-class.** Brand-aligned in both. The Playbill app honors the GNOME color-scheme preference at runtime; the desktop ships matching light + dark wallpapers. (See project memory `project_dual_color_scheme.md`.)
- **Every GNOME GUI control mirrors the Farwatch PWA chrome.** Buttons, inputs, switches, badges, cards, focus rings, glows, radii, and shadows are ported from `/media/dave/extstorage/TrailCurrent/Product/TrailCurrentFarwatch/frontend/public/css/` (with Headwaters PWA as a secondary reference). A user moving between the Farwatch web app on their phone, the Headwaters web UI in a browser, and the GNOME desktop on the rig should feel they're using one product family. (See project memory `project_gnome_theme_mirrors_pwa_chrome.md`.)
- **Repository hygiene** — `.claude/`, `CLAUDE.md`, etc. stay out of the repo via `.gitignore` from day one.

---

## Project location & structure

This project lives at `/media/dave/extstorage/TrailCurrent/Product/TrailCurrentPlaybill/` (the current working directory — currently empty). Layout to scaffold:

```
TrailCurrentPlaybill/
├── app/                          Electron app (no TypeScript)
│   ├── package.json              JS-only; deps: electron, @babel/core, @babel/preset-react,
│   │                             @babel/cli, electron-builder, source-map-support
│   ├── electron-builder.config.js  Plain JS config (NOT .ts, NOT .yml-with-TS-tooling)
│   ├── main/
│   │   ├── main.js               BrowserWindow with fullscreen:true, frame:false,
│   │   │                         webPreferences:{contextIsolation:true, sandbox:true}
│   │   ├── preload.js            Minimal IPC surface (none yet for Stage 1)
│   │   └── displays.js           Detect primary display via screen.getPrimaryDisplay()
│   │                             so we honor the connected panel's native resolution
│   ├── renderer/                 = R&D prototype, copied verbatim
│   │   ├── index.html            (= TV.html, viewport 1920x1080)
│   │   ├── styles/
│   │   │   ├── colors_and_type.css
│   │   │   └── tv.css
│   │   ├── data.js               Empty-data variant for Stage 1 (titles + skeletons,
│   │   │                         no real content)
│   │   └── components/           app.jsx, chrome.jsx, home.jsx, apps.jsx, live.jsx,
│   │                             local.jsx, rig.jsx — copied as-is
│   ├── packaging/
│   │   ├── trailcurrent-playbill.desktop      XDG launcher entry (installs to /usr/share/applications/)
│   │   └── trailcurrent-playbill.png          Icon (multi-res via electron-builder)
│   ├── build/                    Babel-compiled JSX → JS (gitignored)
│   └── dist/                     electron-builder .deb output (gitignored)
│
├── image/                        Radxa OS image build (forks Headwaters Q6A pattern)
│   ├── build.sh                  Orchestrator — fork of Headwaters build.sh
│   ├── preflight.sh              Cache + host validation
│   ├── flash.sh                  edl-ng wrapper for SPI NOR + NVMe
│   ├── rsdk/                     Vendored Radxa SDK
│   │   └── src/share/rsdk/build/rootfs.jsonnet  Customize-hooks (modified for Playbill)
│   ├── embloader/
│   │   └── patches/0001-playbill-autoboot-on-timeout-zero.patch  (copy of Headwaters patch)
│   ├── overlays/                 Q6A DT overlays (compiled at build time)
│   ├── firmware/                 SPI NOR firmware blob (vetted version)
│   ├── files/
│   │   ├── plymouth/             Branded boot splash (logo.png, background.png, .script)
│   │   ├── gnome/                GNOME shell theme + GTK4/libadwaita theme (Farwatch-PWA port) + icon overrides + wallpapers + dconf
│   │   │   ├── gtk-4.0/gtk.css           System-wide GTK4 override — the Farwatch widget chrome
│   │   │   ├── libadwaita/colors.css     libadwaita recoloring (accent, surface, etc.)
│   │   │   ├── shell/                    GNOME Shell theme (top bar, overview, lock screen)
│   │   │   ├── icons/                    Icon theme overrides (Ionicons-derived where needed)
│   │   │   ├── dconf/00-trailcurrent-playbill   dconf override (wallpapers, theme, fonts)
│   │   │   └── wallpapers/               Installed wallpapers: light + dark variants
│   │   ├── gdm/                  GDM background + logo override
│   │   ├── audio/
│   │   │   ├── wireplumber.conf.d/50-playbill-default-sink.conf  Default sink = analog jack
│   │   │   └── alsa-ucm/                                          UCM profile if not in distro pkg
│   │   ├── systemd/
│   │   │   └── trailcurrent-playbill-firstboot.service  One-shot: rootfs expand, machine-id, SSH host keys
│   │   ├── scripts/
│   │   │   └── trailcurrent-playbill-firstboot.sh       The one-shot script above
│   │   ├── modprobe/             (only NPU + BT blacklisted; WiFi STAYS ENABLED)
│   │   ├── apt/
│   │   │   ├── 50-trailcurrent-playbill-holds.pref     Kernel/Mesa/firmware Pin-Priority -1
│   │   │   └── 60-trailcurrent-playbill-no-recommends.conf
│   │   └── sysctl/90-trailcurrent-playbill.conf
│   └── output/                   Built images (gitignored)
│
├── branding/                     Source assets (PNG/SVG masters + ComfyUI prompts)
│   ├── plymouth-logo.png
│   ├── plymouth-background.png   Dark variant only (boot is always dark)
│   ├── wallpaper-light-2880x1620.png   ComfyUI Juggernaut Lightning, light brand variant
│   ├── wallpaper-dark-2880x1620.png    ComfyUI Juggernaut Lightning, dark brand variant
│   ├── gdm-background.png        Dark variant (login screen is always shown dark)
│   ├── playbill-logo.svg         Used in the Electron renderer + branding pipeline
│   └── comfyui-prompts.md        Prompts used for each generated asset (reproducible)
│
├── docs/
│   ├── README.md                 Top-level overview — opens with "this is a desktop, not an appliance"
│   ├── SETUP.md                  Operator guide (flash, first boot, WiFi, audio test)
│   ├── ARCHITECTURE.md           Stage 1+ architecture
│   └── KERNEL_UPDATE_POLICY.md   Why we hold kernel/mesa/firmware (the Q6A pain point)
│
├── .gitignore                    Includes .claude/, CLAUDE.md, .cursor*, .aider*, etc. + node_modules, dist, build, image/output, image/cache
└── package.json                  Workspace root (npm workspaces -> app/)
```

The Playbill app is packaged as a normal `.deb` by electron-builder. It installs to `/opt/TrailCurrent Playbill/` (electron-builder default), drops a launcher at `/usr/share/applications/trailcurrent-playbill.desktop`, and registers an icon in `/usr/share/icons/`. The image build hook just `apt install`s that .deb during rootfs assembly so the app is preinstalled — but it remains a normal desktop application that the user starts and stops at will.

---

## Stage 1 build phases

### Phase A — Repo skeleton & .gitignore (do FIRST)

1. Scaffold the layout above inside the cwd `/media/dave/extstorage/TrailCurrent/Product/TrailCurrentPlaybill/`.
2. Write `.gitignore` containing the global-rule patterns (`.claude/`, `CLAUDE.md`, `.cursor*`, `.aider*`, etc.) plus `node_modules/`, `app/build/`, `app/dist/`, `image/output/`, `image/cache/`, `*.img`, `*.img.xz`. **No agent files committed, ever.**
3. `git init` (do NOT auto-commit — leave staging to user per global rule).

### Phase B — Branding asset generation

Generate via ComfyUI per the global CLAUDE.md ComfyUI workflow (Juggernaut Lightning SDXL, 7 steps, cfg 1.8, euler / sgm_uniform). Save outputs to `branding/`.

**Brand color discipline (read this before writing any prompt).** The TrailCurrent brand is grounded in real photography of motorhomes and travel trailers in real outdoor settings — the marketing site uses photographs at `/media/dave/extstorage/TrailCurrent/Marketing/ClaudWebSite/src/images/hero/` (`bright_motorhome.webp` — Class C RV on a grass clifftop over the ocean, clear blue sky; `camping-exterior-02.webp` — two travel trailers in a misty redwood campsite by a lake; `motorhome-2.webp` — Class C RV on a desert highway through red-rock canyon country at golden hour; `Interior.webp`, `TravelTrailer04.webp`). Look at these directly before drafting prompts.

The canonical brand tokens live in `/media/dave/extstorage/TrailCurrent/Marketing/ClaudWebSite/src/css/variables.css`: primary `#52A441`, primary-dark `#3D7D31`, primary-light `#6AB85A`, secondary `#D0E2C7`, link/eucalyptus `#83A79C`, success `#74FE00`, info `#48E6FE`, danger `#FF5453`, primary-subtle `#DCEDD9`. Inter is the canonical typeface (`--font-primary: 'Inter', -apple-system, ...`).

**Off-brand colors and motifs to actively block** (these never appear in TrailCurrent imagery): purple, magenta, pink, lavender, violet, mauve, alpenglow, aurora/northern lights, coral-as-sky, vaporwave, synthwave, neon, cyberpunk, generic adventure-van mood-board fiction. Real RVs in real campsites, real golden-hour deserts, real clifftop oceans — that is the brand.

**Both light and dark wallpapers are required** — both brand-aligned, both ComfyUI-generated, paired so a user toggling GNOME light/dark sees the same scene at a different time of day, not two unrelated images.

**Chosen scene for the paired set:** A Pacific Northwest campsite by a still lake — tall redwood/pine canopy, an off-white travel-trailer-style RV parked under the trees, camp chairs near a stone fire pit, soft mist on the lake in middle distance. This mirrors `camping-exterior-02.webp` exactly. Same camera angle for both wallpapers; only the time of day changes.

| Asset | Resolution | Style direction |
|---|---|---|
| `wallpaper-dark.png` | 2880×1620 (resized for connected panels) | The campsite at evening blue hour. Cool slate-blue sky upper-third with the last light washing over the canopy. Warm amber glow from the RV's interior windows + a low orange ember from the fire pit are the only warm light sources. Lake reflects sky cool. Pines render as deep forest-green silhouettes. Earth tones in the dirt path (warm browns, no reds). Brand green `#52A441` reads in the canopy mid-tones; brand amber `#FFC107` only as the window glow accent. |
| `wallpaper-light.png` | 2880×1620 | The same campsite at midday. Soft natural daylight filters through the canopy in shafts, lighting the forest floor in warm cream and sage. Sky is a clean pale blue (think `bright_motorhome.webp`'s sky), no clouds. Pines in mid-greens (`#52A441` family + `#6AB85A`), trunks in warm cream-brown, eucalyptus mist `#83A79C` rising off the lake middle-distance. Same camera, same RV, same chairs — just noon. |
| `plymouth-background.png` | 1920×1080 | Dark variant only — solid `#0a0e08` with a faint topographic contour overlay in `#1f3a18` and a subtle radial green vignette. No photographic content — boot splash must render identically on every device. |
| `plymouth-logo.png` | 512×512 transparent | Existing `playbill-logo.svg` rasterized via ImageMagick (NOT generated). |
| `gdm-background.png` | 1920×1080 | Dark variant only. Reuse `wallpaper-dark.png` blurred: `convert wallpaper-dark.png -resize 1920x1080^ -gravity center -extent 1920x1080 -blur 0x12 gdm-background.png`. |

**ComfyUI prompt template (use verbatim — do NOT add "alpenglow," "aurora," "vibrant gradient sunset," "vaporwave," "cinematic," etc.):**

For `wallpaper-dark.png`:
- **Positive:** `Pacific Northwest campsite by a still lake at evening blue hour, tall redwood and pine canopy, off-white travel trailer RV parked under the trees, two empty camp chairs near a stone fire pit with a low orange ember glow, warm amber light from the RV interior windows, mist on the lake in middle distance, dirt path in warm brown earth tones, deep forest green canopy silhouettes, cool slate blue sky upper third, photoreal real-camera photograph, natural lighting, ultra wide composition, rule of thirds, negative space upper third for desktop icons, no people, no text, no words, no letters, no watermark, no logo, no signature`
- **Negative:** `purple, magenta, pink, lavender, violet, mauve, alpenglow, aurora, aurora borealis, northern lights, coral, salmon, vaporwave, synthwave, neon, glowing fog, cyberpunk, urban, city, buildings, road signs, signage, text, words, letters, watermark, logo, signature, people, person, human, face, oversaturated, HDR halo, lens flare, painterly, illustration, drawing, cartoon`

For `wallpaper-light.png`:
- **Positive:** `same Pacific Northwest campsite at midday, off-white travel trailer RV under tall redwood pine canopy, two empty camp chairs near a stone fire pit, soft natural daylight filtering through the trees in shafts, clean pale blue sky, warm cream sunlit forest floor, pine canopy in mid forest green, eucalyptus pale teal mist rising off the lake middle distance, same camera angle as the evening shot, photoreal real-camera photograph, ultra wide composition, rule of thirds, negative space upper third for desktop icons, no people, no text, no words, no letters, no watermark, no logo, no signature`
- **Negative:** `purple, magenta, pink, lavender, violet, mauve, alpenglow, aurora, coral, salmon, vaporwave, synthwave, neon, cyberpunk, urban, city, buildings, road signs, signage, text, words, letters, watermark, logo, signature, people, person, human, face, oversaturated, HDR halo, lens flare, painterly, illustration, drawing, cartoon, dark, night, sunset, sunrise, golden hour`

Generate 4-6 candidates per wallpaper with different seeds; pick the one whose palette stays closest to the reference photo `camping-exterior-02.webp`. Reject any candidate with visible purple or pink in the sky regardless of composition. If the model keeps drifting, lower CFG to 1.5 or switch the checkpoint to `realvisxlV50_v50LightningBakedvae.safetensors` (per the global CLAUDE.md, RealVis Lightning is the photoreal model).

ImageMagick post-processing per global CLAUDE.md: always use `-alpha remove -alpha off` when flattening PNGs intended for video/Plymouth pipelines.

ComfyUI prompts get written into `branding/comfyui-prompts.md` so future variants are reproducible.

### Phase C — OS image build pipeline (image/)

Fork the **Headwaters Q6A image** at `/media/dave/extstorage/TrailCurrent/Product/TrailCurrentHeadwaters/RADXAQ6A/image/` for the bootloader/firmware/DT pieces only. The Headwaters appliance scaffolding (two-stage sentinel firstboot, masked unattended-upgrades, rfkill of WiFi, GPU min-freq pin) does **not** apply here — this is a desktop install.

**Forked verbatim — hardware-level Q6A workarounds, valid regardless of use case:**
- `build.sh`, `preflight.sh`, `flash.sh` — rename PROJECT/VERSION strings to TRAILCURRENT_PLAYBILL.
- `embloader/patches/0001-*-autoboot-on-timeout-zero.patch` — **mandatory**, otherwise EMI on the floating UART RX line traps the boot menu (documented Q6A gotcha). Rename file only.
- `overlays/qcs6490-radxa-dragon-q6a-headwaters-unused-pins-disable.dtso` — keep, it's just power savings on unused pins; rename `headwaters` → `playbill`.
- The "do NOT unbind msm_dsi/msm_dp/msm_mdss/camss/qcom_q6v5_pas drivers at runtime — it hard-hangs the board" comment block from `power-save-hw.service`. Carry that warning forward into our docs even though we're not running that service.

**Discarded from Headwaters (appliance patterns that don't fit a desktop):**
- Two-stage sentinel firstboot pattern. We keep only a single one-shot service for rootfs expand + machine-id reset + SSH host-key regen (standard pre-built image hygiene). No DNS-deferred network firstboot, no automatic security-update run on first boot, no sentinel files.
- `rfkill block wifi bluetooth` — discarded. WiFi must be available; Bluetooth optional (leave on so a BT remote can pair later if the user adds one).
- `disable-unused.conf` WiFi blacklist (ath10k_*, ath11k*, cfg80211, mac80211, ath) — discarded. Keep NPU blacklisted (we don't use it yet).
- GPU min-freq devfreq pin — discarded. Desktop needs GPU performance for compositing and Electron rendering.
- Masked `unattended-upgrades` — discarded. We **leave unattended-upgrades enabled** in the standard Ubuntu desktop configuration (security pocket only). The kernel/mesa/firmware holds (below) prevent the dangerous packages from rolling silently.

**New hooks added to `rootfs.jsonnet`:**

| Hook | Purpose |
|---|---|
| `install-gnome-desktop` | `apt install ubuntu-desktop-minimal gnome-shell gdm3 nautilus gnome-control-center gnome-terminal network-manager-gnome firefox`. Standard Ubuntu desktop install. GDM uses Wayland by default (Ubuntu Noble default). Keep AutomaticLoginEnable=false; user logs in normally. |
| `install-gpu-userspace` | `apt install mesa-vulkan-drivers libdrm2 libgbm1 libegl1 libgl1-mesa-dri libglx-mesa0`. Then **immediately `apt-mark hold`** all of these — they must NOT be silently upgraded. |
| `install-wifi-firmware` | Ensure `linux-firmware` is present (Q6A WiFi is ath11k, firmware ships in linux-firmware). Pin via `50-trailcurrent-playbill-holds.pref`. NetworkManager from the desktop install handles configuration via the GNOME UI. |
| `install-audio-stack` | `apt install pipewire pipewire-pulse wireplumber alsa-ucm-conf pavucontrol`. Drop `wireplumber.conf.d/50-playbill-default-sink.conf` that pins the default sink to the analog headphone jack. **Verify on real hardware** that the WCD938x codec is recognized and the analog jack appears as a sink — this is a known Qualcomm/Linaro pain point and may require an extra UCM file in `/usr/share/alsa/ucm2/` if the distro's `alsa-ucm-conf` doesn't ship a Dragon Q6A profile. |
| `install-electron-runtime` | `apt install nodejs npm` (for build only, not required at runtime once the .deb is installed). Then `dpkg -i` the Playbill `.deb` produced by Phase E. The .deb places the app at `/opt/TrailCurrent Playbill/`, the launcher at `/usr/share/applications/trailcurrent-playbill.desktop`, and the icon at `/usr/share/icons/hicolor/512x512/apps/trailcurrent-playbill.png`. |
| `install-branding` | Copy Plymouth assets into `/usr/share/plymouth/themes/trailcurrent-playbill/`, run `update-alternatives` (NOT `plymouth-set-default-theme` — removed in Noble), `update-initramfs -u -k all`. Copy GDM background. Drop a dconf override at `/etc/dconf/db/local.d/00-trailcurrent-playbill` that sets BOTH `org.gnome.desktop.background picture-uri` (→ `wallpaper-light.png`) AND `picture-uri-dark` (→ `wallpaper-dark.png`), plus matching GTK theme and icon theme tokens, then run `dconf update`. The user toggling GNOME's appearance preference (Settings → Appearance → Style: Default / Dark) swaps both the wallpaper and the GTK chrome consistently. |
| `install-gtk-theme` | Build and install the **TrailCurrent Playbill GTK4 / libadwaita theme**, a faithful port of the Farwatch PWA chrome. Source: `/media/dave/extstorage/TrailCurrent/Product/TrailCurrentFarwatch/frontend/public/css/theme.css` and `main.css` (Headwaters PWA at `/media/dave/extstorage/TrailCurrent/Product/TrailCurrentHeadwaters/containers/frontend/public/css/` is a secondary reference). The theme lives in this project at `image/files/gnome/gtk-4.0/gtk.css` (system-wide override) plus a libadwaita recoloring file at `image/files/gnome/libadwaita/colors.css`. Both light and dark variants. Concrete widget mapping is in `project_gnome_theme_mirrors_pwa_chrome.md` — buttons get 8-12px radius with the green hover-glow, inputs get 12px radius with a 3px primary focus ring, switches are 60×32px pills, status badges use 10% opacity tinted backgrounds, focus rings are 3px `rgba(82,164,65,0.2)`. Standard Adwaita defaults are not acceptable. |
| `install-firstboot-oneshot` | Drop `trailcurrent-playbill-firstboot.service` (Type=oneshot, RemainAfterExit=yes, ConditionPathExists=!/var/lib/trailcurrent-playbill/.firstboot-done). Script: resize root partition to fill NVMe, regenerate machine-id, regenerate SSH host keys, write the sentinel. That is the entire scope of firstboot — no security updates, no two-stage anything. |
| `install-apt-pins` | Drop `/etc/apt/preferences.d/50-trailcurrent-playbill-holds.pref` with Pin-Priority -1 on `linux-image-*`, `linux-headers-*`, `linux-modules-*`, `mesa-*`, `libdrm*`, `libgbm1`, `libegl1`, `libgl1-mesa-dri`, `linux-firmware`. Apt cannot silently upgrade these even via unattended-upgrades. |

### Phase D — First-boot behavior (Stage 1 acceptance flow)

1. **Embloader** autoboots to kernel (no menu — patch in place).
2. **Plymouth** shows TrailCurrent Playbill logo + background.
3. **`trailcurrent-playbill-firstboot.service`** (one-shot, before sysinit.target):
   - Resize root partition to fill the NVMe.
   - Regenerate machine-id.
   - Regenerate SSH host keys.
   - Set hostname.
   - Write `/var/lib/trailcurrent-playbill/.firstboot-done`.
4. **GDM** appears on Wayland with the TrailCurrent background and logo, at the connected panel's native resolution.
5. User logs in to GNOME normally. Themed wallpaper, themed top bar, normal desktop.
6. User configures WiFi via the GNOME network indicator (NetworkManager — the default Ubuntu desktop UX). NetworkManager remembers the connection; subsequent boots reconnect automatically.
7. User verifies audio: opens GNOME Settings → Sound, confirms the analog 3.5mm jack is the active output, plays a test tone.
8. Once online, the standard Ubuntu desktop's `unattended-upgrades` runs in the background as it normally would — security updates flow except for the held packages (kernel, Mesa, linux-firmware).
9. **User clicks the TrailCurrent Playbill launcher in the GNOME dock / Activities.** Electron opens fullscreen, black background, full TV shell visible: top bar with brand logo, side nav rail, home screen with empty rows ("Continue Watching", "Apps", etc.) and the hero placeholder. Arrow keys + H + Esc navigate. The user can quit the app (Cmd/Ctrl+Q or Esc-out via a deliberate exit affordance) and return to the GNOME desktop. **This is the Stage 1 success state.**

### Phase E — Electron app (`app/`)

**`app/package.json`** (no TypeScript anywhere):
```json
{
  "name": "trailcurrent-playbill",
  "version": "0.1.0",
  "main": "main/main.js",
  "scripts": {
    "build:renderer": "babel renderer/components --out-dir build/components --presets=@babel/preset-react",
    "build": "npm run build:renderer",
    "start": "npm run build && electron .",
    "dist": "npm run build && electron-builder --linux deb --arm64 --config electron-builder.config.js"
  }
}
```
Dependencies kept deliberately minimal: `electron`, `@babel/core`, `@babel/preset-react`, `@babel/cli`. **No** `typescript`, `ts-node`, `@types/*`, or any TS-typed tooling.

**`app/main/main.js`** key behavior:
- `app.commandLine.appendSwitch('ozone-platform', 'wayland')` (Wayland-native).
- `app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations')`.
- Single `BrowserWindow` with `fullscreen: true`, `frame: false`, `backgroundColor` set from `nativeTheme.shouldUseDarkColors` (so there's no white flash on launch in dark mode and no black flash in light mode), `webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }`. **Not** `kiosk:true` — this is a normal app, the user can quit, minimize, switch workspaces, or Alt+Tab away.
- Subscribe to `nativeTheme.on('updated', ...)` and forward the current `shouldUseDarkColors` value to the renderer over IPC so the shell can flip `data-theme` live when the user toggles GNOME Settings → Appearance.
- Use `screen.getPrimaryDisplay().workAreaSize` to size to the actual connected panel ("native panel resolution, auto-detected").
- Standard quit affordance: Ctrl+Q quits, Esc on the home screen prompts to quit, the GNOME window controls remain accessible via the system menu.
- Load `renderer/index.html` (the prototype's `TV.html`, renamed).

**`app/renderer/`** — copy from the R&D prototype verbatim:
- `/media/dave/extstorage/TrailCurrent/RandD/trailcurrent-tv/tv/TV.html` → `index.html`. **Add a tiny inline script** that sets `document.documentElement.dataset.theme` from the IPC-supplied `shouldUseDarkColors` (or, as fallback, `window.matchMedia('(prefers-color-scheme: dark)')`), and listens for theme-change events.
- `/media/dave/extstorage/TrailCurrent/RandD/trailcurrent-tv/tv/tv.css` and `colors_and_type.css` → `styles/`. **Audit `tv.css` and replace any hardcoded dark hex values with the role tokens** (`var(--bg-primary)`, `var(--text-primary)`, `var(--role-surface)`, etc.) — the design system is already dual-themed in `colors_and_type.css`, but the shell-specific CSS may have been written assuming dark and needs a pass.
- `/media/dave/extstorage/TrailCurrent/RandD/trailcurrent-tv/tv/data.js` → `data.js` (then **edit to empty out arrays** — keep titles like "Continue Watching", "Apps", "Trails Nearby" but with `[]` content lists, so the shell renders with empty rows / "no items" placeholders. This is the "full TV shell with empty data" behavior.)
- `/media/dave/extstorage/TrailCurrent/RandD/trailcurrent-tv/tv/components/*.jsx` → `components/` verbatim.

**`app/packaging/trailcurrent-playbill.desktop`:**
```
[Desktop Entry]
Name=TrailCurrent Playbill
Comment=In-rig entertainment center
Exec=/opt/TrailCurrent Playbill/trailcurrent-playbill %U
Icon=trailcurrent-playbill
Terminal=false
Type=Application
Categories=AudioVideo;Player;TV;
StartupWMClass=trailcurrent-playbill
```

The renderer keeps the existing in-browser Babel transform from `TV.html` for Stage 1 (Babel CDN script tag) — no bundler yet. Stage 2 swaps to a pre-built bundle.

### Phase F — Kernel-update survivability strategy

Documented in `docs/KERNEL_UPDATE_POLICY.md`. Summary:

1. **Hold the kernel.** `linux-image-*`, `linux-headers-*`, `linux-modules-*` get Pin-Priority `-1` in `/etc/apt/preferences.d/50-trailcurrent-playbill-holds.pref`. Apt cannot silently upgrade them — not via `apt upgrade`, not via `unattended-upgrades`. This is the single biggest fix for the "kernel update broke GPU/WiFi" pain point.
2. **Hold Mesa userspace.** `mesa-*`, `libdrm*`, `libgbm1`, `libegl1`, `libgl1-mesa-dri` pinned. GPU userspace upgrades have historically broken Adreno on Q6A.
3. **Hold `linux-firmware`.** ath11k WiFi firmware lives here; firmware regressions are real. Pin to a vetted version, bump explicitly when validated.
4. **Allow everything else.** Standard `unattended-upgrades` runs and pulls userspace security updates (openssl, glibc, gnome, browser, etc.) — these don't break GPU/WiFi.
5. **Kernel updates only via explicit operator action.** When a new kernel is validated, an admin runs `apt-mark unhold linux-image-*` and `apt full-upgrade`. Headwaters has a `deployment-watcher` OTA pattern we can borrow in a later stage if we want hands-off kernel rollouts; for Stage 1 this is manual.

### Phase G — Verification (end-to-end)

Burn the image and walk this checklist on real hardware:

1. `flash.sh --firmware` (one-time SPI NOR firmware) → `flash.sh --os <image>`.
2. Power on. **Expected:** no boot menu (embloader patch); Plymouth splash with TrailCurrent Playbill logo within ~5s.
3. Within ~30s: GDM login screen with TrailCurrent wallpaper + logo, on the panel's native resolution.
4. Log in as `trailcurrent`. GNOME desktop appears, themed.
5. **WiFi:** click the GNOME network indicator → pick SSID → enter PSK → connection succeeds.
6. **Audio:** GNOME Settings → Sound → confirm the analog 3.5mm headphone jack appears as the active output. Plug in headphones / line-in to the rig amp, click "Test" on each channel, confirm sound. `wpctl status` from a terminal should show the analog sink as default. `aplay -l` should list the QCS6490 sound card.
7. Verify the apt-hold policy:
   - `apt-mark showhold` → lists `linux-image-*`, `mesa-*`, `libdrm*`, `libgbm1`, `linux-firmware`.
   - `systemctl is-enabled unattended-upgrades` → `enabled` (standard desktop config).
   - `unattended-upgrade --dry-run --debug` → confirm the held packages are skipped while userspace security packages are queued.
8. Open the Activities overview → search "TrailCurrent Playbill" → click. Electron opens fullscreen, full TV shell visible: top bar with brand logo, side nav rail, home screen with empty rows ("Continue Watching", "Apps", etc.) and the hero placeholder. Arrow keys + H + Esc navigate. **Stage 1 success state.**
9. **Color-scheme test:** GNOME Settings → Appearance → Style → toggle Default / Dark. Confirm:
   - The desktop wallpaper swaps between the light and dark brand variants.
   - GTK chrome (Settings, Files, Terminal) follows.
   - Playbill (relaunch if needed) renders the matching theme — light surfaces / light text on dark in dark mode, light surfaces / dark text on light in light mode. Brand green focus rings, glows, and accent colors look correct in both. No hardcoded-dark areas peeking through.
9a. **PWA-fidelity test:** open Settings, Files (Nautilus), and Terminal side-by-side with the Farwatch PWA running in Firefox. Confirm:
   - Buttons in Settings use forest-green `#52A441` for the suggested-action class with the green hover glow, 8-12px radius — matching `.btn-primary` and `.login-btn` in Farwatch.
   - Switch widgets in Settings are pill-shaped, 60×32px-ish, fill brand green when on, with a white circular thumb that slides — matching the `.toggle-switch` from Farwatch.
   - Text inputs (in Files address bar, Terminal preferences) have a 12px radius and a brand-green focus ring with 3px halo — matching `.form-input:focus` in Farwatch.
   - Cards/list rows in Settings have 16px radius, 1px subtle border, and lift-on-hover behavior — matching `.card` in Farwatch.
   - Default Adwaita (white pill buttons, harsh blue accent, sharp corners on entries) is **nowhere visible**.
10. Quit Playbill (Ctrl+Q). Land back on the GNOME desktop. Re-launch from the dock. Works again.
11. Reboot. WiFi reconnects automatically (NetworkManager remembers). GPU still works (GDM renders, Electron renders). Audio sink still defaults to the analog jack.
12. **GPU + WiFi survival smoke test:** unhold + upgrade just `linux-firmware`, reboot, confirm WiFi still works. Hold it again. This proves the pinning policy isolates the dangerous packages without freezing the whole system.

---

## Critical files to fork from Headwaters Q6A

These are the load-bearing files to fork — read them before modifying. Take only the bootloader / firmware / DT pieces; **leave the appliance scaffolding behind.**

- `/media/dave/extstorage/TrailCurrent/Product/TrailCurrentHeadwaters/RADXAQ6A/image/build.sh` — orchestrator (fork)
- `/media/dave/extstorage/TrailCurrent/Product/TrailCurrentHeadwaters/RADXAQ6A/image/rsdk/src/share/rsdk/build/rootfs.jsonnet` — hooks (heavily edit, see Phase C)
- `/media/dave/extstorage/TrailCurrent/Product/TrailCurrentHeadwaters/RADXAQ6A/image/embloader/patches/0001-headwaters-autoboot-on-timeout-zero.patch` — boot trap fix (mandatory)
- `/media/dave/extstorage/TrailCurrent/Product/TrailCurrentHeadwaters/RADXAQ6A/image/files/systemd/power-save-hw.service` — read for the **DO-NOT-UNBIND comment block**, then discard
- `/media/dave/extstorage/TrailCurrent/Product/TrailCurrentHeadwaters/RADXAQ6A/image/files/plymouth/` — Plymouth theme template
- `/media/dave/extstorage/TrailCurrent/Product/TrailCurrentHeadwaters/RADXAQ6A/README.md` — read the embloader/UART/GPU gotcha sections in full

R&D prototype to copy into `app/renderer/`:

- `/media/dave/extstorage/TrailCurrent/RandD/trailcurrent-tv/colors_and_type.css`
- `/media/dave/extstorage/TrailCurrent/RandD/trailcurrent-tv/tv/TV.html`
- `/media/dave/extstorage/TrailCurrent/RandD/trailcurrent-tv/tv/tv.css`
- `/media/dave/extstorage/TrailCurrent/RandD/trailcurrent-tv/tv/data.js`
- `/media/dave/extstorage/TrailCurrent/RandD/trailcurrent-tv/tv/components/` — all `.jsx` files

---

## Out of scope for Stage 1 (deferred)

- Headwaters NAS integration, CAN bus telemetry, camera feeds, OTA antenna tuner, external streaming app launchers — wired up in later stages.
- Replacing the in-browser Babel transform with a proper bundler.
- Bluetooth remote pairing UX inside the Playbill app (BT itself is enabled at the OS level; the in-app pairing flow comes later).
- Hands-off OTA kernel update pipeline (kernel updates are manual operator action in Stage 1).

---

## Display stack decision (locked)

**GNOME on Wayland (Mutter compositor, Ubuntu Noble's standard desktop)** is the chosen display stack. The earlier "Wayland + Cage" answer was inconsistent with the desktop framing the user later reinforced. Cage is a single-window kiosk compositor with no desktop, so it's incompatible with running GNOME Settings, Files, Terminal, NetworkManager applet, the GNOME audio panel, or the Appearance/Style light-dark toggle — all of which the rest of this plan depends on. Sway and X11/openbox were ruled out because they sit outside the GNOME ecosystem the rest of the plan inherits from (libadwaita, GDM, GTK4 system theme), and GNOME-on-X11 is deprecated in Noble. GNOME-on-Wayland is the only stack where the Farwatch-PWA-derived GTK4 theme drops in cleanly and recolors libadwaita system-wide. Playbill itself runs as a fullscreen Wayland window inside the GNOME session.
