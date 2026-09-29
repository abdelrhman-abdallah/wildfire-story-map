// Minimal scroll-driven "sidecar" story map built directly on MapLibre GL JS.
// No build step, no API key, no account required. All chapter content, theme,
// icons, legend, and footer content live in data/chapters.json - this file
// only contains the logic that reads that JSON and drives the page/map.

// --- Global settings (overridden by data/chapters.json "settings") --------
const SETTINGS = {
  pauseVideoOffscreen: true, // pause video when its chapter scrolls fully out of view
  legendPosition: "left" // "left" | "right"
};

function applySettings(userSettings) {
  Object.assign(SETTINGS, userSettings || {});
}

// data/chapters.json "legend" block, kept module-level because two separate
// map instances render legends off it: the scroll-driven story legend
// (renderLegendShell) and the Block Explorer's own in-section legend
// (renderExplorerLegend), which is built lazily long after bootstrap().
let LEGEND_CONFIG = null;

// Tracks whichever chapter is currently active in the viewport - read by
// the map's "home" control to know what view to reset back to.
let currentChapterId = null;

// Shared reference to the single MapLibre instance + a readiness flag (true
// once its layers actually exist, after the "load" event's addLayer calls
// finish) - both the automatic per-chapter layer visibility in
// setupScrollTriggers() and the manual legend toggle clicks in
// renderLegendShell() drive the SAME map through setMapLayerVisibility()
// below, so a user's manual on/off click and the story's own scroll-driven
// state never fight each other via two different code paths.
let mapInstance = null;
let mapLayersReady = false;

// Maps each legend/chapters.json layer key to the real MapLibre layer id(s)
// it controls (homesteadHighlight is backed by a fill + line pair sharing
// one on/off state; the old sample "risk"/"points" dummy layers and the
// duplicate black-dashed "homesteadBoundary" treatment have been removed -
// see data/chapters.json legend config for the current real layers).
const LEGEND_LAYER_IDS = {
  marin: ["marin-line"],
  homesteadHighlight: ["homestead-highlight-fill", "homestead-highlight-line"],
  vegetation: ["vegetation-fill"],
  elevation: ["elevation-fill"],
  bivariate: ["bivariate-fill"],
  contours: ["contours-line-casing", "contours-line", "contours-label"],
  streets: [
    "streets-halo-main",
    "streets-halo-trail",
    "streets-line-main",
    "streets-line-trail"
  ]
};

// --- Shared contour / road line symbology -------------------------------
// Both the scroll-driven story map and the Explorer's second map instance
// draw the same contour and road layers, so the numbers live here once
// rather than being retyped (and drifting) in each addLayer() call.

// White casing drawn underneath each contour/road line so it reads cleanly
// over the vegetation and elevation fills, and so two lines crossing each
// other stay visually separable.
const LINE_HALO_COLOR = "#ffffff";
const LINE_HALO_OPACITY = 0.9;
const LINE_HALO_PAD = 1; // px the halo extends past each edge of the line

const CONTOUR_LINE_WIDTH = 1;

// Contours are generated at a 20 ft interval, so labels can only land on
// multiples of 20. 40 ft is the closest achievable step to the 30 ft asked
// for; drop this to 20 to label every single contour.
const CONTOUR_LABEL_INTERVAL_FT = 40;
const CONTOUR_LABEL_FILTER = [
  "==",
  ["%", ["get", "elev_ft"], CONTOUR_LABEL_INTERVAL_FT],
  0
];

// Through-streets and trails share one color and one width - the dot
// pattern is the only thing telling them apart.
const ROAD_COLOR = "#2b2f33";
const ROAD_LINE_WIDTH = 2;
const ROAD_LINE_OPACITY = 0.8;
const ROAD_HALO_WIDTH = ROAD_LINE_WIDTH + 2 * LINE_HALO_PAD;
const TRAIL_DASHARRAY = [0.1, 1.6];
// line-dasharray is measured in multiples of line-width, so the wider halo
// needs its own array scaled by the width ratio - otherwise its dots drift
// out of step with the dots they are supposed to sit behind.
const TRAIL_HALO_DASHARRAY = TRAIL_DASHARRAY.map(
  (n) => (n * ROAD_LINE_WIDTH) / ROAD_HALO_WIDTH
);

const ROAD_MAIN_FILTER = ["match", ["get", "highway"], ["tertiary", "residential"], true, false];
const ROAD_TRAIL_FILTER = ["match", ["get", "highway"], ["tertiary", "residential"], false, true];

// Adds the four road layers in one go: both halos first, then both lines,
// so a halo can never be painted over the line it belongs behind.
function addRoadLayers(map, ids) {
  const base = {
    type: "line",
    source: ids.source,
    layout: { visibility: "none", "line-cap": "round", "line-join": "round" }
  };

  map.addLayer({
    ...base,
    id: ids.haloMainId,
    filter: ids.mainFilter,
    paint: {
      "line-color": LINE_HALO_COLOR,
      "line-width": ROAD_HALO_WIDTH,
      "line-opacity": LINE_HALO_OPACITY
    }
  });
  map.addLayer({
    ...base,
    id: ids.haloTrailId,
    filter: ids.trailFilter,
    paint: {
      "line-color": LINE_HALO_COLOR,
      "line-width": ROAD_HALO_WIDTH,
      "line-opacity": LINE_HALO_OPACITY,
      "line-dasharray": TRAIL_HALO_DASHARRAY
    }
  });
  map.addLayer({
    ...base,
    id: ids.mainId,
    filter: ids.mainFilter,
    paint: {
      "line-color": ROAD_COLOR,
      "line-width": ROAD_LINE_WIDTH,
      "line-opacity": ROAD_LINE_OPACITY
    }
  });
  map.addLayer({
    ...base,
    id: ids.trailId,
    filter: ids.trailFilter,
    paint: {
      "line-color": ROAD_COLOR,
      "line-width": ROAD_LINE_WIDTH,
      "line-opacity": ROAD_LINE_OPACITY,
      "line-dasharray": TRAIL_DASHARRAY
    }
  });
}

function setMapLayerVisibility(layerKey, visible) {
  if (!mapInstance || !mapLayersReady) return;
  const ids = LEGEND_LAYER_IDS[layerKey] || [];
  ids.forEach((id) => mapInstance.setLayoutProperty(id, "visibility", visible ? "visible" : "none"));
}

// Homestead/CSA14 boundary paint states, keyed by whether the current
// chapter also shows the Marin County outline (chapter.layers.marin).
// Only "homestead-in-marin" is true - every other chapter showing the
// boundary uses the subtle black/transparent treatment instead.
const HOMESTEAD_BOUNDARY_STYLES = {
  marin: { fillColor: "#c0392b", fillOpacity: 0.55, lineColor: "#c0392b", lineWidth: 2.5 },
  default: { fillColor: "#000000", fillOpacity: 0.08, lineColor: "#000000", lineWidth: 2 },
  // Line-only (fill fully transparent) - used whenever a chapter stacks two
  // or more thematic layers (vegetation/elevation/contours/streets) on top
  // of the boundary, so it reads as a clean outline instead of a
  // translucent black wash muddying the colors underneath it. The boundary
  // LINE itself is also added last in initMap() (after every thematic
  // layer) so it's never visually buried regardless of fill state.
  lineOnly: { fillColor: "#000000", fillOpacity: 0, lineColor: "#000000", lineWidth: 2 }
};

function updateHomesteadBoundaryStyle(map, chapter) {
  if (!map || !mapLayersReady) return;

  const layers = (chapter && chapter.layers) || {};
  const stackedThematicCount = ["vegetation", "elevation", "bivariate", "contours", "streets"].filter(
    (key) => layers[key]
  ).length;

  // The bivariate layer forces lineOnly on its own, without needing a second
  // thematic layer stacked on it. Its whole point is that a reader can match
  // a fill against a 16-cell legend, and default's translucent black wash
  // would shift all 16 toward grey - most damagingly the light low/low corner,
  // which is already near-neutral by design.
  const style = layers.marin
    ? HOMESTEAD_BOUNDARY_STYLES.marin
    : stackedThematicCount >= 2 || layers.bivariate
      ? HOMESTEAD_BOUNDARY_STYLES.lineOnly
      : HOMESTEAD_BOUNDARY_STYLES.default;

  map.setPaintProperty("homestead-highlight-fill", "fill-color", style.fillColor);
  map.setPaintProperty("homestead-highlight-fill", "fill-opacity", style.fillOpacity);
  map.setPaintProperty("homestead-highlight-line", "line-color", style.lineColor);
  map.setPaintProperty("homestead-highlight-line", "line-width", style.lineWidth);

  // Keep the legend swatch honest - it should show whichever boundary
  // color is actually live on the map right now, not a fixed color baked
  // into chapters.json. It's a line-style swatch (see renderLegendShell()),
  // so the color goes on border-top, not background.
  const swatch = document.querySelector('.legend-section[data-layer="homesteadHighlight"] .legend-swatch');
  if (swatch) swatch.style.borderTopColor = style.lineColor;
}

// Vegetation/elevation use their own fixed green/hypsometric ramps
// (documented in the legend) at fairly high opacity - see the "vegetation"/
// "elevation-fill" addLayer calls in initMap(). One chapter needs those SAME
// two layers backed off:
//   - "reduced" (chapter.reducedOpacity: true) - the "Why Homestead Is
//     Different" chapter shows every layer together, backed off to <=50%
//     opacity so none of them visually competes with the others.
// Every other chapter keeps the original ramps/opacity untouched.
//
// There used to be a third mode here, "bivariate": the intervention chapter
// recolored these two layers to a red ramp and a blue ramp at 30% opacity
// each and let the translucent fills blend toward purple where they
// overlapped. That treatment is gone, replaced by the real bivariate layer
// below, because stacked transparency cannot deliver what a bivariate map
// is for. Two independent 4-class ramps composited at 30% produce a
// continuum of muddy colors, not 16 identifiable ones; the reader cannot
// invert a given purple back into a (fuel, elevation) pair; and no legend
// can honestly enumerate the result. It also could not have shown a 4-step
// elevation axis, since the hypsometric layer has 8 classes.
const VEGETATION_RAMP_NORMAL = [
  "match", ["get", "ndvi_class"],
  1, "#d9f0a3", 2, "#78c679", 3, "#31a354", 4, "#006837",
  "#cccccc"
];
const ELEVATION_RAMP_NORMAL = [
  "match", ["get", "elev_class"],
  1, "#F0F0F0", 2, "#D9D9D9", 3, "#BDBDBD", 4, "#969696",
  5, "#737373", 6, "#525252", 7, "#353535", 8, "#1A1A1A",
  "#cccccc"
];

// --- Bivariate fuel x elevation ------------------------------------------
// A TRUE bivariate choropleth: one layer, one polygon per contiguous joint
// class, each carrying a single integer `bv` that encodes both class values
// as bv = (veg_class - 1) * 4 + elev_class. That encoding is what lets the
// paint expression be one flat "match" on one attribute instead of a nested
// 4x4 decision tree, and it is asserted feature-by-feature by
// bivariate_work/04_qa_bivariate.py (check 1).
//
// Colors are the 4x4 matrix from bivariate_work/02_palette.py - bilinear in
// sRGB between four hand-picked corners (neutral / red = fuel / blue =
// elevation / dark plum = both), verified luminance-monotonic along every row
// and column so "more of either factor" always reads as darker. They are
// transcribed here from bivariate_palette.json's by_bv_code block, and the
// same values are baked into each feature's `fill_color` property in the
// GeoJSON, so a mismatch between this expression and the data is detectable
// rather than silent (04's check 2 re-derives the matrix from the corners
// independently and compares against the file).
const BIVARIATE_FILL_COLOR = [
  "match", ["get", "bv"],
  // veg 1 (Sparse)      elev 1 -> 4
  1, "#e4e2dd", 2, "#a8bccb", 3, "#6b95ba", 4, "#2f6fa8",
  // veg 2 (Moderate)
  5, "#d4a3a2", 6, "#a08a9b", 7, "#6c7194", 8, "#38588c",
  // veg 3 (Dense)
  9, "#c36367", 10, "#98586a", 11, "#6c4d6d", 12, "#414271",
  // veg 4 (Very dense)
  13, "#b3242c", 14, "#90263a", 15, "#6d2947", 16, "#4a2b55",
  "#cccccc"
];
// High enough that each fill stays close to its legend chip, low enough that
// Positron's street lines and place labels still read through it. The
// compositing shift is small BECAUSE Positron's land is near-white, the same
// surface the legend chips sit on - so the same 0.85 that keeps the map
// readable also keeps map and legend showing effectively the same color.
// This is the one place transparency is acceptable in a bivariate map: it is
// uniform across all 16 classes, so it cannot make two classes converge.
const BIVARIATE_FILL_OPACITY = 0.85;

