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

// --- Chapter rendering ---------------------------------------------------
// Two distinct shapes: a full-bleed hero/title screen (isTitleScreen), and
// regular chapters, which render as a floating text card. Where that card
// sits (and which side the persistent map docks to) is driven per-chapter
// by "mapPosition": "left" | "right" | "none" - see placeMapForChapter().
function renderHeroChapter(story, chapter) {
  const section = document.createElement("section");
  section.className = "chapter hero";
  section.id = chapter.id;
  section.dataset.mapPosition = chapter.mapPosition || "none";

  const bgImage = chapter.image ? chapter.image.src : "";

  section.innerHTML = `
    <div class="hero-bg" style="background-image: linear-gradient(180deg, rgba(0,0,0,0.35), rgba(0,0,0,0.6)), url('${bgImage}')"></div>
    <div class="hero-content">
      ${renderIcon(chapter.icon)}
      ${chapter.eyebrow ? `<p class="eyebrow">${chapter.eyebrow}</p>` : ""}
      <h1>${chapter.title}</h1>
      <p class="hero-lede">${chapter.description}</p>
      <div class="scroll-cue">Scroll to begin<span class="scroll-cue-arrow">&#8595;</span></div>
    </div>
  `;

  story.appendChild(section);
}

function renderChapter(story, chapter) {
  const section = document.createElement("section");
  section.className = "chapter";
  section.id = chapter.id;
  section.dataset.mapPosition = chapter.mapPosition || "none";

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
    <p>${chapter.description}</p>
  `;

  if (chapter.image) {
    const figure = document.createElement("figure");
    figure.innerHTML = `
      <img src="${chapter.image.src}" alt="${chapter.image.alt}" loading="lazy" />
      ${chapter.image.caption ? `<figcaption>${chapter.image.caption}</figcaption>` : ""}
    `;
    content.appendChild(figure);
  }

  if (chapter.video) {
    const videoWrap = document.createElement("div");
    let html = "";

    if (chapter.video.localSrc) {
      html += `
        <div class="video-block">
          <h3>Local video embed (client-supplied file)</h3>
          <video controls preload="none">
            <source src="${chapter.video.localSrc}" type="video/quicktime" />
            Your browser may not support inline .mov playback - swap for an
            .mp4 if this doesn't play.
          </video>
        </div>
      `;
    }

    if (chapter.video.youtubeUrl) {
      const ytId = parseYouTubeId(chapter.video.youtubeUrl);
      if (ytId) {
        html += `
          <div class="video-block">
            <h3>YouTube embed</h3>
            <iframe
              class="yt-embed"
              src="https://www.youtube.com/embed/${ytId}?enablejsapi=1"
              title="YouTube video"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowfullscreen>
            </iframe>
          </div>
        `;
      } else {
        html += `<p><em>Could not parse a video ID from "${chapter.video.youtubeUrl}".</em></p>`;
      }
    }

    videoWrap.innerHTML = html;
    content.appendChild(videoWrap);
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

// --- Video auto-pause when scrolled fully out of view ----------------------
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

function setupVideoPauseOnScrollOut() {
  if (!SETTINGS.pauseVideoOffscreen) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        // threshold 0 fires exactly when a chapter becomes fully hidden
        // (scrolled entirely above or below the viewport) or reappears.
        if (!entry.isIntersecting) {
          pauseMediaIn(entry.target);
        }
      });
    },
    { threshold: 0 }
  );

  document.querySelectorAll(".chapter").forEach((el) => observer.observe(el));
}

// --- Legend ---------------------------------------------------------------
function renderLegendShell(legendConfig) {
  const legend = document.getElementById("legend");
  if (!legendConfig) return;

  legend.classList.toggle("legend-right", SETTINGS.legendPosition === "right");
  // Start hidden - updateLegend() reveals it once a chapter with an active
  // layer scrolls into view, so there's no empty box flash before then.
  legend.classList.add("legend-hidden");

  Object.entries(legendConfig).forEach(([layerKey, section]) => {
    const box = document.createElement("div");
    box.className = "legend-section";
    box.dataset.layer = layerKey;

    const itemsHtml = section.items
      .map(
        (item) => `
          <div class="legend-item">
            <span class="legend-swatch" style="background:${item.color}"></span>
            <span>${item.label}</span>
          </div>
        `
      )
      .join("");

    box.innerHTML = `<h4>${section.title}</h4>${itemsHtml}`;
    legend.appendChild(box);
  });
}

function updateLegend(activeLayers) {
  const legend = document.getElementById("legend");
  const anyActive = Object.values(activeLayers).some(Boolean);
  legend.classList.toggle("legend-hidden", !anyActive);

  document.querySelectorAll(".legend-section").forEach((section) => {
    const key = section.dataset.layer;
    section.classList.toggle("active", Boolean(activeLayers[key]));
  });
}

// --- Map --------------------------------------------------------------
function initMap(chapters) {
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

  map.addControl(new maplibregl.NavigationControl(), "top-right");

  map.on("load", () => {
    map.addSource("risk-zone", {
      type: "geojson",
      data: "data/sample-risk-zone.geojson"
    });
    map.addLayer({
      id: "risk-zone-fill",
      type: "fill",
      source: "risk-zone",
      layout: { visibility: "none" },
      paint: {
        // Data-driven symbology: color keyed off the riskLevel property,
        // the same way a real hazard-severity or vegetation-risk layer
        // would be styled.
        "fill-color": [
          "match",
          ["get", "riskLevel"],
          "High", "#c0392b",
          "Moderate", "#e67e22",
          "#999999"
        ],
        "fill-opacity": 0.45
      }
    });
    map.addLayer({
      id: "risk-zone-outline",
      type: "line",
      source: "risk-zone",
      layout: { visibility: "none" },
      paint: { "line-color": "#7b241c", "line-width": 2 }
    });

    map.addSource("points", {
      type: "geojson",
      data: "data/sample-points.geojson"
    });
    map.addLayer({
      id: "points-circle",
      type: "circle",
      source: "points",
      layout: { visibility: "none" },
      paint: {
        "circle-radius": 7,
        "circle-color": "#2c3e91",
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 2
      }
    });

    // CSA 14 (Homestead Valley) boundary. This is a DUMMY placeholder shape
    // for now (data/dummy-csa14-boundary.geojson) - swap the "data" path
    // below for the real converted-shapefile GeoJSON once it's ready; no
    // other code needs to change since the source/layer wiring stays the
    // same either way.
    map.addSource("csa14", {
      type: "geojson",
      data: "data/dummy-csa14-boundary.geojson"
    });
    map.addLayer({
      id: "csa14-fill",
      type: "fill",
      source: "csa14",
      layout: { visibility: "none" },
      paint: {
        "fill-color": "#1c1c1c",
        "fill-opacity": 0.08
      }
    });
    map.addLayer({
      id: "csa14-line",
      type: "line",
      source: "csa14",
      layout: { visibility: "none" },
      paint: {
        "line-color": "#1c1c1c",
        "line-width": 2.5,
        "line-dasharray": [2, 1.5]
      }
    });

    setupScrollTriggers(map, chapters);
  });

  return map;
}

// Docks the single shared full-screen map to the left half, right half, or
// hides it entirely, based on the currently active chapter's "mapPosition".
// This is pure CSS (see body.map-pos-* rules in style.css) - the map never
// moves in the DOM, so no reparenting/resize-glitch handling is needed.
function placeMapForChapter(map, chapter) {
  const position = chapter.mapPosition || "none";
  document.body.classList.remove("map-pos-left", "map-pos-right", "map-pos-none");
  document.body.classList.add(`map-pos-${position}`);

  // The map's on-screen width just changed (or is changing via CSS
  // transition) - nudge MapLibre to recompute its canvas size, both
  // immediately and once the transition settles.
  map.resize();
  window.setTimeout(() => map.resize(), 450);
}

function setupScrollTriggers(map, chapters) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const chapter = chapters.find((c) => c.id === entry.target.id);
        if (!chapter) return;

        placeMapForChapter(map, chapter);
        map.flyTo({ ...chapter.location, duration: 1200 });

        const riskVisibility = chapter.layers.risk ? "visible" : "none";
        const pointsVisibility = chapter.layers.points ? "visible" : "none";
        const csa14Visibility = chapter.layers.csa14 ? "visible" : "none";
        map.setLayoutProperty("risk-zone-fill", "visibility", riskVisibility);
        map.setLayoutProperty("risk-zone-outline", "visibility", riskVisibility);
        map.setLayoutProperty("points-circle", "visibility", pointsVisibility);
        map.setLayoutProperty("csa14-fill", "visibility", csa14Visibility);
        map.setLayoutProperty("csa14-line", "visibility", csa14Visibility);

        updateLegend(chapter.layers);
      });
    },
    { threshold: 0.5 }
  );

  document.querySelectorAll(".chapter").forEach((el) => observer.observe(el));
}

// --- Bootstrap --------------------------------------------------------
async function bootstrap() {
  const response = await fetch("data/chapters.json");
  const config = await response.json();

  applySettings(config.settings);
  applyTheme(config.theme);

  renderChapters(config.chapters);
  renderLegendShell(config.legend);
  renderFooter(config.footer);
  initMap(config.chapters);
  setupVideoPauseOnScrollOut();
}

bootstrap();
