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
  elevation: ["elevation-fill"]
};

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
  default: { fillColor: "#000000", fillOpacity: 0.08, lineColor: "#000000", lineWidth: 2 }
};

function updateHomesteadBoundaryStyle(map, chapter) {
  if (!map || !mapLayersReady) return;
  const style = chapter && chapter.layers && chapter.layers.marin
    ? HOMESTEAD_BOUNDARY_STYLES.marin
    : HOMESTEAD_BOUNDARY_STYLES.default;
  map.setPaintProperty("homestead-highlight-fill", "fill-color", style.fillColor);
  map.setPaintProperty("homestead-highlight-fill", "fill-opacity", style.fillOpacity);
  map.setPaintProperty("homestead-highlight-line", "line-color", style.lineColor);
  map.setPaintProperty("homestead-highlight-line", "line-width", style.lineWidth);

  // Keep the legend swatch honest - it should show whichever boundary
  // color/line-width is actually live on the map right now, not a fixed
  // color baked into chapters.json.
  const swatch = document.querySelector('.legend-section[data-layer="homesteadHighlight"] .legend-swatch');
  if (swatch) swatch.style.background = style.lineColor;
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
// its media either place via "mediaPosition": "inline" | "left" | "right".

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

  // The text card docks opposite whichever side panel is active for this
  // chapter - the map if "mapPosition" is set, otherwise the media sidecar
  // if "mediaPosition" is "left"/"right", otherwise centered ("none").
  const dockPosition =
    chapter.mapPosition && chapter.mapPosition !== "none"
      ? chapter.mapPosition
      : chapter.mediaPosition && chapter.mediaPosition !== "inline"
      ? chapter.mediaPosition
      : "none";
  section.dataset.mapPosition = dockPosition;

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
    const box = document.createElement("div");
    box.className = "legend-section";
    box.dataset.layer = layerKey;
    // Each section IS the toggle - a reader clicks/taps/Enter-Space's the
    // whole swatch group to flip that map layer on or off, independent of
    // whatever the current chapter set it to (see setMapLayerVisibility()
    // and the click handler below).
    box.setAttribute("role", "switch");
    box.setAttribute("tabindex", "0");
    box.setAttribute("aria-checked", "false");
    box.setAttribute("aria-label", `Toggle ${section.title} map layer`);

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

    box.innerHTML = `
      <div class="legend-header">
        <h4>${section.title}</h4>
        <span class="legend-toggle" aria-hidden="true"><span class="legend-toggle-thumb"></span></span>
      </div>
      ${itemsHtml}
    `;
    legend.appendChild(box);

    const toggleLayer = () => {
      const nowActive = !box.classList.contains("active");
      box.classList.toggle("active", nowActive);
      box.setAttribute("aria-checked", String(nowActive));
      setMapLayerVisibility(layerKey, nowActive);
    };
    box.addEventListener("click", toggleLayer);
    box.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleLayer();
      }
    });
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
    chapter.mediaPosition === "left" || chapter.mediaPosition === "right"
      ? chapter.mediaPosition
      : "none";

  document.body.classList.remove("media-pos-left", "media-pos-right", "media-pos-none");
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
function flyToChapter(map, chapter, layerBounds) {
  const bounds = chapter.fitToLayer && layerBounds[chapter.fitToLayer];
  if (bounds) {
    map.fitBounds(bounds, {
      padding: chapter.fitPadding || 60,
      pitch: chapter.location.pitch || 0,
      bearing: chapter.location.bearing || 0,
      duration: 1200
    });
  } else {
    map.flyTo({ ...chapter.location, duration: 1200 });
  }
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
    fullscreenBtn.addEventListener("click", () => {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        mapEl.requestFullscreen().catch(() => {});
      }
    });
    document.addEventListener("fullscreenchange", () => {
      window.setTimeout(() => map.resize(), 100);
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
    // a subtle black outline + near-transparent black fill everywhere else,
    // so it doesn't compete with the vegetation/elevation layers. Default
    // paint below is the "everywhere else" state.
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
    map.addLayer({
      id: "homestead-highlight-line",
      type: "line",
      source: "homestead",
      layout: { visibility: "none" },
      paint: { "line-color": "#000000", "line-width": 2 }
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
        "fill-opacity": 0.6
      }
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
          1, "#c9e2b6",
          2, "#a8d18c",
          3, "#cfe0a0",
          4, "#e8dfa8",
          5, "#dfc389",
          6, "#cba173",
          7, "#b8835f",
          8, "#e8ddd3",
          "#cccccc"
        ],
        "fill-opacity": 0.75
      }
    }, "homestead-highlight-line");

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
}

bootstrap();