// Pulls the plain hex colors back out of a ["match", ["get", field], class1,
// color1, class2, color2, ..., defaultColor] paint expression, in class order
// (skipping the trailing default fallback), and pushes them onto that
// layer's legend swatches - the same "keep the legend honest" idea used for
// the homestead boundary swatch above.
//
// These two functions existed to swap the vegetation/elevation swatches
// between their normal and (now removed) pseudo-bivariate ramps. With one
// ramp per layer they no longer switch anything, but they are kept because
// they make the MAP the single source of truth for those swatch colors: if
// the ramps above and the colors authored in chapters.json ever drift apart,
// the legend follows the map rather than quietly describing a color that
// isn't on screen. They are deliberately NOT used for the bivariate matrix,
// whose colors are checked against the data by 04_qa_bivariate.py instead.
function extractRampColors(rampExpression) {
  const colors = [];
  for (let i = 3; i < rampExpression.length - 1; i += 2) {
    colors.push(rampExpression[i]);
  }
  return colors;
}

function applyLegendSwatchColors(layerKey, colors) {
  const swatches = document.querySelectorAll(`.legend-section[data-layer="${layerKey}"] .legend-swatch`);
  swatches.forEach((swatch, i) => {
    if (colors[i]) swatch.style.background = colors[i];
  });
}

function updateThematicLayerStyle(map, chapter) {
  if (!map || !mapLayersReady) return;

  const mode = chapter && chapter.reducedOpacity ? "reduced" : "default";

  map.setPaintProperty("vegetation-fill", "fill-color", VEGETATION_RAMP_NORMAL);
  map.setPaintProperty("vegetation-fill", "fill-opacity", mode === "reduced" ? 0.5 : 0.6);
  applyLegendSwatchColors("vegetation", extractRampColors(VEGETATION_RAMP_NORMAL));

  map.setPaintProperty("elevation-fill", "fill-color", ELEVATION_RAMP_NORMAL);
  map.setPaintProperty("elevation-fill", "fill-opacity", mode === "reduced" ? 0.5 : 0.75);
  applyLegendSwatchColors("elevation", extractRampColors(ELEVATION_RAMP_NORMAL));

  // One fade factor for the whole road stack, so the white halos dim in step
  // with the lines they sit behind - fading only the lines would leave the
  // halos reading as solid white streaks on a "reduced" chapter.
  const roadFade = mode === "reduced" ? 0.7 : 1;
  ["streets-line-main", "streets-line-trail"].forEach((id) => {
    map.setPaintProperty(id, "line-opacity", ROAD_LINE_OPACITY * roadFade);
  });
  ["streets-halo-main", "streets-halo-trail"].forEach((id) => {
    map.setPaintProperty(id, "line-opacity", LINE_HALO_OPACITY * roadFade);
  });
}

// --- Wind arrows --------------------------------------------------------
// Schematic Diablo (offshore, NE->SW) and reverse (onshore, SW->NE) wind
// arrows. They're decorative annotations rather than a data layer, so they
// ride on MapLibre markers instead of going through
// LEGEND_LAYER_IDS/setMapLayerVisibility - but being markers (not a fixed
// HTML overlay) they stay pinned to the ground as the reader pans and
// zooms. All of them appear/disappear together on chapter.layers.wind.
const WIND_ARROWS_PER_SIDE = 4;

// How far to pull each arrow off the boundary toward the middle of the
// valley, as a fraction of the distance to the bbox center. Keeps the whole
// fan inside the frame a chapter's fitBounds() produces.
const WIND_ARROW_INSET = 0.12;

const windArrowElements = [];

function windArrowSvg(gradientId) {
  return `<svg viewBox="0 0 34 62" xmlns="http://www.w3.org/2000/svg">
    <linearGradient id="${gradientId}" x1="17" y1="1" x2="17" y2="55.5" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="currentColor" stop-opacity="1"/>
      <stop offset="0.45" stop-color="currentColor" stop-opacity="0.82"/>
      <stop offset="1" stop-color="currentColor" stop-opacity="0.22"/>
    </linearGradient>
    <path d="M17 1 L31.5 19.5 L21.5 19.5 C22.8 31 24.5 43 25.5 55.5 L8.5 55.5 C9.5 43 11.2 31 12.5 19.5 L2.5 19.5 Z"
          fill="url(#${gradientId})" stroke="rgba(255,255,255,0.9)" stroke-width="1.1" stroke-linejoin="round"/>
  </svg>`;
}

// Walks the two-segment run of the homestead bbox that faces into the wind
// (north edge then east edge for Diablo, south then west for the reverse)
// and spaces the arrows evenly along it, so each fan hugs the side of the
// boundary the wind actually arrives from.
function windFanPosition(bounds, upwind, along) {
  const [[west, south], [east, north]] = bounds;
  const spanLng = east - west;
  const spanLat = north - south;
  const firstLegShare = spanLng / (spanLng + spanLat);

  let lng;
  let lat;
  if (along < firstLegShare) {
    const t = along / firstLegShare;
    lng = upwind > 0 ? west + t * spanLng : east - t * spanLng;
    lat = upwind > 0 ? north : south;
  } else {
    const t = (along - firstLegShare) / (1 - firstLegShare);
    lng = upwind > 0 ? east : west;
    lat = upwind > 0 ? north - t * spanLat : south + t * spanLat;
  }

  return [
    lng + WIND_ARROW_INSET * (west + spanLng / 2 - lng),
    lat + WIND_ARROW_INSET * (south + spanLat / 2 - lat)
  ];
}

function buildWindArrows(map, bounds) {
  if (!bounds) return;

  [
    { side: "diablo", bearing: 225, upwind: 1 },
    { side: "reverse", bearing: 45, upwind: -1 }
  ].forEach(({ side, bearing, upwind }) => {
    for (let i = 0; i < WIND_ARROWS_PER_SIDE; i++) {
      const [lng, lat] = windFanPosition(bounds, upwind, (i + 0.5) / WIND_ARROWS_PER_SIDE);

      const el = document.createElement("div");
      el.className = `wind-arrow wind-arrow-${side}`;
      el.innerHTML = windArrowSvg(`wind-grad-${side}-${i}`);

      new maplibregl.Marker({
        element: el,
        rotation: bearing,
        rotationAlignment: "map",
        pitchAlignment: "map"
      })
        .setLngLat([lng, lat])
        .addTo(map);

      windArrowElements.push(el);
    }
  });
}

function updateWindIndicator(chapter) {
  const on = Boolean(chapter && chapter.layers && chapter.layers.wind);
  const key = document.getElementById("wind-indicator");
  if (key) key.classList.toggle("visible", on);
  windArrowElements.forEach((el) => el.classList.toggle("visible", on));
}

// --- Theme (colors + fonts) -----------------------------------------------
// Applied as CSS custom properties so css/style.css can reference
// var(--color-primary), var(--font-heading), etc. Falls back to whatever
// defaults are already declared on :root in style.css if chapters.json
// doesn't supply a theme block.
function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement;

  Object.entries(theme.colors || {}).forEach(([name, value]) => {
    root.style.setProperty(`--color-${name}`, value);
  });

  const fonts = theme.fonts || {};
  if (fonts.heading) root.style.setProperty("--font-heading", fonts.heading);
  if (fonts.body) root.style.setProperty("--font-body", fonts.body);
}

// --- Icons ------------------------------------------------------------
// Small hand-drawn inline SVGs (no icon-library dependency, no build step).
// Each draws in a 24x24 box and inherits color via currentColor, so it
// picks up whatever text color/theme color surrounds it in CSS.
const ICONS = {
  flame: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2c1 3-3 4-3 8a3 3 0 0 0 6 0c0-1-.5-2-1-2.5 1.5 1 3 3 3 5.5a5 5 0 0 1-10 0c0-4 2-5.5 3-8.5.4-1.2.7-2 2-2.5z" fill="currentColor"/>
  </svg>`,
  "map-pin": `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 22s7-7.2 7-12.5A7 7 0 0 0 5 9.5C5 14.8 12 22 12 22z" fill="currentColor"/>
    <circle cx="12" cy="9.5" r="2.6" fill="#fff"/>
  </svg>`,
  home: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 11.5 12 4l9 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M5.5 10v9a1 1 0 0 0 1 1H9v-5.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V20h2.5a1 1 0 0 0 1-1v-9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  tree: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2 7 9h2.5L6 15h4v6h4v-6h4l-3.5-6H17z" fill="currentColor"/>
  </svg>`,
  wind: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 8h11a2.5 2.5 0 1 0-2.2-3.7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M3 12h15a2.5 2.5 0 1 1-2.2 3.7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M3 16h9a2.5 2.5 0 1 1-2.2 3.7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5l-8-3z" fill="currentColor"/>
    <path d="M8.5 12.2 11 14.7l4.8-5.2" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  mountain: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 20 9 8l4 6 2-3 6 9H3z" fill="currentColor"/>
  </svg>`,
  layers: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 3 2 9l10 6 10-6-10-6z" fill="currentColor"/>
    <path d="M2 15l10 6 10-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  route: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 21 9 3h6l4 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M12 3v18" stroke="currentColor" stroke-width="2" stroke-dasharray="2 3" stroke-linecap="round"/>
  </svg>`,
  footprints: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="8" cy="7" rx="2.4" ry="3.2" fill="currentColor"/>
    <ellipse cx="16" cy="14" rx="2.4" ry="3.2" fill="currentColor"/>
    <circle cx="8" cy="12.2" r="1.1" fill="currentColor"/>
    <circle cx="16" cy="19.2" r="1.1" fill="currentColor"/>
  </svg>`
};

function renderIcon(name) {
  if (!name || !ICONS[name]) return "";
  return `<span class="icon icon-${name}" aria-hidden="true">${ICONS[name]}</span>`;
}

// --- YouTube URL parsing -----------------------------------------------
// Accepts any common YouTube URL shape (watch, youtu.be, shorts, embed)
// pasted straight from a browser address bar and returns just the video ID.
function parseYouTubeId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.slice(1);
    }
    if (u.pathname.startsWith("/shorts/")) {
      return u.pathname.split("/shorts/")[1];
    }
    if (u.pathname.startsWith("/embed/")) {
      return u.pathname.split("/embed/")[1];
    }
    if (u.searchParams.get("v")) {
      return u.searchParams.get("v");
    }
  } catch (e) {
    return null;
  }
  return null;
}

// --- Media (images/videos) -------------------------------------------------
// A chapter can carry one or more media items, each either an image or a
// video (local file and/or YouTube embed). The legacy single "image"/"video"
// chapter fields are normalized into that same array shape so both old and
// new chapters.json entries render through the one carousel implementation.
function normalizeMedia(chapter) {
  if (Array.isArray(chapter.media) && chapter.media.length) return chapter.media;

  const media = [];
  if (chapter.image) {
    media.push({ type: "image", ...chapter.image });
  }
  if (chapter.video) {
    if (chapter.video.localSrc) {
      media.push({
        type: "video",
        localSrc: chapter.video.localSrc,
        caption: "Local video embed (client-supplied file)"
      });
    }
    if (chapter.video.youtubeUrl) {
      media.push({
        type: "video",
        youtubeUrl: chapter.video.youtubeUrl,
        caption: "YouTube embed"
      });
    }
  }
  return media;
}

function renderMediaItemInner(item) {
  if (item.type === "video") {
    if (item.youtubeUrl) {
      const ytId = parseYouTubeId(item.youtubeUrl);
      if (!ytId) {
        return `<p><em>Could not parse a video ID from "${item.youtubeUrl}".</em></p>`;
      }
      return `
        <iframe
          class="yt-embed"
          src="https://www.youtube.com/embed/${ytId}?enablejsapi=1"
          title="YouTube video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen>
        </iframe>
      `;
    }
    if (item.localSrc) {
      return `
        <video controls preload="none">
          <source src="${item.localSrc}" type="video/quicktime" />
          Your browser may not support inline .mov playback - swap for an
          .mp4 if this doesn't play.
        </video>
      `;
    }
    return "";
  }
  return `<img src="${item.src}" alt="${item.alt || ""}" loading="lazy" />`;
}

// Builds a self-contained gallery: a sliding track of media items, plus
// prev/next arrows and dot indicators once there's more than one item. Used
// both inline (inside a chapter-content card) and in the full-bleed sidecar
// panel (see #media-sidecar / placeMediaForChapter()) - a chapter can send
// its media either place via
// "mediaPosition": "inline" | "left" | "right" | "full".

// --- Image fullscreen modal ------------------------------------------------
// One overlay, lazily built on first use and reused for every image on the
// page (inline carousels, the docked sidecar, wherever) - keeps this to a
// single DOM node/listener set instead of one modal per slide. Sidecar
// images are cropped with object-fit:cover to fill their panel; this modal
// renders the same <img> with object-fit:contain instead, so the reader can
// always see the whole photo at its real aspect ratio.
let imageModal = null;

function ensureImageModal() {
  if (imageModal) return imageModal;

  const modal = document.createElement("div");
  modal.id = "image-modal";
  modal.className = "image-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "Expanded image");

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "image-modal-close";
  closeBtn.setAttribute("aria-label", "Close expanded image");
  closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

  const figure = document.createElement("figure");
  figure.className = "image-modal-figure";

  const img = document.createElement("img");
  img.className = "image-modal-img";

  const caption = document.createElement("figcaption");
  caption.className = "image-modal-caption";

  figure.appendChild(img);
  figure.appendChild(caption);
  modal.appendChild(closeBtn);
  modal.appendChild(figure);
  document.body.appendChild(modal);

  const close = () => {
    modal.classList.remove("open");
    document.body.classList.remove("image-modal-open");
    // Drop the src once the close transition finishes so a lingering
    // large image doesn't sit decoded in memory between opens.
    window.setTimeout(() => {
      if (!modal.classList.contains("open")) img.src = "";
    }, 250);
  };

  // Click anywhere on the dark backdrop (i.e. not the image/caption/close
  // button themselves) closes it, same convention as most lightboxes.
  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target === figure) close();
  });
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("open")) close();
  });

  imageModal = { modal, img, caption, closeBtn, close };
  return imageModal;
}

function openImageModal(src, alt, captionText) {
  if (!src) return;
  const { modal, img, caption, closeBtn } = ensureImageModal();
  img.src = src;
  img.alt = alt || "";
  caption.textContent = captionText || "";
  caption.style.display = captionText ? "" : "none";
  modal.classList.add("open");
  document.body.classList.add("image-modal-open");
  closeBtn.focus();
}

function renderMediaCarousel(mediaItems) {
  const wrap = document.createElement("div");
  wrap.className = "media-carousel";
  if (!mediaItems.length) return wrap;

  const track = document.createElement("div");
  track.className = "media-carousel-track";

  mediaItems.forEach((item) => {
    const slide = document.createElement("figure");
    slide.className = "media-carousel-item";
    slide.innerHTML = `
      ${renderMediaItemInner(item)}
      ${item.caption ? `<figcaption>${item.caption}</figcaption>` : ""}
    `;

    // Fullscreen/expand only makes sense for images - videos (local <video
    // controls> or the YouTube iframe) already have their own native
    // fullscreen affordance. Reuses the same four-corner-bracket icon as
    // #map-fullscreen-btn so it reads as the same "expand" action.
    if (item.type !== "video") {
      const expandBtn = document.createElement("button");
      expandBtn.type = "button";
      expandBtn.className = "media-expand-btn";
      expandBtn.setAttribute("aria-label", "View expanded image");
      expandBtn.title = "Expand image";
      expandBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`;
      expandBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        openImageModal(item.src, item.alt, item.caption);
      });
      slide.appendChild(expandBtn);
    }

    track.appendChild(slide);
  });

  wrap.appendChild(track);

  if (mediaItems.length > 1) {
    const dotsWrap = document.createElement("div");
    dotsWrap.className = "media-carousel-dots";

    const dots = mediaItems.map((_, i) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "media-carousel-dot" + (i === 0 ? " active" : "");
      dot.setAttribute("aria-label", `Go to slide ${i + 1}`);
      dotsWrap.appendChild(dot);
      return dot;
    });

    let index = 0;
    const goTo = (i) => {
      index = (i + mediaItems.length) % mediaItems.length;
      track.style.transform = `translateX(-${index * 100}%)`;
      dots.forEach((dot, di) => dot.classList.toggle("active", di === index));
    };
    dots.forEach((dot, i) => dot.addEventListener("click", () => goTo(i)));

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "media-carousel-arrow media-carousel-prev";
    prevBtn.setAttribute("aria-label", "Previous");
    prevBtn.innerHTML = "&#8249;";
    prevBtn.addEventListener("click", () => goTo(index - 1));

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "media-carousel-arrow media-carousel-next";
    nextBtn.setAttribute("aria-label", "Next");
    nextBtn.innerHTML = "&#8250;";
    nextBtn.addEventListener("click", () => goTo(index + 1));

    wrap.appendChild(prevBtn);
    wrap.appendChild(nextBtn);
    wrap.appendChild(dotsWrap);
  }

  return wrap;
}

