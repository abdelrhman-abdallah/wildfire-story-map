# Homestead Valley StoryMap — Working Prototype

A minimal, no-build-step scroll-driven story map: a persistent MapLibre GL JS
map stays on screen while chapters scroll past it, changing the map's
camera, visible layers, and legend as you go — and docking itself to the
left or right of the text (or hiding entirely for text-only chapters), the
same way ArcGIS StoryMaps' "sidecar" blocks behave. This version is
hand-built so it's fully inspectable/editable as plain HTML/CSS/JS, using
MapLibre GL JS (open source, no API key/account) instead of Mapbox.

**Everything in here is placeholder content** — the point is to prove out
the mechanics (hero/title screen, text chapters, photo embeds, video
embeds, sidecar map layers, legend, theme, footer) before wiring in final
narrative copy, final graphics, and final GIS data.

## What's in this prototype

- `index.html` — page shell, loads MapLibre GL JS + Google Fonts from a CDN (no API key/account needed)
- `css/style.css` — theme variables, hero/cover styling, sidecar layout (map left/right/hidden), legend, footer
- `js/story.js` — all logic: loads `data/chapters.json`, renders the hero + chapters, drives the map, legend, theme, and footer
- `data/chapters.json` — **the only file you need to touch to change content.** Plain JSON, no JavaScript knowledge needed.
- `data/dummy-csa14-boundary.geojson` — placeholder shape standing in for the real Marin County CSA 14 (Homestead Valley) boundary
- `data/csa14-boundary.geojson` — the real CSA 14 boundary, already converted from the County's shapefile and sitting ready — not wired into the map yet on purpose (see "Swapping in the real CSA 14 boundary" below)
- `data/sample-risk-zone.geojson` — dummy polygons (two risk categories) standing in for a real hazard/vegetation overlay
- `data/sample-points.geojson` — dummy points standing in for real waypoints (e.g. evacuation route, chimney/ridge markers)
- `media/` — all client-supplied photos/video, served locally so paths work both here and on GitHub Pages

## Editing content — `data/chapters.json`

Everything editorial lives in this one JSON file: global settings, theme
colors/fonts, chapter order, titles, body text, images, video URLs, map
camera position per chapter, which map layers are visible in each chapter
and which side the map sits on, the legend labels/colors, and the footer.
Add a new chapter by copying an existing object in the `"chapters"` array —
no code changes needed.

### Global `"settings"` block

```json
"settings": {
  "pauseVideoOffscreen": true,
  "legendPosition": "right"
}
```

- **`pauseVideoOffscreen`** — `true`/`false`. When `true`, any playing
  video (local `.mov`/`.mp4` or YouTube embed) automatically pauses the
  moment its chapter scrolls fully out of view (above or below the
  viewport). Set to `false` to let videos keep playing in the background
  while scrolling past.
- **`legendPosition`** — `"left"` or `"right"` — which bottom corner the
  legend box sits in.

### `"theme"` block — colors and fonts

```json
"theme": {
  "colors": {
    "primary": "#c0392b",
    "secondary": "#e67e22",
    "accent": "#2c3e91",
    "dark": "#1c1c1c",
    "light": "#fdf6f0"
  },
  "fonts": {
    "heading": "'Poppins', 'Segoe UI', sans-serif",
    "body": "'Noto Serif', Georgia, serif"
  }
}
```

These are applied at runtime as CSS custom properties (`--color-primary`,
`--font-heading`, etc.), so changing a hex code or font name here updates
the whole site — dummy tags, icons, hero eyebrow text, footer, everything
— with no CSS edits required. If you swap in a font name other than
Poppins/Noto Serif, also update the Google Fonts `<link>` in `index.html`
to load it.

### Per-chapter `"mapPosition"` — the sidecar layout

```json
"mapPosition": "left" | "right" | "none"
```

This is the config knob for the exact behavior ArcGIS StoryMaps calls a
"sidecar": as a chapter scrolls into view, the single persistent map
either docks to the **left** of the text, docks to the **right** of the
text, or is **hidden entirely** (`"none"`) so the text renders full-width
and centered, like a plain narrative panel. There's only ever one MapLibre
instance on the page — this setting just moves/hides it with CSS as the
user scrolls, so transitions stay smooth and cheap.

### Per-chapter `"icon"`

```json
"icon": "flame" | "map-pin" | "home" | "tree" | "wind" | "shield"
```

Renders a small inline SVG icon (hand-drawn, no icon-library dependency)
next to the chapter heading, colored from the theme. Omit the field for no
icon. Add more icons by adding an entry to the `ICONS` object in
`js/story.js`.

### Per-chapter `"dummy"`

Set `"dummy": false` on a chapter once its text/photos are final — this
removes the orange "Dummy content" tag. Any chapter that omits this field,
or sets it to `true`, keeps showing the tag.

### The `"isTitleScreen"` hero chapter

The first chapter in the array is normally the hero/cover: a full-bleed
background image with a dark gradient overlay, a centered eyebrow/title/
lede, and an animated "scroll to begin" cue — the same convention ArcGIS
StoryMaps uses for its cover. Mark a chapter this way with
`"isTitleScreen": true` and give it an `"eyebrow"` field for the small
label above the title.

### `"footer"` block

