# TrailCurrent Playbill — Branding Asset Prompts

Reproducibility doc for every ComfyUI-generated asset that ships in this project. Regenerate with these exact prompts and settings to get equivalent results; reject any output that drifts off-brand (purple/pink skies, vaporwave palettes, illustrated/cartoon style).

## Workflow settings (all wallpapers)

| Field | Value |
|---|---|
| Checkpoint | `realvisxlV50_v50LightningBakedvae.safetensors` |
| Steps | 7 |
| CFG | 1.8 |
| Sampler | euler |
| Scheduler | sgm_uniform |
| Denoise | 1.0 |
| Resolution | 1344×768 (~1 MP, SDXL-friendly; upscale to panel native at install time) |

`realvisxlV50` is the photoreal SDXL Lightning model per the global ComfyUI guidance. If output keeps drifting (illustrated, oversaturated, lens flares), drop CFG to 1.5 before changing models.

## Wallpapers (paired set — same scene, two times of day)

The intent is one Pacific Northwest redwood campsite with the same off-white travel trailer + fire pit + camp chairs by a still lake, rendered at evening blue hour for `--data-theme=dark` and at midday for `--data-theme=light`. A user toggling GNOME's Style preference should see the same scene at a different hour, not two different images.

The single best brand reference for what this scene should look like in real photography: `/media/dave/extstorage/TrailCurrent/Marketing/ClaudWebSite/src/images/hero/camping-exterior-02.webp`.

### `wallpaper-dark.png` (selected: seed `2349566239`, candidate 1 of 3)

**Positive:**
```
Pacific Northwest campsite by a still lake at evening blue hour, tall redwood and pine canopy,
off-white travel trailer RV parked under the trees, two empty camp chairs near a stone fire pit
with a low orange ember glow, warm amber light from the RV interior windows, mist on the lake
in middle distance, dirt path in warm brown earth tones, deep forest green canopy silhouettes,
cool slate blue sky upper third, photoreal real-camera photograph, natural lighting,
ultra wide composition, rule of thirds,
no people, no text, no words, no letters, no watermark, no logo, no signature
```

**Negative:**
```
purple, magenta, pink, lavender, violet, mauve, alpenglow, aurora, aurora borealis,
northern lights, coral, salmon, vaporwave, synthwave, neon, glowing fog, cyberpunk,
urban, city, buildings, road signs, signage, text, words, letters, watermark, logo,
signature, people, person, human, face, oversaturated, HDR halo, lens flare,
painterly, illustration, drawing, cartoon, anime
```

### `wallpaper-light.png` (selected: candidate 1 of 3)

**Positive:**
```
same Pacific Northwest campsite at midday, off-white travel trailer RV under tall redwood
pine canopy, two empty camp chairs near a stone fire pit, soft natural daylight filtering
through the trees in shafts, clean pale blue sky, warm cream sunlit forest floor,
pine canopy in mid forest green, eucalyptus pale teal mist rising off the lake middle distance,
same camera angle as the evening shot, photoreal real-camera photograph,
ultra wide composition, rule of thirds,
no people, no text, no words, no letters, no watermark, no logo, no signature
```

**Negative:** same as `wallpaper-dark.png` plus `dark, night, sunset, sunrise, golden hour`.

## Off-brand block list (for ALL future TrailCurrent wallpaper generations)

These never appear in TrailCurrent imagery; always include them in the negative prompt:

```
purple, magenta, pink, lavender, violet, mauve, alpenglow, aurora, aurora borealis,
northern lights, coral, salmon, vaporwave, synthwave, neon, cyberpunk,
oversaturated, HDR halo, lens flare, painterly, illustration, drawing, cartoon, anime,
text, words, letters, watermark, logo, signature, people, person, human, face
```

## Selection workflow

1. Generate 3-6 candidates per wallpaper with different seeds (the selection script for this is `branding/_drafts/generate-wallpaper.py` — gitignored).
2. Inspect every candidate at full size; reject any with visible purple/pink in the sky regardless of how good the composition looks.
3. Pick the strongest pair (dark + light) where composition matches across both, so the GNOME Style toggle reads as a single scene at two times.
4. Save the picks at the canonical names (`wallpaper-dark.png`, `wallpaper-light.png`) — committed to the repo. Discard candidates.

## Plymouth + GDM background

`plymouth-background.png` and `gdm-background.png` are NOT ComfyUI-generated. They are derived from `wallpaper-dark.png` via ImageMagick:

```bash
# Plymouth: solid-ish dark with the wallpaper as a heavily darkened backdrop
convert wallpaper-dark.png -resize 1920x1080^ -gravity center -extent 1920x1080 \
  -modulate 35,50,100 -blur 0x6 plymouth-background.png

# GDM: blurred wallpaper for legibility behind the login form
convert wallpaper-dark.png -resize 1920x1080^ -gravity center -extent 1920x1080 \
  -blur 0x12 gdm-background.png
```

Always pass `-alpha remove -alpha off` if any source has transparency (per global guidance) before flattening into a Plymouth or GDM PNG.

## Logo

`playbill-logo.svg` is hand-authored, NOT generated. Source-of-truth lives in this repo. Rasterize for Plymouth via:

```bash
convert -background none -density 300 playbill-logo.svg -resize 512x512 playbill-logo.png
```