// --- Chapter rendering ---------------------------------------------------
// Two distinct shapes: a full-bleed hero/title screen (isTitleScreen), and
// regular chapters, which render as a floating text card. Where that card
// sits is driven by whichever docked side panel the chapter is using - the
// persistent map ("mapPosition") or the media sidecar ("mediaPosition") -
// see placeMapForChapter()/placeMediaForChapter().
function renderHeroChapter(story, chapter) {
  const section = document.createElement("section");
  section.className = "chapter hero";
  section.id = chapter.id;
  section.dataset.mapPosition = chapter.mapPosition || "none";

  const bgImage = chapter.image ? chapter.image.src : "";
  const bgVideo = chapter.backgroundVideo;
  const prefersReducedMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Background video ("underneath the title") if the chapter supplies one
  // and the reader hasn't asked the OS for reduced motion - otherwise falls
  // back to the original static background-image div. `image`/`image.src`
  // doubles as the video's poster frame so there's never a blank/black
  // flash before the (large) video file has buffered enough to play.
  const heroBgHtml =
    bgVideo && !prefersReducedMotion
      ? `
        <div class="hero-bg hero-bg-video">
          <video
            class="hero-bg-media"
            autoplay
            muted
            loop
            playsinline
            preload="auto"
            poster="${bgVideo.poster || bgImage}"
            aria-hidden="true"
          >
            <source src="${bgVideo.src}" type="video/mp4" />
          </video>
          <div class="hero-bg-overlay"></div>
          <button type="button" class="hero-video-toggle" aria-label="Pause background video" title="Pause background video">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
          </button>
        </div>
      `
      : `<div class="hero-bg" style="background-image: linear-gradient(180deg, rgba(0,0,0,0.35), rgba(0,0,0,0.6)), url('${bgVideo && bgVideo.poster ? bgVideo.poster : bgImage}')"></div>`;

  section.innerHTML = `
    ${heroBgHtml}
    <div class="hero-content">
      ${renderIcon(chapter.icon)}
      ${chapter.eyebrow ? `<p class="eyebrow">${chapter.eyebrow}</p>` : ""}
      <h1>${chapter.title}</h1>
      <p class="hero-lede">${chapter.description}</p>
      <div class="scroll-cue">Scroll to begin<span class="scroll-cue-arrow">&#8595;</span></div>
    </div>
  `;

  story.appendChild(section);

  // Playback speed isn't a static HTML attribute (there's no such thing as
  // defaultPlaybackRate="2" in markup) - it's a DOM property that has to be
  // set on the actual <video> element in JS. Some browsers reset
  // playbackRate when the source finishes loading, so it's re-applied on
  // loadedmetadata too, not just once immediately after creation.
  const heroVideoEl = section.querySelector(".hero-bg-media");

  if (heroVideoEl && bgVideo && bgVideo.playbackRate && !prefersReducedMotion) {
    heroVideoEl.playbackRate = bgVideo.playbackRate;
    heroVideoEl.addEventListener("loadedmetadata", () => {
      heroVideoEl.playbackRate = bgVideo.playbackRate;
    });
  }

  // Manual play/pause for the background video. Needed for two reasons:
  // a muted autoplay video has no native controls (and adding `controls`
  // would drop a full scrubber bar over the title), and browsers can refuse
  // to autoplay at all - leaving the reader with a still frame and no way
  // to start it. data-user-paused records an explicit pause so the
  // scroll-back resume in resumeMediaIn() doesn't override the reader.
  const heroToggle = section.querySelector(".hero-video-toggle");
  if (heroVideoEl && heroToggle) {
    const PLAY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>`;
    const PAUSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`;

    const syncToggle = () => {
      const playing = !heroVideoEl.paused && !heroVideoEl.ended;
      heroToggle.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
      const label = playing ? "Pause background video" : "Play background video";
      heroToggle.setAttribute("aria-label", label);
      heroToggle.setAttribute("title", label);
    };

    heroToggle.addEventListener("click", () => {
      if (heroVideoEl.paused) {
        heroVideoEl.dataset.userPaused = "false";
        const played = heroVideoEl.play();
        if (played && typeof played.catch === "function") played.catch(() => {});
      } else {
        heroVideoEl.dataset.userPaused = "true";
        heroVideoEl.pause();
      }
    });

    // Driven off the element's own events rather than set inside the click
    // handler, so the icon also stays correct when playback is started or
    // stopped by something else - autoplay landing, the scroll observer,
    // or the browser blocking playback.
    heroVideoEl.addEventListener("play", syncToggle);
    heroVideoEl.addEventListener("pause", syncToggle);
    syncToggle();
  }
}

function renderChapter(story, chapter) {
  const section = document.createElement("section");
  section.className = "chapter";
  section.id = chapter.id;

  // The text card docks opposite whichever side panel is active for this
  // chapter - the map if "mapPosition" is set, otherwise the media sidecar
  // if "mediaPosition" is "left"/"right", otherwise centered ("none").
  const dockPosition =
    chapter.mapPosition && chapter.mapPosition !== "none"
      ? chapter.mapPosition
      : chapter.mediaPosition === "left" || chapter.mediaPosition === "right"
      ? chapter.mediaPosition
      : "none";
  section.dataset.mapPosition = dockPosition;

  // "full" media spans the whole viewport rather than docking to one side,
  // so there is no opposite side for the card to sit in - it overlays the
  // media instead. Flagged separately from dockPosition (which stays
  // "none") purely so CSS can style that overlay case.
  if (chapter.mediaPosition === "full") section.dataset.mediaFull = "true";

  const content = document.createElement("div");
  content.className = "chapter-content";

  // "dummy": false marks a chapter as real/final content - everything else
  // is still treated as placeholder and gets the "Dummy content" flag.
  const isDummy = chapter.dummy !== false;

  content.innerHTML = `
    ${isDummy ? '<span class="dummy-tag">Dummy content</span>' : ""}
    <div class="chapter-heading">
      ${renderIcon(chapter.icon)}
      <h2>${chapter.title}</h2>
    </div>
    <div class="chapter-body">${chapter.description}</div>
  `;

  const mediaPosition = chapter.mediaPosition || "inline";
  if (mediaPosition === "inline") {
    const media = normalizeMedia(chapter);
    if (media.length) content.appendChild(renderMediaCarousel(media));
  }

  // Optional short caveat noting that the map layer/overlay for this chapter
  // is a stand-in until the client supplies real GIS data (see chapter.mapNote
  // in data/chapters.json) - distinct from the "dummy": true tag, since the
  // narrative copy itself can be final even when its map treatment isn't yet.
  if (chapter.mapNote) {
    const note = document.createElement("p");
    note.className = "map-placeholder-note";
    note.textContent = chapter.mapNote;
    content.appendChild(note);
  }

  section.appendChild(content);
  story.appendChild(section);
}

function renderChapters(chapters) {
  const story = document.getElementById("story");
  chapters.forEach((chapter) => {
    if (chapter.isTitleScreen) {
      renderHeroChapter(story, chapter);
    } else {
      renderChapter(story, chapter);
    }
  });

  // Block Explorer (see renderExplorerSection() below) isn't a narrative
  // chapter - it's an interactive detour dropped in right after "Where Do
  // We Have the Greatest Ability to Intervene?" (section1-transition),
  // the natural place for "here's a tool to go look at your own block"
  // before the story moves on to how homes ignite. It's a plain in-flow
  // section, not a `.chapter`, so it never enters the shared-map
  // IntersectionObserver/docking system - see initExplorerObserver().
  const anchorChapter = document.getElementById("section1-transition");
  const explorerSection = renderExplorerSection();
  if (anchorChapter) {
    anchorChapter.insertAdjacentElement("afterend", explorerSection);
  } else {
    story.appendChild(explorerSection);
  }
}

// --- Toolbar (chapter navigation) ------------------------------------------
// Two-tier nav: a top row of section pills ("Get Oriented", "What Wildfire
// Means Here", ...) plus, below it, one sub-row per section listing that
// section's chapters - only the sub-row for the currently-active (or
// last-clicked) section is visible at a time. This keeps the bar usable
// once a story has dozens of chapters, instead of one long flat scrolling
// row of pills - same idea as ArcGIS StoryMaps' section nav / table of
// contents, just collapsed a level. It's inserted directly after the hero
// section (see bootstrap()) and uses "position: sticky" in CSS, so it
// scrolls normally underneath the hero and only locks to the top once the
// reader scrolls past it.
//
// Section grouping is derived from each chapter's id prefix rather than a
// hardcoded per-chapter list, so new "section1-*"/"section2-*" chapters
// automatically land in the right group.
const SECTION_LABELS = {
  orient: "Get Oriented",
  section1: "What Wildfire Means Here",
  section2: "How Homes Ignite",
  reduce: "Reduce Your Risk",
  together: "Work Together",
  history: "Our History",
  closing: "Take Action"
};

