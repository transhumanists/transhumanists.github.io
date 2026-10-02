/* Interactive world map — projection + event plotting
 * No external dependencies. Equirectangular projection with smooth pan/zoom.
 * Includes day/night terminator overlay (sun position).
 */
(function() {
  'use strict';

  if (window.__WORLDMAP_INIT__) return;
  window.__WORLDMAP_INIT__ = true;

  const canvas = document.getElementById('world-map-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const tooltip = document.getElementById('map-tooltip');

  // ---- Constants ----
  const TERMINATOR_SAMPLES = 180;
  const TERMINATOR_UPDATE_MS = 60000;
  const DRAW_INTERVAL_MS = 100;
  const MIN_SCALE = 0.5;
  const MAX_SCALE = 8;
  const ZOOM_FACTOR = 1.1; // Used by zoomAt for keyboard/button zoom steps
  const HIT_RADIUS_BASE = 10;
  const CLICK_DRAG_THRESHOLD = 5;
// Default-view latitude window. The window is asymmetric on purpose: the land is
  // not symmetric about the equator, and a symmetric window leaves a wide empty
  // band of Southern Ocean below Antarctica while crowding the Arctic against the
  // top edge. +76 / -66 keeps every landmass in frame (the dataset's extremes are
  // 59.4N and 13.5S), trims the dead space underneath, and gives the northern
  // coastlines room. The span is also slightly smaller than the previous symmetric
  // +/-72, which zooms the geometry in a little as requested.
  const MAP_LAT_NORTH = 76;
  const MAP_LAT_SOUTH = -66;
  const MAP_LAT_SPAN = MAP_LAT_NORTH - MAP_LAT_SOUTH;
  // Terminator reach. Deliberately WIDER than the visible frame, so both the
  // boundary curves and the night fill extend past the top and bottom edges.
  //
  // Stopping inside the frame was the bug: the night band is a closed polygon, so
  // wherever it ended it left a straight horizontal seam across the full canvas
  // width. That seam was drawn over the Arctic landmass and read as a grey band
  // lying on top of the map rather than as part of the globe.
  //
  // Beyond ~66.6 degrees at the solstices the hour angle saturates and the
  // boundary longitude becomes constant, so the curve runs vertically off the
  // frame edge - which is exactly the "terminator curving off the globe" look,
  // and is also physically right: at high latitude a pole is either fully dark or
  // fully lit, so the night side spans a full 180 degrees of longitude there
  // instead of pinching to a point.
  const TERMINATOR_LAT_LIMIT = 84;
  const TOOLTIP_WIDTH = 260;
  const TOOLTIP_HEIGHT = 100;
  const TOOLTIP_OFFSET = 12;

  // Day/night palette. Deliberately disjoint from every CATEGORY_COLORS value
  // so the terminator never visually collides with a milestone category.
  const DAY_TINT = 'rgba(140, 200, 255, 0.07)';
  // The night shade. NIGHT_FILL_CLEAR and the RGB-triple indirection existed only
  // for the polar-cap gradient, which no longer exists: the band is now sampled
  // past both edges of the frame, so there is no seam to fade out.
  const NIGHT_FILL = 'rgba(2, 6, 14, 0.45)';
  const SUNSET_BOUNDARY = 'rgba(255, 222, 178, ALPHA)';
  const SUNRISE_BOUNDARY = 'rgba(176, 188, 255, ALPHA)';
  const SUN_ICON = '#fff3c4';
  const SUN_ICON_GLOW = '#fff3c4';
  const MOON_ICON = '#c9d0ff';
  const MOON_ICON_GLOW = '#c9d0ff';

  // Operational layers (conflict zones + tracked deployments).
  const ZONE_COLOR = '#ff6d8a';
  // Crisis zones (humanitarian): distinct purple to differentiate from conflict (red) and deployments (blue/amber)
  const CRISIS_COLOR = '#b388ff';
  // Ground deployments (mobilizations, troop movements): distinct amber/orange
  const GROUND_COLOR = '#ffb347';
  const FLEET_COLOR = '#4fc3f7';
// Human Rights Violations landmark. Deliberately outside the category palette so
// the layer can never be mistaken for a milestone category in the legend.
const HUMAN_RIGHTS_COLOR = '#ff7043';
// One full swell-and-fade cycle for a landmark. Long enough to read as a
// breath rather than a flicker, short enough that the layer feels live.
const HUMAN_RIGHTS_PULSE_MS = 2400;

  // Landmark geometry, in screen pixels, shared by the renderer and the hit test.
  //
  // These are deliberately one set of constants. The hit radius used to be a
  // hardcoded 12px while the pulsing glow reached 24px, so the visible halo was
  // twice as large as the clickable area and aiming at it did nothing. Deriving
  // the hit radius from the same numbers the renderer uses makes that
  // unrepresentable.
  const HUMAN_RIGHTS_CORE_MIN = 3;
  const HUMAN_RIGHTS_CORE_MAX = 8;
  const HUMAN_RIGHTS_CORE_ACTIVE = 5;   // nominal core radius, active entry
  const HUMAN_RIGHTS_CORE_DONE = 3.5;   // nominal core radius, concluded entry
  const HUMAN_RIGHTS_GLOW_INNER = 1.9;  // glow radius at the trough of the pulse
  const HUMAN_RIGHTS_GLOW_PULSE = 1.1; // extra glow radius at the peak
  // Widest the landmark ever paints itself, therefore the widest the pointer may
  // reasonably be from its centre and still count as "on" it.
  const HUMAN_RIGHTS_HIT_RADIUS =
    HUMAN_RIGHTS_CORE_MAX * (HUMAN_RIGHTS_GLOW_INNER + HUMAN_RIGHTS_GLOW_PULSE);
  // Very transparent arrow tail line (barely visible) — 8% opacity
  const ARROW_TAIL_OPACITY = 0.08;

  // ---- Layer lifecycle (active/concluded + duration) ----
  // Operational layers now carry an optional lifecycle: still-active zones,
  // crises and deployments are drawn with a distinct "fluo" glow, while
  // concluded ones render dim and expose their full duration in the tooltip.
  const STATUS_ACTIVE = 'active';
  const STATUS_CONCLUDED = 'concluded';

  // Timeline slider state, declared up here because layerCurrentYear() (below) and
  // the layer renderers all read it. It used to live ~2800 lines further down,
  // which worked only because nothing called those functions during module
  // evaluation — a fragile ordering dependency for a load-bearing value.
  // The floor is a deliberate UI/perf choice: a first-time visitor sees the full
  // set and the slider clusters within a recent window, so a layer concluded
  // wholly before TIMELINE_MIN_YEAR would never be reachable at any position.
  // 1945 covers the full historical milestone archive (Trinity test, ENIAC, etc.).
  let timelineYear = new Date().getFullYear(); // current year by default
  const TIMELINE_MIN_YEAR = 1945;
  function getTimelineMaxYear() { return new Date().getFullYear(); }

  const FLUO_GLOW_BLUR = 26;
  const FLUO_LINE_GLOW_BLUR = 9;
  const FLUO_PULSE_RADIUS = 10;
  // Passive-area ladder, deliberately a visible multi-step ladder rather than a
  // single "off" look: hot (full fluo glow) > quiet (no glow, desaturated, dark
  // fill) > cold (darkest, long-running background) > done (ghost outline only).
  // The stroke alpha matters more than the fill: it is what makes a ring legible
  // over the ocean. Keyed by the layerPaintTier() values so the three layer
  // renderers share one palette.
  const LAYER_TIER_PAINT = {
    // Active and recent: the only tier allowed to glow.
    hot: { fill: 0.30, stroke: 1.0, halo: 0.16, line: 3, desat: 0, glow: true, pulse: true },
    // Active but not current (or single-list sourced, or no recency signal).
    quiet: { fill: 0.14, stroke: 0.42, halo: 0, line: 1.5, desat: 0.55, glow: false, pulse: false },
    // Active and long-running background.
    cold: { fill: 0.07, stroke: 0.22, halo: 0, line: 1, desat: 0.75, glow: false, pulse: false },
    // Concluded: ghost only.
    done: { fill: 0.05, stroke: 0.20, halo: 0, line: 1, desat: 0.80, glow: false, pulse: false },
  };
  // Centre-marker alpha per tier, so a "hot" dot still reads as a live point
  // rather than a hole in the ring.
  const LAYER_TIER_CENTER_ALPHA = { hot: 1, quiet: 0.55, cold: 0.32, done: 0.26 };
  // Deployment arrows use their own alpha table rather than being derived from the
  // area-ring fill above. An arrow is a thin 1px line, not a filled disc, so it
  // needs a much higher alpha to read at all - deriving it from the ring's fill
  // (dividing by the hot value) meant retuning a ring silently retuned every
  // arrow on the map.
  const LAYER_TIER_ARROW = {
    hot: { tail: 1.0, head: 1.0, line: 2.2 },
    quiet: { tail: 0.45, head: 0.55, line: 1.5 },
    cold: { tail: 0.28, head: 0.34, line: 1.2 },
    done: { tail: 0.18, head: 0.22, line: 1.2 },
  };
  /**
   * Decimal places for coordinate rounding when clustering events into stacks.
   * 4 dp ≈ 11 m at the equator — tight enough to merge only truly co-located events.
   * @type {number}
   */
  const STACK_ROUND_DIGITS = 4;
  const STACK_FAN_DX = 3;
  const STACK_FAN_DY = -3;

  function withOpacity(hexColor, opacity) {
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }

  function desaturateHex(hexColor, amount) {
    if (typeof hexColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hexColor)) {
      return hexColor; // Return as-is for invalid input (fail-open for rendering)
    }
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);
    const grey = Math.round((r + g + b) / 3);
    const mix = (c) => Math.round(c + (grey - c) * amount);
    const to2 = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
    return `#${to2(mix(r))}${to2(mix(g))}${to2(mix(b))}`;
  }

  // Normalize a layer entry's lifecycle status. Missing/`active`/`ongoing`
  // mean the marker is still live (fluo glow); anything explicitly ended
  // (`concluded`, `inactive`, `ended`, `resolved`) maps to the dimmed state.
  function layerStatus(item) {
    const s = String(item && (item.status || '')).toLowerCase();
    return s === '' || s === 'active' || s === 'ongoing' ? STATUS_ACTIVE : STATUS_CONCLUDED;
  }

  function isLayerActive(item) {
    return layerStatus(item) === STATUS_ACTIVE;
  }

  // The year the layer is being judged against. `timelineYear` is the single
  // source of truth for the slider position; this used to read a `state.timelineYear`
  // that nothing ever assigned, so the field was permanently undefined and the
  // fallback silently won — staleness was judged against the wall clock even with
  // the slider parked in the past, marking layers stale that were fresh in the
  // year being displayed.
  function layerCurrentYear() {
    return timelineYear;
  }

  // ---- Layer recency tiers ----
  // How current a layer looks, judged against the year the map is displaying.
  //
  // `last_news_year` is a recency *proxy*, not a literal last-reported date: for
  // Wikipedia-derived layers sync_layers.py fills it from the conflict's start
  // column (recent start = current, 1948 start = long-running), and curated
  // news-derived layers carry their own value. Crises and most deployments ship no
  // `last_news_year` at all, so start_date is the only signal they have.
  //
  // Tiers, brightest to dimmest:
  //   hot   - active and recent. Neon glow + pulse. Reserved for this.
  //   quiet - active but not recent, or no recency signal, or single-list sourced.
  //   cold  - active and long-running. Dark and desaturated.
  //   done  - concluded. Ghost outline, no fill.
  // Absence of a recency signal is deliberately NOT treated as current: showing a
  // layer as "hot" because we know nothing about it would misrepresent it, and the
  // whole point of the ladder is that neon means "active and recent".
  const TIER_HOT = 'hot';
  const TIER_QUIET = 'quiet';
  const TIER_COLD = 'cold';
  const TIER_DONE = 'done';
  // Age (in years, vs the displayed year) at or below which an active layer is
  // still "hot". 3 keeps the 2024 deployments and 2022-23 conflicts lit while
  // pushing 2022-and-older material down a tier.
  const LAYER_FRESH_YEARS = 3;
  // Beyond this the layer reads as long-running background rather than news.
  const LAYER_STALE_YEARS = 15;

  // Wikipedia's "List of ongoing armed conflicts" is a single community-maintained
  // list. It is a reasonable catalogue of what is *listed*, not corroboration that
  // each entry is currently active, so a zone sourced only from it is never
  // rendered in the neon "hot" treatment - it is capped at `quiet` regardless of
  // how recent its start year looks. Zones that also carry a named authority
  // (UN OCHA, IMSC, ISW, ...) are unaffected.
  const WIKI_CONFLICT_SOURCE = 'wikipedia (list of ongoing armed conflicts)';
  function isSingleListSourced(item) {
    const s = String((item && item.source) || '').toLowerCase();
    return s.includes('wikipedia');
  }

  // The recency signal for a layer, in years, or null when it carries none.
  function layerRecencyYear(item) {
    const news = item && item.last_news_year;
    if (typeof news === 'number' && Number.isFinite(news)) return news;
    const start = normalizeLayerDate(layerStartDate(item));
    return start ? parseInt(start.slice(0, 4), 10) : null;
  }

  // Single source of truth for how a layer should be painted. drawZone,
  // drawCrisis and drawFleet all switch on this so the three layer types can
  // never drift into disagreeing about what "active" looks like.
  function layerTier(item) {
    if (!isLayerActive(item)) return TIER_DONE;
    const recency = layerRecencyYear(item);
    if (recency === null) return TIER_QUIET;          // no signal -> not "hot"
    const age = layerCurrentYear() - recency;
    // A recency marker *after* the displayed year means the signal lies outside
    // the window being viewed (the slider is parked before the layer's data). That
    // is not evidence the layer is current, so it must not reach the neon tier.
    if (age < 0) return TIER_QUIET;
    if (age > LAYER_STALE_YEARS) return TIER_COLD;
    if (age <= LAYER_FRESH_YEARS) return TIER_HOT;
    return TIER_QUIET;
  }

  // The tier actually painted, after the single-list-sourcing cap.
  function layerPaintTier(item) {
    const tier = layerTier(item);
    if (tier === TIER_HOT && isSingleListSourced(item)) return TIER_QUIET;
    return tier;
  }

  // Retained for callers that only need the old boolean. "Stale" now means
  // "anything that should not read as current", which is quiet or cold.
  function isStaleLayer(item) {
    const tier = layerPaintTier(item);
    return tier === TIER_QUIET || tier === TIER_COLD;
  }

  // Accept YYYY-MM-DD, YYYY-MM or just YYYY (the forms sync_layers.py writes)
  // and normalize to a comparable YYYY-MM-DD, or null when absent/unparsable.
  function normalizeLayerDate(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    if (!s) return null;
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) return isoMatch[0];
    const monthMatch = s.match(/^(\d{4})-(\d{2})$/);
    if (monthMatch) return `${monthMatch[1]}-${monthMatch[2]}-01`;
    const yearMatch = s.match(/^(\d{4})$/);
    if (yearMatch) return `${yearMatch[1]}-01-01`;
    return parseDateToISO(s);
  }

  function layerStartDate(item) { return item && (item.start_date || item.startDate); }
  function layerEndDate(item) { return item && (item.end_date || item.endDate); }

  // Humanized lifecycle line shown in layer tooltips: active markers say how
  // long they have been live; concluded ones show the complete duration span.
  function layerActivityLabel(item) {
    const start = normalizeLayerDate(layerStartDate(item));
    const end = normalizeLayerDate(layerEndDate(item));
    if (isLayerActive(item)) return start ? `Active since ${start}` : 'Active';
    if (start && end) {
      const days = Math.max(1, 1 + Math.round(
        (Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000
      ));
      return `Concluded · ${days} day${days === 1 ? '' : 's'} (${start} → ${end})`;
    }
    if (start) return `Concluded · ran from ${start}`;
    if (end) return `Concluded · ended ${end}`;
    return 'Concluded';
  }

  // Whether a layer entry was (or is) live during `year`. Active entries appear
  // from their start year onward (so a conflict begun in 2022 stays on the map
  // at 2025); concluded entries stay visible only inside their active window.
  // Entries without dates default to visible in every year (backwards-compatible).
  function layerVisibleInYear(item, year) {
    const start = normalizeLayerDate(layerStartDate(item));
    const end = normalizeLayerDate(layerEndDate(item));
    const startYear = start ? parseInt(start.slice(0, 4), 10) : null;
    const endYear = end ? parseInt(end.slice(0, 4), 10) : null;
    if (isLayerActive(item)) return startYear === null || year >= startYear;
    if (startYear !== null && endYear !== null) return year >= startYear && year <= endYear;
    if (startYear !== null) return year >= startYear;
    if (endYear !== null) return year <= endYear;
    return true;
  }

  // Smart pluralization helper
  function pluralize(count, singular, plural) {
    if (count === 1) return singular;
    return plural;
  }

  // Geocoding cache for intelligent fallback
  const GEOCODE_CACHE_KEY = 'worldmap_geocode_cache_v1';
  const GEOCODE_CACHE_MAX_SIZE = 500;
  // Ceiling on the serialized cache we will even attempt to parse. Each entry is
  // a short "source|title|category" key plus a 2-number object, so a full cache
  // is well under 100 kB; this is a cheap guard against a hand-edited or
  // hostile localStorage value forcing an unbounded JSON.parse on the main thread
  // during page load. The entry-count trim below is the real size control.
  const GEOCODE_CACHE_MAX_BYTES = 512 * 1024;

  // Upper bound on the persisted hidden-category list. Nine canonical names is a few
  // hundred bytes; anything past this is a hand-edited or hostile value.
  const HIDDEN_CATEGORIES_MAX_BYTES = 4 * 1024;

  // Single source of truth for the source-link URL scheme gate.
  // Every renderer (worldmap, dashboard, widgets) must test the raw string
  // against this before assigning to href. A mismatched gate would either
  // let a javascript: URL through or fail CI on data the browser accepts.
  const SOURCE_URL_RE = /^https?:\/\//i;

  // JSON.parse can succeed on the wrong type - the string "null" parses to null -
  // and every later geocodeCache[cacheKey] would then throw. loadEvents catches
  // that and falls back to sample data, so a corrupt cache entry would silently
  // replace the whole map with four sample events. Only a non-null object is
  // usable, so everything else starts from an empty cache.
  function parseGeocodeCache(raw) {
    // Length is checked before parsing, not after: the point is to never hand an
    // arbitrarily large string to JSON.parse on the load path.
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > GEOCODE_CACHE_MAX_BYTES) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      return (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  let geocodeCache = {};
  try {
    const cached = localStorage.getItem(GEOCODE_CACHE_KEY);
    if (cached) geocodeCache = parseGeocodeCache(cached);
    // Enforce max size on load in case the stored cache grew beyond the limit.
    const keys = Object.keys(geocodeCache);
    if (keys.length > GEOCODE_CACHE_MAX_SIZE) {
      const toRemove = keys.length - GEOCODE_CACHE_MAX_SIZE;
      keys.slice(0, toRemove).forEach(k => delete geocodeCache[k]);
    }
  } catch (_) {}

  let geocodeCacheDirty = false;
  let geocodeCacheIntervalId = null;
  function saveGeocodeCache() {
    if (!geocodeCacheDirty) return;
    try {
      localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(geocodeCache));
      geocodeCacheDirty = false;
    } catch (_) {}
  }
  // Flush and stop the periodic writer. Named (not an inline arrow) so cleanup()
  // can detach it: the listeners used to be anonymous, so a teardown that did not
  // happen to be a page unload left them attached to a dead interval. Idempotent,
  // because both beforeunload and pagehide fire on a normal navigation.
  function flushAndStopGeocodeCache() {
    saveGeocodeCache();
    if (geocodeCacheIntervalId) {
      clearInterval(geocodeCacheIntervalId);
      geocodeCacheIntervalId = null;
    }
  }
  // Persist cache periodically and on unload
  geocodeCacheIntervalId = setInterval(saveGeocodeCache, 30000);
  window.addEventListener('beforeunload', flushAndStopGeocodeCache);
  window.addEventListener('pagehide', flushAndStopGeocodeCache);

  // Known institution coordinates for intelligent geocoding fallback
  const INSTITUTION_COORDS = {
    'arxiv': { lat: 42.4440, lon: -76.5019 }, // Cornell University, Ithaca NY
    'cornell': { lat: 42.4440, lon: -76.5019 },
    'cornell university': { lat: 42.4440, lon: -76.5019 },
    'mit': { lat: 42.3601, lon: -71.0942 },
    'stanford': { lat: 37.4275, lon: -122.1697 },
    'harvard': { lat: 42.3770, lon: -71.1167 },
    'berkeley': { lat: 37.8719, lon: -122.2585 },
    'cmu': { lat: 40.4433, lon: -79.9438 },
    'caltech': { lat: 34.1377, lon: -118.1253 },
    'princeton': { lat: 40.3440, lon: -74.6514 },
    'yale': { lat: 41.3111, lon: -72.9267 },
    'columbia': { lat: 40.8075, lon: -73.9626 },
    'chicago': { lat: 41.7886, lon: -87.5987 },
    'ucla': { lat: 34.0689, lon: -118.4452 },
    'ucsd': { lat: 32.8801, lon: -117.2340 },
    'eth zurich': { lat: 47.3769, lon: 8.5417 },
    'epfl': { lat: 46.5197, lon: 6.5667 },
    'oxford': { lat: 51.7548, lon: -1.2544 },
    'cambridge': { lat: 52.2053, lon: 0.1218 },
    'deepmind': { lat: 51.5074, lon: -0.1278 },
    'google': { lat: 37.4220, lon: -122.0841 },
    'openai': { lat: 37.7749, lon: -122.4194 },
    'anthropic': { lat: 37.7749, lon: -122.4194 },
    'nvidia': { lat: 37.3688, lon: -122.0363 },
    'ibm': { lat: 41.0323, lon: -73.5543 },
    'microsoft': { lat: 47.6062, lon: -122.3321 },
    'meta': { lat: 37.4848, lon: -122.1484 },
    'apple': { lat: 37.3349, lon: -122.0090 },
    'amazon': { lat: 47.6062, lon: -122.3321 },
    'spacex': { lat: 28.5728, lon: -80.6490 },
    'nasa': { lat: 28.5237, lon: -80.6810 },
    'jaxa': { lat: 35.6762, lon: 139.6503 },
    'esa': { lat: 48.9219, lon: 2.3646 },
    'cern': { lat: 46.2333, lon: 6.0500 },
    'llnl': { lat: 37.6881, lon: -121.7045 },
    'nifs': { lat: 35.6762, lon: 139.6503 },
    'ipp': { lat: 54.0956, lon: 13.4725 },
    'quantinuum': { lat: 51.5074, lon: -0.1278 },
    'qutech': { lat: 52.0116, lon: 4.3571 },
    'broad': { lat: 42.3375, lon: -71.1061 },
    'neuralink': { lat: 37.4861, lon: -122.1519 },
    'dexcom': { lat: 32.8844, lon: -117.2340 },
    'thermofisher': { lat: 44.4268, lon: -123.0764 },
    'hms': { lat: 42.3375, lon: -71.1061 },
    'mpi-cbg': { lat: 51.0504, lon: 13.7373 },
    'sparktx': { lat: 39.9526, lon: -75.1652 },
    'jcvi': { lat: 32.7157, lon: -117.1611 },
    'quantumscape': { lat: 37.5485, lon: -122.0591 },
    'autogpt': { lat: 37.7749, lon: -122.4194 },
    'cncell': { lat: 31.2304, lon: 121.4737 },
    'intel': { lat: 45.5215, lon: -122.6774 },
    'amd': { lat: 37.4220, lon: -122.0841 },
    'tsmc': { lat: 24.7867, lon: 120.9969 },
    'asml': { lat: 51.5900, lon: 5.0500 },
    'samsung': { lat: 37.2636, lon: 127.0286 },
    'hzdr': { lat: 51.2323, lon: 13.6830 },
    'nist': { lat: 38.8951, lon: -77.0364 },
    'csrc': { lat: 38.8951, lon: -77.0364 },
    'cisa': { lat: 38.8951, lon: -77.0364 },
    'nvd': { lat: 38.8951, lon: -77.0364 },
    'usaf': { lat: 38.8951, lon: -77.0364 },
    'norad': { lat: 38.8951, lon: -77.0364 },
    'us navy': { lat: 36.8508, lon: -76.2995 },
    'rafael': { lat: 32.0853, lon: 34.7818 },
    'idf': { lat: 32.0853, lon: 34.7818 },
    'almaz-antey': { lat: 55.7558, lon: 37.6173 },
    'nato': { lat: 50.8609, lon: 4.3676 },
    'ismsc': { lat: 13.5, lon: 43.0 },
    'unocha': { lat: 31.3, lon: 34.3 },
    'isw': { lat: 48.0, lon: 37.8 },
    'usni': { lat: 38.8951, lon: -77.0364 },
    'rn': { lat: 50.8, lon: -1.1 },
    'iiss': { lat: 51.5074, lon: -0.1278 },
    'india': { lat: 19.0, lon: 72.8 },
    'plan': { lat: 26.7, lon: 114.0 },
    'iaea': { lat: 48.2082, lon: 16.3738 },
    'who_org': { lat: 46.2276, lon: 6.1424 },
    'un_org': { lat: 40.7580, lon: -73.9683 },
    'fda': { lat: 38.8951, lon: -77.0364 },
    'ncsc': { lat: 51.5074, lon: -0.1278 },
    'gchq': { lat: 51.5074, lon: -0.1278 },
    'mossad': { lat: 31.9686, lon: 35.5064 },
    'nsa': { lat: 38.8951, lon: -77.0364 },
    'plaff': { lat: 39.9042, lon: 116.4074 },
    'csir': { lat: 51.2323, lon: 13.6830 },
    'significant-gravitas': { lat: 37.7749, lon: -122.4194 },
    'github': { lat: 37.7749, lon: -122.4194 },
    // Additional entries for better geocoding coverage
    'quanta magazine': { lat: 40.7580, lon: -73.9683 }, // NYC
    'nature biotechnology': { lat: 51.5074, lon: -0.1278 }, // London (Nature Publishing)
    'nature': { lat: 51.5074, lon: -0.1278 },
    'fiercebiotech': { lat: 42.3601, lon: -71.0942 }, // Boston area
    'open khipu repository': { lat: -13.5, lon: -71.9 }, // Cusco, Peru (Inca region)
    'research team': { lat: 0.0, lon: 0.0 }, // Will not match - generic
    'research authors': { lat: 0.0, lon: 0.0 }, // Will not match - generic
    'academic researchers': { lat: 0.0, lon: 0.0 }, // Will not match - generic
    'international mathematics collaboration': { lat: 48.8566, lon: 2.3522 }, // Paris (IMU)
    'quantamagazine': { lat: 40.7580, lon: -73.9683 }, // NYC (Quanta Magazine)
    'ieee': { lat: 40.7580, lon: -73.9683 }, // NYC
    'acm': { lat: 40.7580, lon: -73.9683 }, // NYC
    'usenix': { lat: 37.7749, lon: -122.4194 }, // Berkeley/SF
    'siggraph': { lat: 34.0522, lon: -118.2437 }, // LA
    'neurips': { lat: 37.7749, lon: -122.4194 }, // Usually virtual/varied
    'icml': { lat: 37.7749, lon: -122.4194 },
    'aaai': { lat: 37.7749, lon: -122.4194 },
    'cvpr': { lat: 37.7749, lon: -122.4194 },
    'iclr': { lat: 37.7749, lon: -122.4194 },
    'ijcai': { lat: 37.7749, lon: -122.4194 },
  };

  const INSTITUTION_PATTERNS = Object.entries(INSTITUTION_COORDS).map(([key, coords]) => ({
    key,
    coords,
    pattern: new RegExp(`(^|[^a-z0-9])${key.toLowerCase()}([^a-z0-9]|$)`)
  }));

  function geocodeInstitution(source, title, category) {
    if (!source || source === 'Unknown' || source === 'unknown') return null;
    if (!title || title === 'Untitled' || title === 'untitled') return null;

    const cacheKey = `${source}|${title}|${category}`.toLowerCase();
    if (geocodeCache[cacheKey]) {
      return geocodeCache[cacheKey];
    }
    const text = `${source} ${title} ${category}`.toLowerCase();
    for (const { coords, pattern } of INSTITUTION_PATTERNS) {
      if (pattern.test(text)) {
        if (Object.keys(geocodeCache).length >= GEOCODE_CACHE_MAX_SIZE) {
          const firstKey = Object.keys(geocodeCache)[0];
          delete geocodeCache[firstKey];
        }
        geocodeCache[cacheKey] = coords;
        geocodeCacheDirty = true;
        return coords;
      }
    }
    return null;
  }

  // ---- State ----
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  
  // Persistence keys
  const STORAGE_KEY_FILTER_RECENT = 'worldmap_filter_recent';
  const STORAGE_KEY_FILTER_MILITARY = 'worldmap_filter_military';
  const STORAGE_KEY_FILTER_CRISIS = 'worldmap_filter_crisis';
  const STORAGE_KEY_SHOW_ZONES = 'worldmap_show_zones';
  const STORAGE_KEY_SHOW_FLEETS = 'worldmap_show_fleets';
  const STORAGE_KEY_SHOW_CRISES = 'worldmap_show_crises';
const STORAGE_KEY_SHOW_HUMAN_RIGHTS = 'worldmap_show_human_rights';
const STORAGE_KEY_HIDDEN_CATEGORIES = 'worldmap_hidden_categories';

  // Load persisted preferences. Defaults are deliberately "show everything":
  // a brand-new visitor sees the full milestone set (filterRecent OFF), while
  // the operational layers (conflict zones / deployments / crises) stay hidden
  // until explicitly enabled. A returning visitor's saved choice wins.
  let filterRecentDefault = false;
  let filterMilitaryDefault = false;
  let filterCrisisDefault = false;
  let showZonesDefault = false;
  let showFleetsDefault = false;
  let showCrisesDefault = false;
  let showHumanRightsDefault = false;
  try {
    const fr = localStorage.getItem(STORAGE_KEY_FILTER_RECENT);
    const fm = localStorage.getItem(STORAGE_KEY_FILTER_MILITARY);
    const fc = localStorage.getItem(STORAGE_KEY_FILTER_CRISIS);
    const sz = localStorage.getItem(STORAGE_KEY_SHOW_ZONES);
    const sf = localStorage.getItem(STORAGE_KEY_SHOW_FLEETS);
    const sc = localStorage.getItem(STORAGE_KEY_SHOW_CRISES);
    const sh = localStorage.getItem(STORAGE_KEY_SHOW_HUMAN_RIGHTS);
    if (fr !== null) filterRecentDefault = fr === 'true';
    if (fm !== null) filterMilitaryDefault = fm === 'true';
    if (fc !== null) filterCrisisDefault = fc === 'true';
    if (sz !== null) showZonesDefault = sz === 'true';
    if (sf !== null) showFleetsDefault = sf === 'true';
    if (sc !== null) showCrisesDefault = sc === 'true';
    if (sh !== null) showHumanRightsDefault = sh === 'true';
  } catch (_) {}

  const state = {
     width: 0,
height: 0,
      dpr: window.devicePixelRatio || 1,
      transform: { scale: 1, tx: 0, ty: 0 },
      isDragging: false,
      hoveredEvent: null,
      hoveredType: null, // 'zone', 'deployment', 'event', 'crisis'
      selectedEvent: null,
      tooltipHover: false,
      stackIndex: 0,
      pressX: null,
      pressY: null,
      events: [],
      showTerminator: true,
      // Test/demo override for the sun position (set via the __WORLDMAP_TEST__
      // hook so day/night rendering is deterministic in the test suite).
      sunPositionOverride: null,
      // Non-null when the milestone feed could not be loaded in production. Drives
      // the on-map notice so an empty map is explained rather than mysterious.
      dataLoadError: null,
      hiddenCategories: new Set(),
  selectedHumanRight: null,
  selectedLayer: null,
  selectedLayerType: null,
  _box: null, _boxW: -1, _boxH: -1,
      foldedCategories: false,  // whether the entire categories section is folded
      zones: [],
      fleets: [],
      crises: [],
      humanRights: [],
      // Filter states
      filterRecent: filterRecentDefault,  // breakthroughs this week only
      filterMilitary: filterMilitaryDefault, // conflict zones & deployments
      filterCrisis: filterCrisisDefault,   // crisis zones
      // Layer visibility (persisted, default OFF)
      showZones: showZonesDefault,
      showFleets: showFleetsDefault,
      showCrises: showCrisesDefault,
      showHumanRights: showHumanRightsDefault,
      // Cached terminator data (geo-space: sun angle barely moves, but the
      // screen projection must be recomputed for every draw since pan/zoom
      // changes the transform).
      terminatorCache: {
        sunLon: null,
        sunLat: null,
        sunsetGeo: null,
        sunriseGeo: null,
        nightBand: null,
        computedAt: 0
      }
    };

  const CATEGORY_COLORS = {
    'Biotechnology & Biohacking': '#00e676',
    'Computing & AGI': '#448aff',
    'Quantum Physics': '#b388ff',
    'Renewable Energy': '#ffd740',
    'Mobility & Logistics': '#ff5c9a',
    'Cybersecurity': '#ff5252',
    'Robotics': '#6c7a89',
    'Spaceflight & Aeronautics': '#00d4ff',
    'Military & Defense': '#ff9100'
  };

  // Two-tone categories. The primary colour is the category colour above; a record
  // whose `tone` matches the secondary label renders in `secondary`, so one legend
  // row covers both (the row is drawn with splitColors, like Deployments).
  // Classified upstream by sync_milestones.classify_tone; the keyword list that
  // drives it lives in CATEGORY_SUBTONES there and is mirrored in
  // schema/worldmap-data.schema.json.
  const CATEGORY_SUBTONES = {
    'Biotechnology & Biohacking': {
      secondary: 'Biohacking',
      secondaryColor: '#00a651'
    }
  };

  function secondaryColorFor(cat, tone) {
    if (!tone) return null;
    const spec = CATEGORY_SUBTONES[canonicalCategory(cat)];
    if (!spec || spec.secondary !== tone) return null;
    return spec.secondaryColor;
  }

  // The colour a milestone landmark is actually drawn in: the category colour,
  // overridden by its sub-tone when it has one.
  function landmarkColorFor(cat, tone) {
    return secondaryColorFor(cat, tone) || CATEGORY_COLORS[canonicalCategory(cat)] || '#00d4ff';
  }

  const CATEGORY_STAT_MAP = {
    'Biotechnology & Biohacking': { statId: 'map-stat-active', label: 'breakthroughs this week' },
    'Cybersecurity': { statId: 'map-stat-conflicts', label: 'active conflict zones' },
    'Military & Defense': { statId: 'map-stat-fleets', label: 'fleet movements tracked' },
    'Renewable Energy': { statId: 'map-stat-active', label: 'breakthroughs this week' },
    'Mobility & Logistics': { statId: 'map-stat-active', label: 'breakthroughs this week' },
    'Robotics': { statId: 'map-stat-active', label: 'breakthroughs this week' },
    'Spaceflight & Aeronautics': { statId: 'map-stat-fleets', label: 'fleet movements tracked' },
    'Quantum Physics': { statId: 'map-stat-active', label: 'breakthroughs this week' },
    'Computing & AGI': { statId: 'map-stat-active', label: 'breakthroughs this week' }
  };

  // Map category names from any source (old short names or the canonical data names)
  // to the canonical names used by events.json, so colors/stats/legend always align.
  const CATEGORY_ALIASES = {
    'Quantum': 'Quantum Physics',
    'Energy': 'Renewable Energy',
    'Defense': 'Military & Defense',
    'Spaceflight': 'Spaceflight & Aeronautics',
    'Quantum Physics': 'Quantum Physics',
    'Renewable Energy': 'Renewable Energy',
    'Military & Defense': 'Military & Defense',
    'Spaceflight & Aeronautics': 'Spaceflight & Aeronautics',
    'Quantum Gravity': 'Quantum Physics',
    'Mathematics': 'Computing & AGI',
    'Computational Archaeology': 'Computing & AGI',
    'Computer Vision': 'Computing & AGI',
    'Legal AI': 'Computing & AGI',
    // Split / renamed categories. Legacy payloads and the dev sample data still
    // carry the old labels, so they fold into the canonical bucket.
    'Biotechnology': 'Biotechnology & Biohacking',
    'Biohacking': 'Biotechnology & Biohacking',
    'Biotech': 'Biotechnology & Biohacking',
    'Synthetic Biology': 'Biotechnology & Biohacking',
    'Logistics': 'Mobility & Logistics',
    'Transportation': 'Mobility & Logistics',
    'Transport': 'Mobility & Logistics',
    'Robotics & Automation': 'Robotics',
    'Automation': 'Robotics'
  };

  // Canonical category order used by the legend (color, label). This is the
  // product's reading order: human-progress fields first, then infrastructure,
  // then the operational ones. Mirrors category_order in
  // schema/worldmap-data.schema.json; scripts/test_check_data.py enforces parity.
  const CATEGORY_LEGEND = [
    { key: 'Biotechnology & Biohacking', label: 'Biotechnology & Biohacking' },
    { key: 'Computing & AGI', label: 'Computing & AGI' },
    { key: 'Quantum Physics', label: 'Quantum Physics' },
    { key: 'Renewable Energy', label: 'Renewable Energy' },
    { key: 'Mobility & Logistics', label: 'Mobility & Logistics' },
    { key: 'Cybersecurity', label: 'Cybersecurity' },
    { key: 'Robotics', label: 'Robotics' },
    { key: 'Spaceflight & Aeronautics', label: 'Spaceflight & Aeronautics' },
    { key: 'Military & Defense', label: 'Military & Defense' }
  ];

  // Category visibility is persisted too; it used to reset on every reload, so
  // a visitor who switched a category off saw it return unprompted. Applied
  // here rather than in the preference block above because validating against
  // CATEGORY_LEGEND at that point would throw a TDZ ReferenceError that the
  // surrounding try/catch would swallow - silently discarding every saved
  // preference, not just this one.
  // Extracted so the load path's trust boundary is directly testable rather than
  // only reachable by mutating localStorage and reloading the module.
  //
  // Returns the canonical names to hide, or null when the stored value is absent or
  // unusable - in which case the caller's existing set is left alone.
  function parseHiddenCategories(raw) {
    // Length-checked before parsing, for the same reason parseGeocodeCache does it:
    // never hand an arbitrarily large user-writable string to JSON.parse. A real
    // payload is nine category names.
    if (typeof raw !== 'string' || raw.length === 0 ||
        raw.length > HIDDEN_CATEGORIES_MAX_BYTES) {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    // Filter to canonical names: localStorage is user-writable, and an unfiltered
    // value could push arbitrary strings into the legend.
    return parsed.filter(
      (name) => typeof name === 'string' &&
        CATEGORY_LEGEND.some((l) => l.key === name)
    );
  }

  try {
    const restored = parseHiddenCategories(
      localStorage.getItem(STORAGE_KEY_HIDDEN_CATEGORIES));
    if (restored) state.hiddenCategories = new Set(restored);
  } catch (_) {}

function canonicalCategory(cat) {
    return CATEGORY_ALIASES[cat] || cat;
  }

  function isCategoryVisible(cat) {
    const canonical = canonicalCategory(cat);
    return !state.hiddenCategories.has(canonical);
  }

  // Bulk visibility for milestone categories.
  //
  // Deliberately scoped to CATEGORY_LEGEND only: Conflict Zones, Ground
  // Deployments and Human Rights Violations are operational layers with their own
  // switches further down the same frame, and a "hide everything" control that
  // also switched those off would be lying about what it does.
  //
  // Derived, never stored. The eye has to agree with the per-row switches after
  // the user clicks them one at a time, and the only way to guarantee that is to
  // compute it from the same state the rows read.
  function areAllCategoriesHidden() {
    return CATEGORY_LEGEND.every(c => state.hiddenCategories.has(c.key));
  }

  function setAllCategoriesHidden(hidden) {
    if (hidden) {
      CATEGORY_LEGEND.forEach(c => state.hiddenCategories.add(c.key));
    } else {
      state.hiddenCategories.clear();
    }
    try {
      localStorage.setItem(STORAGE_KEY_HIDDEN_CATEGORIES,
        JSON.stringify(Array.from(state.hiddenCategories)));
    } catch (_) {}
    rebuildStackMap();
    dismissTooltip();
    renderLegend();
    draw();
  }

  function toggleAllCategories() {
    setAllCategoriesHidden(!areAllCategoriesHidden());
  }

  // Apply the derived state to a button node. Separate from the lookup below so a
  // freshly built button can be initialised while it is still in hand, instead of
  // depending on it being findable in the document a moment later.
  function applyBulkVisibilityState(btn) {
    if (!btn) return;
    const allHidden = areAllCategoriesHidden();
    btn.setAttribute('aria-pressed', String(allHidden));
    const label = allHidden
      ? 'Show all milestone categories'
      : 'Hide all milestone categories';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  }

  // Keep the eye in step after an individual row click, without rebuilding the
  // whole legend (which would drop keyboard focus mid-interaction).
  function syncBulkVisibilityButton() {
    applyBulkVisibilityState(
      document.getElementById('map-legend-bulk-visibility'));
  }

  function toggleCategory(cat) {
    const canonical = canonicalCategory(cat);
    if (state.hiddenCategories.has(canonical)) {
      state.hiddenCategories.delete(canonical);
    } else {
      state.hiddenCategories.add(canonical);
    }
    // Persist the set so a category hidden before a reload stays hidden.
    try {
      localStorage.setItem(STORAGE_KEY_HIDDEN_CATEGORIES,
        JSON.stringify(Array.from(state.hiddenCategories)));
    } catch (_) {}
    // Category visibility is part of a stack's membership: hiding one member
    // can drop a location below the stacking threshold (and unhide can merge
    // locations that used to be lone dots).
    rebuildStackMap();
    // A popup can be pointing at a milestone that is no longer drawn.
    dismissTooltip();
    syncBulkVisibilityButton();
    draw();
    updateStatsDisplay();
    renderLegend();
  }

  // ---- Country outlines (simplified continent path) ----
  const CONTINENTS = [
    [[ -170, 70], [-150, 70], [-95, 60], [-80, 50], [-65, 25], [-80, 15], [-95, 18], [-105, 30], [-118, 35], [-125, 45], [-130, 55], [-165, 60]],
    [[ -80, 12], [-60, 5], [-50, -5], [-35, -10], [-40, -25], [-55, -35], [-70, -55], [-80, -45], [-82, -20], [-80, 0]],
    [[ -10, 60], [5, 65], [30, 70], [40, 60], [30, 45], [15, 38], [0, 40], [-10, 50]],
    [[ -15, 35], [10, 35], [30, 30], [40, 15], [50, -10], [40, -30], [20, -35], [10, -25], [0, -10], [-10, 10], [-15, 25]],
    [[ 40, 60], [80, 70], [120, 70], [140, 55], [130, 35], [110, 25], [95, 15], [75, 25], [55, 35], [45, 45]],
    [[ 115, -12], [140, -12], [152, -20], [148, -38], [120, -35], [115, -22]],
    [[ -180, -65], [180, -65], [180, -85], [-180, -85]]
  ];

  // ---- Projection ----
  // Longitude always spans the full 360deg across the canvas; latitude spans the
  // asymmetric MAP_LAT_NORTH..MAP_LAT_SOUTH window, so the canvas top/bottom edges
  // are the cropped polar edges.
  // The world is 360 degrees of longitude by MAP_LAT_SPAN of latitude, so it has a
  // fixed aspect ratio. Stretching it to fill the canvas instead - which is what
  // this used to do - squashed longitude and inflated latitude whenever the two
  // disagreed. On a phone that turned the map into an unreadable smear and the
  // coastlines stopped lining up with the graticule you were reading them against.
  //
  // The map is therefore fitted inside the canvas at its natural ratio and centred,
  // leaving a margin rather than distorting. CSS keeps the container close to 2:1
  // so that margin is only a few pixels on desktop and zero on mobile; this is the
  // guarantee that it can never become a distortion if the box is some other shape.
  const MAP_ASPECT = 360 / MAP_LAT_SPAN;

  function mapBox() {
    // Memoised on the canvas dimensions. project() calls this once per graticule
    // line, per continent vertex, per marker and per hit test - several thousand
    // calls per frame - and recomputing the fit each time was slow enough to push
    // the initial data load past the settling window the tests allow, which showed
    // up as an empty map rather than as a slow one.
    //
    // Keyed on width/height rather than invalidated from applyResize(), so a call
    // made before the first resize (or after a transform-only change) is still
    // correct instead of returning a stale box.
    if (state._box && state._boxW === state.width && state._boxH === state.height) {
      return state._box;
    }
    const cw = state.width;
    const ch = state.height;
    let h = ch;
    let w = h * MAP_ASPECT;
    if (w > cw) { w = cw; h = w / MAP_ASPECT; }
    state._box = { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
    state._boxW = cw;
    state._boxH = ch;
    return state._box;
  }

  // The map plate in screen space, i.e. mapBox() after the pan/zoom transform.
// Anything painted as geography has to be clipped to this: project() fits the world
// inside the canvas and centres it, so without a clip the vertical graticule lines
// and the terminator tint carry on into the letterbox margin where no coastline is
// drawn, which reads as a shaded border around the map rather than as map.
function mapScreenRect() {
    const b = mapBox();
    const t = state.transform;
    return {
      x: b.x * t.scale + t.tx,
      y: b.y * t.scale + t.ty,
      w: b.w * t.scale,
      h: b.h * t.scale,
    };
  }

  function project(lon, lat) {
    const b = mapBox();
    const x = b.x + (lon + 180) / 360 * b.w;
    const y = b.y + (MAP_LAT_NORTH - lat) / MAP_LAT_SPAN * b.h;
    return { x: x * state.transform.scale + state.transform.tx, y: y * state.transform.scale + state.transform.ty };
  }

  // Screen pixels per degree of latitude. Geographic layer radii (conflict and
  // crisis zones) are declared in degrees and drawn as circles, so they follow
  // this — the same scale project() uses for latitude.
  function latDegToPx() {
    return mapBox().h / MAP_LAT_SPAN;
  }

  // ---- Sample data (LOCAL DEV ONLY) ----
  // These entries are fabricated: the sources, figures and dates are invented so
  // the widget has something to draw while iterating on layout. They must never
  // reach a real visitor, because this site presents itself as a live tracker of
  // actual breakthroughs and an indistinguishable fake is worse than an empty
  // map. loadEvents() therefore only falls back to them on a local origin (see
  // isLocalDev) and otherwise shows an honest "data unavailable" state.
  // Dates sit within 7 days of a typical deploy so the "this week" filter works
  // during local development.
  const SAMPLE_EVENTS = [
    { lat: 37.7749, lon: -122.4194, title: 'CRISPR Cas-13b phase-3 trial cleared', category: 'Biotechnology', value: '50 patients', source: 'Stanford', date: '2026-09-22' },
    { lat: 47.3769, lon: 8.5417, title: 'ETH Zurich - 137 qubit entanglement', category: 'Quantum Physics', value: '137 qubits', source: 'ETH Zurich', date: '2026-09-21' },
    { lat: 35.6762, lon: 139.6503, title: 'JT-60SA sustained fusion: 100 MJ', category: 'Renewable Energy', value: '100 MJ', source: 'NIFS Japan', date: '2026-09-20' },
    { lat: 51.5074, lon: -0.1278, title: 'GCHQ cyber threat advisory - 9.8 CVSS', category: 'Cybersecurity', value: 'CVSS 9.8', source: 'NCSC UK', date: '2026-09-19' },
    { lat: 28.5728, lon: -80.6490, title: 'SpaceX Starship: 156t to LEO', category: 'Spaceflight & Aeronautics', value: '156 tonnes', source: 'SpaceX', date: '2026-09-18' },
    { lat: 50.4501, lon: 30.5234, title: 'NATO exercise - 12,000 troops', category: 'Military & Defense', value: '12k troops', source: 'NATO', date: '2026-09-17' },
    { lat: 39.9042, lon: 116.4074, title: 'Beijing hypersonic test: Mach 13', category: 'Military & Defense', value: 'Mach 13', source: 'PLASSF', date: '2026-09-16' },
    { lat: 31.9686, lon: 35.5064, title: 'Mossad joint cyber op with NSA', category: 'Cybersecurity', value: 'Tier-1', source: 'Mossad', date: '2026-09-15' },
    { lat: 52.5200, lon: 13.4050, title: 'Wendelstein 7-X - 6 min plasma record', category: 'Renewable Energy', value: '6 min', source: 'IPP', date: '2026-09-14' },
    { lat: 32.0853, lon: 34.7818, title: 'Tel Aviv biotech: in-vivo organoid', category: 'Biotechnology', value: 'patent-pending', source: 'Tel Aviv U', date: '2026-09-13' },
    { lat: -33.8688, lon: 151.2093, title: 'CSIRO solar cell: 33.2% efficiency', category: 'Renewable Energy', value: '33.2%', source: 'CSIRO', date: '2026-09-12' },
    { lat: 1.3521, lon: 103.8198, title: 'ST Engineering drone swarm test', category: 'Military & Defense', value: '1000 UAVs', source: 'CSA', date: '2026-09-11' }
  ];

  // ---- Terminator (Day/Night boundary) ----
  function getSunPosition() {
    if (state.sunPositionOverride) return state.sunPositionOverride;
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const day = now.getUTCDate();
    const hour = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;

    const startOfYear = Date.UTC(year, 0, 1);
    const dayOfYear = Math.floor((Date.UTC(year, month, day) - startOfYear) / 86400000);

    const declination = -23.44 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
    const B = (360 / 365) * (dayOfYear - 81) * Math.PI / 180;
    const equationOfTime = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
    const solarTime = hour + equationOfTime / 60;
    const hourAngle = (solarTime - 12) * 15 * Math.PI / 180;

    const subSolarLat = declination;
    const subSolarLon = -hourAngle * 180 / Math.PI;

    return { lat: subSolarLat, lon: subSolarLon };
  }

  function normalizeLon(lon) {
    // Normalize longitude to [-180, 180) using modulo (faster than while loops)
    return ((lon + 180) % 360 + 360) % 360 - 180;
  }

  // Geo-space terminator: for each sample latitude the boundary longitude at a
  // given offset from the sub-solar point. Pure lon/lat data — independent of
  // the current pan/zoom transform.
  function buildTerminatorGeo(sunLat, sunLon, offsetLon) {
    const effLon = normalizeLon(sunLon + offsetLon);
    const geo = new Array(TERMINATOR_SAMPLES + 1);

    // Sampled across +/-TERMINATOR_LAT_LIMIT, not +/-90: the polar band above it
    // is left to the cap fade instead of being given a constant longitude.
    for (let i = 0; i <= TERMINATOR_SAMPLES; i++) {
      const lat = TERMINATOR_LAT_LIMIT - (i / TERMINATOR_SAMPLES) * (TERMINATOR_LAT_LIMIT * 2);
      const latRad = lat * Math.PI / 180;
      const declRad = sunLat * Math.PI / 180;

      const cosHourAngle = -Math.tan(latRad) * Math.tan(declRad);

      // cosHourAngle is now strictly inside (-1, 1) for every sample, but keep the
      // clamp so a future TERMINATOR_LAT_LIMIT change can never produce NaN.
      const hourAngle = Math.acos(Math.max(-1, Math.min(1, cosHourAngle)));
      geo[i] = { lon: normalizeLon(effLon + (hourAngle * 180 / Math.PI)), lat };
    }
    return geo;
  }

  function getCachedTerminatorGeo(sunLat, sunLon) {
    const now = Date.now();
    const cache = state.terminatorCache;

    // Recompute if sun position changed significantly (>0.01°) or cache expired (>1 min)
    const sunMoved = Math.abs(cache.sunLon - sunLon) > 0.01 || Math.abs(cache.sunLat - sunLat) > 0.01;
    const cacheExpired = now - cache.computedAt > TERMINATOR_UPDATE_MS;

    if (!cache.sunsetGeo || sunMoved || cacheExpired) {
      cache.sunsetGeo = buildTerminatorGeo(sunLat, sunLon, 0);
      cache.sunriseGeo = buildTerminatorGeo(sunLat, sunLon, 180);
      cache.nightBand = buildNightBand(cache.sunsetGeo);
      cache.sunLon = sunLon;
      cache.sunLat = sunLat;
      cache.computedAt = now;
    }
    return { sunset: cache.sunsetGeo, sunrise: cache.sunriseGeo, nightBand: cache.nightBand };
  }

  // Night-shade polygon spanning the whole night hemisphere (the region between
  // the evening terminator and the morning terminator). The sunrise terminator
  // is always exactly 180deg east of the sunset one at every latitude, so the
  // band is built purely from the (unwrapped) sunset longitudes — no dependence
  // on the sun's declination or the current pan/zoom transform. The result is a
  // closed strip from the north pole down the evening edge and back up the
  // morning edge; when painted in longitude-shifted copies (see drawTerminator)
  // the correct half of the map always falls dark, including at sun lon ~0 where
  // the older corner-sewn polygon painted the daylit side.
  function buildNightBand(sunset) {
    const n = sunset.length;
    const band = new Array(n * 2);

    // Unwrap the evening edge into a continuous lon curve (each step < 180deg).
    let offset = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const prev = sunset[i - 1].lon + offset;
        const cur = sunset[i].lon + offset;
        if (cur - prev > 180) offset -= 360;
        else if (cur - prev < -180) offset += 360;
      }
      band[i] = { lon: sunset[i].lon + offset, lat: sunset[i].lat };
    }

    // Morning edge mirrors the evening edge 180deg east, walked back up from
    // the south pole so the strip closes along both polar rows.
    for (let i = 0; i < n; i++) {
      band[n + i] = { lon: band[n - 1 - i].lon + 180, lat: band[n - 1 - i].lat };
    }
    return band;
  }

  // Draw one terminator boundary as a few stacked translucent passes (widest
  // first) so the day/night edge reads as a gentle, highly transparent gradient
  // band instead of a hard line. Both boundaries get identical treatment so they
  // blend into each other.
  function strokeSoftBoundary(geo, rgbaBase) {
    const passes = [
      { w: 7, a: 0.03 },
      { w: 4, a: 0.06 },
      { w: 1.6, a: 0.11 }
    ];
    for (const pass of passes) {
      ctx.beginPath();
      geo.forEach((pt, i) => {
        const p = project(pt.lon, pt.lat);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.strokeStyle = rgbaBase.replace('ALPHA', String(pass.a));
      ctx.lineWidth = pass.w;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }

  function drawTerminator() {
    if (!state.showTerminator) return;

    const sun = getSunPosition();
    const w = state.width;
    const h = state.height;

    // Geo-space terminator (cached by sun angle), projected to screen now so
    // the boundary tracks every pan/zoom.
    const { sunset, sunrise, nightBand } = getCachedTerminatorGeo(sun.lat, sun.lon);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    // Brighten the sunlit side of the map beneath the night shade so daytime
    // hemispheres read clearly brighter than the night side.
    ctx.fillStyle = DAY_TINT;
    ctx.fillRect(0, 0, w, h);

    // ---- Night shading: region between the sunset and sunrise terminators ----
    // Painted as three longitude-shifted copies of the unwrapped band so the
    // night side covers the map correctly under any pan/zoom; project() is
    // linear, so shifted longitudes land off-canvas and clip away cleanly.
    const band = nightBand;
    ctx.fillStyle = NIGHT_FILL;
    for (const lonShift of [-360, 0, 360]) {
      ctx.beginPath();
      band.forEach((pt, i) => {
        const p = project(pt.lon + lonShift, pt.lat);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fill();
    }

    // ---- Day/night boundary lines: soft, blended and very transparent ----
    strokeSoftBoundary(sunset, SUNSET_BOUNDARY);
    strokeSoftBoundary(sunrise, SUNRISE_BOUNDARY);

    // No polar cap fade: the night band is sampled past both edges of the frame,
    // so there is no seam left to hide and nothing to soften. Fading here would
    // lighten the pole while the terminator runs off the side of the map.

    // ---- Sun position marker (small sun icon, no dot) ----
    const sunPos = project(sun.lon, sun.lat);
    if (sunPos.x >= -50 && sunPos.x <= w + 50 && sunPos.y >= -50 && sunPos.y <= h + 50) {
      ctx.save();
      ctx.font = '14px ui-monospace, SFMono-Regular, monospace';
      ctx.fillStyle = SUN_ICON;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = SUN_ICON_GLOW;
      ctx.shadowBlur = 14;
      ctx.fillText('☀', sunPos.x, sunPos.y);
      ctx.restore();
    }

    // ---- Anti-sun (sunrise) marker: small moon icon, no outline dot ----
    const antiSunLon = normalizeLon(sun.lon + 180);
    const antiSunLat = -sun.lat;
    const antiSunPos = project(antiSunLon, antiSunLat);
    if (antiSunPos.x >= -50 && antiSunPos.x <= w + 50 && antiSunPos.y >= -50 && antiSunPos.y <= h + 50) {
      ctx.save();
      ctx.font = '12px ui-monospace, SFMono-Regular, monospace';
      ctx.fillStyle = MOON_ICON;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = MOON_ICON_GLOW;
      ctx.shadowBlur = 10;
      ctx.fillText('☽', antiSunPos.x, antiSunPos.y);
      ctx.restore();
    }

    ctx.restore();
  }

  // ---- Resize ----
  let resizeTimeout = null;
  function applyResize() {
    const rect = canvas.getBoundingClientRect();
    // Refuse to resize into a zero-area canvas. That happens whenever the widget is
    // hidden or not laid out yet - a display:none ancestor, a collapsed panel, or the
    // first paint before the aspect-ratio box has a width. Adopting 0x0 clobbers the
    // backing store and collapses every projection onto the origin, painting a frame
    // full of dots stacked in one corner. Keeping the last good size means the next
    // resize event (which follows layout) simply draws correctly.
    if (!(rect.width > 0) || !(rect.height > 0)) return false;
    state.width = rect.width;
    state.height = rect.height;
    // Refresh DPR on every resize: the device scale can change (window moved to
    // another monitor, OS display zoom) and that alone fires a resize event.
    state.dpr = window.devicePixelRatio || 1;
    canvas.width = state.width * state.dpr;
    canvas.height = state.height * state.dpr;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    return true;
  }

  function resize() {
    applyResize();
    draw();
  }

  function scheduleResize() {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      applyResize();
      draw();
      resizeTimeout = null;
    }, 50);
  }

  // ---- Draw ----
  function draw() {
    const w = state.width;
    const h = state.height;

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#0a1424');
    grad.addColorStop(1, '#060b14');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Graticule, coastlines and terminator are all geography, so they are confined
    // to the map plate. Only the plate background fills the whole canvas, which is
    // what makes the margin read as surround. Clipping to the *transformed* rect
    // keeps the frame correct while panning and zoomed in.
    const plate = mapScreenRect();
    ctx.save();
    ctx.beginPath();
    ctx.rect(plate.x, plate.y, plate.w, plate.h);
    ctx.clip();

    ctx.strokeStyle = 'rgba(0, 212, 255, 0.05)';
    ctx.lineWidth = 1;
    for (let lon = -180; lon <= 180; lon += 30) {
      const a = project(lon, 90);
      const b = project(lon, -90);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const a = project(-180, lat);
      const b = project(180, lat);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(0, 212, 255, 0.08)';
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.3)';
    ctx.lineWidth = 0.5;
    CONTINENTS.forEach(poly => {
      ctx.beginPath();
      poly.forEach((coord, i) => {
        const p = project(coord[0], coord[1]);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });

    ctx.restore();

    drawTerminator();

    // Milestones: draw each visible location once. A location holding several
    // milestones renders a single fan + count badge (or just the focused dot
    // when one of its members is pinned/hovered) instead of one copy per member.
    const todayISO = currentDayISO();
    // Re-group once per frame if the day rolled over. Doing it here rather than
    // relying on the loop below means a frame that filters out every milestone
    // still notices the new day instead of waiting for something to be visible.
    ensureStackMapFresh(todayISO);
    for (const ev of state.events) {
      if (ev._hiddenByTimeline) continue;
      if (state.filterRecent && !isInRolling7Days(ev.date, todayISO)) continue;
      const stackEvts = stackForEvent(ev, todayISO);
      if (stackEvts.length > 1) {
        // A focused member replaces the cluster so the pinned popup always has
        // its dot on screen; otherwise the first member draws it for everyone.
        const focused = stackEvts.find(m => m === state.selectedEvent || m === state.hoveredEvent);
        const lead = focused || stackEvts[0];
        if (lead !== ev) continue;
      }
      drawEvent(ev, stackEvts);
    }

    // Only draw military layers if filterMilitary is active
    if (state.filterMilitary) {
      if (state.showZones) {
        const visibleZones = state.zones.filter(z => !z._hiddenByTimeline);
        const zoneAutoScale = visibleZones.length > 20 ? Math.min(1, 20 / visibleZones.length) : 1;
        visibleZones.forEach(z => drawZone(z, zoneAutoScale));
      }
      if (state.showFleets) state.fleets.forEach(f => drawFleet(f));
    }

    // Only draw crisis zones if filterCrisis is active
    if (state.filterCrisis) {
      if (state.showCrises) {
        const visibleCrises = state.crises.filter(c => !c._hiddenByTimeline);
        const crisisAutoScale = visibleCrises.length > 20 ? Math.min(1, 20 / visibleCrises.length) : 1;
        visibleCrises.forEach(c => drawCrisis(c, crisisAutoScale));
      }
    }
    // Human Rights Violations: landmarks, not rings, and independent of the
    // military/crisis filters. Off by default like every operational layer.
    if (state.showHumanRights) {
      // Iterate clusters, not entries: one landmark per location, fanned when a
      // cluster holds more than one. Scaling is by distinct location, since that
      // is what determines how crowded the map looks.
      const rightsClusters = visibleHumanRightClusters();
      const rightsScale = rightsClusters.length > 30
        ? Math.min(1, 30 / rightsClusters.length) : 1;
      rightsClusters.forEach(group => drawHumanRightsLandmark(group[0], rightsScale, group));
    }
  }

  // Rounding to a fixed number of decimals is what makes two milestones a few
  // hundred metres apart count as "the same location" (campus/city clusters).
  // The coordinates never change after normalisation, so the key is memoised:
  // draw() runs ~10x/s and would otherwise re-round every event each frame.
  function stackKey(ev) {
    if (ev._stackKey === undefined) {
      const f = (n) => Number(n.toFixed(STACK_ROUND_DIGITS));
      ev._stackKey = `${f(ev.lat)},${f(ev.lon)}`;
    }
    return ev._stackKey;
  }

  function drawStack(px, py, count, color) {
    const r = 4;
    for (let i = 0; i < count; i++) {
      const ox = STACK_FAN_DX * (i - (count - 1) / 2);
      const oy = STACK_FAN_DY * (i - (count - 1) / 2);
      ctx.beginPath();
      ctx.arc(px + ox, py + oy, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    if (count > 1) {
      ctx.beginPath();
      ctx.arc(px, py, r + 1, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '7px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(count), px, py);
    }
  }

  let stackMap = null;
  let stackMapDay = null;

  // Group the milestones that share a location so they can be drawn as one
  // fanned marker with a count badge. Only milestones the visitor can actually
  // see belong in a group: hidden by the year slider, hidden by the category
  // legend, or outside the "this week" window are all excluded, which keeps the
  // badge, the pager and hit-testing in agreement with what is on screen.
  function rebuildStackMap(todayISO = currentDayISO()) {
    stackMap = new Map();
    stackMapDay = todayISO;
    for (const ev of state.events) {
      if (ev._hiddenByTimeline) continue;
      if (!isCategoryVisible(ev.category)) continue;
      if (state.filterRecent && !isInRolling7Days(ev.date, todayISO)) continue;
      const key = stackKey(ev);
      let group = stackMap.get(key);
      if (!group) { group = []; stackMap.set(key, group); }
      group.push(ev);
    }
  }

  // The "this week" window moves on its own, so the map has to notice the day
  // rolling over even when no filter is touched: a milestone that ages out must
  // leave its stack instead of lingering in the count badge and the pager, and
  // any popup pinned to it has to go with it. The explicit filter toggles and the
  // year slider already dismiss stale popups, but they never run on their own,
  // so the rollover is the only trigger that can leave a popup over empty canvas.
  // The caller may pass the day it already resolved this frame; recomputing it
  // here would allocate a Date per event per frame for a value we just built.
  function ensureStackMapFresh(todayISO = currentDayISO()) {
    if (stackMap && stackMapDay === todayISO) return;
    rebuildStackMap(todayISO);
    dismissTooltipIfTargetHidden();
  }

  function stackForEvent(ev, todayISO) {
    ensureStackMapFresh(todayISO);
    return stackMap.get(stackKey(ev)) || [];
  }

  // Draws one milestone marker. The caller has already decided which event owns
  // the location (see draw()), and passes that event's stack group along.
  function drawEvent(ev, stackEvts = stackForEvent(ev)) {
     // Skip if hidden by timeline filter
     if (ev._hiddenByTimeline) return;

     const isStackRepresentative = state.selectedEvent === ev || state.hoveredEvent === ev;

     if (stackEvts.length > 1 && !isStackRepresentative) {
       const p = project(ev.lon, ev.lat);
       const color = CATEGORY_COLORS[canonicalCategory(ev.category)] || '#00d4ff';
       ctx.save();
       ctx.globalAlpha = 0.8;
       drawStack(p.x, p.y, stackEvts.length, color);
       ctx.restore();
       ctx.save();
       ctx.globalAlpha = 0.5;
       ctx.strokeStyle = color + '80';
       ctx.lineWidth = 1.5;
       ctx.beginPath();
       // ev is the group's lead member, so its projection is the cluster centre.
       ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
       ctx.stroke();
       ctx.restore();
       return;
     }

     if (!isCategoryVisible(ev.category)) {
       const p = project(ev.lon, ev.lat);
       const color = CATEGORY_COLORS[canonicalCategory(ev.category)] || '#00d4ff';
       ctx.beginPath();
       ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
       ctx.fillStyle = color + '40';
       ctx.fill();
       return;
     }
     const p = project(ev.lon, ev.lat);
     const color = CATEGORY_COLORS[canonicalCategory(ev.category)] || '#00d4ff';
     const pulse = 0.5 + 0.5 * Math.sin((Date.now() / 1000 + ev.lon) * 2);
     const r = 4 + pulse * 2;

    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 2, 0, Math.PI * 2);
    ctx.fillStyle = color + '20';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    if (state.hoveredEvent === ev || state.selectedEvent === ev) {
      const isSelected = state.selectedEvent === ev;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + (isSelected ? 5 : 4), 0, Math.PI * 2);
      ctx.strokeStyle = isSelected ? 'rgba(255,255,255,0.95)' : '#fff';
      ctx.lineWidth = isSelected ? 2 : 1.5;
      ctx.stroke();
    }
  }

  // Area ring shared by conflict zones and crisis zones. Both were near-identical
  // ~90-line copies that had already drifted from each other (drawCrisis painted
  // its centre dot twice, and the two disagreed on the "stale" treatment), so the
  // tier ladder is applied here once and the callers only supply a colour.
  //
  // Only the `hot` tier glows. quiet / cold / done are progressively darker and
  // more desaturated, which is what makes an active-and-recent layer visually
  // distinct from a long-running or unverified one at a glance.
  function drawAreaRing(item, baseColor, autoScale) {
    const p = project(item.lon, item.lat);
    const degToPx = latDegToPx();
    const baseRadius = Math.max(4, (item.radiusDeg || 3) * degToPx * state.transform.scale * (autoScale || 1));
    const tier = layerPaintTier(item);
    const spec = LAYER_TIER_PAINT[tier];
    const color = spec.desat ? desaturateHex(baseColor, spec.desat) : baseColor;

    if (spec.glow) {
      // Neon halo, breathing. The only place 'lighter' compositing is used.
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 900 + item.lon);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = baseColor;
      ctx.shadowBlur = FLUO_GLOW_BLUR + FLUO_PULSE_RADIUS * pulse;
      ctx.beginPath();
      ctx.arc(p.x, p.y, baseRadius * 1.14, 0, Math.PI * 2);
      ctx.fillStyle = withOpacity(baseColor, spec.halo);
      ctx.fill();
      ctx.restore();
    }

    ctx.beginPath();
    ctx.arc(p.x, p.y, baseRadius, 0, Math.PI * 2);
    ctx.fillStyle = withOpacity(color, spec.fill);
    ctx.fill();

    ctx.save();
    if (spec.glow) {
      ctx.shadowColor = baseColor;
      ctx.shadowBlur = FLUO_LINE_GLOW_BLUR;
    }
    ctx.setLineDash([4, 3]);
    // Marching dash is the "live" cue, so it is reserved for the hot tier.
    if (spec.pulse) ctx.lineDashOffset = -Date.now() / 40;
    ctx.lineWidth = spec.line;
    ctx.strokeStyle = withOpacity(color, spec.stroke);
    ctx.beginPath();
    ctx.arc(p.x, p.y, baseRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Centre marker, sized down with the tier so a cold zone does not read as a
    // live point.
    const centerR = tier === TIER_HOT ? 3 : 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, centerR, 0, Math.PI * 2);
    ctx.fillStyle = tier === TIER_HOT ? color : withOpacity(color, LAYER_TIER_CENTER_ALPHA[tier]);
    ctx.fill();
  }

  // Conflict zone: area ring in the conflict palette (red/pink). Only zones
  // sourced from something stronger than Wikipedia's conflict list reach the neon
  // "hot" treatment - see isSingleListSourced().
  function drawZone(zone, zoneAutoScale) {
    if (!state.showZones) return;
    if (zone._hiddenByTimeline) return;
    drawAreaRing(zone, ZONE_COLOR, zoneAutoScale);
  }

  // Crisis zone (humanitarian): same ladder in the crisis palette (purple), which
  // is what separates it from conflict zones at a glance.
  function drawCrisis(crisis, crisisAutoScale) {
    if (!state.showCrises) return;
    if (crisis._hiddenByTimeline) return;
    drawAreaRing(crisis, CRISIS_COLOR, crisisAutoScale);
  }

  // A reported violation is a point occurrence, so these draw as landmarks rather
  // than an area ring: a ring would imply an affected extent we do not have.
  //
  // ---- Human Rights landmark clustering -------------------------------------
  // Two reports about the same country geocode to the same country centroid, so
  // the layer drew them on top of each other at one pixel and the legend count
  // disagreed with what was visible: five entries, four dots, one of them
  // invisible. Milestones already solve this with stackKey/drawStack, so the
  // landmarks now group the same way and fan apart instead of overplotting.
  //
  // Deliberately looser than STACK_ROUND_DIGITS (4): these coordinates are country
  // centroids reused verbatim from the fetcher's lookup table, so identical values
  // mean "same country", and the tolerance only needs to absorb float noise.
  const HUMAN_RIGHTS_STACK_DIGITS = 1;
  let humanRightStackMap = new Map();

  function humanRightStackKey(h) {
    if (h._hrStackKey) return h._hrStackKey;
    const f = (n) => Number(n.toFixed(HUMAN_RIGHTS_STACK_DIGITS));
    h._hrStackKey = f(h.lat) + ',' + f(h.lon);
    return h._hrStackKey;
  }

  function rebuildHumanRightStackMap() {
    humanRightStackMap = new Map();
    for (const h of state.humanRights) {
      const k = humanRightStackKey(h);
      const group = humanRightStackMap.get(k);
      if (group) group.push(h); else humanRightStackMap.set(k, [h]);
    }
    return humanRightStackMap;
  }

  function humanRightStackFor(h) {
    return humanRightStackMap.get(humanRightStackKey(h)) || [h];
  }

  // How many visible reports this landmark stands for. Several reports can share
  // one country centroid, in which case the marker is a fan and the tooltip has to
  // say so. Derived on demand rather than cached on the entry: findHumanRight used
  // to write this onto the object it returned, which meant the count was a property
  // of "the last hit" rather than of the landmark, and any caller that built a
  // tooltip from an entry the hit test had not just touched would show a stale
  // number.
  function humanRightClusterSize(h) {
    if (!h) return 0;
    return humanRightStackFor(h).filter(e => !e._hiddenByTimeline).length;
  }

  // Timeline-filtered clusters, so a cluster never mixes hidden and shown members.
  function visibleHumanRightClusters() {
    const out = [];
    for (const group of humanRightStackMap.values()) {
      const shown = group.filter(h => !h._hiddenByTimeline);
      if (shown.length) out.push(shown);
    }
    return out;
  }

  // Landmarks pulse with a soft glow so the layer reads as live rather than as
  // another set of static dots. The pulse is a function of wall-clock time only -
  // no per-entry state - so it cannot desynchronise, and it costs nothing when the
  // layer is off because drawHumanRightsLandmark returns immediately.
  function drawHumanRightsLandmark(entry, autoScale, cluster) {
    if (!state.showHumanRights) return;
    if (entry._hiddenByTimeline) return;
    const p = project(entry.lon, entry.lat);
    if (!p) return;
    const done = entry.status && entry.status !== 'active' && entry.status !== 'ongoing';
    const base = Math.max(
      HUMAN_RIGHTS_CORE_MIN,
      Math.min(HUMAN_RIGHTS_CORE_MAX, (done ? HUMAN_RIGHTS_CORE_DONE : HUMAN_RIGHTS_CORE_ACTIVE) * autoScale)
    );
    const alpha = done ? 0.35 : 0.85;

    // Ease the pulse with a raised cosine so it swells and fades rather than
    // stepping. Stagger by longitude so neighbouring landmarks do not breathe in
    // lockstep, which reads as a single blinking blob rather than several.
    const phase = (Date.now() / HUMAN_RIGHTS_PULSE_MS
                   + (entry.lon + 180) / 360) % 1;
    const pulse = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);

    // Painted as an orb in three passes - halo, breathing shell, core - which is the
    // language the milestone landmarks already use, so the two layers read as one
    // system instead of one being a plain dot and the other a smudge.
    //
    // Everything stays inside HUMAN_RIGHTS_CORE_MAX * (GLOW_INNER + GLOW_PULSE),
    // because that product is what HUMAN_RIGHTS_HIT_RADIUS is derived from: paint
    // outside it and the hit test no longer covers what is drawn.
    const maxR = HUMAN_RIGHTS_CORE_MAX * (HUMAN_RIGHTS_GLOW_INNER + HUMAN_RIGHTS_GLOW_PULSE);

    // 1. Halo. A wide, very soft wash that gives the orb a presence on the map
    //    without competing with the coastline underneath it.
    const haloR = base * (HUMAN_RIGHTS_GLOW_INNER + HUMAN_RIGHTS_GLOW_PULSE) * 0.55;
    const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(haloR, 1));
    halo.addColorStop(0, withOpacity(HUMAN_RIGHTS_COLOR,
      (done ? 0.16 : 0.42) * (1 - pulse * 0.45)));
    halo.addColorStop(0.55, withOpacity(HUMAN_RIGHTS_COLOR,
      (done ? 0.06 : 0.14) * (1 - pulse * 0.45)));
    halo.addColorStop(1, withOpacity(HUMAN_RIGHTS_COLOR, 0));
    ctx.beginPath();
    ctx.arc(p.x, p.y, haloR, 0, Math.PI * 2);
    ctx.fillStyle = halo;
    ctx.fill();

    // 2. Breathing shell. A crisp ring that expands and fades on its own cycle,
    //    slightly out of phase with the core so the orb never looks like a single
    //    uniform scale. Staggered by longitude upstream, so neighbouring landmarks
    //    do not breathe in lockstep.
    const shellPhase = (pulse + 0.35) % 1;
    const shellR = base * (1.25 + shellPhase * 1.15);
    if (shellR <= maxR) {
      ctx.save();
      ctx.globalAlpha = alpha * (1 - shellPhase) * 0.7;
      ctx.strokeStyle = HUMAN_RIGHTS_COLOR;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, shellR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 3. Core. Bright and small, with a soft inner falloff so it reads as a lit
    //    sphere rather than a flat disc.
    const core = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, base);
    core.addColorStop(0, withOpacity('#ffffff', done ? 0.55 : 0.95));
    core.addColorStop(0.35, withOpacity(HUMAN_RIGHTS_COLOR, done ? 0.5 : 0.95));
    core.addColorStop(1, withOpacity(HUMAN_RIGHTS_COLOR, done ? 0.1 : 0.35));
    ctx.beginPath();
    ctx.arc(p.x, p.y, base * (1 + pulse * 0.12), 0, Math.PI * 2);
    ctx.fillStyle = core;
    ctx.fill();

    // A single specular highlight, offset up-left, which is what makes a flat circle
    // read as a sphere. Cheap: one small filled arc.
    if (!done) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x - base * 0.3, p.y - base * 0.3, base * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Selected landmark: a bright ring, matching how a pinned milestone reads, so
    // it is obvious the popup is docked here rather than merely hovered.
    if (state.selectedHumanRight === entry) {
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, base + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Cluster fan. Without this the extra reports were not merely unlabelled, they
    // were literally invisible underneath the first one at the same pixel.
    if (cluster && cluster.length > 1) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      drawStack(p.x, p.y, cluster.length, HUMAN_RIGHTS_COLOR);
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = withOpacity(HUMAN_RIGHTS_COLOR, 0.8);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, base + 2.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // The fanned markers sit a few pixels outboard of the glow, so label them
      // separately - otherwise the count is unreadable against the map.
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = 3;
      ctx.fillText(String(cluster.length), p.x + 11, p.y - 11);
      ctx.restore();
    }

    // Solid core, breathing slightly with the glow.
    const radius = base * (0.86 + pulse * 0.24);
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = withOpacity(HUMAN_RIGHTS_COLOR, alpha);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = withOpacity('#ffffff', done ? 0.3 : 0.45 + pulse * 0.3);
    ctx.stroke();
  }

  // Single source of truth for a tracked movement's drawn endpoints.
  // drawFleet synthesized an infantry tail from `direction` inline while
  // findDeployment read fleet.from/fleet.to — which infantry entries do not have
  // at all. Hovering a map that contained one therefore threw inside the
  // mousemove handler, which killed hover for every layer (events, zones,
  // deployments and crises alike), not just the arrow under the cursor. Both
  // sides derive from here now, so the hit target always matches the pixels.
  function isInfantryKind(fleet) {
    const k = fleet && fleet.kind;
    return k === 'infantry' || k === 'mobilization' || k === 'deployment' || k === 'rotation';
  }

  // Geographic endpoints for a movement, in lon/lat. Returns null when the pair
  // is unusable so callers can skip rather than draw a degenerate arrow.
  //
  // Memoized on the entry for the same reason stackKey() is: draw() runs ~10x/s
  // and findDeployment() runs on every mousemove, so recomputing (and
  // re-allocating) the infantry pair per call per frame is pure garbage
  // collection pressure. normalizeFleet() is the only producer and it never
  // mutates a movement afterwards, so the cache cannot go stale.
  function fleetEndpoints(fleet) {
    if (fleet._ends !== undefined) return fleet._ends;
    fleet._ends = computeFleetEndpoints(fleet);
    return fleet._ends;
  }

  function computeFleetEndpoints(fleet) {
    if (!isInfantryKind(fleet)) {
      if (!isLocatedCoord(fleet?.from) || !isLocatedCoord(fleet?.to)) return null;
      // Reuse the payload objects rather than wrapping them: these are read-only.
      return { from: fleet.from, to: fleet.to };
    }
    const destLon = fleet.lon;
    const destLat = fleet.lat;
    let fromLon = destLon;
    let fromLat = destLat;
    const dir = fleet.direction ? String(fleet.direction).toLowerCase() : 'global';

    // A ground deployment is a point plus a compass heading, so the tail is
    // synthesized 5 degrees BEHIND the destination and the arrowhead lands on the
    // destination. "Behind" means the opposite of travel, hence every offset is
    // the negation of the direction: north travels to higher latitude, so its tail
    // sits at a lower one.
    //
    // This was previously signed the other way for the latitude cases only - east
    // and west were right, north and south were inverted, so a deployment tagged
    // "Heading: North" drew an arrowhead pointing south. Expressing all four as one
    // table keeps the symmetry obvious and stops the halves drifting apart again.
    const TAIL_OFFSET_DEG = 5;
    const BACK_OFFSETS = {
      east: [-TAIL_OFFSET_DEG, 0],   // travel +lon, so tail is west of it
      west: [TAIL_OFFSET_DEG, 0],
      north: [0, -TAIL_OFFSET_DEG],  // travel +lat, so tail is south of it
      south: [0, TAIL_OFFSET_DEG],
    };
    const offset = BACK_OFFSETS[dir];
    if (offset) {
      fromLon = destLon + offset[0];
      fromLat = destLat + offset[1];
    } else {
      // Global/no direction: deterministic offset based on fleet properties.
      const seed = (destLon * 7 + destLat * 13) % 6;
      fromLon = destLon - 3 + seed;
      fromLat = destLat - 3 + ((seed * 2) % 6);
    }
    return { from: { lat: fromLat, lon: fromLon }, to: { lat: destLat, lon: destLon } };
  }

  // Tracked deployment: solid colored vector from origin to destination with a
  // solid arrowhead indicating direction of travel. Ground/troop movements render
  // distinct amber, naval/fleet movements solid blue — never dashed or dotted, and
  // the arrowhead matches the line colour. The arrow tail is deliberately faint.
  // Recency uses the same ladder as the area rings: only a hot (active + recent)
  // movement glows, so a long-quiet fleet movement reads as background.
  // Movements outside the timeline year are skipped.
  function drawFleet(fleet) {
    if (!state.showFleets) return;
    if (fleet._hiddenByTimeline) return;

    const isInfantry = isInfantryKind(fleet);
    const isGround = fleet.kind === 'ground';

    const ends = fleetEndpoints(fleet);
    if (!ends) return;
    const a = project(ends.from.lon, ends.from.lat);
    const b = project(ends.to.lon, ends.to.lat);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    const ang = Math.atan2(dy, dx);
    const headLen = 8;

    const tier = layerPaintTier(fleet);
    const spec = LAYER_TIER_PAINT[tier];
    const arrow = LAYER_TIER_ARROW[tier];
    const base = isInfantry || isGround ? GROUND_COLOR : FLEET_COLOR;
    const color = spec.desat ? desaturateHex(base, spec.desat) : base;

    // Tail: a faint memory of the route, brightening into a luminous second pass
    // only for hot movements.
    ctx.save();
    ctx.strokeStyle = withOpacity(color, ARROW_TAIL_OPACITY * arrow.tail);
    ctx.lineWidth = arrow.line * 0.55;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (spec.glow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = FLUO_LINE_GLOW_BLUR;
      ctx.strokeStyle = withOpacity(color, 0.3);
      ctx.lineWidth = arrow.line;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();

    // Arrowhead. Only hot heads breathe and glow; every other tier is desaturated
    // as well as dimmed so the state does not rely on alpha alone.
    ctx.save();
    if (tier === TIER_HOT) {
      ctx.shadowColor = color;
      ctx.shadowBlur = FLUO_LINE_GLOW_BLUR + 5 * (0.5 + 0.5 * Math.sin(Date.now() / 650 + a.x));
    }
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - headLen * Math.cos(ang - 0.4), b.y - headLen * Math.sin(ang - 0.4));
    ctx.lineTo(b.x - headLen * Math.cos(ang + 0.4), b.y - headLen * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fillStyle = tier === TIER_HOT ? color : withOpacity(color, arrow.head);
    ctx.fill();
    ctx.restore();
  }

  // Coalesce high-frequency redraws (wheel zoom, drag pan) into a single draw
  // per animation frame instead of one full synchronous draw per input event.
  let drawRequested = false;
  let scheduledDrawId = null;
  function requestDraw() {
    if (drawRequested) return;
    drawRequested = true;
    scheduledDrawId = requestAnimationFrame(() => {
      drawRequested = false;
      scheduledDrawId = null;
      draw();
    });
  }

  // ---- Hit-test ----
  function findEvent(px, py) {
    const hitRadius = HIT_RADIUS_BASE / state.transform.scale;
    const hitRadiusSq = hitRadius * hitRadius;
    const todayISO = currentDayISO();
    for (let i = state.events.length - 1; i >= 0; i--) {
      const ev = state.events[i];
      if (ev._hiddenByTimeline) continue;
      if (!isCategoryVisible(ev.category)) continue;
      // If filterRecent is active, skip events outside the 7-day window
      if (state.filterRecent && !isInRolling7Days(ev.date, todayISO)) continue;
      const p = project(ev.lon, ev.lat);
      const dx = p.x - px;
      const dy = p.y - py;
      if (dx * dx + dy * dy < hitRadiusSq) return ev;
    }
    return null;
  }

  // Radius within which a nearby-but-different milestone is treated as visually
  // confusable with the anchor rather than as a move to a new subject. Scaled with
  // zoom so it stays a constant apparent distance on screen. Roughly twice the hit
  // radius: enough to bridge the gap between a small dot and the tooltip, too small
  // to swallow an adjacent landmark.
  const PROXIMITY_RADIUS = 56;

  function isNearAnchor(px, py) {
    const anchor = state.selectedEvent || state.hoveredEvent;
    if (!anchor || anchor.lon == null || anchor.lat == null) return false;
    if (anchor._hiddenByTimeline) return false;
    if (!isCategoryVisible(anchor.category)) return false;
    const p = project(anchor.lon, anchor.lat);
    if (!p) return false;
    const r = PROXIMITY_RADIUS / state.transform.scale;
    const dx = p.x - px;
    const dy = p.y - py;
    return dx * dx + dy * dy < r * r;
  }

  // Whether two milestones render as one co-located cluster, i.e. share a stack
  // position. Stepping between members must take over the tooltip; stepping
  // between two merely-adjacent dots must not.
  function sameLocationCluster(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.lon == null || a.lat == null || b.lon == null || b.lat == null) return false;
    return stackKey(a) === stackKey(b);
  }

  function findZone(px, py) {
    if (!state.showZones) return null;
    const hitRadius = HIT_RADIUS_BASE / state.transform.scale;
    const hitRadiusSq = hitRadius * hitRadius;
    for (let i = state.zones.length - 1; i >= 0; i--) {
      const zone = state.zones[i];
      if (zone._hiddenByTimeline) continue;
      const p = project(zone.lon, zone.lat);
      const dx = p.x - px;
      const dy = p.y - py;
      if (dx * dx + dy * dy < hitRadiusSq) return zone;
    }
    return null;
  }

  function findDeployment(px, py) {
    if (!state.showFleets) return null;
    // Check if mouse is near any deployment arrow (distance to line segment)
    const hitDist = 8 / state.transform.scale; // threshold in map coordinates
    const hitDistSq = hitDist * hitDist;
    for (let i = state.fleets.length - 1; i >= 0; i--) {
      const fleet = state.fleets[i];
      if (fleet._hiddenByTimeline) continue;
      // Same endpoint derivation the renderer uses, so infantry arrows (which
      // carry lat/lon + direction, not from/to) are hittable and the hit target
      // lines up with the pixels that were actually drawn.
      const ends = fleetEndpoints(fleet);
      if (!ends) continue;
      const a = project(ends.from.lon, ends.from.lat);
      const b = project(ends.to.lon, ends.to.lat);
      // Distance from point to line segment
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lenSq));
      const closestX = a.x + t * dx;
      const closestY = a.y + t * dy;
      const distSq = (px - closestX) ** 2 + (py - closestY) ** 2;
      if (distSq < hitDistSq) return fleet;
    }
    return null;
  }

  // Crisis zone hit-test: check if mouse is near crisis zone center
  function findCrisis(px, py) {
    if (!state.showCrises) return null;
    const hitRadius = HIT_RADIUS_BASE / state.transform.scale;
    const hitRadiusSq = hitRadius * hitRadius;
    for (let i = state.crises.length - 1; i >= 0; i--) {
      const crisis = state.crises[i];
      if (crisis._hiddenByTimeline) continue;
      const p = project(crisis.lon, crisis.lat);
      const dx = p.x - px;
      const dy = p.y - py;
      if (dx * dx + dy * dy < hitRadiusSq) return crisis;
    }
    return null;
  }

  // Landmark hit test for the Human Rights Violations layer. Only participates when
  // the layer is on: an invisible layer must not steal hover from a milestone.
  function findHumanRight(px, py) {
    if (!state.showHumanRights) return null;
    // Derived from the widest painted landmark, not a separate magic number.
    const hitRadius = HUMAN_RIGHTS_HIT_RADIUS;
    const hitRadiusSq = hitRadius * hitRadius;
    // Walk clusters so a fan of several reports is one target and the returned
    // entry is always the lead, which owns the projected centre.
    let best = null;
    let bestDist = Infinity;
    for (const group of visibleHumanRightClusters()) {
      const lead = group[0];
      const p = project(lead.lon, lead.lat);
      if (!p) continue;
      const dx = p.x - px;
      const dy = p.y - py;
      const dist = dx * dx + dy * dy;
      if (dist < hitRadiusSq && dist < bestDist) {
        bestDist = dist;
        best = lead;
      }
    }
    return best;
  }

  // Landmarks are the one layer that pins; zones, deployments and crisis rings were
  // hover-only, so their tooltips vanished the moment the pointer moved and the source
  // link inside them could never be clicked. Same treatment as a milestone now.
  //
  // One finder for all three so the pin/unpin path does not have to know which
  // layer it was, and so the precedence matches the hover order above it.
  function findLayerAt(x, y) {
    const zone = findZone(x, y);
    if (zone) return { entry: zone, type: 'zone' };
    const deploy = findDeployment(x, y);
    if (deploy) return { entry: deploy, type: 'deployment' };
    const crisis = findCrisis(x, y);
    if (crisis) return { entry: crisis, type: 'crisis' };
    return null;
  }

  // Draw the layer's popup docked at the marker rather than under the cursor.
  function pinTooltipToLayer(entry, type) {
    if (!tooltip || !entry) return;
    const p = project(entry.lon !== undefined ? entry.lon : 0,
                       entry.lat !== undefined ? entry.lat : 0);
    if (!p) return;
    if (type === 'zone') showZoneTooltip(entry, p.x, p.y);
    else if (type === 'deployment') showDeploymentTooltip(entry, p.x, p.y);
    else if (type === 'crisis') showCrisisTooltip(entry, p.x, p.y);
  }

  // Is the pinned layer still drawable? Switching its layer off, or filtering it
  // away, has to release the popup rather than leave it floating over a map it no
  // longer describes.
  function layerIsHidden(entry, type) {
    if (!entry) return true;
    if (type === 'zone') return !state.showZones || !state.filterMilitary;
    if (type === 'deployment') return !state.showFleets || !state.filterMilitary;
    if (type === 'crisis') return !state.showCrises || !state.filterCrisis;
    return true;
  }

  // ---- Tooltip hover handlers ----
  function handleTooltipMouseEnter() { state.tooltipHover = true; }
  function handleTooltipMouseLeave() {
    state.tooltipHover = false;
    state.hoveredEvent = null;
    if (state.selectedEvent) return;
    hideTooltip();
    draw();
  }

  // ---- Mouse ----
  canvas.addEventListener('mousemove', handleMouseMove);
  function handleMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (state.isDragging) {
      state.transform.tx += e.movementX;
      state.transform.ty += e.movementY;
      // Once the press has clearly turned into a pan, drop the popup so it does
      // not float over the map mid-drag. The selection itself is kept until
      // mouseup, so a press that settles within the click threshold still
      // toggles/pins instead of being swallowed by the drag.
      if (state.pressX !== null && state.pressY !== null &&
          Math.hypot(x - state.pressX, y - state.pressY) > CLICK_DRAG_THRESHOLD) {
        hideTooltip();
      }
      requestDraw();
      return;
    }

    // A pinned (selected) event keeps its popup persistent so the pointer can
    // travel to it and click the "View source" link; hovering a different dot
    // re-pins it in place instead of letting the popup chase the cursor.
    // Same for a docked zone, deployment or crisis ring.
    if (state.selectedLayer && !state.selectedEvent && !state.selectedHumanRight) {
      const layer = findLayerAt(x, y);
      if (layer) {
        canvas.style.cursor = 'pointer';
        state.hoveredType = layer.type;
        if (layer.entry !== state.selectedLayer) {
          state.selectedLayer = layer.entry;
          state.selectedLayerType = layer.type;
          pinTooltipToLayer(layer.entry, layer.type);
          draw();
        }
        return;
      }
      canvas.style.cursor = 'grab';
      return;
    }

    // A docked landmark behaves like a docked milestone: the popup stays put, the
    // cursor keeps its pointer feedback over the target, and only a click on the
    // landmark itself or empty canvas closes it.
    if (state.selectedHumanRight && !state.selectedEvent) {
      const hit = findHumanRight(x, y);
      if (hit) {
        canvas.style.cursor = 'pointer';
        state.hoveredType = 'human_rights';
        if (hit !== state.selectedHumanRight) {
          // Re-dock in place on a different landmark, same as milestones.
          state.selectedHumanRight = hit;
          pinTooltipToHumanRight(hit);
          draw();
        }
        return;
      }
      canvas.style.cursor = 'grab';
      return;
    }

    if (state.selectedEvent) {
      const hit = findEvent(x, y);
      if (hit && hit !== state.selectedEvent) {
        state.selectedEvent = hit;
        state.hoveredEvent = hit;
        canvas.style.cursor = 'pointer';
        pinTooltipToEvent(hit);
        draw();
      } else if (hit === state.selectedEvent) {
        canvas.style.cursor = 'pointer';
        if (state.hoveredEvent !== hit) { state.hoveredEvent = hit; draw(); }
        if (!tooltip || !tooltip.classList.contains('visible')) pinTooltipToEvent(hit);
      } else {
        canvas.style.cursor = 'grab';
        state.hoveredEvent = null;
      }
      return;
    }

    // Check for hovered event (primary), zone, deployment, or crisis
    let hit = null;
    let hitType = null; // 'zone', 'deployment', 'event', 'crisis'
    
    const eventHit = findEvent(x, y);
    if (eventHit) {
      hit = eventHit;
      hitType = 'event';
    } else {
      const zoneHit = findZone(x, y);
      if (zoneHit) {
        hit = zoneHit;
        hitType = 'zone';
      } else {
        const deployHit = findDeployment(x, y);
        if (deployHit) {
          hit = deployHit;
          hitType = 'deployment';
        } else {
          const crisisHit = findCrisis(x, y);
          if (crisisHit) {
            hit = crisisHit;
            hitType = 'crisis';
          }
          else {
            const rightsHit = findHumanRight(x, y);
            if (rightsHit) {
              hit = rightsHit;
              hitType = 'human_rights';
            }
          }
        }
      }
    }

canvas.style.cursor = hit ? 'pointer' : 'grab';
    // --- Hover arbitration -----------------------------------------------------
    // "Whatever is under the cursor wins" was wrong in three distinct ways, so
    // they are separated here rather than left to the hit test:
    //
    // 1. Drift. A milestone dot is a handful of pixels across, so a pointer moving
    //    toward the tooltip drifts off it long before reaching anything else.
    //    Hiding on a miss made the tooltip's own source link unreachable.
    //
    // 2. Nearby, and NOT the same location. Two dots a few pixels apart are
    //    visually ambiguous, and swapping the tooltip as the pointer crossed the
    //    gap made it impossible to read either one. The current tooltip is left
    //    completely untouched - the anchor does not even move.
    //
    // 3. Same-location cluster. Stepping through co-located milestones is the
    //    point of a cluster, so each member DOES take over.
    //
    // Past the proximity radius the pointer has clearly travelled somewhere else,
    // so switching is expected and stays easy. A click pins the milestone
    // (state.selectedEvent); while pinned the tooltip is persistent and nearby
    // hovers of any kind leave it alone, including cluster members.
    const anchor = state.selectedEvent || state.hoveredEvent;
    if (anchor && hit !== anchor && isNearAnchor(x, y)) {
      if (state.selectedEvent) return;                  // pinned: persist
      if (hit && hitType === 'event' && sameLocationCluster(hit, anchor)) {
        // Same location: fall through so this member opens its own tooltip.
      } else {
        return;                                          // nearby: leave alone
      }
    }
    if (!hit && isNearAnchor(x, y)) return;              // drift: keep it

    if (hit !== state.hoveredEvent || hitType !== state.hoveredType) {
      state.hoveredEvent = hit;
      state.hoveredType = hitType;
      if (hit) {
        if (hitType === 'zone') {
          showZoneTooltip(hit, e.clientX - rect.left, e.clientY - rect.top);
        } else if (hitType === 'deployment') {
          showDeploymentTooltip(hit, e.clientX - rect.left, e.clientY - rect.top);
        } else if (hitType === 'crisis') {
          showCrisisTooltip(hit, e.clientX - rect.left, e.clientY - rect.top);
        } else if (hitType === 'human_rights') {
          showHumanRightsTooltip(hit, e.clientX - rect.left, e.clientY - rect.top);
        } else {
          showTooltip(hit, e.clientX - rect.left, e.clientY - rect.top);
        }
      } else if (!state.tooltipHover) {
        hideTooltip();
      }
      draw();
    } else if (hit) {
      if (hitType === 'zone') {
        moveZoneTooltip(e.clientX - rect.left, e.clientY - rect.top);
      } else if (hitType === 'deployment') {
        moveDeploymentTooltip(e.clientX - rect.left, e.clientY - rect.top);
      } else if (hitType === 'crisis') {
        moveCrisisTooltip(e.clientX - rect.left, e.clientY - rect.top);
      } else if (hitType === 'human_rights') {
        moveHumanRightsTooltip(e.clientX - rect.left, e.clientY - rect.top);
      } else {
        moveTooltip(e.clientX - rect.left, e.clientY - rect.top);
      }
    }
  }

  canvas.addEventListener('mousedown', handleMouseDown);
  function handleMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    state.pressX = Number.isFinite(x) ? x : null;
    state.pressY = Number.isFinite(y) ? y : null;
    state.isDragging = true;
    canvas.style.cursor = 'grabbing';
    // Deliberately no dismissal here: the press is only a candidate click, so
    // a pinned popup survives until we know whether the pointer stayed put
    // (toggle/pin) or travelled (drag/pan).
  }

  window.addEventListener('mouseup', handleMouseUp);
  function handleMouseUp(e) {
    state.isDragging = false;
    canvas.style.cursor = 'grab';
    // A release that lands on the popup is a UI interaction with the popup, not
    // a canvas gesture. This listener is on window so it also sees presses that
    // started on the tooltip, and because the popup sits on top of the map the
    // same coordinates hit-test as the dot underneath — so the old code
    // dismissed the pinned popup here, tearing the pager out of the DOM before
    // its click could fire and making "previous milestone" unusable. Deselecting
    // the landmark is the lower-priority behaviour: the popup wins.
    //
    // Containment of the event target is the authoritative test. The sticky
    // `tooltipHover` flag alone is not enough: it is only cleared by mouseleave,
    // which never fires if the pointer leaves the window or the popup is
    // re-rendered under the cursor, and a stuck-true flag would silently kill
    // deselect-by-click for the rest of the session.
    const target = e.target;
    const overPopup = state.tooltipHover ||
      (tooltip && target && typeof tooltip.contains === 'function' && tooltip.contains(target));
    if (overPopup) {
      state.pressX = null;
      state.pressY = null;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (!Number.isFinite(x) || !Number.isFinite(y)) { state.pressX = null; state.pressY = null; return; }
    // A press/release with (almost) no movement selects the event under the
    // cursor and pins its popup, keeping "View source" reachable and clickable.
    const moved = Math.hypot((state.pressX ?? x) - x, (state.pressY ?? y) - y);
    if (moved > CLICK_DRAG_THRESHOLD) {
      // The dots moved out from under the pointer, so any popup is now stale.
      dismissTooltip();
    } else {
      const hit = findEvent(x, y);
      if (!hit) {
        // Landmarks are not milestones, so findEvent cannot see them. Without this
        // branch a click on a Human Rights landmark found nothing and dismissed
        // the popup - the layer had hover but no docking at all.
        const rightsHit = findHumanRight(x, y);
        if (rightsHit) {
          // Identity, not id: two reports at one country centroid are distinct
          // entries, and clicking either should pin that one.
          if (rightsHit === state.selectedHumanRight) {
            dismissTooltip();
          } else {
            state.selectedHumanRight = rightsHit;
            // A milestone may already be docked. Leaving it selected would keep two
            // popups claiming to be pinned and let the milestone hover branch fight
            // the landmark one for the same pointer.
            state.selectedEvent = null;
            state.hoveredEvent = null;
            pinTooltipToHumanRight(rightsHit);
          }
        } else {
          // Zones, deployments and crisis rings. They were hover-only, so their
          // tooltips could never be pinned and the source link inside them was
          // unreachable - the same defect the landmark branch above had.
          const layer = findLayerAt(x, y);
          if (layer) {
            if (layer.entry === state.selectedLayer &&
                layer.type === state.selectedLayerType) {
              dismissTooltip();
            } else {
              state.selectedLayer = layer.entry;
              state.selectedLayerType = layer.type;
              state.selectedEvent = null;
              state.selectedHumanRight = null;
              pinTooltipToLayer(layer.entry, layer.type);
            }
          } else {
            // Empty canvas closes a pinned popup.
            dismissTooltip();
          }
        }
      } else if (hit === state.selectedEvent) {
        // Clicking the pinned dot again unpins it (identity, not id: two
        // milestones at one location can share a generated id).
        dismissTooltip();
      } else {
        state.selectedEvent = hit;
        state.selectedHumanRight = null;
        pinTooltipToEvent(hit);
      }
    }
    state.pressX = null;
    state.pressY = null;
    draw();
  }

  // Double-click to zoom in around the cursor
  canvas.addEventListener('dblclick', handleDblClick);
  function handleDblClick(e) {
    const rect = canvas.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, 1.5);
  }

  // ---- Zoom helpers (used by controls, wheel, keyboard, double-click) ----
  function applyZoom(x, y, factor) {
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, state.transform.scale * factor));
    const wx = (x - state.transform.tx) / state.transform.scale;
    const wy = (y - state.transform.ty) / state.transform.scale;
    state.transform.scale = newScale;
    state.transform.tx = x - wx * state.transform.scale;
    state.transform.ty = y - wy * state.transform.scale;
    dismissTooltip();
  }

  function zoomAt(x, y, factor) {
    applyZoom(x, y, factor);
    draw();
  }

  function resetView() {
    state.transform.scale = 1;
    state.transform.tx = 0;
    state.transform.ty = 0;
    dismissTooltip();
    draw();
  }

  // ---- Keyboard accessibility ----
  canvas.addEventListener('keydown', handleKeyDown);
  function handleKeyDown(e) {
    if (e.target !== canvas && !canvas.contains(e.target)) return;
    const panStep = 50 / state.transform.scale;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': state.transform.tx += panStep; break;
      case 'ArrowRight': state.transform.tx -= panStep; break;
      case 'ArrowUp': state.transform.ty += panStep; break;
      case 'ArrowDown': state.transform.ty -= panStep; break;
      case '+':
      case '=':
        zoomAt(state.width / 2, state.height / 2, 1.2);
        break;
      case '-':
        zoomAt(state.width / 2, state.height / 2, 1 / 1.2);
        break;
      case '0':
        resetView();
        break;
      case 'Escape':
        resetView();
        break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      dismissTooltip();
      draw();
    }
  }

  // Make canvas focusable for keyboard interaction
  canvas.setAttribute('tabindex', '0');
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', 'Interactive world map with transhumanist milestones');

  // ---- Tooltip ----
  function createTooltipElement(ev) {
    const color = landmarkColorFor(ev.category, ev.tone) || '#00d4ff';
    const wrapper = document.createElement('div');
    const cat = document.createElement('div');
    cat.className = 'tt-category';
    cat.style.color = color;
    cat.textContent = canonicalCategory(ev.category);
    // Label which half of a two-tone category this milestone belongs to.
    if (ev.tone) cat.textContent += ' \u00b7 ' + ev.tone;
    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = ev.title;
    const meta = document.createElement('div');
    meta.style.cssText = 'color: var(--fg-subtle); font-size: 0.7rem; margin-top: 4px;';
    meta.textContent = `${ev.source} · ${ev.date}`;
    wrapper.append(cat, title, meta);

    // Metric-less events publish their title as the value; skip the row when it
    // would only repeat the title heading above it.
    if (ev.value && ev.value !== ev.title) {
      const value = document.createElement('div');
      value.className = 'tt-value';
      value.textContent = ev.value;
      wrapper.appendChild(value);
    }

    if (ev.url && SOURCE_URL_RE.test(ev.url)) {
      const link = document.createElement('a');
      link.href = ev.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'tt-link';
      link.textContent = 'View source ↗';
      wrapper.appendChild(link);
    }

    const stackEvts = stackForEvent(ev);
    if (stackEvts.length > 1) {
      const pager = document.createElement('div');
      pager.className = 'tt-pager';
      pager.style.cssText = 'margin-top: 6px; display: flex; gap: 4px; justify-content: center; align-items: center;';
      // Real <button>s, not <span>s: only form controls match the :disabled
      // pseudo-class and honour the `disabled` property, so a <span> left the
      // pager looking clickable at the first/last milestone and was unreachable
      // by keyboard.
      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'tt-pager-btn tt-pager-prev';
      prevBtn.title = 'Previous milestone';
      prevBtn.setAttribute('aria-label', 'Previous milestone');
      prevBtn.textContent = '←';
      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'tt-pager-btn tt-pager-next';
      nextBtn.title = 'Next milestone';
      nextBtn.setAttribute('aria-label', 'Next milestone');
      nextBtn.textContent = '→';
      const indexEl = document.createElement('span');
      indexEl.className = 'tt-pager-index';
      indexEl.style.cssText = 'font-family: var(--font-mono); font-size: 0.7rem; color: var(--fg-subtle); min-width: 2.5ch; text-align: center;';
      // Start on the milestone actually shown, not always the first one.
      indexEl.textContent = `${Math.max(0, stackEvts.indexOf(ev)) + 1}/${stackEvts.length}`;
      pager.append(prevBtn, indexEl, nextBtn);
      wrapper.appendChild(pager);
    }
    return wrapper;
  }

  function moveTooltip(x, y) {
    if (!tooltip) return;
    const offset = TOOLTIP_OFFSET;
    // Clamp against the tooltip's real size when measurable (works even for
    // taller tooltips that include a value or source link).
    const tw = tooltip.offsetWidth || TOOLTIP_WIDTH;
    const th = tooltip.offsetHeight || TOOLTIP_HEIGHT;
    let tx = x + offset;
    let ty = y + offset;
    if (tx + tw > state.width) tx = x - tw - offset;
    if (ty + th > state.height) ty = y - th - offset;
    tooltip.style.left = tx + 'px';
    tooltip.style.top = ty + 'px';
  }