```json
"footer": {
  "title": "Take the Next Step, Together",
  "text": "Closing paragraph...",
  "links": [{ "label": "Ember Ready sign-up", "url": "#" }],
  "credit": "Small print at the very bottom."
}
```

Renders as a full-width dark closing section after the last chapter, with
a title, paragraph, a row of pill-shaped links, and a small credit line.
Leave any field out to skip that part of the footer.

## Swapping in the real CSA 14 boundary

`data/csa14-boundary.geojson` already exists in this folder — a real
Marin County CSA 14 polygon converted from the County's own shapefile —
but the map currently loads `data/dummy-csa14-boundary.geojson` instead
(a rough placeholder outline), per an explicit choice to keep a simple
placeholder in place until the real layer is finalized/re-supplied. To
switch to the real data, open `js/story.js`, find the `map.addSource("csa14", ...)`
call, and change its `data` path from `"data/dummy-csa14-boundary.geojson"`
to `"data/csa14-boundary.geojson"`. Nothing else needs to change — the
fill/outline layers, per-chapter visibility toggling, and legend entry all
key off the same `"csa14"` source name either way.

## Viewing it

`data/chapters.json` and the `.geojson` files are loaded via `fetch()`,
which browsers block under `file://` (i.e. double-clicking `index.html`
directly won't work — the page will look empty). Serve the folder over
local HTTP instead, e.g. from this folder:

```
python -m http.server 8765
```

then open `http://localhost:8765/`.

## Interaction notes

- Mouse-wheel scrolling always scrolls the story/page (the map's own
  scroll-to-zoom is disabled) — no need to hover the browser scrollbar.
  You can still zoom the map with the +/- buttons (top-right) or by
  dragging/pinching.
- The legend only shows entries for layers that are visible in the current
  chapter, and the whole legend box hides itself when no layer in the
  current chapter is active (instead of showing an empty box).
- Video (local file or YouTube) auto-pauses once its chapter is fully
  scrolled out of view — see `pauseVideoOffscreen` above to turn this off.
- The map smoothly slides between left-docked, right-docked, and hidden
  as you scroll between chapters with different `mapPosition` values.

## Known placeholder caveats

- `.mov` playback support varies by browser/codec — this is standing in for wherever the client's final video ends up (self-hosted file or YouTube).
- The CSA 14 boundary layer is a hand-drawn placeholder shape, not the real County GIS geometry — see "Swapping in the real CSA 14 boundary" above.
- The risk-zone/points layers are dummy shapes with approximate coordinates, not real hazard data.

## Deploying to GitHub Pages — things that can go wrong

This prototype is 100% static (HTML/CSS/JS + JSON + GeoJSON + images/video),
so GitHub Pages works with zero build step — just push the `storymap-prototype`
folder contents to a repo and enable Pages on that branch/folder. Watch out for:

- **Repo file size limits.** GitHub blocks any single file over 100 MB by default (and warns starting at 50 MB). `media/HV_PANORAMIC_VIDEO_1.mov` (~58 MB) and a couple of the panoramic JPGs are worth checking — if any production file ends up over 100 MB, either compress/convert it or don't self-host it at all (upload to YouTube, unlisted if needed, and embed it the same way the Shorts video is embedded here).
- **Repo size soft cap.** GitHub recommends keeping repos under ~1 GB and will nag (not hard-block) past that. A photo/video-heavy StoryMap repo can creep up fast once all 48 production graphics + final video are added — worth checking total repo size before the final push, and considering Git LFS or external hosting (e.g. Cloudflare R2, YouTube for video) for the heaviest files if so.
- **Bandwidth soft limit.** GitHub Pages has a soft ~100 GB/month bandwidth guideline. Fine for a community-sized audience; would matter if the page went viral or got embedded/shared heavily elsewhere.
- **Build frequency soft limit.** ~10 Pages builds/hour soft cap — irrelevant here since there's no build step, but worth knowing if a build process (e.g. Jekyll) gets added later.
- **Case sensitivity.** GitHub Pages serves from Linux, which treats file paths as case-sensitive — unlike Windows. Double-check that the exact casing in `chapters.json` image/video paths matches the real filenames in `media/` byte-for-byte, or images that "work locally on Windows" can silently 404 once deployed.
- **Spaces in paths.** Filenames like `media/HV Panoramic.jpg` work fine as literal spaces in `chapters.json` — browsers and GitHub Pages both handle the un-encoded space transparently as long as it's used consistently.
- **Public visibility.** GitHub Pages sites are public by default on free/personal accounts (a private repo can still have a public Pages site unless you're on GitHub Enterprise) — worth confirming with the client whether the site should be publicly discoverable/indexable before launch, or whether it should go on a host with access control instead (e.g. Cloudflare Pages behind Cloudflare Access).
- **Custom domain HTTPS certs** can take up to 24 hours to provision the first time a custom domain is attached — plan any launch-day timing around that if the client wants their own domain rather than the default `github.io` URL.

None of these are blockers for this prototype's current size — they matter once the real 48 production graphics, real GIS layers, and final video are swapped in.

## Next steps (per the main project plan)

1. Replace remaining dummy chapter text in `data/chapters.json` with real narrative copy from the brief.
2. Replace remaining dummy images/video with final production assets.
3. Add the rest of the sections from the full content plan (8 sections + opening).
4. Deploy to GitHub Pages / Cloudflare Pages / Netlify (all free) once content is finalized.