function sectionIdFor(chapter) {
  if (chapter.id.startsWith("section1")) return "section1";
  if (chapter.id.startsWith("section2")) return "section2";
  // Sections 3 (two strategies) and 4 (defensible-space zones) are two
  // narrative sections in the design brief, but both are "how do I reduce
  // risk on my own property" content - grouped under one toolbar pill so
  // the top row doesn't grow a pill per source-document section.
  if (chapter.id.startsWith("section3") || chapter.id.startsWith("section4")) return "reduce";
  // Sections 5 (prioritize) and 6 (neighborhood) are both about acting
  // beyond a single fix-it list - together under one pill.
  if (chapter.id.startsWith("section5") || chapter.id.startsWith("section6")) return "together";
  if (chapter.id.startsWith("section7")) return "history";
  if (chapter.id.startsWith("section8") || chapter.id === "see-it-in-motion" || chapter.id === "take-action") return "closing";
  return "orient";
}

// Preserves first-appearance order (chapters.json order), grouping chapters
// under whichever section id they belong to.
function groupChaptersBySection(chapters) {
  const order = [];
  const groups = {};
  chapters.forEach((chapter) => {
    const sectionId = sectionIdFor(chapter);
    if (!groups[sectionId]) {
      groups[sectionId] = [];
      order.push(sectionId);
    }
    groups[sectionId].push(chapter);
  });
  return { order, groups };
}

function scrollToChapter(id) {
  const target = document.getElementById(id);
  if (target) target.scrollIntoView({ behavior: "smooth" });
}

// Clicking a top-level toolbar section pill normally jumps to that
// section's first chapter (see renderToolbar() below) - but for "Get
// Oriented" that first chapter is the full-bleed hero/title screen, which
// just re-scrolls to the very top of the page instead of anywhere useful.
// This override sends it straight to the "where Homestead Valley sits"
// chapter instead. Add more entries here if another section ever needs
// its pill to land somewhere other than its first chapter.
const SECTION_NAV_OVERRIDES = {
  orient: "welcome"
};

// Shows the sub-row for one section (hides all others) and marks its
// section pill active - used both on section-pill click and, via
// updateToolbar(), as the reader scrolls between sections.
function showToolbarSection(sectionId, toolbarEl) {
  const bar = toolbarEl || document.getElementById("toolbar");
  if (!bar) return;
  bar.querySelectorAll(".toolbar-section-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.section === sectionId);
  });
  bar.querySelectorAll(".toolbar-subrow").forEach((row) => {
    row.classList.toggle("active", row.dataset.section === sectionId);
  });
}

function renderToolbar(chapters) {
  const toolbar = document.createElement("nav");
  toolbar.id = "toolbar";
  toolbar.setAttribute("aria-label", "Story chapters");

  const { order, groups } = groupChaptersBySection(chapters);

  const sectionsRow = document.createElement("div");
  sectionsRow.className = "toolbar-sections";
  sectionsRow.innerHTML = order
    .map(
      (sectionId) => `
        <button type="button" class="toolbar-section-item" data-section="${sectionId}">
          ${SECTION_LABELS[sectionId] || sectionId}
        </button>
      `
    )
    .join("");
  toolbar.appendChild(sectionsRow);

  order.forEach((sectionId) => {
    const subrow = document.createElement("div");
    subrow.className = "toolbar-subrow";
    subrow.dataset.section = sectionId;
    subrow.innerHTML = groups[sectionId]
      .map(
        (chapter) => `
          <button type="button" class="toolbar-item" data-target="${chapter.id}">
            ${chapter.navLabel || chapter.title}
          </button>
        `
      )
      .join("");
    toolbar.appendChild(subrow);
  });

  toolbar.querySelectorAll(".toolbar-item").forEach((btn) => {
    btn.addEventListener("click", () => scrollToChapter(btn.dataset.target));
  });

  toolbar.querySelectorAll(".toolbar-section-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sectionId = btn.dataset.section;
      showToolbarSection(sectionId, toolbar);
      const firstChapter = groups[sectionId] && groups[sectionId][0];
      const targetId = SECTION_NAV_OVERRIDES[sectionId] || (firstChapter && firstChapter.id);
      if (targetId) scrollToChapter(targetId);
    });
  });

  // Default to the first section's sub-row visible before any scrolling.
  if (order.length) showToolbarSection(order[0], toolbar);

  return toolbar;
}

function updateToolbar(activeChapterId, chapters) {
  document.querySelectorAll(".toolbar-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.target === activeChapterId);
  });

  const activeChapter = chapters.find((c) => c.id === activeChapterId);
  if (activeChapter) {
    showToolbarSection(sectionIdFor(activeChapter));
  }
}

// --- Footer ------------------------------------------------------------
function renderFooter(footerConfig) {
  const footer = document.getElementById("footer");
  if (!footer || !footerConfig) return;

  const linksHtml = (footerConfig.links || [])
    .map((link) => `<a class="footer-link" href="${link.url}">${link.label}</a>`)
    .join("");

  footer.innerHTML = `
    <div class="footer-inner">
      ${footerConfig.title ? `<h2>${footerConfig.title}</h2>` : ""}
      ${footerConfig.text ? `<p class="footer-text">${footerConfig.text}</p>` : ""}
      ${linksHtml ? `<nav class="footer-links">${linksHtml}</nav>` : ""}
      ${footerConfig.credit ? `<p class="footer-credit">${footerConfig.credit}</p>` : ""}
    </div>
  `;
}

// --- Video auto-pause/resume as chapters scroll in and out of view --------
// Toggled by settings.pauseVideoOffscreen in data/chapters.json.
function pauseMediaIn(sectionEl) {
  sectionEl.querySelectorAll("video").forEach((v) => v.pause());
  sectionEl.querySelectorAll("iframe.yt-embed").forEach((frame) => {
    if (!frame.contentWindow) return;
    frame.contentWindow.postMessage(
      JSON.stringify({ event: "command", func: "pauseVideo", args: [] }),
      "*"
    );
  });
}

// The counterpart to pauseMediaIn(): without this, an autoplaying background
// video played once on load, got paused the first time the reader scrolled
// past it, and then stayed frozen on its last frame forever.
//
// Scoped to video[autoplay] so it only ever restarts videos that were
// *meant* to run on their own - a regular <video controls> the reader
// deliberately stopped stays stopped. data-user-paused is the same
// exemption for a background video paused via its own toggle button.
function resumeMediaIn(sectionEl) {
  sectionEl.querySelectorAll("video[autoplay]").forEach((v) => {
    if (v.dataset.userPaused === "true") return;
    // play() rejects if the browser blocks playback (e.g. autoplay policy);
    // the hero's visible play/pause button is the manual fallback.
    const played = v.play();
    if (played && typeof played.catch === "function") played.catch(() => {});
  });
}

function setupVideoPauseOnScrollOut() {
  if (!SETTINGS.pauseVideoOffscreen) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        // threshold 0 fires exactly when a chapter becomes fully hidden
        // (scrolled entirely above or below the viewport) or reappears.
        if (entry.isIntersecting) {
          resumeMediaIn(entry.target);
        } else {
          pauseMediaIn(entry.target);
        }
      });
    },
    { threshold: 0 }
  );

  document.querySelectorAll(".chapter").forEach((el) => observer.observe(el));
}

// --- Legend ---------------------------------------------------------------
// SYMBOLOGY RENDERERS
//
// A legend section declares HOW it should be drawn via an optional
// "symbology" key in data/chapters.json, and renderLegendSymbology() below
// dispatches to the matching renderer. The point of the indirection is that
// a chapter needing a differently-shaped legend (a bivariate matrix, and in
// future a continuous ramp bar, a graduated-symbol column, ...) is a new
// entry in LEGEND_SYMBOLOGY_RENDERERS plus some CSS - it does NOT mean
// touching renderLegendShell(), renderExplorerLegend(), or the existing
// sections, all of which stay on the default "items" renderer.
//
// Contract every renderer honours:
//   - takes the whole section object, returns an HTML string
//   - renders only the section BODY; the header, the on/off switch and the
//     .legend-section box itself belong to buildLegendSectionHtml() below,
//     so all symbologies get the same toggle behaviour for free
//   - is pure (no DOM reads, no map reads) so the same function can serve
//     the story legend and the Block Explorer legend
//
// Escaping note: labels come from our own chapters.json and legitimately
// contain markup-ish characters (en-dashes, ×, ≥), so they are interpolated
// as-is, consistent with how chapter descriptions are already handled. These
// are authored strings, never user input.

// "items" (the default) - a vertical list of swatch + label rows. "swatch"
// on an item (optional, defaults to a flat filled square) lets a row
// visually match a LINE-based map layer (marin/homesteadHighlight
// boundaries, contours, streets) instead of always rendering a filled block
// for what's actually a line on the map - "line-solid" draws a solid rule,
// "line-dashed" a dashed one, both colored via item.color.
function renderLegendItemHtml(item) {
  const swatchType = item.swatch || "fill";
  const swatchStyle =
    swatchType === "fill" ? `background:${item.color}` : `border-top-color:${item.color}`;
  return `
    <div class="legend-item">
      <span class="legend-swatch legend-swatch-${swatchType}" style="${swatchStyle}"></span>
      <span>${item.label}</span>
    </div>
  `;
}

function renderItemsSymbology(section) {
  return (section.items || []).map(renderLegendItemHtml).join("");
}

// "matrix" - a 2D bivariate grid: one axis per variable, one cell per
// combination, so a reader decodes a map color back into a PAIR of classes
// rather than matching it against N arbitrary chips.
//
// section.matrix = {
//   rows:  [[hex x4], ...]   row 0 = LOWEST y-axis class (see the reverse below)
//   yAxis: { label, ticks: [one short name per row] }
//   xAxis: { label, edges: [N+1 numbers/strings], unit }
//   note:  optional sentence under the grid
// }
//
// The two axes are labelled differently on purpose. The y axis is
// CATEGORICAL in the reader's head ("Sparse".."Very dense"), so it gets one
// name per row. The x axis is a continuous variable cut into classes, so it
// gets its N+1 class EDGES rendered at the cell boundaries rather than N
// ranges centred under cells: edge numbers are short enough to fit under a
// ~20px cell, where "265-393 ft" is not, and boundaries are what a reader
// actually needs to place a value.
//
// rows are authored LOW-to-HIGH on the y axis - the same orientation as
// bivariate_work/bivariate_palette.json's matrix[vegClass-1][elevClass-1] -
// so the JSON can be diffed against the palette the data was built with
// without mentally flipping it. They are reversed here because CSS grid
// fills top-down, and "more of the y variable" has to read UPWARD for the
// grid to match the axis arrow (and the reference bivariate legend supplied
// with the request).
//
// Everything lives in ONE CSS grid - tick column, cells, edge row and axis
// label - so the edge numbers stay aligned with the cell boundaries no
// matter how wide the y-axis tick labels turn out to be. A separate row of
// labels underneath could not track an `auto`-width first column.
function renderMatrixSymbology(section) {
  const matrix = section.matrix;
  if (!matrix || !Array.isArray(matrix.rows)) return renderItemsSymbology(section);

  const yTicks = matrix.yAxis?.ticks || [];
  const xEdges = matrix.xAxis?.edges || [];
  const unit = matrix.xAxis?.unit ? ` ${matrix.xAxis.unit}` : "";
  const cols = matrix.rows[0]?.length || 0;

  const bodyRows = matrix.rows
    .map((row, y) => ({ row, y }))
    .reverse()
    .map(({ row, y }) => {
      const cells = row
        .map((color, x) => {
          // title= gives every cell a hover / assistive-tech readable
          // decoding, the only per-cell labelling that fits a grid this size.
          const xRange =
            xEdges.length > x + 1 ? `${xEdges[x]}–${xEdges[x + 1]}${unit}` : `class ${x + 1}`;
          const label = `${yTicks[y] || `class ${y + 1}`} × ${xRange}`;
          return `<span class="legend-matrix-cell" style="background:${color}" title="${label}"></span>`;
        })
        .join("");
      return `<span class="legend-matrix-ytick">${yTicks[y] || ""}</span>${cells}`;
    })
    .join("");

  const edgeSpan = `grid-column: 2 / span ${cols}`;
  const edgesHtml = xEdges.length
    ? `<span></span><span class="legend-matrix-xedges" style="${edgeSpan}">${xEdges
        .map((e) => `<span>${e}</span>`)
        .join("")}</span>`
    : "";
  const xLabelHtml = matrix.xAxis?.label
    ? `<span></span><span class="legend-matrix-xlabel" style="${edgeSpan}">${matrix.xAxis.label}</span>`
    : "";

  return `
    <div class="legend-matrix">
      <div class="legend-matrix-ylabel">${matrix.yAxis?.label || ""}</div>
      <div class="legend-matrix-grid" style="--legend-matrix-cols:${cols}">
        ${bodyRows}
        ${edgesHtml}
        ${xLabelHtml}
      </div>
    </div>
    ${matrix.note ? `<p class="legend-matrix-note">${matrix.note}</p>` : ""}
  `;
}

