# Netflix — one-time Widevine bootstrap

Playbill streams Netflix by launching Brave Browser in kiosk mode
(`brave-browser --kiosk --app=https://www.netflix.com`). Brave is
Chromium-based and supports the Widevine DRM Netflix requires, but
**Brave does not bundle the Widevine CDM** — it has to be downloaded
once, per profile, the first time the user opts in via a banner inside
Brave's UI.

That banner is **hidden by `--kiosk` mode** (no Brave chrome is visible),
so the kiosk can't bootstrap Widevine on its own. Doing it once
interactively, on the desktop, is the workaround.

After this one-time setup, the Widevine CDM is cached inside the kiosk's
user-data-dir at `~/.config/trailcurrent-playbill/sources/netflix/profile/`,
and every subsequent `netflix.start` plays DRM content without prompts.

## When to do this

- Once per device, immediately after first boot
- Again if the profile dir is wiped (e.g. an admin runs `rm -rf
  ~/.config/trailcurrent-playbill/sources/netflix/`)
- Not after image updates — the profile dir survives apt upgrades

## Steps

> [!IMPORTANT]
> The browser must run on the **Playbill board**, not on your dev box.
> Brave is only installed on the board (the image ships it via apt hook
> 3a), and the profile dir path is on the board's filesystem. You'll
> physically interact with the board's keyboard + mouse to click "Install
> Widevine" — that's the whole point of doing this once.

### Option A — Local (at the Playbill board)

Sit at the board, open a Terminal in the GNOME session, and run:

```bash
brave-browser \
  --user-data-dir="$HOME/.config/trailcurrent-playbill/sources/netflix/profile" \
  --password-store=basic \
  https://www.netflix.com
```

Brave opens with full chrome (address bar, tabs, etc.).

### Option B — Remote-spawn from your dev box

Kick the browser off via SSH, with the window appearing on the board's
display (you still walk over to click the info-bar):

```bash
ssh trailcurrent@playbill.local \
  'WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000 \
   nohup brave-browser \
     --user-data-dir="$HOME/.config/trailcurrent-playbill/sources/netflix/profile" \
     --password-store=basic \
     https://www.netflix.com >/dev/null 2>&1 &'
```

The Brave window appears on the board's physical display.

### Then, from either option above:

1. **Sign in to Netflix** with your account (if you haven't already in
   a prior kiosk session). The login cookie persists in the profile dir,
   so the kiosk will already be signed in next time.

2. Click any title and press Play. Netflix shows
   "Pardon the interruption — your browser does not support our video
   player." Above Netflix's page Brave shows an info-bar that says
   roughly: **"Brave needs additional software to play this video.
   [Install Widevine]"**.

3. Click **Install Widevine**. Brave downloads the CDM (~5 MB) in the
   background; the info-bar updates to "Installing…" then disappears
   when done. Takes about 30 seconds on a normal home connection.

4. **Refresh the Netflix page** (Ctrl+R). Click Play again. The video
   should now start. Confirm at least one title plays for a few seconds.

5. Close Brave. The CDM is now cached in the profile dir.

6. From any machine that can reach the Playbill IPC socket, kick off the
   kiosk to confirm:

   ```bash
   ssh trailcurrent@playbill.local 'node -e "
   const net = require(\"net\");
   const s = net.createConnection(\"/run/user/1000/playbill-controller.sock\");
   s.on(\"data\", (c) => { console.log(c.toString().trim()); s.end(); });
   s.on(\"connect\", () => s.write(JSON.stringify({kind:\"command\", id:1, cmd:{action:\"netflix.start\"}})+\"\\n\"));
   "'
   ```

   Brave should fullscreen onto Netflix and Play should work immediately
   with no info-bar, no Widevine prompt.

## Why not just bundle the CDM in the image?

Two reasons:

1. Widevine's license terms forbid redistributing the CDM blob outside
   of Google's component-updater channel. Bundling it in an apt repo or
   shipping it inside the Playbill image would be a TOS violation. Brave
   downloads it from Google's CDN directly at user request, which is the
   sanctioned path.

2. The CDM updates on its own schedule. A bundled snapshot would go
   stale and Netflix would eventually refuse the older version. Brave's
   component updater keeps the CDM fresh transparently.

If a future Brave release ships a CLI flag to auto-accept the Widevine
download (or if we swap to Microsoft Edge, which **does** bundle Widevine
in its ARM64 .deb), this bootstrap step disappears. As of May 2026 it's
still required.

## Troubleshooting

**The "Install Widevine" info-bar never appears.**
You may have already dismissed it once in this profile. Trigger it again
by visiting `brave://settings/extensions` and turning on
"Widevine" — Brave's component updater will start the download
immediately. Or visit `brave://components`, find "Widevine Content
Decryption Module," and click "Check for update."

**Netflix plays in the bootstrap browser but the kiosk still shows
"Pardon the interruption."**
The kiosk is using a different profile dir. Confirm the bootstrap was
launched with the exact `--user-data-dir=` path above, and that the
kiosk's `controller/src/sources/netflix/browser.js` `PROFILE_DIR` matches.
