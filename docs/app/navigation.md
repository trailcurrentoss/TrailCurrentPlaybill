# Remote Navigation — The Contract

This is the single source of truth for how the user navigates Playbill with
a remote, a keyboard, or the PWA virtual remote. Every screen — current and
future — must conform. Adding a new sub-page is a matter of tagging DOM
nodes with `data-zone-*` attributes; no per-screen keyboard handlers.

If you find yourself writing screen-specific arrow-key logic, stop. The
problem is almost always solvable with zones.

---

## The vocabulary (eight keys)

Modeled on the [Argon IR Remote](https://argon40.com/products/argon-remote)
and the Roku remote convention.

| Key | Always means | Never means |
|---|---|---|
| **Up / Down / Left / Right** | Move focus spatially within the current view | Hierarchy escape (that's Back's job) |
| **OK** (center of D-pad) | Activate the focused element (click button / submit form / play item) | Drill into a hidden menu |
| **Back** (↩) | Go to the previous screen (historical) | Move focus |
| **Home** (⌂) | Go to the home screen | — |
| **Vol +/−** | System volume control (forwarded to PipeWire) | — |
| **Power** | System power (handled at the case / kernel level) | — |
| **Menu** (≡) | Reserved for future contextual options (Roku-Star pattern) — currently a no-op | "Open the side nav" |

The d-pad has **one rule, applied everywhere**:

> Up/Down/Left/Right move focus spatially. At the edge of a zone, the move
> escapes to the parent zone in that direction.

Hierarchy lives on **Back**, never on a direction key.

---

## Spatial layout discipline

Inside any screen, **parents are laid out to the left of children** and
**siblings stack top-to-bottom**. Then Left-arrow naturally moves toward
the parent — not because Left has a special meaning, but because that's
where the parent is positioned.

If you find yourself wanting "Left = drill out" semantics, fix the layout
instead. The d-pad stays purely spatial.

---

## The zone tree

Every focusable area on a screen is a **zone**. Zones nest. Each zone has:

- an **axis**: `vertical`, `horizontal`, or `grid` (controls which arrow
  keys move focus within it)
- a **parent zone** (implicit via DOM nesting)
- a **last-focused child** (remembered so re-entering the zone restores
  position, like a browser tab)

The full Playbill zone tree, screen by screen:

```
ROOT (axis: horizontal)
├── SideNav                          (axis: vertical)
└── Screen
    ├── Home                         (axis: vertical, stacked card rows)
    │   ├── Hero                     (axis: horizontal)
    │   ├── Continue Watching        (axis: horizontal)
    │   ├── Your Apps                (axis: horizontal)
    │   └── …                        (axis: horizontal)
    ├── Apps                         (axis: grid)
    ├── Live                         (axis: vertical channel list)
    ├── Radio                        (axis: vertical)
    │   ├── Band-row                 (axis: horizontal)
    │   ├── Dial / ZIP entry         (leaf)
    │   ├── Scan results             (axis: grid)
    │   └── Presets                  (axis: horizontal)
    ├── Local Library                (axis: vertical)
    │   ├── Filter row               (axis: horizontal)
    │   └── Poster grid              (axis: grid)
    ├── Rig                          (axis: horizontal)
    │   ├── Cameras                  (axis: grid)
    │   └── Info panel               (axis: vertical)
    ├── Explore                      (bespoke d-pad mode — see special-case section)
    │   └── Map canvas               (leaf — captures all arrows + OK locally)
    ├── YouTube                      (axis: vertical)
    │   ├── Search bar               (axis: horizontal)
    │   └── Results                  (axis: vertical or grid)
    ├── Settings                     (axis: horizontal)
    │   ├── Tab strip                (axis: vertical)
    │   └── Tab content              (axis: vertical, stacked sections)
    │       ├── Section A            (axis: vertical)
    │       └── Section B            (axis: vertical)
    ├── Cast                         (leaf — receiver card, Back to exit)
    ├── DVD prompt (modal)           (focus trapped — Back dismisses)
    └── Video player (fullscreen)    (d-pad does media: vol/seek, OK pauses)
```

---

## How to mark up a screen

Tag the screen root with `data-zone-root`. Tag every region with
`data-zone` (a human-readable name) and `data-zone-axis`. Focusable
leaves (`<button>`, `<input>`, `<textarea>`, anything with `tabindex`)
don't need any attributes — the zone engine finds them automatically.

Example — Settings:

```jsx
<div data-zone-root data-zone="settings" data-zone-axis="horizontal">
  <div data-zone="settings.tabs" data-zone-axis="vertical">
    <button data-tab="headwaters">Headwaters</button>
    <button data-tab="device">Device</button>
  </div>
  <div data-zone="settings.content" data-zone-axis="vertical">
    <section data-zone="settings.content.broker" data-zone-axis="vertical">
      <input ... />
      <button>Save</button>
    </section>
    <section data-zone="settings.content.apikey" data-zone-axis="vertical">
      <input ... />
      <button>Save</button>
    </section>
  </div>
</div>
```

Adding a third tab (e.g. "Bearing") is then:
1. Add the button to `settings.tabs`.
2. Add a new `<section data-zone="settings.content.bearing" data-zone-axis="vertical">` to `settings.content`.

That's it. No keyboard code to touch.

### Optional attributes

- `data-zone-default` — on a focusable element to mark the preferred
  landing target when a zone is entered with no remembered position.
- `data-tab-active="true"` — for tab-strip patterns, marks the currently
  selected tab so other code can find it.

---

## Special-case rules

These are the only deviations from the universal rule. Keep this list
short — every entry is a tax.

### Text fields and the remote

The d-pad keys cooperate with the input caret rather than fighting it.
Rules (applied by `focus-zones.js handleKeydown`):

- **ArrowUp / ArrowDown**: **always escape the field.** Single-line
  `<input>` has no meaningful vertical motion; in a `<textarea>` we
  defer to native cursor movement until the caret can't move further
  in that direction, then we escape.
- **ArrowLeft**: cursor passthrough until the caret is at position 0,
  then escape. ArrowLeft at the start of a leftmost-zone input falls
  through to app.jsx's "left at root → open SideNav" fallback, matching
  the rest of the contract.
- **ArrowRight**: cursor passthrough until the caret is at the end,
  then escape.
- **Enter** in a single-line `<input>`: submits the form if one is
  present, otherwise clicks the input (zone-engine `activate()`).
- **Enter** in a `<textarea>`: inserts a newline. The contract has no
  way to "submit" a textarea via d-pad; provide a Submit button.
- **Escape**: blurs the input. The blurred state is then picked up by
  the central handler the next dispatch and routed as Back per the
  global contract.

> **What we tried and discarded:** an earlier draft of the contract
> proposed distinguishing "real keyboard" from "remote" via `e.isTrusted`.
> This does not work. IR-remote keys reach the renderer through the
> kernel input layer (`gpio-ir-receiver` → evdev → libinput → Wayland →
> DOM), so they arrive with `isTrusted === true`, indistinguishable from
> a USB keyboard. The caret-position policy above is independent of the
> event source and works for both.

### Modal overlays (DVD prompt, future dialogs)

When a modal opens, it becomes the entire focus tree — d-pad keys move
within it only. **Back** dismisses the modal (or rejects, depending on
context). Other zones are unreachable until the modal closes.

Mark a modal root with `data-zone-modal` in addition to `data-zone-root`.

### Fullscreen video player

The d-pad changes meaning:

- Up / Down → Volume
- Left / Right → Seek ±10 s
- OK → Toggle play/pause
- Back → Stop playback, return to referring screen

This is the Roku convention. Implement it at the player view, not in the
zone engine.

### Explore (map)

The map canvas captures all directional input locally, the same way the
fullscreen video player does. The toolbar buttons (Recenter / Zoom + / −)
on the map are mouse-only — they are NOT in the zone path, so an arrow
press never wanders into them.

- Up / Down / Left / Right → Pan map
- OK → Cycle through zoom presets (overview → regional → street → loop)
- Back → Exit to Home (handled globally by app.jsx, unchanged)
- `+` / `=` / `-` / `_` → Zoom by one level (keyboard convenience)
- `r` / `R` → Recenter on the rig's GPS fix (keyboard convenience)

Implemented in `app/renderer/components/explore.jsx` with a native
`keydown` listener bound to the canvas DOM node (NOT a window listener).
`e.stopPropagation()` keeps the event from bubbling to the central
handler, so arrows on the map never escape to the side nav.

---

## Global keys (override all zones)

These ALWAYS work, regardless of focus, screen, or modal state:

| Key | Action |
|---|---|
| **Home** (`h` / `H` / `KEY_HOMEPAGE`)         | `goHome()` — reset to home screen, focus top-left card |
| **Back**  (`Escape` / `Backspace` / `KEY_ESC`) | `goBack()` — exit current screen to parent (Settings/YouTube/Cast → Apps; rest → Home; modal → close modal) |

`Escape` and `Backspace` are **identical**. The Argon remote's Back button
arrives as `KEY_ESC` via the IR keymap; a USB keyboard's `Backspace` does
the same. Inside `<input>`/`<textarea>` `Backspace` keeps its normal
delete-a-character meaning — the handler skips Back when a text field has
focus.

They're handled in `app/renderer/components/app.jsx` before the zone
engine sees the event.

> **Rule of thumb for new screens:** if you find yourself adding *any*
> `onKeyDown` / `window.addEventListener('keydown', …)` in a screen file,
> you've left the contract. Stop, mark the regions with `data-zone*`, and
> let the central handler in app.jsx do its job. The single exception
> is the fullscreen video player, which redefines the d-pad as media
> transport (see the special-case section above).

---

## SideNav

The SideNav is the leftmost zone of every screen. It is **always rendered**
(narrow icon-only by default, ~96 px; expanded with labels when focused,
~260 px). There is no "popout" gesture — it's just spatially there.

You reach it by pressing Left from the leftmost zone of any screen. You
leave it by pressing Right or by activating one of its items with OK.

The Menu (≡) key does **not** open the SideNav. The SideNav has no
shortcut button — it's reached spatially, by Left, like any other zone.

---

## Hardware: physical and virtual remote

Reference remote: the 11-button IR remote bundled with the Playbill rig
(visually similar to the Argon ONE remote but emits a **different NEC
scancode set** — see table below). Scancodes captured directly from the
physical remote on 2026-05-13 against the Q6A's gpio-ir-receiver:

| Remote button | NEC scancode | Linux keycode (toml) | Playbill action |
|---|---|---|---|
| Power     | `0x9c` | `KEY_PROG1`         | Launch Playbill (via GNOME XF86Launch1 keybinding — does NOT poweroff) |
| ▲ Up      | `0xca` | `KEY_UP`            | Move focus up |
| ▼ Down    | `0xd2` | `KEY_DOWN`          | Move focus down |
| ◀ Left    | `0x99` | `KEY_LEFT`          | Move focus left (or open SideNav from leftmost zone) |
| ▶ Right   | `0xc1` | `KEY_RIGHT`         | Move focus right |
| OK        | `0xce` | `KEY_ENTER`         | Activate focused element |
| ↩ Back    | `0x90` | `KEY_ESC`           | Go back / dismiss modal |
| ⌂ Home    | `0xcb` | `KEY_HOMEPAGE`      | Go to home screen |
| ≡ Menu    | `0x9d` | `KEY_CONTEXT_MENU`  | (reserved — currently no-op) |
| Vol +     | `0x80` | `KEY_VOLUMEUP`      | System volume up (PipeWire) |
| Vol −     | `0x81` | `KEY_VOLUMEDOWN`    | System volume down (PipeWire) |

The Argon decoder script at `download.argon40.com/scripts/argonone-irdecoder-libgpiod.py`
publishes a different scancode set; only Vol − (0x81) overlaps with this
remote by coincidence. If the bundled remote ever changes model, recapture
with `sudo ir-keytable -t -p nec` (press each button), then update both
[image/files/rc_keymaps/playbill.toml](../../image/files/rc_keymaps/playbill.toml)
and this table, and hot-reload with `sudo udevadm trigger
--action=add --subsystem-match=rc` (the project's
`60-playbill-ir-keymap.rules` re-applies on rc-core add events).

### IR receiver: VS1838B on Q6A header PIN_15 (gpio1)

We do not consume a USB port for IR.

- VS1838B (KY-022 module) — 3 pins: `+` (3.3V), `−` (GND), `S` (signal)
- Wiring: Q6A PIN_1 (3.3V), PIN_9 (GND), PIN_15 (gpio1). The three pins all
  sit in the LEFT (odd) column of the header.
- **Do NOT use PIN_3** — the Q6A's pre-kernel firmware probes I2C7 for
  HAT-EEPROM and hangs the boot when a non-I2C device sits on SDA; the DT
  `exclusive` claim is too late to fix it.
- **Do NOT use PIN_5 either** — empirically the IR receiver works on PIN_5
  but with a "few presses then decoder stops" reliability pattern. PIN_5's
  primary TLMM function is I2C7_SCL and the muxed-out pad state interacts
  poorly with bias settings; `bias-pull-up` made it worse, not better.
  Moved to PIN_15 / gpio1 (a pad whose primary alt-function is plain GPIO
  with no I2C / UART / SPI side-effects) on 2026-05-14.
- Overlay: [image/overlays/qcs6490-radxa-dragon-q6a-playbill-ir-recv.dts](../../image/overlays/qcs6490-radxa-dragon-q6a-playbill-ir-recv.dts)
  binds `gpio-ir-receiver` to `&tlmm 1 GPIO_ACTIVE_LOW` and declares the
  node as a `wakeup-source` (required on Qualcomm SoCs so runtime PM
  doesn't suspend the IRQ at idle).
- Keymap: [image/files/rc_keymaps/playbill.toml](../../image/files/rc_keymaps/playbill.toml) (scancodes above).
- Auto-load: [image/files/udev/60-playbill-ir-keymap.rules](../../image/files/udev/60-playbill-ir-keymap.rules)
  runs `ir-keytable -s $name -c -p nec -w /etc/rc_keymaps/playbill.toml`
  on every rc-core add event. Required because Ubuntu Noble's
  `ir-keytable` deb does **not** ship its own
  `/lib/udev/rules.d/60-ir-keytable.rules` — without our rule the kernel
  boots with `rc-empty` + LIRC-only and every press is silently dropped.

The keycodes arrive in the renderer as standard `KeyboardEvent`s — no
special remote codepath. The controller's `nav.dpad` action is only
used by the PWA virtual remote and CAN-bus button MCUs that don't go
through evdev.

### Virtual remote (PWA)

The virtual remote on a paired phone delivers the same eight-key
vocabulary via the controller's `nav.dpad` action over MQTT. The PWA
UI **must match the Argon Remote layout** — D-pad ring with center OK,
Menu/Home/Back row, Volume +/−, Power. Keep one mental model.

The PWA also has the soft-keyboard `nav.text` channel for text entry,
since the remote has no number/letter keys.

---

## Adding a new screen — checklist

1. Lay out the DOM: parent zones on the left, children on the right.
   Stacked content top-to-bottom.
2. Tag the screen root: `data-zone-root data-zone="<name>" data-zone-axis="…"`.
3. Tag every region: `data-zone="<name>" data-zone-axis="…"`.
4. Make sure `<button>`s and `<input>`s are real focusable elements.
   No `<div onClick>`.
5. Add the screen to the side-nav router (`SIDE_IDS` in app.jsx) and
   `initialFocusFor()` if it should be reachable from the menu.
6. Add the screen's name to the auto-focus-on-entry effect in app.jsx so
   the first remote press after navigation lands inside the zone tree:
   ```js
   if (screen !== 'settings' && screen !== 'youtube' && screen !== 'rig'
        && screen !== 'explore' && screen !== '<your-new-screen>') return;
   ```
7. Test with: keyboard arrows, the GUI virtual remote, the physical
   Argon remote. All three must produce identical behavior. Specifically:
   - Pressing Left from the leftmost focusable element opens the SideNav.
   - Pressing Escape OR Backspace returns to the parent screen.
   - Pressing `H` returns home.

If a screen needs anything beyond zones — bespoke arrow logic, custom
selection state, etc. — that's a smell. Push back and reshape the
layout instead.

## What NOT to do (anti-patterns we keep regressing on)

- ❌ Don't add `window.addEventListener('keydown', …)` inside a screen
  component. The central handler in app.jsx already exists and already
  handles every key in the vocabulary. Duplicating it is the source of
  every "Back doesn't work" report we've ever filed.
- ❌ Don't extend the legacy `ROWS` schema in app.jsx for new screens.
  It's there for backward compatibility with pre-zone screens only.
  New screens use `data-zone-root` and inherit everything for free.
- ❌ Don't bind the Menu key (≡) to "open SideNav" or anything else.
  Reserved per the table above; binding it now would conflict with the
  future contextual-menu work.
- ❌ Don't bind Backspace differently from Escape. They're the same Back.