const LEGEND_SYMBOLOGY_RENDERERS = {
  items: renderItemsSymbology,
  matrix: renderMatrixSymbology
};

function renderLegendSymbology(section) {
  const kind = section.symbology || "items";
  const renderer = LEGEND_SYMBOLOGY_RENDERERS[kind];
  if (!renderer) {
    // Fall back rather than render an empty box - an unknown symbology name
    // is an authoring typo, and a legend section that silently disappears is
    // much harder to notice than one that renders plainly with a console note.
    console.warn(`Unknown legend symbology "${kind}" - falling back to "items".`);
    return renderItemsSymbology(section);
  }
  return renderer(section);
}

// The .legend-section box is identical in the story legend and the Block
// Explorer legend (same markup, same CSS, same switch semantics) - only the
// host element and the toggle callback differ. Building it in one place means
// a new symbology, or a change to the switch markup, lands in both at once.
function buildLegendSectionHtml(section) {
  return `
    <div class="legend-header">
      <h4>${section.title}</h4>
      <span class="legend-toggle" aria-hidden="true"><span class="legend-toggle-thumb"></span></span>
    </div>
    ${renderLegendSymbology(section)}
  `;
}

function createLegendSectionBox(layerKey, section, onToggle) {
  const box = document.createElement("div");
  box.className = "legend-section";
  box.dataset.layer = layerKey;
  // Each section IS the toggle - a reader clicks/taps/Enter-Space's the
  // whole section to flip that map layer on or off, independent of whatever
  // the current chapter set it to.
  box.setAttribute("role", "switch");
  box.setAttribute("tabindex", "0");
  box.setAttribute("aria-checked", "false");
  box.setAttribute("aria-label", `Toggle ${section.title} map layer`);
  box.innerHTML = buildLegendSectionHtml(section);

  box.addEventListener("click", () => onToggle(box));
  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggle(box);
    }
  });
  return box;
}

function renderLegendShell(legendConfig) {
  const legend = document.getElementById("legend");
  const reopenBtn = document.getElementById("legend-reopen");
  if (!legendConfig || !legend) return;

  const onRight = SETTINGS.legendPosition === "right";
  legend.classList.toggle("legend-right", onRight);
  if (reopenBtn) reopenBtn.classList.toggle("legend-right", onRight);

  // Start hidden - updateLegend() reveals it once a chapter with an active
  // layer scrolls into view, so there's no empty box flash before then.
  legend.classList.add("legend-hidden");
  // Legend defaults to the closed (collapsed, reopen-button-only) state -
  // a reader has to explicitly reopen it, even once a chapter with active
  // map layers scrolls into view. See updateLegend() below, which keeps
  // this the steady state instead of popping back open on every chapter
  // that has no active layers.
  legend.classList.add("legend-closed");

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "legend-close";
  closeBtn.setAttribute("aria-label", "Close legend");
  closeBtn.innerHTML = "&times;";
  closeBtn.addEventListener("click", () => {
    legend.classList.add("legend-closed");
    if (reopenBtn) reopenBtn.classList.add("visible");
  });
  legend.appendChild(closeBtn);

  if (reopenBtn) {
    reopenBtn.addEventListener("click", () => {
      legend.classList.remove("legend-closed");
      reopenBtn.classList.remove("visible");
    });
  }

  Object.entries(legendConfig).forEach(([layerKey, section]) => {
    const box = createLegendSectionBox(layerKey, section, (el) => {
      const nowActive = !el.classList.contains("active");
      el.classList.toggle("active", nowActive);
      el.setAttribute("aria-checked", String(nowActive));
      setMapLayerVisibility(layerKey, nowActive);
    });
    legend.appendChild(box);
  });
}

function updateLegend(activeLayers) {
  const legend = document.getElementById("legend");
  const reopenBtn = document.getElementById("legend-reopen");
  const anyActive = Object.values(activeLayers).some(Boolean);

  legend.classList.toggle("legend-hidden", !anyActive);

  if (reopenBtn) {
    const showReopen = anyActive && legend.classList.contains("legend-closed");
    reopenBtn.classList.toggle("visible", showReopen);
    // Closed is the persistent default - a chapter with no active layers
    // re-affirms it (rather than clearing it) so the legend doesn't pop
    // back open the next time an active-layer chapter is reached. Once a
    // reader explicitly reopens it (legend-reopen / legend-close handlers
    // above), it stays open until they close it again or scroll away.
    if (!anyActive) legend.classList.add("legend-closed");
  }

  // Chapter-scroll resets every section to that chapter's authored state -
  // it overwrites any manual toggle left over from the previous chapter.
  document.querySelectorAll(".legend-section").forEach((section) => {
    const key = section.dataset.layer;
    const active = Boolean(activeLayers[key]);
    section.classList.toggle("active", active);
    section.setAttribute("aria-checked", String(active));
  });
}

// --- Media sidecar ----------------------------------------------------
// Docks a media carousel to the left/right half of the viewport, the same
// way the map docks (see placeMapForChapter()) - a chapter picks ONE of the
// two side panels via "mapPosition" or "mediaPosition", never both.
//
// Tracks whichever side the panel was docked to for the previously-active
// chapter (mirrors lastMapDockPosition below), so a content swap only gets
// the extra crossfade treatment when the panel itself stays put - if it's
// appearing/disappearing/switching sides, its own opacity transition (see
// body.media-pos-* in CSS) already makes that change smooth.
let lastMediaDockPosition = null;

function placeMediaForChapter(chapter) {
  const sidecar = document.getElementById("media-sidecar");
  if (!sidecar) return;

  const position =
    chapter.mediaPosition === "left" ||
    chapter.mediaPosition === "right" ||
    chapter.mediaPosition === "full"
      ? chapter.mediaPosition
      : "none";

  document.body.classList.remove(
    "media-pos-left",
    "media-pos-right",
    "media-pos-full",
    "media-pos-none"
  );
  document.body.classList.add(`media-pos-${position}`);

  const dockPositionChanged = lastMediaDockPosition !== position;
  lastMediaDockPosition = position;

  const swapContent = () => {
    sidecar.innerHTML = "";
    if (position !== "none") {
      sidecar.appendChild(renderMediaCarousel(normalizeMedia(chapter)));
    }
  };

  if (dockPositionChanged || position === "none") {
    swapContent();
  } else {
    // Docked to the same side as before, just showing a different
    // chapter's media (e.g. scrolling from one right-docked chapter
    // straight into the next) - crossfade the swap instead of an
    // abrupt cut from one image/video straight to another.
    sidecar.classList.add("media-sidecar-swapping");
    window.setTimeout(() => {
      swapContent();
      requestAnimationFrame(() => sidecar.classList.remove("media-sidecar-swapping"));
    }, 220);
  }
}

// --- Map framing (camera) ------------------------------------------------
// Computes the bounding box of every coordinate in a GeoJSON
// FeatureCollection. Used to fly/fit the map to a layer's true extent -
// the same idea as Esri's view.goTo(layer.fullExtent) - instead of a
// hand-tuned center+zoom, which only ever looks right at one window size
// and tends to crop or drift once you eyeball a "close enough" zoom level.
function computeBBox(geojson) {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  const walk = (coords) => {
    if (typeof coords[0] === "number") {
      const [lng, lat] = coords;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    } else {
      coords.forEach(walk);
    }
  };

  geojson.features.forEach((f) => walk(f.geometry.coordinates));
  return [
    [minLng, minLat],
    [maxLng, maxLat]
  ];
}

// Fetched directly (independent of the map's own tile loading) so a
// chapter's camera framing is available immediately, keyed by the same
// names used for the MapLibre sources below ("marin", "homestead").
async function loadLayerBounds() {
  const [marin, homestead] = await Promise.all([
    fetch("data/marin_county.geojson").then((r) => r.json()),
    fetch("data/homestead.geojson").then((r) => r.json())
  ]);
  return {
    marin: computeBBox(marin),
    homestead: computeBBox(homestead)
  };
}

// Moves the camera for a given chapter. A chapter can supply "fitToLayer"
// (one of the names returned by loadLayerBounds()) to reliably frame that
// layer's real extent regardless of viewport size/shape. Chapters that
// aren't framing a specific boundary layer fall back to a hand-tuned
// center/zoom/pitch/bearing ("location").
function flyToChapter(map, chapter, layerBounds, duration = 1200) {
  const bounds = chapter.fitToLayer && layerBounds[chapter.fitToLayer];
  if (bounds) {
    map.fitBounds(bounds, {
      padding: chapter.fitPadding || 60,
      pitch: chapter.location.pitch || 0,
      bearing: chapter.location.bearing || 0,
      duration
    });
  } else {
    map.flyTo({ ...chapter.location, duration });
  }
}

// --- Block Explorer -----------------------------------------------------
// A self-contained, interactive detour (not a narrative chapter) letting a
// reader click any of Homestead's numbered blocks (data/blocks.geojson) to
// see its Block Captain and description. Runs on its OWN MapLibre instance
// (not the shared docked #map) since it lives inline in the document flow
// instead of being pinned to the viewport - see renderExplorerSection() for
// the markup and initExplorerObserver() for how/when the map instance gets
// created.
const EXPLORER_EMPTY_FC = { type: "FeatureCollection", features: [] };

// The Explorer's own thematic layers, in the order they appear in its
// legend, mapped to the MapLibre layer id(s) each legend row switches.
// Deliberately separate from LEGEND_LAYER_IDS: the Explorer drives a second,
// independent map instance, so its layer ids are prefixed and its on/off
// state never touches the scroll-driven story map. Keys match
// data/chapters.json "legend" so both legends read off one config.
const EXPLORER_LAYER_IDS = {
  streets: [
    "explorer-streets-halo-main",
    "explorer-streets-halo-trail",
    "explorer-streets-main",
    "explorer-streets-trail"
  ],
  contours: [
    "explorer-contours-line-casing",
    "explorer-contours-line",
    "explorer-contours-label"
  ],
  vegetation: ["explorer-vegetation-fill"],
  elevation: ["explorer-elevation-fill"],
  homesteadHighlight: ["explorer-homestead-line"]
};

// The layers that belong to a single block, and so are switched on when one
// is selected and off again on reset. Everything in EXPLORER_LAYER_IDS
// except the CSA 14 boundary, which is valley-wide context and stays on at
// the overview scale - it's what tells a reader what they're looking at
// before they've picked anything.
const EXPLORER_BLOCK_LAYER_KEYS = Object.keys(EXPLORER_LAYER_IDS).filter(
  (key) => key !== "homesteadHighlight"
);

// Base (block-independent) filter for each clipped thematic layer, or null
// where the layer draws everything in its source. Declared here rather than
// inline in addExplorerThematicLayers() because it is needed in two places -
// once when the layer is created, and again every time a block is selected
// and the Block_No clause has to be re-composed on top of it. Two inline
// copies could drift apart and silently widen a filter.
const EXPLORER_BASE_FILTERS = {
  "explorer-elevation-fill": null,
  "explorer-vegetation-fill": null,
  "explorer-contours-line-casing": null,
  "explorer-contours-line": null,
  "explorer-contours-label": CONTOUR_LABEL_FILTER,
  "explorer-streets-halo-main": ROAD_MAIN_FILTER,
  "explorer-streets-halo-trail": ROAD_TRAIL_FILTER,
  "explorer-streets-main": ROAD_MAIN_FILTER,
  "explorer-streets-trail": ROAD_TRAIL_FILTER
};

let explorerMapInitialized = false;
let explorerHomeBounds = null;
let explorerMaskOuterRing = null;
let explorerSelectedBlockId = null;
let explorerPopup = null;

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );
}

function renderExplorerSection() {
  const section = document.createElement("section");
  section.className = "explorer-section";
  section.id = "block-explorer";

  section.innerHTML = `
    <div class="explorer-header">
      <span class="explorer-badge">Interactive</span>
      <h2>Explore Your Block</h2>
      <p>Homestead Valley is organized into numbered blocks, each with a Block Captain who helps coordinate preparedness locally. Click a block to zoom to it and see its Block Captain, along with the roads, terrain and vegetation around it.</p>
    </div>
    <div class="explorer-map-wrap">
      <div id="explorer-map"></div>
      <button type="button" id="explorer-fullscreen-btn" class="map-control-btn explorer-map-fullscreen" aria-label="Toggle fullscreen map" title="Toggle fullscreen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
      </button>
      <div class="explorer-map-controls">
        <button type="button" id="explorer-home-btn" class="map-control-btn" aria-label="Reset block view" title="Reset view">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/></svg>
        </button>
        <div class="map-control-zoom-group">
          <button type="button" id="explorer-zoom-in-btn" class="map-control-btn" aria-label="Zoom in" title="Zoom in">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <button type="button" id="explorer-zoom-out-btn" class="map-control-btn" aria-label="Zoom out" title="Zoom out">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>
          </button>
        </div>
      </div>
      <div class="explorer-legend" id="explorer-legend">
        <button type="button" class="legend-close" id="explorer-legend-close" aria-label="Hide map layers">&times;</button>
        <p class="explorer-legend-hint" id="explorer-legend-hint">Pick a block to switch on its roads, terrain and vegetation</p>
        <div class="explorer-legend-sections" id="explorer-legend-sections"></div>
      </div>
      <button type="button" class="explorer-legend-reopen" id="explorer-legend-reopen" aria-label="Show map layers">Layers</button>
    </div>
  `;

  return section;
}