function showTooltip(ev, x, y) {
    if (!tooltip) return;
    // Keep the stack pager in step with the milestone actually on screen, and wire
    // it. The hover tooltip renders the same pager as the pinned popup, but only
    // the popup used to wire it: hovering the second member of a cluster showed
    // "2/2" with a dead prev button, so co-located milestones were reachable only
    // by clicking.
    const stack = stackForEvent(ev);
    state.stackIndex = stack.length > 1 ? Math.max(0, stack.indexOf(ev)) : 0;
    tooltip.replaceChildren(createTooltipElement(ev));
    wireStackPager(tooltip, ev);
    tooltip.classList.add('visible');
    moveTooltip(x, y);
  }

  // Attach prev/next behaviour to whichever stack pager is currently rendered.
  // Shared by the hover tooltip and the pinned popup: both render the same pager,
  // and wiring only one of them is what left the other visibly broken.
  function wireStackPager(container, ev) {
    const stack = stackForEvent(ev);
    if (stack.length <= 1) return;
    if (typeof container.querySelector !== 'function') return;
    const pager = container.querySelector('.tt-pager');
    if (!pager) return;
    const prevBtn = pager.querySelector('.tt-pager-prev');
    const nextBtn = pager.querySelector('.tt-pager-next');
    const indexEl = pager.querySelector('.tt-pager-index');

    const step = (delta) => {
      const members = stackForEvent(ev);
      const target = members[state.stackIndex + delta];
      if (!target) return;
      pinTooltipToEvent(target);
    };
    const handlePrev = (e) => { e.stopPropagation(); step(-1); };
    const handleNext = (e) => { e.stopPropagation(); step(1); };

    if (prevBtn) prevBtn.addEventListener('click', handlePrev);
    if (nextBtn) nextBtn.addEventListener('click', handleNext);
    pager._cleanup = () => {
      if (prevBtn) prevBtn.removeEventListener('click', handlePrev);
      if (nextBtn) nextBtn.removeEventListener('click', handleNext);
    };
    // Reflect the current position. Real <button>s are used precisely so this
    // works: a <span> accepts `disabled` but never matches :disabled, which is
    // why the arrows once looked clickable at the ends of the stack.
    const refresh = () => {
      const total = stackForEvent(ev).length;
      if (indexEl) indexEl.textContent = `${state.stackIndex + 1}/${total}`;
      if (prevBtn) prevBtn.disabled = state.stackIndex === 0;
      if (nextBtn) nextBtn.disabled = state.stackIndex >= total - 1;
    };
    refresh();
  }

  function hideTooltip() {
    if (tooltip) tooltip.classList.remove('visible');
  }

  // Pin the popup for a selected event: place it beside the dot once and keep
  // it from chasing the cursor, so the "View source" link stays reachable.
  function pinTooltipToEvent(ev) {
    if (!tooltip) return;
    const p = project(ev.lon, ev.lat);
    const tw = tooltip.offsetWidth || TOOLTIP_WIDTH;
    const th = tooltip.offsetHeight || TOOLTIP_HEIGHT;
    let tx = p.x + TOOLTIP_OFFSET;
    let ty = p.y + TOOLTIP_OFFSET;
    if (tx + tw > state.width) tx = p.x - tw - TOOLTIP_OFFSET;
    if (ty + th > state.height) ty = p.y - th - TOOLTIP_OFFSET;
    tooltip.style.left = tx + 'px';
    tooltip.style.top = ty + 'px';

    // Clean up previous pager if any (defensive: tooltip may be a mock without querySelector)
    if (typeof tooltip.querySelector === 'function') {
      const oldPager = tooltip.querySelector('.tt-pager');
      if (oldPager && oldPager._cleanup) oldPager._cleanup();
    }

    tooltip.replaceChildren(createTooltipElement(ev));
    tooltip.classList.add('visible');

    // Track which member of the stack is on screen so prev/next move from here
    // (the pager used to snap back to 1/N on every re-pin and never advanced),
    // then hand the pager to the shared wiring so the hover tooltip and this
    // popup cannot drift apart again.
    const stackEvts = stackForEvent(ev);
    state.stackIndex = stackEvts.length > 1 ? Math.max(0, stackEvts.indexOf(ev)) : 0;
    wireStackPager(tooltip, ev);
  }

  // Remove the tooltip AND forget which event it pointed at (including any
  // pinned selection). Forgetting is what lets the next mousemove re-open it
  // cleanly after a pan/zoom/drag moved the dots underneath the pointer.
  // Dock a landmark popup at the landmark rather than under the cursor, so it
  // survives the pointer travelling away to read it or reach its source link.
  function pinTooltipToHumanRight(entry) {
    if (!tooltip || !entry) return;
    const p = project(entry.lon, entry.lat);
    if (!p) return;
    showHumanRightsTooltip(entry, p.x, p.y);
  }

  function dismissTooltip() {
    // Clean up pager event listeners before hiding
    if (tooltip && typeof tooltip.querySelector === 'function') {
      const pager = tooltip.querySelector('.tt-pager');
      if (pager && pager._cleanup) pager._cleanup();
    }
    state.selectedEvent = null;
    state.selectedHumanRight = null;
    state.selectedLayer = null;
    state.selectedLayerType = null;
    state.hoveredEvent = null;
    state.hoveredType = null;
    state.stackIndex = 0;
    hideTooltip();
  }

  // A popup pinned to a milestone that a filter just took off the map would
  // otherwise linger over empty canvas, so drop it when its target disappears.
  function eventIsHidden(ev) {
    if (ev._hiddenByTimeline) return true;
    if (!isCategoryVisible(ev.category)) return true;
    return state.filterRecent && !isInRolling7Days(ev.date, currentDayISO());
  }

  // A docked landmark is released when it stops being drawable: the layer switched
  // off, the timeline filtered it away, or the data was replaced without it. Same
  // reasoning as eventIsHidden for milestones - a popup anchored to nothing is
  // just a stale panel covering the map.
  function humanRightIsHidden(entry) {
    if (!entry) return true;
    if (!state.showHumanRights) return true;
    if (entry._hiddenByTimeline) return true;
    return !state.humanRights.includes(entry);
  }

  function dismissTooltipIfTargetHidden() {
    // Layer popups (zone / crisis / deployment) carry no category and are not
    // affected by the milestone filters, so only milestones are checked.
    const targets = [state.selectedEvent, state.hoveredEvent].filter((t) => t && typeof t.category === 'string');
    if (targets.some(eventIsHidden)) { dismissTooltip(); return; }
    if (state.selectedHumanRight && humanRightIsHidden(state.selectedHumanRight)) {
      dismissTooltip();
      return;
    }
    if (state.selectedLayer &&
        layerIsHidden(state.selectedLayer, state.selectedLayerType)) {
      dismissTooltip();
    }
  }

  // ---- Zone/Deployment Tooltips ----
  // Shared lifecycle line for layer tooltips: a glowing "●" marker for still
  // active entries (shows how long they have been live) and a dim "○" for
  // concluded ones (shows the full duration span the layers pipeline recorded).
  function appendActivityLine(wrapper, item) {
    const line = document.createElement('div');
    line.style.cssText = 'margin-top: 4px; font-size: 0.7rem; color: var(--fg-muted);';
    line.textContent = `${isLayerActive(item) ? '●' : '○'} ${layerActivityLabel(item)}`;
    if (isLayerActive(item)) {
      line.style.color = 'var(--accent)';
      line.style.fontWeight = '600';
    }
    wrapper.appendChild(line);
    return wrapper;
  }

  function createZoneTooltipElement(zone) {
    const wrapper = document.createElement('div');
    const cat = document.createElement('div');
    cat.className = 'tt-category';
    cat.style.color = ZONE_COLOR;
    cat.textContent = 'Conflict Zone';
    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = zone.name;
    const meta = document.createElement('div');
    meta.style.cssText = 'color: var(--fg-subtle); font-size: 0.7rem; margin-top: 4px;';
    if (zone.source && zone.url && SOURCE_URL_RE.test(zone.url)) {
      const link = document.createElement('a');
      link.href = zone.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.color = 'var(--accent)';
      link.textContent = zone.source;
      meta.appendChild(link);
    } else {
      meta.textContent = zone.source || 'Unknown source';
    }
    wrapper.append(cat, title, meta);
    if (zone.note) {
      const note = document.createElement('div');
      note.style.cssText = 'margin-top: 6px; font-size: 0.75rem; color: var(--fg-muted);';
      note.textContent = zone.note;
      wrapper.appendChild(note);
    }
    return appendActivityLine(wrapper, zone);
  }

  function createDeploymentTooltipElement(fleet) {
    const wrapper = document.createElement('div');
    const cat = document.createElement('div');
    cat.className = 'tt-category';
    const isInfantry = isInfantryKind(fleet);
    cat.style.color = (isInfantry || fleet.kind === 'ground') ? GROUND_COLOR : FLEET_COLOR;
    cat.textContent = isInfantry ? 'Ground Deployment' : (fleet.kind === 'ground' ? 'Ground Deployment' : 'Fleet Deployment');
    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = fleet.label;
    const meta = document.createElement('div');
    meta.style.cssText = 'color: var(--fg-subtle); font-size: 0.7rem; margin-top: 4px;';
    if (fleet.source && fleet.url && SOURCE_URL_RE.test(fleet.url)) {
      const link = document.createElement('a');
      link.href = fleet.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.color = 'var(--accent)';
      link.textContent = fleet.source;
      meta.appendChild(link);
    } else {
      meta.textContent = fleet.source || 'Unknown source';
    }
    wrapper.append(cat, title, meta);

    // Add country/nation info for infantry deployments
    if (fleet.country) {
      const countryEl = document.createElement('div');
      countryEl.style.cssText = 'font-size: 0.75rem; color: var(--fg-muted); margin-top: 2px;';
      countryEl.textContent = `Nation: ${fleet.country}`;
      wrapper.appendChild(countryEl);
    }

    // Route info. Derived from the same endpoints the renderer draws, so an
    // infantry arrow (lat/lon + direction, no from/to) reports a real route
    // instead of silently showing nothing.
    const ends = fleetEndpoints(fleet);
    if (ends) {
      const fromEl = document.createElement('div');
      fromEl.style.cssText = 'font-size: 0.75rem; color: var(--fg-muted); margin-top: 2px;';
      fromEl.textContent = `From: ${ends.from.lat.toFixed(1)}°, ${ends.from.lon.toFixed(1)}°`;
      wrapper.appendChild(fromEl);
      const toEl = document.createElement('div');
      toEl.style.cssText = 'font-size: 0.75rem; color: var(--fg-muted); margin-top: 2px;';
      toEl.textContent = `To: ${ends.to.lat.toFixed(1)}°, ${ends.to.lon.toFixed(1)}°`;
      wrapper.appendChild(toEl);
    }
    if (fleet.direction) {
      const dirEl = document.createElement('div');
      dirEl.style.cssText = 'font-size: 0.75rem; color: var(--fg-muted); margin-top: 2px;';
      dirEl.textContent = `Heading: ${String(fleet.direction).toLowerCase()}`;
      wrapper.appendChild(dirEl);
    }

    // Add troop count if available
    if (fleet.troops) {
      const troopsEl = document.createElement('div');
      troopsEl.style.cssText = 'font-size: 0.75rem; color: var(--fg-muted); margin-top: 2px;';
      troopsEl.textContent = `Troops: ${fleet.troops.toLocaleString()}`;
      wrapper.appendChild(troopsEl);
    }

    if (fleet.note) {
      const note = document.createElement('div');
      note.style.cssText = 'margin-top: 6px; font-size: 0.75rem; color: var(--fg-muted);';
      note.textContent = fleet.note;
      wrapper.appendChild(note);
    }
    return appendActivityLine(wrapper, fleet);
  }

  function moveZoneTooltip(x, y) {
    if (!tooltip) return;
    const offset = TOOLTIP_OFFSET;
    const tw = tooltip.offsetWidth || TOOLTIP_WIDTH;
    const th = tooltip.offsetHeight || TOOLTIP_HEIGHT;
    let tx = x + TOOLTIP_OFFSET;
    let ty = y + TOOLTIP_OFFSET;
    if (tx + tw > state.width) tx = x - tw - TOOLTIP_OFFSET;
    if (ty + th > state.height) ty = y - th - TOOLTIP_OFFSET;
    tooltip.style.left = tx + 'px';
    tooltip.style.top = ty + 'px';
  }

  function moveDeploymentTooltip(x, y) {
    if (!tooltip) return;
    const offset = TOOLTIP_OFFSET;
    const tw = tooltip.offsetWidth || TOOLTIP_WIDTH;
    const th = tooltip.offsetHeight || TOOLTIP_HEIGHT;
    let tx = x + TOOLTIP_OFFSET;
    let ty = y + TOOLTIP_OFFSET;
    if (tx + tw > state.width) tx = x - tw - TOOLTIP_OFFSET;
    if (ty + th > state.height) ty = y - th - TOOLTIP_OFFSET;
    tooltip.style.left = tx + 'px';
    tooltip.style.top = ty + 'px';
  }

  function showZoneTooltip(zone, x, y) {
    if (!tooltip) return;
    tooltip.replaceChildren(createZoneTooltipElement(zone));
    tooltip.classList.add('visible');
    moveZoneTooltip(x, y);
  }

  function showDeploymentTooltip(fleet, x, y) {
    if (!tooltip) return;
    tooltip.replaceChildren(createDeploymentTooltipElement(fleet));
    tooltip.classList.add('visible');
    moveDeploymentTooltip(x, y);
  }

  function createCrisisTooltipElement(crisis) {
    const wrapper = document.createElement('div');
    const cat = document.createElement('div');
    cat.className = 'tt-category';
    cat.style.color = CRISIS_COLOR;
    cat.textContent = 'Crisis Zone';
    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = crisis.name;
    const meta = document.createElement('div');
    meta.style.cssText = 'color: var(--fg-subtle); font-size: 0.7rem; margin-top: 4px;';
    if (crisis.source && crisis.url && SOURCE_URL_RE.test(crisis.url)) {
      const link = document.createElement('a');
      link.href = crisis.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.color = 'var(--accent)';
      link.textContent = crisis.source;
      meta.appendChild(link);
    } else {
      meta.textContent = crisis.source || 'Unknown source';
    }
    wrapper.append(cat, title, meta);
    if (crisis.note) {
      const note = document.createElement('div');
      note.style.cssText = 'margin-top: 6px; font-size: 0.75rem; color: var(--fg-muted);';
      note.textContent = crisis.note;
      wrapper.appendChild(note);
    }
    return appendActivityLine(wrapper, crisis);
  }

  function moveCrisisTooltip(x, y) {
    if (!tooltip) return;
    const offset = TOOLTIP_OFFSET;
    const tw = tooltip.offsetWidth || TOOLTIP_WIDTH;
    const th = tooltip.offsetHeight || TOOLTIP_HEIGHT;
    let tx = x + TOOLTIP_OFFSET;
    let ty = y + TOOLTIP_OFFSET;
    if (tx + tw > state.width) tx = x - tw - TOOLTIP_OFFSET;
    if (ty + th > state.height) ty = y - th - TOOLTIP_OFFSET;
    tooltip.style.left = tx + 'px';
    tooltip.style.top = ty + 'px';
  }

  function showCrisisTooltip(crisis, x, y) {
    if (!tooltip) return;
    tooltip.replaceChildren(createCrisisTooltipElement(crisis));
    tooltip.classList.add('visible');
    moveCrisisTooltip(x, y);
  }

  // Human Rights Violations reuse the milestone tooltip treatment, as specified:
  // a reader who has learned to read a milestone dot can read these too.
  function showHumanRightsTooltip(entry, x, y) {
    if (!tooltip) return;
    tooltip.replaceChildren(createHumanRightsTooltipElement(entry));
    tooltip.classList.add('visible');
    moveHumanRightsTooltip(x, y);
  }

  const moveHumanRightsTooltip = moveCrisisTooltip;

  function createHumanRightsTooltipElement(entry) {
    const wrapper = document.createElement('div');
    const cat = document.createElement('div');
    cat.className = 'tt-category';
    cat.style.color = HUMAN_RIGHTS_COLOR;
    cat.textContent = 'Human Rights Violation';
    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = entry.name;
    wrapper.append(cat, title);
    if (entry.note) {
      const note = document.createElement('div');
      note.style.cssText = 'color: var(--fg-muted); font-size: 0.72rem; margin-top: 4px;';
      note.textContent = entry.note;
      wrapper.appendChild(note);
    }
    // Several reports can geocode to one country centroid. Without this line the
    // legend count reads as a bug: the marker is a fan, not a single report.
    const clusterCount = humanRightClusterSize(entry);
    if (clusterCount > 1) {
      const shared = document.createElement('div');
      shared.style.cssText = 'color: var(--fg-muted); font-size: 0.72rem; margin-top: 4px;';
      shared.textContent = clusterCount + ' reports at this location';
      wrapper.appendChild(shared);
    }

    const meta = document.createElement('div');
    meta.style.cssText = 'color: var(--fg-subtle); font-size: 0.7rem; margin-top: 4px;';
    const bits = [entry.region, entry.start_date].filter(Boolean).join(' \u00b7 ');
    if (entry.source && entry.url && SOURCE_URL_RE.test(entry.url)) {
      const link = document.createElement('a');
      link.href = entry.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.color = 'var(--accent)';
      link.textContent = bits ? bits + ' \u2014 ' + entry.source : entry.source;
      meta.appendChild(link);
    } else {
      meta.textContent = [bits, entry.source].filter(Boolean).join(' \u2014 ') || 'Unknown source';
    }
    wrapper.appendChild(meta);
    return wrapper;
  }

  // ---- Stats computation ----
  // The rolling 7-day window runs from today back six days, inclusive. The window
  // only moves when the day does, but isInRolling7Days() is called once per event
  // per frame (draw runs ~10x/s) and rebuilt two Date objects every time. Memoise
  // on the day it was computed for, so a new todayISO (a real midnight rollover or
  // the test clock) recomputes and replaces the entry.
  let rollingBoundsDay = null;
  let rollingBounds = null;
  function rolling7DayBounds(todayISO) {
    if (rollingBoundsDay === todayISO) return rollingBounds;
    const end = new Date(todayISO + 'T00:00:00Z');
    const start = new Date(end.getTime() - 6 * 86400000); // 6 days back = 7 days total
    rollingBoundsDay = todayISO;
    rollingBounds = { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
    return rollingBounds;
  }

  function parseDateToISO(dateStr) {
    if (!dateStr) return null;
    const trimmed = String(dateStr).trim();
    // Try parsing as YYYY-MM-DD first
    const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    }
    // Try parsing as DD-MM-YYYY or DD/MM/YYYY
    const dmyMatch = trimmed.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
    if (dmyMatch) {
      const day = dmyMatch[1].padStart(2, '0');
      const month = dmyMatch[2].padStart(2, '0');
      const year = dmyMatch[3];
      return `${year}-${month}-${day}`;
    }
    // Fallback: try Date constructor
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
    return null;
  }

  function isInRolling7Days(dateStr, todayISO) {
    const iso = parseDateToISO(dateStr);
    if (!iso) return false;
    const { start, end } = rolling7DayBounds(todayISO);
    return iso >= start && iso <= end;
  }

  // Single source of truth for "today": rendering, hit-testing, stats and the
  // stack map must all window the same day, otherwise a dot can be drawn but not
  // clicked (or vice versa).
  function currentDayISO() {
    const hook = (typeof window !== 'undefined' && window.__WORLDMAP_TEST__)?.getTodayISO;
    return hook ? hook() : new Date().toISOString().slice(0, 10);
  }

  // Legacy ISO week function (kept for test compatibility)
  function weekBoundsISO(todayISO) {
    const d = new Date(todayISO + 'T00:00:00Z');
    const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow + 6));
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }

  function isInCurrentWeek(dateStr, todayISO) {
    if (!dateStr) return false;
    const iso = String(dateStr).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
    const { start, end } = weekBoundsISO(todayISO);
    return iso >= start && iso <= end;
  }

  function computeStats() {
    const counts = {
      breakthroughs: 0, conflicts: 0, fleets: 0, crises: 0,
      conflictsActive: 0, conflictsConcluded: 0,
      fleetsActive: 0, fleetsConcluded: 0,
      crisesActive: 0, crisesConcluded: 0
    };
    // Must be the same "today" the stack map and hit-testing window on, or the
    // headline count can disagree with what is drawn on the map.
    const todayISO = currentDayISO();
    state.events.forEach(ev => {
       if (!isCategoryVisible(ev.category)) return;
       // Always count breakthroughs in the last 7 days (static count)
       if (!isInRolling7Days(ev.date, todayISO)) return;
       const statMap = CATEGORY_STAT_MAP[canonicalCategory(ev.category)];
       if (!statMap || statMap.statId !== 'map-stat-active') return;
       counts.breakthroughs++;
     });
     // Conflicts/fleets/crises: always show actual total counts (not zero when
     // invisible), plus an active/concluded split so the fluo/dim styling is
     // reflected in the button labels and legend counts.
     counts.conflicts = state.zones.length;
     counts.conflictsActive = state.zones.filter(isLayerActive).length;
     counts.conflictsConcluded = counts.conflicts - counts.conflictsActive;
     counts.fleets = state.fleets.length;
     counts.fleetsActive = state.fleets.filter(isLayerActive).length;
     counts.fleetsConcluded = counts.fleets - counts.fleetsActive;
     counts.crises = state.crises.length;
     counts.crisesActive = state.crises.filter(isLayerActive).length;
     counts.crisesConcluded = counts.crises - counts.crisesActive;
     return counts;
   }

  function toggleFilterRecent() {
    state.filterRecent = !state.filterRecent;
    try { localStorage.setItem(STORAGE_KEY_FILTER_RECENT, String(state.filterRecent)); } catch (_) {}
    rebuildStackMap();
    dismissTooltipIfTargetHidden();
    updateFilterButton('filter-recent', state.filterRecent);
    draw();
    updateStatsDisplay();
    renderLegend();
  }

  function toggleFilterMilitary() {
    state.filterMilitary = !state.filterMilitary;
    // When toggling military filter, also toggle both layers together
    state.showZones = state.filterMilitary;
    state.showFleets = state.filterMilitary;
    try { 
      localStorage.setItem(STORAGE_KEY_FILTER_MILITARY, String(state.filterMilitary)); 
      localStorage.setItem(STORAGE_KEY_SHOW_ZONES, String(state.showZones));
      localStorage.setItem(STORAGE_KEY_SHOW_FLEETS, String(state.showFleets));
    } catch (_) {}
    syncFilterButtons();
    draw();
    updateStatsDisplay();
    renderLegend();
  }

  function toggleFilterCrisis() {
    state.filterCrisis = !state.filterCrisis;
    // When toggling crisis filter, also toggle crisis layer
    state.showCrises = state.filterCrisis;
    try { 
      localStorage.setItem(STORAGE_KEY_FILTER_CRISIS, String(state.filterCrisis)); 
      localStorage.setItem(STORAGE_KEY_SHOW_CRISES, String(state.showCrises));
    } catch (_) {}
    syncFilterButtons();
    draw();
    updateStatsDisplay();
    renderLegend();
  }

  function updateFilterButton(id, pressed) {
    const btn = document.getElementById(id);
    if (btn) {
      btn.setAttribute('aria-pressed', String(pressed));
      btn.style.opacity = pressed ? '1' : '0.5';
    }
  }

  // Whether each upper-left tile currently controls something that is actually
  // painted. The tiles are gated on the filter flag, but the legend can switch
  // every layer underneath a filter off, so the flag alone stays true while
  // nothing is drawn. Reporting the flag re-lit the tile at full brightness with
  // an empty map behind it, which read as "selected" when nothing was selected.
  // Effective visibility = filter flag AND at least one of its layers on.
  function militaryVisible() { return state.filterMilitary && (state.showZones || state.showFleets); }
  function crisisVisible() { return state.filterCrisis && state.showCrises; }

  // Single place that keeps all three tiles in step with what is on the map, so
  // the filter buttons and the legend rows can never disagree.
  function syncFilterButtons() {
    updateFilterButton('filter-recent', state.filterRecent);
    updateFilterButton('filter-military', militaryVisible());
    updateFilterButton('filter-crisis', crisisVisible());
  }

  function toggleLayer(name) {
    if (name === 'zones') {
      state.showZones = !state.showZones;
      try { localStorage.setItem(STORAGE_KEY_SHOW_ZONES, String(state.showZones)); } catch (_) {}
    } else if (name === 'fleets' || name === 'deployments') {
      state.showFleets = !state.showFleets;
      try { localStorage.setItem(STORAGE_KEY_SHOW_FLEETS, String(state.showFleets)); } catch (_) {}
    } else if (name === 'crises') {
      state.showCrises = !state.showCrises;
      try { localStorage.setItem(STORAGE_KEY_SHOW_CRISES, String(state.showCrises)); } catch (_) {}
    } else if (name === 'human_rights') {
      state.showHumanRights = !state.showHumanRights;
      try { localStorage.setItem(STORAGE_KEY_SHOW_HUMAN_RIGHTS, String(state.showHumanRights)); } catch (_) {}
      // Switching the layer off while one of its popups is docked would leave the
      // panel floating over a map it no longer describes.
      if (!state.showHumanRights) dismissTooltip();
    }
    // If enabling a military layer, also enable the military filter
    if ((name === 'zones' && state.showZones) || (name === 'fleets' && state.showFleets) || (name === 'deployments' && state.showFleets)) {
      if (!state.filterMilitary) {
        state.filterMilitary = true;
        try { localStorage.setItem(STORAGE_KEY_FILTER_MILITARY, 'true'); } catch (_) {}
      }
    }
    // If enabling crisis layer, also enable the crisis filter
    if (name === 'crises' && state.showCrises) {
      if (!state.filterCrisis) {
        state.filterCrisis = true;
        try { localStorage.setItem(STORAGE_KEY_FILTER_CRISIS, 'true'); } catch (_) {}
      }
    }
    draw();
    updateStatsDisplay();
    // Re-derive brightness from effective visibility, so switching the last layer
    // off in a group dims that group's tile instead of leaving it lit.
    syncFilterButtons();
    renderLegend();
  }

  function appendLayerRow(fragment, opts) {
    const row = document.createElement('div');
    row.className = 'map-legend-row';
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-label', `${opts.label}, ${opts.count}`);
    row.tabIndex = 0;
    row.setAttribute('aria-pressed', String(opts.visible));
    row.setAttribute('data-layer', opts.key);
    if (opts.title) row.setAttribute('title', opts.title);
    if (opts.splitColors && opts.splitColors.length > 1) {
      // Split dot: render a dot for each color in the split array
      // so the legend shows both ground (green) and fleet (blue) components.
      for (const c of opts.splitColors) {
        const dot = document.createElement('span');
        dot.className = 'map-legend-dot';
        dot.style.background = c;
        dot.style.borderColor = c;
        dot.setAttribute('aria-hidden', 'true');
        row.append(dot);
      }
    } else {
      const dot = document.createElement('span');
      dot.className = 'map-legend-dot' + (opts.ring ? ' map-legend-dot--ring' : '') + (opts.diamond ? ' map-legend-dot--diamond' : '');
      dot.style.background = opts.color;
      dot.style.borderColor = opts.color;
      dot.setAttribute('aria-hidden', 'true');
      row.append(dot);
    }
    const label = document.createElement('span');
    label.className = 'map-legend-label';
    label.textContent = opts.label;
    const count = document.createElement('span');
    count.className = 'map-legend-count';
    count.textContent = opts.count;
    count.setAttribute('aria-hidden', 'true');
    row.append(label, count);
    row.addEventListener('click', () => toggleLayer(opts.key));
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleLayer(opts.key);
      }
    });
    fragment.appendChild(row);
  }

  function updateStatsDisplay() {
    const stats = computeStats();
    const active = document.getElementById('map-stat-active');
    const conflicts = document.getElementById('map-stat-conflicts');
    const fleets = document.getElementById('map-stat-fleets');
    const crises = document.getElementById('map-stat-crises');
    if (active) active.textContent = stats.breakthroughs;
    if (conflicts) conflicts.textContent = stats.conflicts;
    if (fleets) fleets.textContent = stats.fleets;
    if (crises) crises.textContent = stats.crises;

    // Update button labels with smart pluralization
    const breakthroughLabel = document.querySelector('#filter-recent .map-hint-title span:last-child');
    if (breakthroughLabel) {
      breakthroughLabel.textContent = ` ${pluralize(stats.breakthroughs, 'breakthrough', 'breakthroughs')} this week`;
    }
    const conflictLabel = document.querySelector('#filter-military .map-hint-title span:nth-child(2)');
    if (conflictLabel) {
      conflictLabel.textContent = stats.conflictsConcluded > 0
        ? ` ${pluralize(stats.conflicts, 'conflict zone', 'conflict zones')} · ${stats.conflictsActive} active, ${stats.conflictsConcluded} concluded,`
        : ` ${pluralize(stats.conflicts, 'active conflict zone', 'active conflict zones')},`;
    }
    const fleetLabel = document.querySelector('#filter-military .map-hint-title span:last-child');
    if (fleetLabel) {
      fleetLabel.textContent = stats.fleetsConcluded > 0
        ? ` ${pluralize(stats.fleets, 'deployment', 'deployments')} · ${stats.fleetsActive} active, ${stats.fleetsConcluded} concluded`
        : ` ${pluralize(stats.fleets, 'deployment', 'deployments')}`;
    }
    const crisisLabel = document.querySelector('#filter-crisis .map-hint-title span:last-child');
    if (crisisLabel) {
      crisisLabel.textContent = stats.crisesConcluded > 0
        ? ` ${pluralize(stats.crises, 'humanitarian crisis', 'humanitarian crises')} · ${stats.crisesActive} active, ${stats.crisesConcluded} concluded`
        : ` ${pluralize(stats.crises, 'humanitarian crisis', 'humanitarian crises')}`;
    }
  }

  // ---- Milestone data notice ----
  // An empty map with no explanation reads as "no breakthroughs recorded", which
  // is a different and false claim from "we could not reach the data". One small
  // live-region line, built once and reused, fixes the difference for assistive
  // tech as well as sighted visitors.
  let dataNoticeEl = null;
  function renderDataNotice() {
    const mapEl = document.getElementById('world-map');
    if (!mapEl) return;
    const message = state.dataLoadError;
    if (!message) {
      if (dataNoticeEl && dataNoticeEl.parentNode) dataNoticeEl.remove();
      dataNoticeEl = null;
      return;
    }
    if (!dataNoticeEl || !dataNoticeEl.parentNode) {
      dataNoticeEl = document.createElement('p');
      dataNoticeEl.id = 'map-data-notice';
      dataNoticeEl.className = 'map-data-notice';
      dataNoticeEl.setAttribute('role', 'status');
      dataNoticeEl.setAttribute('aria-live', 'polite');
      mapEl.appendChild(dataNoticeEl);
    }
    dataNoticeEl.textContent = message;
  }

  // ---- Legend ----
  // Humanized legend/count breakdown for a layer list (active vs concluded).
  function layerCountTitle(items) {
    const active = items.filter(isLayerActive).length;
    const concluded = items.length - active;
    if (concluded === 0) return `${active} active`;
    return `${active} active, ${concluded} concluded`;
  }

  function renderLegend() {
    const mapEl = document.getElementById('world-map');
    if (!mapEl) return;
    let legendEl = document.getElementById('map-legend');
    if (!legendEl) {
      legendEl = document.createElement('div');
      legendEl.id = 'map-legend';
      legendEl.className = 'map-legend';
      legendEl.setAttribute('role', 'list');
      legendEl.setAttribute('aria-label', 'Milestone categories with event counts');
      mapEl.appendChild(legendEl);
    }

    const counts = {};
      state.events.forEach(ev => {
        const key = canonicalCategory(ev.category);
        if (CATEGORY_COLORS[key]) {
          counts[key] = (counts[key] || 0) + 1;
        }
      });

const fragment = document.createDocumentFragment();

      // Header row: the fold control on the left, the bulk eye on the right.
      const head = document.createElement('div');
      head.className = 'map-legend-head';

      const title = document.createElement('div');
      title.className = 'map-legend-title';
      title.textContent = 'CATEGORIES';
      title.setAttribute('role', 'button');
      title.setAttribute('tabindex', '0');
      title.setAttribute('aria-pressed', String(state.foldedCategories));
      title.setAttribute('aria-label', 'Toggle categories visibility');

      // The click target is the whole header row, not the seven-pixel-tall word. The
      // empty space in front of, above, under and behind CATEGORIES - right up to the
      // eye - toggles the list, which is where a pointer actually goes. Keyboard focus
      // stays on the word itself, where role="button" and tabindex live, because a
      // <button> inside a role="button" is invalid ARIA.
      const toggleFolded = () => {
        // renderLegend() rebuilds the whole frame, which destroys the element that
        // had focus. Without this a keyboard user toggles once and is dumped back on
        // <body>, so the second Enter goes nowhere and the control looks broken.
        const hadFocus = document.activeElement === title ||
                         document.activeElement === head;
        state.foldedCategories = !state.foldedCategories;
        renderLegend();
        if (hadFocus) {
          const next = document.querySelector('.map-legend-title');
          if (next && typeof next.focus === 'function') next.focus();
        }
      };
      head.addEventListener('click', toggleFolded);
      title.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleFolded();
        }
      });
      head.appendChild(title);

      // White eye, drawn rather than an icon font so it scales with the frame and
      // needs no extra asset. The lid is a stroke that rotates down over the iris.
      const bulk = document.createElement('button');
      bulk.type = 'button';
      bulk.id = 'map-legend-bulk-visibility';
      bulk.className = 'map-legend-bulk';
      bulk.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleAllCategories();
      });
      const eyeNs = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(eyeNs, 'svg');
      svg.setAttribute('viewBox', '0 0 12 12');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const outline = document.createElementNS(eyeNs, 'path');
      outline.setAttribute('d', 'M1.1 6 C3 2.9 4.5 2.4 6 2.4 C7.5 2.4 9 2.9 10.9 6'
        + ' C9 9.1 7.5 9.6 6 9.6 C4.5 9.6 3 9.1 1.1 6 Z');
      outline.setAttribute('fill', 'none');
      outline.setAttribute('stroke', 'currentColor');
      outline.setAttribute('stroke-width', '1.1');
      outline.setAttribute('stroke-linejoin', 'round');
      const iris = document.createElementNS(eyeNs, 'circle');
      iris.setAttribute('class', 'eye-iris');
      iris.setAttribute('cx', '6');
      iris.setAttribute('cy', '6');
      iris.setAttribute('r', '1.7');
      iris.setAttribute('fill', 'currentColor');
      const lid = document.createElementNS(eyeNs, 'path');
      lid.setAttribute('class', 'eye-lid');
      lid.setAttribute('d', 'M1.2 6 L10.8 6');
      lid.setAttribute('stroke', 'currentColor');
      lid.setAttribute('stroke-width', '1.4');
      lid.setAttribute('stroke-linecap', 'round');
      svg.append(outline, iris, lid);
      bulk.appendChild(svg);
      applyBulkVisibilityState(bulk);
      head.appendChild(bulk);

      fragment.appendChild(head);

      // Wrapper for category rows that can be folded with animation
      const categoriesWrapper = document.createElement('div');
      categoriesWrapper.className = 'map-legend-categories';
      categoriesWrapper.style.overflow = 'hidden';
      categoriesWrapper.style.transition = 'max-height 0.15s ease, opacity 0.15s ease';
      if (state.foldedCategories) {
        categoriesWrapper.style.maxHeight = '0';
        categoriesWrapper.style.opacity = '0';
      } else {
        categoriesWrapper.style.maxHeight = '500px';
        categoriesWrapper.style.opacity = '1';
      }

      CATEGORY_LEGEND.forEach(cat => {
        const row = document.createElement('div');
        row.className = 'map-legend-row';
        row.setAttribute('role', 'listitem');
        row.setAttribute('aria-label', `${cat.label}, ${counts[cat.key] || 0} events`);
        row.tabIndex = 0;
        row.setAttribute('aria-pressed', String(!state.hiddenCategories.has(cat.key)));
        row.setAttribute('data-category', cat.key);
        const subtone = CATEGORY_SUBTONES[cat.key];
        if (subtone) {
          // Two-tone categories show both colours side by side, like the
          // Deployments ground/fleet row, so the split is discoverable.
          for (const colour of [CATEGORY_COLORS[cat.key], subtone.secondaryColor]) {
            const toneDot = document.createElement('span');
            toneDot.className = 'map-legend-dot';
            toneDot.style.background = colour;
            toneDot.setAttribute('aria-hidden', 'true');
            row.appendChild(toneDot);
          }
          row.setAttribute('aria-label',
            cat.label + ' (' + subtone.primary + ' and ' + subtone.secondary + '), ' +
            (counts[cat.key] || 0) + ' events');
        } else {
          const dot = document.createElement('span');
          dot.className = 'map-legend-dot';
          dot.style.background = CATEGORY_COLORS[cat.key];
          dot.setAttribute('aria-hidden', 'true');
          row.appendChild(dot);
        }
        const label = document.createElement('span');
        label.className = 'map-legend-label';
        label.textContent = cat.label;
        const count = document.createElement('span');
        count.className = 'map-legend-count';
        count.textContent = String(counts[cat.key] || 0);
        count.setAttribute('aria-hidden', 'true');
        row.append(label, count);
        row.addEventListener('click', () => toggleCategory(cat.key));
        row.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleCategory(cat.key);
          }
        });
        categoriesWrapper.appendChild(row);
      });
      fragment.appendChild(categoriesWrapper);

      // Operational layers: toggleable, with the same row pattern as categories.
      // Zones render as a ring, deployments as a diamond (direction arrows on canvas).
      // Crisis zones (humanitarian) render as a ring with purple color.
      const zonesVisible = state.filterMilitary && state.showZones;
      const deploymentsVisible = state.filterMilitary && state.showFleets;
      const crisesVisible = state.filterCrisis && state.showCrises;
      appendLayerRow(fragment, {
        key: 'zones',
        label: 'Conflict Zones',
        visible: zonesVisible,
        color: ZONE_COLOR,
        count: String(state.zones.length),
        ring: true,
        title: layerCountTitle(state.zones)
      });
      appendLayerRow(fragment, {
        key: 'deployments',
        label: 'Ground Deployments & Fleet Movements',
        visible: deploymentsVisible,
        splitColors: [GROUND_COLOR, FLEET_COLOR],
        count: String(state.fleets.length),
        diamond: true,
        title: layerCountTitle(state.fleets)
      });
      appendLayerRow(fragment, {
        key: 'crises',
        label: 'Crisis Zones',
        visible: crisesVisible,
        color: CRISIS_COLOR,
        count: String(state.crises.length),
        ring: true,
        title: layerCountTitle(state.crises)
      });
      // Human Rights Violations: landmarks with milestone tooltips, off by
      // default like every operational layer. A layer, not a category, so it
      // carries no category colour and never appears in a category filter.
      appendLayerRow(fragment, {
        key: 'human_rights',
        label: 'Human Rights Violations',
        visible: state.showHumanRights,
        color: HUMAN_RIGHTS_COLOR,
        count: String(state.humanRights.length),
        landmark: true,
        title: layerCountTitle(state.humanRights)
      });

    // Controls section at bottom of legend — reuse existing controls if present
    // (e.g., from initial markup or previous render) to keep event listeners stable.
    let controlsDiv = document.getElementById('map-legend-controls');
    let zoomInBtn = document.getElementById('zoom-in');
    let zoomOutBtn = document.getElementById('zoom-out');
    let resetBtn = document.getElementById('reset-view');
    let terminatorToggle = document.getElementById('terminator-toggle');
    let terminatorIcon = document.getElementById('terminator-icon');
    let terminatorLabel = document.getElementById('terminator-label');

    if (!controlsDiv) {
      controlsDiv = document.createElement('div');
      controlsDiv.id = 'map-legend-controls';
      controlsDiv.className = 'map-legend-controls';
      controlsDiv.setAttribute('role', 'group');
      controlsDiv.setAttribute('aria-label', 'Map controls');
    } else {
      // Clear existing children to rebuild
      controlsDiv.replaceChildren();
    }

    function setupButton(btn, id, className, ariaLabel, text, handler) {
      if (!btn) {
        btn = document.createElement('button');
        btn.id = id;
        btn.className = className;
        btn.setAttribute('aria-label', ariaLabel);
        btn.textContent = text;
      }
      // Always ensure handler is attached (idempotent via flag)
      const flag = '_handler_' + id;
      if (!btn[flag]) {
        btn[flag] = true;
        btn.addEventListener('click', handler);
      }
      return btn;
    }

    zoomInBtn = setupButton(zoomInBtn, 'zoom-in', 'map-control-btn', 'Zoom in', '+', () => zoomAt(state.width / 2, state.height / 2, 1.4));
    zoomOutBtn = setupButton(zoomOutBtn, 'zoom-out', 'map-control-btn', 'Zoom out', '−', () => zoomAt(state.width / 2, state.height / 2, 1 / 1.4));
    resetBtn = setupButton(resetBtn, 'reset-view', 'map-control-btn', 'Reset map view', '⟲', resetView);
    function setupTerminatorToggle(btn, icon) {
      if (btn._terminatorHandler) return; // already set up
      btn._terminatorHandler = true;
      btn.addEventListener('click', () => {
        state.showTerminator = !state.showTerminator;
        btn.setAttribute('aria-pressed', state.showTerminator);
        // Icon shows current state: ☾ = night overlay on, ☀ = off
        icon.textContent = state.showTerminator ? '☾' : '☀';
        draw();
      });
    }

    if (!terminatorToggle) {
      terminatorToggle = document.createElement('button');
      terminatorToggle.id = 'terminator-toggle';
      terminatorToggle.className = 'map-control-btn';
      terminatorIcon = document.createElement('span');
      terminatorIcon.id = 'terminator-icon';
      terminatorLabel = document.createElement('span');
      terminatorLabel.id = 'terminator-label';
      terminatorLabel.textContent = 'Day/Night';
      terminatorToggle.append(terminatorIcon, terminatorLabel);
    }
    setupTerminatorToggle(terminatorToggle, terminatorIcon);
    // Update terminator toggle state (in case it existed already)
    terminatorToggle.setAttribute('aria-pressed', state.showTerminator);
    // Icon shows what clicking will do: ☀ = will show day (turn off), ☾ = will show night (turn on)
    terminatorIcon.textContent = state.showTerminator ? '☾' : '☀';

    controlsDiv.append(zoomInBtn, zoomOutBtn, resetBtn, terminatorToggle);
    fragment.appendChild(controlsDiv);

    legendEl.replaceChildren(fragment);
  }

  // ---- Data loading ----
  let eventsAbortController = null;

  // Map a raw event.json entry to the internal shape, applying fallbacks for
  // every optional field so downstream rendering never hits placeholders.
  // Includes intelligent geocoding fallback for missing or invalid coordinates.
  function normalizeEvent(e) {
    let lat = e.geolocation?.lat;
    let lon = e.geolocation?.lon;
    // Accept the already-flattened form as well, so normalising is idempotent.
    //
    // This was a silent data-loss bug: normalise() rewrites geolocation into flat
    // lat/lon and drops the geolocation object, so normalising its own output a
    // second time found no coordinates at all, failed isPlottable() and discarded
    // every record. setEvents() is exposed, so handing it the current state back is
    // a legitimate thing to do, and it silently emptied the map.
    if (!Number.isFinite(lat) && Number.isFinite(e.lat)) lat = e.lat;
    if (!Number.isFinite(lon) && Number.isFinite(e.lon)) lon = e.lon;
    // Intelligent geocoding fallback if coordinates missing OR invalid (0,0 indicates missing)
    const hasValidCoords = Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
    // When the pipeline has already ruled on this record it says so explicitly
    // (`located: false`, emitted after running its full geocoding cascade).
    // Honouring that decision matters: the client-side table below is a third,
    // smaller copy of the institution hints and uses the older "first match in
    // source+title+category" rule, so a second opinion here could place a
    // milestone somewhere the pipeline deliberately did not - and would place it
    // worse. The fallback still runs for hand-authored or legacy payloads, which
    // carry no such flag.
    const pipelineLocated = e.located === false;
    if (!hasValidCoords && !pipelineLocated) {
      const geo = geocodeInstitution(e.source, e.title, e.category);
      if (geo) {
        lat = geo.lat;
        lon = geo.lon;
      }
    }
    // Built field by field rather than spread from `e`, so an upstream payload
    // cannot smuggle in a cached `_stackKey` (or any other internal flag) that
    // would make two different events collapse into one stack.
    return {
      id: e.id || `${lat},${lon},${e.title ?? 'Untitled'}`,
      lat,
      lon,
      title: e.title ?? 'Untitled',
      category: e.category ?? 'Unknown',
      value: e.value ?? '',
      source: e.source ?? 'Unknown',
      url: e.url ?? '',
      date: String(e.date ?? '')
    };
  }

  // Events without usable numeric coordinates or string title/category are not
  // renderable and must be dropped before drawing or stat/legend counting.
  // NaN/Infinity slips past typeof checks (1e400 parses to Infinity), so gate
  // on Number.isFinite and reject out-of-range coordinates too.
  function isPlottable(ev) {
    return typeof ev.title === 'string' &&
      typeof ev.category === 'string' &&
      Number.isFinite(ev.lat) && ev.lat >= -90 && ev.lat <= 90 &&
      Number.isFinite(ev.lon) && ev.lon >= -180 && ev.lon <= 180;
  }

  // True only for a developer machine. Used to decide whether the fabricated
  // SAMPLE_EVENTS may be shown, so a deployed copy can never present invented
  // milestones as real ones. `location` is read defensively because this also runs
  // under a DOM stub in the test harness.
  const isLocalDev = (() => {
    try {
      const h = window.location && window.location.hostname;
      if (!h) return false;
      return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' ||
        h === '0.0.0.0' || h.endsWith('.localhost');
    } catch (_) {
      return false;
    }
  })();

  async function loadEvents() {
    if (eventsAbortController) eventsAbortController.abort();
    eventsAbortController = new AbortController();

    const eventsUrl = '/data/events.json';
    try {
      const r = await fetch(eventsUrl, { cache: 'no-store', signal: eventsAbortController.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (data && Array.isArray(data.events)) {
        state.events = data.events.map(normalizeEvent).filter(isPlottable);
        state.dataLoadError = null;
      } else {
        // Shape mismatch is a broken deploy, not an empty dataset. Say so rather
        // than rendering a blank map that looks like "no milestones yet".
        state.events = [];
        state.dataLoadError = 'events.json did not contain an "events" array';
        console.warn('[worldmap] ' + state.dataLoadError);
      }
      rebuildStackMap();
    } catch (err) {
      if (err.name === 'AbortError') return;
      // Dev keeps a usable map while iterating; production must not invent data.
      if (isLocalDev) {
        state.events = SAMPLE_EVENTS;
        state.dataLoadError = null;
        console.warn('[worldmap] Failed to load events.json, using LOCAL DEV sample data:', err);
      } else {
        state.events = [];
        state.dataLoadError = 'milestone data is temporarily unavailable';
        console.warn('[worldmap] Failed to load events.json:', err);
      }
      rebuildStackMap();
    }
    renderDataNotice();
  }

  // Operational layers: conflict zones (dots) and tracked fleet movements
  // (direction arrows). Purely additive — safe to fall back to empty arrays.
  let layersAbortController = null;

  function normalizeZone(z) {
    // radiusDeg: coerce to a finite number and clamp to a sane range so a bad
    // value can never produce NaN pixels or a dot larger than a hemisphere.
    const rawR = Number(z.radiusDeg);
    const radiusDeg = Number.isFinite(rawR) && rawR > 0
      ? Math.min(Math.max(rawR, 0.5), 30)
      : 3;
    return {
      id: z.id || '',
      name: z.name || 'Unnamed zone',
      region: z.region || '',
      lat: z.lat,
      lon: z.lon,
      radiusDeg,
      status: z.status || 'active',
      start_date: z.start_date || '',
      end_date: z.end_date || '',
      source: z.source || '',
      url: z.url || '',
      note: z.note || ''
    };
  }

  function normalizeFleet(f) {
    const isInfantry = f.kind === 'infantry' || f.kind === 'mobilization' || f.kind === 'deployment' || f.kind === 'rotation';
    if (isInfantry) {
      // Infantry deployments have lat/lon instead of from/to
      return {
        id: f.id || '',
        label: f.name || f.label || 'Infantry Deployment',
        kind: f.kind,
        lat: f.lat,
        lon: f.lon,
        status: f.status || 'active',
        start_date: f.start_date || '',
        end_date: f.end_date || '',
        note: f.note || '',
        source: f.source || '',
        // url/country were dropped here, so the deployment popup could never
        // offer a source link or name the nation for a ground movement.
        url: f.url || '',
        country: f.country || '',
        troops: f.troops,
        direction: f.direction,
        last_news_year: f.last_news_year,
        radiusDeg: f.radiusDeg || 2
      };
    }
    // Fleet/ground movements have from/to
    return {
      id: f.id || '',
      label: f.label || 'Deployment',
      kind: f.kind === 'ground' ? 'ground' : 'fleet',
      from: f.from || {},
      to: f.to || {},
      status: f.status || 'active',
      start_date: f.start_date || f.date || '',
      end_date: f.end_date || '',
      note: f.note || '',
      source: f.source || '',
      url: f.url || '',
      last_news_year: f.last_news_year
    };
  }

  // The same Number.isFinite + range gate as isPlottable (1e400 Infinity slips
  // past typeof checks); bad layers draw NaN dots/arrows, so drop them first.
  function isZonePlottable(z) {
    return typeof z.name === 'string' &&
      Number.isFinite(z.lat) && z.lat >= -90 && z.lat <= 90 &&
      Number.isFinite(z.lon) && z.lon >= -180 && z.lon <= 180 &&
      !(z.lat === 0 && z.lon === 0); // (0,0) is the "no location" marker, not a real position
  }

  // Human rights entries share the zone shape so the tooltip builder can render
  // them like milestones. radiusDeg is dropped on purpose: these are landmarks,
  // not area rings.
  function normalizeHumanRight(h) {
    return {
      id: h.id || '',
      name: h.name || 'Unnamed report',
      region: h.region || '',
      lat: Number(h.lat),
      lon: Number(h.lon),
      status: h.status || 'active',
      start_date: h.start_date || '',
      end_date: h.end_date || '',
      source: h.source || '',
      url: h.url || '',
      note: h.note || ''
    };
  }

  function isHumanRightPlottable(h) {
    return isZonePlottable(h);
  }

  // A fleet arrow needs both endpoints valid; a missing/malformed endpoint
  // drops the whole movement instead of drawing a degenerate arrow. (0,0) is
  // the "unlocated" marker (same convention as normalizeEvent) and is rejected.
  const isLocatedCoord = (c) =>
    Number.isFinite(c?.lat) && c?.lat >= -90 && c?.lat <= 90 &&
    Number.isFinite(c?.lon) && c?.lon >= -180 && c?.lon <= 180 &&
    !(c?.lat === 0 && c?.lon === 0);

  function isFleetPlottable(f) {
    const isInfantry = f.kind === 'infantry' || f.kind === 'mobilization' || f.kind === 'deployment' || f.kind === 'rotation';
    if (isInfantry) {
      return isLocatedCoord({ lat: f.lat, lon: f.lon });
    }
    return isLocatedCoord(f?.from) && isLocatedCoord(f?.to);
  }

  async function loadLayers() {
    if (layersAbortController) layersAbortController.abort();
    layersAbortController = new AbortController();

    const layersUrl = '/data/world_layers.json';
    try {
      const r = await fetch(layersUrl, { cache: 'no-store', signal: layersAbortController.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      state.zones = Array.isArray(data.conflict_zones)
        ? data.conflict_zones.map(normalizeZone).filter(isZonePlottable)
        : [];
      state.crises = Array.isArray(data.crisis_zones)
        ? data.crisis_zones.map(normalizeZone).filter(isZonePlottable)
        : [];
      const deployments = data.deployments && Array.isArray(data.deployments)
        ? data.deployments
        : (data.fleet_movements && Array.isArray(data.fleet_movements) ? data.fleet_movements : []);
      state.fleets = deployments.map(normalizeFleet).filter(isFleetPlottable);
      // Human Rights Violations: an operational layer, not a milestone category.
      // Landmarks, so they get milestone tooltips rather than a ring.
      state.humanRights = Array.isArray(data.human_rights_violations)
        ? data.human_rights_violations.map(normalizeHumanRight).filter(isHumanRightPlottable)
        : [];
      rebuildHumanRightStackMap();
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('[worldmap] Failed to load world_layers.json, using empty layers:', err);
      state.zones = [];
      state.fleets = [];
      state.crises = [];
      state.humanRights = [];
      rebuildHumanRightStackMap();
    }
  }

  // ---- Animation loop ----
  let lastDrawTime = 0;
  let animationFrameId = null;

  function loop() {
    if (document.hidden || prefersReducedMotion) {
      animationFrameId = null;
      return;
    }
    const now = Date.now();
    if (state.events.length && now - lastDrawTime >= DRAW_INTERVAL_MS) {
      draw();
      lastDrawTime = now;
    }
    animationFrameId = requestAnimationFrame(loop);
  }

  function onVisibilityChange() {
    if (!document.hidden) {
      if (!animationFrameId) animationFrameId = requestAnimationFrame(loop);
      if (state.showTerminator && state.events.length) draw();
    }
  }

let terminatorInterval = null;
function startTerminatorInterval() {
  if (prefersReducedMotion) return;
  if (terminatorInterval) clearInterval(terminatorInterval);
  terminatorInterval = setInterval(() => {
    if (!document.hidden && state.showTerminator && state.events.length) draw();
  }, TERMINATOR_UPDATE_MS);
}

// Cluster milestone events by year: only events dated in that year stay visible.
// Like filterLayersByYear, this is intentionally inert until the slider moves so
// a first-time visitor sees the whole milestone set.
function filterEventsByYear(year) {
  state.events.forEach(ev => {
    if (ev.date) {
      // Route through parseDateToISO (same accept-surface as the 7-day filter):
      // raw .slice(0,4) would misparse "15/03/2026" as the year 15.
      ev._hiddenByTimeline = parseInt((parseDateToISO(ev.date) || '').slice(0, 4), 10) !== year;
    } else {
      ev._hiddenByTimeline = false;
    }
  });
  // Stacks must track the slider, otherwise the count badge and the pager keep
  // paging through milestones the visitor cannot see.
  rebuildStackMap();
}

// Cluster the operational layers by year, mirroring how the slider clusters
// milestone events: still-active entries are plotted from their start year
// onward, concluded ones only inside their active window. Items are left
// untouched on first load so a fresh visitor sees the full set (consistent
// with the events behaviour — the slider only engages once moved).
function filterLayersByYear(year) {
  state.zones.forEach(z => { z._hiddenByTimeline = !layerVisibleInYear(z, year); });
  state.fleets.forEach(f => { f._hiddenByTimeline = !layerVisibleInYear(f, year); });
  state.crises.forEach(c => { c._hiddenByTimeline = !layerVisibleInYear(c, year); });
  // Landmarks are an operational layer too and carry the same start/end dates and
  // status as the zones above, so the slider has to reach them. It did not: nothing
  // ever set _hiddenByTimeline on these entries, which left every _hiddenByTimeline
  // check in drawHumanRightsLandmark, findHumanRight and visibleHumanRightClusters
  // permanently false. Moving the slider appeared to do nothing at all to this layer.
  state.humanRights.forEach(h => { h._hiddenByTimeline = !layerVisibleInYear(h, year); });
}

// Timeline slider initialization
function initTimelineSlider() {
  const timeline = document.getElementById('map-timeline');
  const track = document.getElementById('map-timeline-track');
  const handle = document.getElementById('map-timeline-handle');
  const yearsContainer = document.getElementById('map-timeline-years');
  
  if (!timeline || !track || !handle) return () => {};
  
  // Generate year labels
  renderTimelineYears();
  
  // Set initial handle position and APPLY filter on load so historical milestones respect slider
  updateTimelineHandle();
  applyTimelineFilter();
  
  // Mouse events
  let isDragging = false;
  
  function onPointerDown(e) {
    isDragging = true;
    e.preventDefault();
    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  }
  
  function onPointerMove(e) {
    if (!isDragging) return;
    updateTimelineFromClientX(e.clientX);
  }
  
  function onPointerUp() {
    isDragging = false;
    document.body.style.userSelect = '';
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
  }
  
  function onTrackClick(e) {
    if (e.target === track) {
      updateTimelineFromClientX(e.clientX);
    }
  }
  
  // Register event listeners
  track.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointerdown', onPointerDown);
  track.addEventListener('click', onTrackClick);
  handle.addEventListener('keydown', onHandleKeydown);
  
  function onHandleKeydown(e) {
    let changed = false;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        timelineYear = Math.max(TIMELINE_MIN_YEAR, timelineYear - 1);
        changed = true;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        timelineYear = Math.min(getTimelineMaxYear(), timelineYear + 1);
        changed = true;
        break;
      case 'Home':
        timelineYear = TIMELINE_MIN_YEAR;
        changed = true;
        break;
      case 'End':
        timelineYear = getTimelineMaxYear();
        changed = true;
        break;
    }
    if (changed) {
      e.preventDefault();
      updateTimelineHandle();
      applyTimelineFilter();
    }
  }

  function updateTimelineFromClientX(clientX) {
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    timelineYear = Math.round(TIMELINE_MIN_YEAR + ratio * (getTimelineMaxYear() - TIMELINE_MIN_YEAR));
    updateTimelineHandle();
    applyTimelineFilter();
  }
  
  function updateTimelineHandle() {
    const ratio = (timelineYear - TIMELINE_MIN_YEAR) / (getTimelineMaxYear() - TIMELINE_MIN_YEAR);
    handle.style.left = `${ratio * 100}%`;
    timeline.setAttribute('aria-valuenow', Math.round(ratio * 100));
    // Update handle aria-label
    handle.setAttribute('aria-label', `Year ${timelineYear}`);
    // Update year label display
    const yearLabel = document.getElementById('map-timeline-year-label');
    if (yearLabel) {
      yearLabel.textContent = timelineYear;
    }
  }
  
  function renderTimelineYears() {
    if (!yearsContainer) return;
    yearsContainer.replaceChildren();
    const totalYears = getTimelineMaxYear() - TIMELINE_MIN_YEAR + 1;
    const step = Math.max(1, Math.ceil(totalYears / 25));
    for (let year = TIMELINE_MIN_YEAR; year <= getTimelineMaxYear(); year++) {
      if ((year - TIMELINE_MIN_YEAR) % step !== 0 && year !== getTimelineMaxYear()) continue;
      const label = document.createElement('span');
      label.textContent = year.toString();
      label.style.position = 'absolute';
      label.style.left = `${((year - TIMELINE_MIN_YEAR) / (getTimelineMaxYear() - TIMELINE_MIN_YEAR)) * 100}%`;
      label.style.transform = 'translateX(-50%)';
      label.style.fontSize = '0.55rem';
      label.style.fontFamily = 'var(--font-mono)';
      label.style.color = 'var(--fg-subtle)';
      label.style.whiteSpace = 'nowrap';
      label.style.pointerEvents = 'none';
      yearsContainer.appendChild(label);
    }
  }
  
  function applyTimelineFilter() {
    // Filter events by year and cluster the operational layers per year too.
    filterEventsByYear(timelineYear);
    filterLayersByYear(timelineYear);
    dismissTooltipIfTargetHidden();
    draw();
    updateStatsDisplay();
  }

  // Return cleanup function for timeline slider
  return function cleanupTimelineSlider() {
    track.removeEventListener('pointerdown', onPointerDown);
    handle.removeEventListener('pointerdown', onPointerDown);
    track.removeEventListener('click', onTrackClick);
    handle.removeEventListener('keydown', onHandleKeydown);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
  };
}

// ---- Init ----
  async function load() {
    await loadEvents();
    await loadLayers();
    updateStatsDisplay();
    renderLegend();
    resize();
    window.addEventListener('resize', scheduleResize);
    document.addEventListener('visibilitychange', onVisibilityChange);
    animationFrameId = requestAnimationFrame(loop);
    startTerminatorInterval();

    // Initialize filter buttons. Listeners are attached per button, then the
    // brightness/pressed state is derived once from effective visibility so a
    // returning visitor whose saved flags and saved layer state disagree (filter
    // on, every layer off) does not start with a lit but empty tile.
    const filterRecentBtn = document.getElementById('filter-recent');
    const filterMilitaryBtn = document.getElementById('filter-military');
    if (filterRecentBtn) {
      filterRecentBtn.addEventListener('click', toggleFilterRecent);
    }
    if (filterMilitaryBtn) {
      filterMilitaryBtn.addEventListener('click', toggleFilterMilitary);
    }

    // Initialize crisis filter button
    const filterCrisisBtn = document.getElementById('filter-crisis');
    if (filterCrisisBtn) {
      filterCrisisBtn.addEventListener('click', toggleFilterCrisis);
    }
    syncFilterButtons();


    // Initialize timeline slider
    const cleanupTimelineSlider = initTimelineSlider();

    // Keep tooltip open while the pointer is over it so the source link is clickable
    if (tooltip) {
      tooltip.addEventListener('mouseenter', handleTooltipMouseEnter);
      tooltip.addEventListener('mouseleave', handleTooltipMouseLeave);
      // A press that begins on the popup is never a map pan. Clearing the press
      // origin stops handleMouseMove from treating a drag across the popup as a
      // canvas drag and hiding the very popup being dragged from.
      tooltip.addEventListener('mousedown', handleTooltipMouseDown);
    }
  }

  function handleTooltipMouseDown() {
    state.pressX = null;
    state.pressY = null;
  }

  function cleanup() {
    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
    if (scheduledDrawId) { cancelAnimationFrame(scheduledDrawId); scheduledDrawId = null; }
    if (terminatorInterval) { clearInterval(terminatorInterval); terminatorInterval = null; }
    window.removeEventListener('beforeunload', flushAndStopGeocodeCache);
    window.removeEventListener('pagehide', flushAndStopGeocodeCache);
    if (geocodeCacheIntervalId) { clearInterval(geocodeCacheIntervalId); geocodeCacheIntervalId = null; }
    if (eventsAbortController) eventsAbortController.abort();
    if (layersAbortController) layersAbortController.abort();
    if (resizeTimeout) clearTimeout(resizeTimeout);
    window.removeEventListener('resize', scheduleResize);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    canvas.removeEventListener('mousemove', handleMouseMove);
    canvas.removeEventListener('mousedown', handleMouseDown);
    window.removeEventListener('mouseup', handleMouseUp);
    canvas.removeEventListener('dblclick', handleDblClick);
    canvas.removeEventListener('keydown', handleKeyDown);
    if (tooltip) {
      tooltip.removeEventListener('mouseenter', handleTooltipMouseEnter);
      tooltip.removeEventListener('mouseleave', handleTooltipMouseLeave);
      tooltip.removeEventListener('mousedown', handleTooltipMouseDown);
    }
    if (cleanupTimelineSlider) cleanupTimelineSlider();
    if (dataNoticeEl && dataNoticeEl.parentNode) dataNoticeEl.remove();
    dataNoticeEl = null;
  }

  // ---- Test hook (inert in production; enabled only when the harness pre-sets the flag) ----
  if (typeof window !== 'undefined' && window.__WORLDMAP_TEST__) {
    const existingTestHook = window.__WORLDMAP_TEST__;
    window.__WORLDMAP_TEST__ = {
      canonicalCategory,
  parseHiddenCategories,
  HIDDEN_CATEGORIES_MAX_BYTES,
      CATEGORY_COLORS,
      CATEGORY_STAT_MAP,
      CATEGORY_LEGEND,
      CATEGORY_ALIASES,
  CATEGORY_SUBTONES,
  landmarkColorFor,
  secondaryColorFor,
  HUMAN_RIGHTS_COLOR,
  HUMAN_RIGHTS_PULSE_MS,
  HUMAN_RIGHTS_HIT_RADIUS,
  HUMAN_RIGHTS_CORE_MAX,
  HUMAN_RIGHTS_GLOW_INNER,
  HUMAN_RIGHTS_GLOW_PULSE,
  normalizeHumanRight,
  isHumanRightPlottable,
  findHumanRight,
  areAllCategoriesHidden,
  toggleAllCategories,
  renderLegend,
  mapBox,
  mapScreenRect,
  project,
  // Resize synchronously and redraw. Tests need a canvas change to take effect
  // before the next assertion; the production path uses the debounced
  // scheduleResize() instead.
  resizeNow() { applyResize(); draw(); },
  humanRightStackFor,
  humanRightClusterSize,
  visibleHumanRightClusters,
  isNearAnchor,
  sameLocationCluster,
  PROXIMITY_RADIUS,
      normalizeEvent,
      parseGeocodeCache,
      SOURCE_URL_RE,
      isPlottable,
      normalizeZone,
      isZonePlottable,
      normalizeFleet,
      isFleetPlottable,
      weekBoundsISO,
      isInCurrentWeek,
      get getTodayISO() {
        return existingTestHook?.getTodayISO ?? (() => new Date().toISOString().slice(0, 10));
      },
      getView: () => ({ ...state.transform }),
      setFilterRecent: (val) => { state.filterRecent = val; rebuildStackMap(); syncFilterButtons(); draw(); updateStatsDisplay(); renderLegend(); },
      setFilterMilitary: (val) => { state.filterMilitary = val; state.showZones = val; state.showFleets = val; syncFilterButtons(); draw(); updateStatsDisplay(); renderLegend(); },
      toggleLayer,
      militaryVisible,
      crisisVisible,
      // Layer lifecycle helpers + stats (fluo/concluded split).
      layerStatus,
      isLayerActive,
      layerActivityLabel,
      layerVisibleInYear,
      normalizeLayerDate,
      computeStats,
      layerCountTitle,
      isInfantryKind,
      fleetEndpoints,
      isStaleLayer,
      layerTier,
      layerPaintTier,
      layerRecencyYear,
      isSingleListSourced,
      LAYER_TIER_PAINT,
      LAYER_TIER_ARROW,
      get LAYER_FRESH_YEARS() { return LAYER_FRESH_YEARS; },
      get LAYER_STALE_YEARS() { return LAYER_STALE_YEARS; },
      isLocalDev,
      renderDataNotice,
      get SAMPLE_EVENTS() { return SAMPLE_EVENTS; },
      setDataLoadError: (msg) => { state.dataLoadError = msg; renderDataNotice(); },
      get dataLoadError() { return state.dataLoadError; },
      get GEOCODE_CACHE_MAX_BYTES() { return GEOCODE_CACHE_MAX_BYTES; },
      // Replace the loaded layer data (used to exercise fluo/dim + timeline
      // clustering deterministically without mutating the shared fixtures).
      setLayers: (zones, fleets, crises, humanRights) => {
        state.zones = (zones || []).map(normalizeZone).filter(isZonePlottable);
        state.fleets = (fleets || []).map(normalizeFleet).filter(isFleetPlottable);
        state.crises = (crises || []).map(normalizeZone).filter(isZonePlottable);
        state.humanRights = (humanRights || []).map(normalizeHumanRight).filter(isHumanRightPlottable);
        rebuildHumanRightStackMap();
        // A docked landmark may not exist in the replacement data.
        if (state.selectedHumanRight
            && !state.humanRights.includes(state.selectedHumanRight)) {
          dismissTooltip();
        }
        updateStatsDisplay();
        renderLegend();
      },
      getLayers: () => ({
        zones: state.zones,
        fleets: state.fleets,
        crises: state.crises,
        humanRights: state.humanRights
      }),
      // Same pattern as setLayers but for milestone events (drives timeline
      // clustering tests deterministically).
      setEvents: (events) => {
        state.events = (events || []).map(normalizeEvent).filter(isPlottable);
        rebuildStackMap();
        draw();
        updateStatsDisplay();
        renderLegend();
      },
      getEvents: () => state.events,
      // Exposed so tests can reset transient hover/selection state, which is
      // anchored by design and would otherwise leak between them.
      getState: () => state,
      // Drive the same year-clustering code path as the timeline slider.
      setTimelineYear: (year) => {
        timelineYear = Math.max(TIMELINE_MIN_YEAR, Math.min(getTimelineMaxYear(), year));
        filterEventsByYear(timelineYear);
        filterLayersByYear(timelineYear);
        dismissTooltipIfTargetHidden();
        draw();
        updateStatsDisplay();
      },
      getTimelineYear: () => timelineYear,
      // Stack membership for one location (visit order) — what the count badge
      // and the pager are built from.
      stackForEvent,
      toggleCategory,
      // Pure geometry for the day/night terminator (deterministic tests): the
      // shared sunrise/sunset curve plus the unwrapped night band it feeds.
      buildTerminatorGeo,
      buildNightBand,
      // Screen projection + the default-view latitude window it crops to.
      project,
      get MAP_LAT_NORTH() { return MAP_LAT_NORTH; },
      get MAP_LAT_SOUTH() { return MAP_LAT_SOUTH; },
      get MAP_LAT_SPAN() { return MAP_LAT_SPAN; },
      get TERMINATOR_LAT_LIMIT() { return TERMINATOR_LAT_LIMIT; },
      get NIGHT_FILL() { return NIGHT_FILL; },
      // Pin the sun position (lat, lon) so day/night rendering is deterministic;
      // pass (null, null) to restore the live clock.
      setSunPosition: (lat, lon) => {
        state.sunPositionOverride = (lat === null && lon === null) ? null : { lat: lat || 0, lon: lon || 0 };
        draw();
      }
    };
  }

  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('pagehide', cleanup);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