// GeoJSON polygon hole rings need to run the opposite winding direction
// from their outer ring to render correctly - reversing a ring's point
// order always flips its winding, regardless of what the source data used,
// so this doesn't need to know or care which convention blocks.geojson
// follows. Branches on geometry.type because blocks.geojson mixes 68
// Polygon features with one MultiPolygon (Block_No 1, two constituent
// shapes) - a MultiPolygon contributes one hole ring per constituent part.
function extractExteriorRings(geometry) {
  if (geometry.type === "Polygon") return [geometry.coordinates[0]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates.map((poly) => poly[0]);
  return [];
}

// Builds a "spotlight" mask: a single Polygon feature whose first ring is a
// large fixed rectangle covering the whole map view, and whose remaining
// ring(s) are the selected block's own exterior ring(s), reversed (so they
// render as holes). Filled at high opacity, this darkens every block
// EXCEPT the selected one, without needing a turf.js/geometry-clipping
// dependency.
function buildExplorerMaskFeature(blockFeature, outerRing) {
  const holes = extractExteriorRings(blockFeature.geometry).map((ring) => ring.slice().reverse());
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [outerRing, ...holes] }
  };
}

// Flips one legend row's map layer(s) AND that row's own switch state
// together, so the toggle pill can never drift out of sync with what's
// actually painted - whether the change came from a reader's click or from
// selectExplorerBlock() turning everything on at once.
function setExplorerLayerVisibility(map, layerKey, visible) {
  (EXPLORER_LAYER_IDS[layerKey] || []).forEach((id) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  });

  const box = document.querySelector(
    `#explorer-legend-sections .legend-section[data-layer="${layerKey}"]`
  );
  if (box) {
    box.classList.toggle("active", visible);
    box.setAttribute("aria-checked", String(visible));
  }
}

function setExplorerBlockLayers(map, visible) {
  EXPLORER_BLOCK_LAYER_KEYS.forEach((key) => setExplorerLayerVisibility(map, key, visible));
  const hint = document.getElementById("explorer-legend-hint");
  if (hint) hint.classList.toggle("hidden", visible);
  // With no block selected these rows have nothing to show, so they are
  // marked unavailable rather than left as switches that appear to do
  // nothing - the hint above them says what to do instead.
  EXPLORER_BLOCK_LAYER_KEYS.forEach((key) => {
    const box = document.querySelector(
      `#explorer-legend-sections .legend-section[data-layer="${key}"]`
    );
    if (!box) return;
    box.classList.toggle("legend-section-unavailable", !visible);
    box.setAttribute("aria-disabled", String(!visible));
  });
}

// The clipped layers hold one feature per (source feature x block) pair, each
// already trimmed to its block's outline, so confining a layer to one block is
// a plain equality test. Passing blockNo = null matches nothing, which is the
// correct state at the whole-valley overview where no block is framed. See
// block_clip_work/01_clip_layers_to_blocks.py for why the clip is baked into
// the data instead of done with MapLibre's `within` expression.
function setExplorerBlockFilter(map, blockNo) {
  const blockClause = ["==", ["get", "Block_No"], blockNo];
  Object.keys(EXPLORER_BASE_FILTERS).forEach((layerId) => {
    if (!map.getLayer(layerId)) return;
    const base = EXPLORER_BASE_FILTERS[layerId];
    map.setFilter(layerId, base ? ["all", blockClause, base] : blockClause);
  });
}

// Reuses the story legend's markup/CSS (.legend-section + its switch pill),
// but scoped inside the Explorer section instead of the fixed viewport
// legend, and reading the same data/chapters.json "legend" block so layer
// colors and class breaks are described identically in both places.
function renderExplorerLegend(map) {
  const host = document.getElementById("explorer-legend-sections");
  if (!host || !LEGEND_CONFIG) return;

  Object.keys(EXPLORER_LAYER_IDS).forEach((layerKey) => {
    const section = LEGEND_CONFIG[layerKey];
    if (!section) return;

    const box = createLegendSectionBox(layerKey, section, (el) => {
      if (el.classList.contains("legend-section-unavailable")) return;
      setExplorerLayerVisibility(map, layerKey, !el.classList.contains("active"));
    });
    host.appendChild(box);
  });

  const legend = document.getElementById("explorer-legend");
  const reopenBtn = document.getElementById("explorer-legend-reopen");
  document.getElementById("explorer-legend-close")?.addEventListener("click", () => {
    legend?.classList.add("legend-closed");
    reopenBtn?.classList.add("visible");
  });
  reopenBtn?.addEventListener("click", () => {
    legend?.classList.remove("legend-closed");
    reopenBtn.classList.remove("visible");
  });
}

function openExplorerPopup(map, props, lngLat) {
  const description =
    props.Description && props.Description.trim() ? props.Description : `Block ${props.Block_No}`;
  const captain =
    props.Block_Captian && props.Block_Captian.trim()
      ? props.Block_Captian
      : "Not yet assigned — contact the Safety Committee";

  if (!explorerPopup) {
    explorerPopup = new maplibregl.Popup({
      className: "explorer-popup",
      closeButton: true,
      // Dismissing the card is independent of the selection: closing it
      // leaves the block framed, spotlit and its layers on, so a reader can
      // clear the text out of the way and keep reading the map. Only the
      // home button returns to the whole-valley view.
      closeOnClick: false,
      maxWidth: "300px",
      offset: 14
    });
  }

  explorerPopup
    .setLngLat(lngLat)
    .setHTML(
      `
      <p class="explorer-popup-eyebrow">Block ${escapeHtml(props.Block_No)}</p>
      <h3>${escapeHtml(description)}</h3>
      <p class="explorer-popup-captain">
        <strong>Block Captain</strong>
        <span>${escapeHtml(captain)}</span>
      </p>
    `
    )
    .addTo(map);
}

function selectExplorerBlock(map, feature, lngLat) {
  if (explorerSelectedBlockId !== null) {
    map.setFeatureState({ source: "explorer-blocks", id: explorerSelectedBlockId }, { selected: false });
  }
  explorerSelectedBlockId = feature.id;
  map.setFeatureState({ source: "explorer-blocks", id: feature.id }, { selected: true });

  const maskSource = map.getSource("explorer-mask");
  if (maskSource && explorerMaskOuterRing) {
    maskSource.setData(buildExplorerMaskFeature(feature, explorerMaskOuterRing));
  }

  map.fitBounds(computeBBox({ features: [feature] }), { padding: 80, duration: 900 });

  // Narrow the thematic layers to this block BEFORE showing them, so no frame
  // is ever painted with the previous block's (or the whole valley's) extent.
  setExplorerBlockFilter(map, feature.properties.Block_No);

  // Every thematic layer comes on once a block is framed - at the whole-
  // valley overview they'd just stack into noise and bury the block
  // numbers, but at block scale they're the actual point of zooming in.
  // The legend then lets a reader switch off whichever ones they don't want.
  setExplorerBlockLayers(map, true);
  openExplorerPopup(map, feature.properties, lngLat);
}

function resetExplorer(map) {
  if (explorerSelectedBlockId !== null) {
    map.setFeatureState({ source: "explorer-blocks", id: explorerSelectedBlockId }, { selected: false });
    explorerSelectedBlockId = null;
  }
  const maskSource = map.getSource("explorer-mask");
  if (maskSource) maskSource.setData(EXPLORER_EMPTY_FC);
  if (explorerHomeBounds) {
    map.fitBounds(explorerHomeBounds, { padding: 40, duration: 900 });
  }
  setExplorerBlockLayers(map, false);
  setExplorerBlockFilter(map, null);
  if (explorerPopup) explorerPopup.remove();
}

function initExplorerMap() {
  if (explorerMapInitialized) return;
  explorerMapInitialized = true;

  const map = new maplibregl.Map({
    container: "explorer-map",
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    center: [-122.5472, 37.8956],
    zoom: 13.5,
    attributionControl: true,
    // Same reasoning as the main map (see initMap()) - this section sits
    // inline in the normal page flow, so uncaptured wheel input over the
    // map would fight page scroll. Custom zoom buttons cover zooming.
    scrollZoom: false
  });

  document.getElementById("explorer-home-btn")?.addEventListener("click", () => resetExplorer(map));
  document.getElementById("explorer-zoom-in-btn")?.addEventListener("click", () => map.zoomIn());
  document.getElementById("explorer-zoom-out-btn")?.addEventListener("click", () => map.zoomOut());

  // The Explorer needs its OWN fullscreen button: the story map's button
  // lives inside the fixed #map element and can only ever expand that map,
  // so without this, clicking fullscreen anywhere on the page put the
  // narrative map on screen instead of the block map the reader was using.
  // Expands .explorer-map-wrap (not #explorer-map) so the legend and the
  // zoom/home controls, which are siblings of the canvas, come along.
  const explorerFullscreenBtn = document.getElementById("explorer-fullscreen-btn");
  const explorerWrap = document.querySelector(".explorer-map-wrap");
  if (explorerFullscreenBtn && explorerWrap) {
    explorerFullscreenBtn.addEventListener("click", () => {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        explorerWrap.requestFullscreen().catch(() => {});
      }
    });
    document.addEventListener("fullscreenchange", () => {
      if (document.fullscreenElement && document.fullscreenElement !== explorerWrap) return;
      window.setTimeout(() => map.resize(), 120);
    });
  }

  renderExplorerLegend(map);

  map.on("load", () => {
    addExplorerThematicLayers(map);
    fetch("data/blocks.geojson")
      .then((r) => r.json())
      .then((blocksGeojson) => {
        explorerHomeBounds = computeBBox(blocksGeojson);
        const [[minLng, minLat], [maxLng, maxLat]] = explorerHomeBounds;
        // Mask outer ring padded generously (3x the layer's own span) past
        // the blocks' real extent, so panning/zooming out never reveals its
        // edge as a visible seam.
        const padLng = (maxLng - minLng) * 3 || 0.2;
        const padLat = (maxLat - minLat) * 3 || 0.2;
        explorerMaskOuterRing = [
          [minLng - padLng, minLat - padLat],
          [maxLng + padLng, minLat - padLat],
          [maxLng + padLng, maxLat + padLat],
          [minLng - padLng, maxLat + padLat],
          [minLng - padLng, minLat - padLat]
        ];

        map.addSource("explorer-blocks", {
          type: "geojson",
          data: blocksGeojson,
          // Lets setFeatureState()/feature-state expressions key off each
          // block's real OBJECTID instead of an internal-only geometry
          // index, so the selected-block highlight survives re-renders.
          promoteId: "OBJECTID"
        });

        map.addLayer({
          id: "explorer-blocks-fill",
          type: "fill",
          source: "explorer-blocks",
          paint: {
            "fill-color": "#7f9cc4",
            // The SELECTED block goes fully transparent, not highlighted:
            // selecting it also switches on the vegetation/elevation/
            // contour/street layers underneath, and a tinted fill would
            // wash out exactly the detail the reader zoomed in to read.
            // The thick orange outline (below) plus the darkened surround
            // (explorer-mask-fill) already mark which block is active.
            "fill-opacity": [
              "case",
              ["boolean", ["feature-state", "selected"], false], 0,
              0.35
            ]
          }
        });

        map.addLayer({
          id: "explorer-blocks-line",
          type: "line",
          source: "explorer-blocks",
          paint: {
            "line-color": [
              "case",
              ["boolean", ["feature-state", "selected"], false], "#e67e22",
              "#2c3e91"
            ],
            "line-width": [
              "case",
              ["boolean", ["feature-state", "selected"], false], 3,
              1
            ]
          }
        });

        // Spotlight mask - starts empty (no block selected yet), populated
        // by selectExplorerBlock()/cleared by resetExplorer(). Sits above
        // the fill/line layers but below the labels, so number labels stay
        // legible (via their white halo) even on dimmed, unselected blocks.
        map.addSource("explorer-mask", { type: "geojson", data: EXPLORER_EMPTY_FC });
        map.addLayer({
          id: "explorer-mask-fill",
          type: "fill",
          source: "explorer-mask",
          paint: { "fill-color": "#101418", "fill-opacity": 0.55 }
        });

        // Boundary LINE added after the mask so the CSA 14 outline stays
        // readable across the dimmed surround, and after every thematic
        // layer so nothing paints over it. Line only, no fill, per the
        // Explorer's brief.
        map.addSource("explorer-homestead", { type: "geojson", data: "data/homestead.geojson" });
        map.addLayer({
          id: "explorer-homestead-line",
          type: "line",
          source: "explorer-homestead",
          layout: { visibility: "none" },
          paint: { "line-color": "#000000", "line-width": 2 }
        });

        map.addLayer({
          id: "explorer-blocks-label",
          type: "symbol",
          source: "explorer-blocks",
          layout: {
            "text-field": ["get", "Block_No"],
            "text-font": ["Montserrat Regular", "Open Sans Regular", "Noto Sans Regular"],
            "text-size": 11,
            "text-allow-overlap": true,
            "text-ignore-placement": true
          },
          paint: {
            "text-color": "#1c1c1c",
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.2
          }
        });

        map.on("click", "explorer-blocks-fill", (e) => {
          if (!e.features || !e.features.length) return;
          selectExplorerBlock(map, e.features[0], e.lngLat);
        });

        // The CSA 14 boundary is the one layer on at the overview scale -
        // switched on here rather than via its layer's own `visibility` so
        // the legend row's switch state is set from the same call.
        setExplorerLayerVisibility(map, "homesteadHighlight", true);
        // Puts the four per-block rows into their "no block picked yet" state.
        setExplorerBlockLayers(map, false);

        map.fitBounds(explorerHomeBounds, { padding: 40, duration: 0 });
      });
  });
}

// The four context layers the Explorer stacks under the blocks - same
// symbology as the story map's equivalents (see initMap()), re-added here
// because this is a separate MapLibre instance with its own style object.
//
// They read the block_*.geojson files, not the valley-wide homestead_*
// originals: those are the same data pre-clipped to block outlines, one
// feature per (source feature x block) pair, so a Block_No filter confines
// each layer to the selected block exactly. All start hidden and match
// nothing; selectExplorerBlock() sets the filter and switches them on.
function addExplorerThematicLayers(map) {

  map.addSource("explorer-elevation", { type: "geojson", data: "data/block_elevation.geojson" });
  map.addLayer({
    id: "explorer-elevation-fill",
    type: "fill",
    source: "explorer-elevation",
    layout: { visibility: "none" },
    paint: {
      "fill-color": [
        "match",
        ["get", "elev_class"],
          1, "#F0F0F0",
          2, "#D9D9D9", 
          3, "#BDBDBD", 
          4, "#969696",
          5, "#737373", 
          6, "#525252", 
          7, "#353535", 
          8, "#1A1A1A",
        "#cccccc"
      ],
      "fill-opacity": 1
    }
  });

  map.addSource("explorer-vegetation", {
    type: "geojson",
    data: "data/block_vegetation.geojson"
  });
  map.addLayer({
    id: "explorer-vegetation-fill",
    type: "fill",
    source: "explorer-vegetation",
    layout: { visibility: "none" },
    paint: {
      "fill-color": [
        "match",
        ["get", "ndvi_class"],
        1, "#d9f0a3",
        2, "#78c679",
        3, "#31a354",
        4, "#006837",
        "#cccccc"
      ],
      "fill-opacity": 0.7
    }
  });

  map.addSource("explorer-contours", { type: "geojson", data: "data/block_contours.geojson" });
  map.addLayer({
    id: "explorer-contours-line-casing",
    type: "line",
    source: "explorer-contours",
    layout: { visibility: "none" },
    paint: {
      "line-color": LINE_HALO_COLOR,
      "line-width": CONTOUR_LINE_WIDTH + 2 * LINE_HALO_PAD,
      "line-opacity": LINE_HALO_OPACITY
    }
  });
  map.addLayer({
    id: "explorer-contours-line",
    type: "line",
    source: "explorer-contours",
    layout: { visibility: "none" },
    paint: {
      "line-color": "#8a6d3b",
      "line-width": CONTOUR_LINE_WIDTH,
      "line-opacity": 0.85
    }
  });
  map.addLayer({
    id: "explorer-contours-label",
    type: "symbol",
    source: "explorer-contours",
    layout: {
      visibility: "none",
      "symbol-placement": "line",
      "symbol-spacing": 220,
      "text-field": ["get", "label"],
      "text-font": ["Montserrat Regular", "Open Sans Regular", "Noto Sans Regular"],
      "text-size": 10,
      "text-keep-upright": true
    },
    paint: {
      "text-color": "#5c4826",
      "text-halo-color": "#fdf6f0",
      "text-halo-width": 1.4
    }
  });

  // Same symbology as the story map's road layers (see addRoadLayers) - the
  // per-layer filters set here are immediately re-composed with a Block_No
  // clause by the setExplorerBlockFilter() call below.
  map.addSource("explorer-streets", { type: "geojson", data: "data/block_streets.geojson" });
  addRoadLayers(map, {
    source: "explorer-streets",
    haloMainId: "explorer-streets-halo-main",
    haloTrailId: "explorer-streets-halo-trail",
    mainId: "explorer-streets-main",
    trailId: "explorer-streets-trail",
    mainFilter: ROAD_MAIN_FILTER,
    trailFilter: ROAD_TRAIL_FILTER
  });

  // Applies every layer's base filter from EXPLORER_BASE_FILTERS with a
  // Block_No clause that matches nothing, which is the right starting state:
  // no block is framed yet. Doing it here keeps the base filters declared in
  // exactly one place.
  setExplorerBlockFilter(map, null);
}

// Two observers on the same section, with different jobs and thresholds.
//
// 1. Lazily creates the Explorer's map instance the first time the section
//    scrolls anywhere near view, instead of paying for a second full
//    MapLibre instance + five GeoJSON fetches on every page load regardless
//    of whether the reader ever reaches it.
//
// 2. Marks the section as "on screen" (body.explorer-active) while it owns
//    the viewport. The Explorer is a plain in-flow section, not a .chapter,
//    so setupScrollTriggers()' observer never fires for it - without this
//    the docked story map, its fixed legend and the wind arrows would all
//    stay frozen in whatever state the PREVIOUS chapter left them, floating
//    on top of this section and describing layers that aren't on this map.
//    See body.explorer-active in css/style.css.
function initExplorerObserver() {
  const section = document.getElementById("block-explorer");
  if (!section) return;

  const initObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          initExplorerMap();
          initObserver.disconnect();
        }
      });
    },
    { rootMargin: "200px", threshold: 0 }
  );
  initObserver.observe(section);

  const activeObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        document.body.classList.toggle("explorer-active", entry.isIntersecting);
      });
    },
    { threshold: 0.35 }
  );
  activeObserver.observe(section);
}

// --- Map controls -------------------------------------------------------
// Custom-styled overlay controls (fullscreen top-right; home/zoom stacked
// bottom-right) in place of MapLibre's default NavigationControl, so we can
// match the client's reference design instead of the library's stock look.
function initMapControls(map, chapters, layerBounds) {
  const mapEl = document.getElementById("map");
  const fullscreenBtn = document.getElementById("map-fullscreen-btn");
  const homeBtn = document.getElementById("map-home-btn");
  const zoomInBtn = document.getElementById("map-zoom-in-btn");
  const zoomOutBtn = document.getElementById("map-zoom-out-btn");

  if (zoomInBtn) zoomInBtn.addEventListener("click", () => map.zoomIn());
  if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => map.zoomOut());

  if (homeBtn) {
    homeBtn.addEventListener("click", () => {
      const chapter =
        chapters.find((c) => c.id === currentChapterId) || chapters[0];
      flyToChapter(map, chapter, layerBounds);
    });
  }

  if (fullscreenBtn && mapEl) {
    // Snapshot of which chapter the reader was on when they hit fullscreen.
    // currentChapterId is read back on fullscreenchange, and belt-and-braces
    // against anything nudging it in between - this is the chapter the
    // reader actually asked to see full screen.
    let chapterAtFullscreen = null;

    fullscreenBtn.addEventListener("click", () => {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        chapterAtFullscreen = currentChapterId;
        mapEl.requestFullscreen().catch(() => {});
      }
    });

    document.addEventListener("fullscreenchange", () => {
      // Only react to OUR map entering/leaving fullscreen - the Explorer
      // runs a second map with its own fullscreen button, and this handler
      // is on `document`, so it hears that one's events too.
      if (document.fullscreenElement && document.fullscreenElement !== mapEl) return;

      // map.resize() alone just stretches the existing camera: the docked
      // map is a 58%-wide panel, so its center/zoom belong to that viewport,
      // and carrying them into a full-screen canvas leaves the reader
      // looking at a differently-framed (stale-looking) view. Re-run the
      // ACTIVE chapter's fitBounds against the new canvas size instead, with
      // duration 0 so it's already correct the moment fullscreen paints.
      const wantedId = chapterAtFullscreen || currentChapterId;
      window.setTimeout(() => {
        map.resize();
        const chapter = chapters.find((c) => c.id === wantedId) || chapters[0];
        currentChapterId = chapter.id;
        flyToChapter(map, chapter, layerBounds, 0);
      }, 120);
    });
  }
}

// --- Map --------------------------------------------------------------
function initMap(chapters, layerBounds) {
  const map = new maplibregl.Map({
    container: "map",
    // Free, no-API-key vector basemap (CARTO Positron). Swap for any other
    // open style (e.g. OpenFreeMap, MapLibre demo tiles) as needed.
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    center: chapters[0].location.center,
    zoom: chapters[0].location.zoom,
    pitch: chapters[0].location.pitch,
    bearing: chapters[0].location.bearing,
    attributionControl: true,
    // Scroll-wheel input drives the STORY (page scroll), not map zoom -
    // without this, scrolling over the map (which covers the whole
    // viewport) zooms the map instead of advancing chapters.
    scrollZoom: false
  });

  mapInstance = map;

  initMapControls(map, chapters, layerBounds);

  map.on("load", () => {
    // Marin County boundary (macro scale) - real County GIS data, converted
    // from shapefile (EPSG:2872) to WGS84. Outline only, no fill - it's just
    // context for where Homestead Valley sits within the county.
    map.addSource("marin-county", {
      type: "geojson",
      data: "data/marin_county.geojson"
    });
    map.addLayer({
      id: "marin-line",
      type: "line",
      source: "marin-county",
      layout: { visibility: "none" },
      paint: { "line-color": "#4a4a4a", "line-width": 1.5 }
    });

    // Homestead Valley / CSA 14 boundary (micro scale) - real Marin County
    // GIS data (469-acre service area), reprojected to WGS84. One paint
    // treatment only (the bold red highlight) - a second, duplicate black
    // dashed outline used to be layered on top of the same shape and was
    // removed per client feedback ("2 boundaries for CSA14, use only 1").
    //
    // Symbology now switches per chapter (see updateHomesteadBoundaryStyle):
    // bold red only on the chapter that also shows the Marin County outline
    // (so the CSA14 boundary reads clearly against the county context);
    // a subtle black outline + near-transparent black fill on chapters with
    // 0-1 other thematic layers; and a fully transparent fill (line only)
    // on chapters stacking 2+ thematic layers, so the boundary never washes
    // out or gets buried under vegetation/elevation/contours/streets color.
    // Only the FILL layer is added here - the LINE layer is added at the
    // very end of this block (after every thematic layer below) so it's
    // guaranteed to paint on top of all of them, never visually buried.
    map.addSource("homestead", {
      type: "geojson",
      data: "data/homestead.geojson"
    });
    map.addLayer({
      id: "homestead-highlight-fill",
      type: "fill",
      source: "homestead",
      layout: { visibility: "none" },
      paint: { "fill-color": "#000000", "fill-opacity": 0.08 }
    });

    // Terrain / elevation - real USGS 3DEP 1m LIDAR DEM (see topo_work/),
    // GDAL-polygonized (rasterio.features.shapes) into 8 hypsometric-tint
    // classes. Same colormap and class breaks as the reference cartographic
    // PNG (topo_work/homestead_topo_map.png / 09_render_map.py's "hyps"
    // colormap), so the vector map and the static graphic read as one
    // consistent symbology.
    map.addSource("elevation", {
      type: "geojson",
      data: "data/homestead_elevation.geojson"
    });
    map.addLayer({
      id: "elevation-fill",
      type: "fill",
      source: "elevation",
      layout: { visibility: "none" },
      paint: {
        "fill-color": [
          "match",
          ["get", "elev_class"],
            1, "#F0F0F0",
            2, "#D9D9D9", 
            3, "#BDBDBD", 
            4, "#969696",
            5, "#737373", 
            6, "#525252", 
            7, "#353535", 
            8, "#1A1A1A",
          "#cccccc"
        ],
        "fill-opacity": 1
      }
    });

    // Vegetation density (NDVI) - real Sentinel-2-derived classification for
    // this AOI (see ndvi_work/06_ndvi.py), not sample/dummy data. Four
    // classes on a light-to-dark green ramp, used as a visual proxy for fuel
    // load density across the wildland-urban interface.
    map.addSource("vegetation", {
      type: "geojson",
      data: "data/homestead_ndvi_vegetation.geojson"
    });
    map.addLayer({
      id: "vegetation-fill",
      type: "fill",
      source: "vegetation",
      layout: { visibility: "none" },
      paint: {
        "fill-color": [
          "match",
          ["get", "ndvi_class"],
          1, "#d9f0a3",
          2, "#78c679",
          3, "#31a354",
          4, "#006837",
          "#cccccc"
        ],
        "fill-opacity": 0.7
      }
    });

    // Bivariate fuel x elevation - the joint classification behind the
    // "Where Do We Have the Greatest Ability to Intervene?" chapter. Built by
    // bivariate_work/ (01 derives the elevation breaks, 02 the palette, 03
    // does the joint classification + polygonize, 04 QAs the result cold).
    //
    // This is a separate PRE-BUILT layer rather than a restyling of the
    // vegetation and elevation layers because a bivariate map needs a single
    // joint classification on a common grid: the two source layers are
    // polygonized on different grids (Sentinel-2 10 m NDVI vs. a 1 m LIDAR
    // DEM) into different class counts (4 vs. 8), so there is no client-side
    // expression that could pair them up per-polygon.
    //
    // Extent is vegetated ground only (NDVI >= 0.41, under the same 200 m2
    // minimum mapping unit as the vegetation layer - 04's check 9 holds the
    // two footprints to 0.0001%), so the low column means "sparse fuel", not
    // "no fuel". Added here, after elevation and before contours/streets, so
    // roads and contour labels still draw over it and the boundary line added
    // at the end of this block still sits on top.
    map.addSource("bivariate", {
      type: "geojson",
      data: "data/homestead_bivariate.geojson"
    });
    map.addLayer({
      id: "bivariate-fill",
      type: "fill",
      source: "bivariate",
      layout: { visibility: "none" },
      paint: {
        "fill-color": BIVARIATE_FILL_COLOR,
        "fill-opacity": BIVARIATE_FILL_OPACITY
      }
    });

    // Elevation contour lines - real USGS 3DEP-derived contours (see
    // data/homestead_contours.geojson), shown alongside the elevation fill
    // above as the "topo" treatment on chapters that want it. A second
    // label layer calls out contours every CONTOUR_LABEL_INTERVAL_FT along
    // the line itself (text pre-formatted into the "label" property, e.g.
    // "100 ft"), so a reader can read actual elevation off the map instead
    // of just seeing undifferentiated lines. A white casing runs underneath
    // the brown line so both stay legible over the elevation choropleth.
    map.addSource("contours", {
      type: "geojson",
      data: "data/homestead_contours.geojson"
    });
    map.addLayer({
      id: "contours-line-casing",
      type: "line",
      source: "contours",
      layout: { visibility: "none" },
      paint: {
        "line-color": LINE_HALO_COLOR,
        "line-width": CONTOUR_LINE_WIDTH + 2 * LINE_HALO_PAD,
        "line-opacity": LINE_HALO_OPACITY
      }
    });
    map.addLayer({
      id: "contours-line",
      type: "line",
      source: "contours",
      layout: { visibility: "none" },
      paint: {
        "line-color": "#8a6d3b",
        "line-width": CONTOUR_LINE_WIDTH,
        "line-opacity": 0.85
      }
    });
    map.addLayer({
      id: "contours-label",
      type: "symbol",
      source: "contours",
      filter: CONTOUR_LABEL_FILTER,
      layout: {
        visibility: "none",
        "symbol-placement": "line",
        "symbol-spacing": 220,
        "text-field": ["get", "label"],
        "text-font": ["Montserrat Regular", "Open Sans Regular", "Noto Sans Regular"],
        "text-size": 10,
        "text-keep-upright": true
      },
      paint: {
        "text-color": "#5c4826",
        "text-halo-color": "#fdf6f0",
        "text-halo-width": 1.4
      }
    });

    // Road network - real OpenStreetMap extract (see
    // data/homestead_streets.geojson). Split into two layers: through-streets
    // (tertiary/residential) drawn solid, and service drives/footpaths/trails
    // drawn dotted. Same color and same width for both - the dot pattern is
    // the only difference, with a white halo under each so they stay readable
    // over vegetation/elevation fills and where they cross each other.
    map.addSource("streets", {
      type: "geojson",
      data: "data/homestead_streets.geojson"
    });
    addRoadLayers(map, {
      source: "streets",
      haloMainId: "streets-halo-main",
      haloTrailId: "streets-halo-trail",
      mainId: "streets-line-main",
      trailId: "streets-line-trail",
      mainFilter: ROAD_MAIN_FILTER,
      trailFilter: ROAD_TRAIL_FILTER
    });

    // Boundary LINE, added last (see the fill layer added earlier in this
    // block) so it renders on top of every thematic layer above - vegetation,
    // elevation, contours and streets can never visually bury the CSA14
    // outline, whatever combination of them a chapter turns on.
    map.addLayer({
      id: "homestead-highlight-line",
      type: "line",
      source: "homestead",
      layout: { visibility: "none" },
      paint: { "line-color": "#000000", "line-width": 2 }
    });

    buildWindArrows(map, layerBounds.homestead);

    mapLayersReady = true;
    setupScrollTriggers(map, chapters, layerBounds);
  });

  return map;
}

// Matches the CSS transition duration on #map's left/width (see style.css)
// - used to know when it's safe to re-measure the container after a dock
// change, see placeMapForChapter()/setupScrollTriggers() below.
const MAP_DOCK_TRANSITION_MS = 500;

// Tracks whichever side the map was docked to for the previously-active
// chapter, so we only wait out the CSS width transition when the dock
// position is actually changing (not on every scroll).
let lastMapDockPosition = null;

// Docks the single shared full-screen map to the left half, right half, or
// hides it entirely, based on the currently active chapter's "mapPosition".
// This is pure CSS (see body.map-pos-* rules in style.css) - the map never
// moves in the DOM, so no reparenting/resize-glitch handling is needed.
// Returns true if the dock position actually changed (and so the container
// is about to animate to a new width).
function placeMapForChapter(map, chapter) {
  const position = chapter.mapPosition || "none";
  const changed = lastMapDockPosition !== position;
  lastMapDockPosition = position;

  document.body.classList.remove("map-pos-left", "map-pos-right", "map-pos-none");
  document.body.classList.add(`map-pos-${position}`);

  // Nudge MapLibre to recompute its canvas size for whatever the container's
  // size is right now (immediately useful when the dock side didn't change).
  map.resize();
  return changed;
}

function setupScrollTriggers(map, chapters, layerBounds) {
  // Bumped on every chapter change so a delayed fitBounds() from a chapter
  // the reader has already scrolled past never lands after a newer one.
  let flyToken = 0;

  const observer = new IntersectionObserver(
    (entries) => {
      // Going fullscreen hides the browser's own chrome, so the viewport
      // gets taller and every chapter's intersection ratio is recomputed -
      // which pushes a NEIGHBOURING chapter past the 0.5 threshold and
      // silently re-activates it. That was the "fullscreen shows the
      // previous map" bug: the camera flew to the wrong chapter and its
      // layers (wind arrows and their key included) were switched off,
      // all while the reader was staring at the expanded map.
      //
      // Nothing is scrolling while a map is fullscreen, so there is no
      // legitimate chapter change to process here - freeze until we exit.
      if (document.fullscreenElement) return;

      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const chapter = chapters.find((c) => c.id === entry.target.id);
        if (!chapter) return;

        currentChapterId = chapter.id;
        const token = ++flyToken;

        const dockChanging = placeMapForChapter(map, chapter);
        placeMediaForChapter(chapter);

        if (dockChanging) {
          // The map's on-screen width is mid-transition (CSS), so fitBounds()
          // would frame against the wrong (pre-transition) canvas size if run
          // now. Wait for the transition to finish, resize the canvas to its
          // real final size, then frame the camera.
          window.setTimeout(() => {
            if (token !== flyToken) return;
            map.resize();
            flyToChapter(map, chapter, layerBounds);
          }, MAP_DOCK_TRANSITION_MS);
        } else {
          flyToChapter(map, chapter, layerBounds);
        }

        // Chapter-scroll is the "authoritative" layer state - it always wins
        // over whatever a reader manually toggled in the legend while they
        // were on the previous chapter, so the narrative never gets stuck
        // showing/hiding a layer the new chapter didn't ask for.
        Object.keys(LEGEND_LAYER_IDS).forEach((key) => {
          setMapLayerVisibility(key, Boolean(chapter.layers[key]));
        });
        updateHomesteadBoundaryStyle(map, chapter);
        updateThematicLayerStyle(map, chapter);
        updateWindIndicator(chapter);

        updateLegend(chapter.layers);
        updateToolbar(chapter.id, chapters);
      });
    },
    { threshold: 0.5 }
  );

  document.querySelectorAll(".chapter").forEach((el) => observer.observe(el));

  setupFooterRelease();
}

// --- Footer release -------------------------------------------------------
// #map and #media-sidecar are position:fixed so they stay pinned to the
// viewport while the reader scrolls through chapters - that's the whole
// point of the docked-panel effect. But it means that once the reader
// scrolls past the last chapter, the panel would stay glued to the
// viewport and the footer would have to slide up *over* it to become
// visible (a "curtain" effect), rather than the footer simply appearing
// after it like normal content.
//
// Instead, right as the footer is about to enter the viewport, "release"
// whichever panel is currently docked: switch it from fixed to absolute,
// anchored at the exact document position that puts its bottom edge flush
// against the footer's top edge. It keeps whatever it was showing (nothing
// gets hidden/removed) but becomes a normal document-flow element that
// scrolls away with the rest of the page instead of staying pinned - so
// the footer just follows directly beneath it, like any two stacked
// blocks. Scrolling back up above the footer re-pins it to fixed so the
// normal chapter-driven docking resumes.
function setupFooterRelease() {
  const footer = document.getElementById("footer");
  const panels = [document.getElementById("map"), document.getElementById("media-sidecar")].filter(Boolean);
  if (!footer || !panels.length) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const footerTop = entry.boundingClientRect.top + window.scrollY;
          panels.forEach((panel) => {
            const height = panel.getBoundingClientRect().height;
            panel.style.position = "absolute";
            panel.style.top = `${footerTop - height}px`;
          });
        } else {
          panels.forEach((panel) => {
            panel.style.position = "";
            panel.style.top = "";
          });
        }
      });
    },
    { threshold: 0 }
  );

  observer.observe(footer);
}

// --- Nav offset ---------------------------------------------------------
// #header (fixed) and #toolbar (sticky, locks under it) together occupy the
// top of the viewport once the reader scrolls past the hero. Everything
// else that's fixed to the viewport - the docked #map/#media-sidecar panels
// - needs to start below that combined height, and chapter sections need
// enough top clearance that their content doesn't scroll to a stop
// underneath it. Both are driven off one CSS custom property, kept in sync
// here so it never has to be hand-tuned to match the nav's actual rendered
// height (which varies with the two-tier toolbar's content).
function setupNavOffset(headerEl, toolbarEl) {
  if (!headerEl || !toolbarEl) return;

  const update = () => {
    const offset = headerEl.offsetHeight + toolbarEl.offsetHeight;
    document.documentElement.style.setProperty("--nav-offset", `${offset}px`);
    toolbarEl.style.top = `${headerEl.offsetHeight}px`;
  };

  update();

  if (window.ResizeObserver) {
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(headerEl);
    resizeObserver.observe(toolbarEl);
  } else {
    window.addEventListener("resize", update);
  }
}

// --- Bootstrap --------------------------------------------------------
async function bootstrap() {
  const [config, layerBounds] = await Promise.all([
    fetch("data/chapters.json").then((r) => r.json()),
    loadLayerBounds()
  ]);

  applySettings(config.settings);
  applyTheme(config.theme);
  LEGEND_CONFIG = config.legend;

  renderChapters(config.chapters);

  // Toolbar lives right after the hero section (not as a permanently fixed
  // header) so it scrolls normally under the intro and only sticks once the
  // reader scrolls past it - see "position: sticky" on #toolbar in CSS.
  const toolbar = renderToolbar(config.chapters);
  const heroSection = document.querySelector(".chapter.hero");
  const story = document.getElementById("story");
  if (heroSection) {
    heroSection.insertAdjacentElement("afterend", toolbar);
  } else {
    story.prepend(toolbar);
  }

  setupNavOffset(document.getElementById("header"), toolbar);

  renderLegendShell(config.legend);
  renderFooter(config.footer);
  initMap(config.chapters, layerBounds);
  setupVideoPauseOnScrollOut();
  initExplorerObserver();
}

bootstrap();
