/* Interactive world map — projection + event plotting
 * No external dependencies. Equirectangular projection with smooth pan/zoom.
 * Includes day/night terminator overlay (sun position).
 */
(function() {
  'use strict';

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
  const ZOOM_FACTOR = 1.1;
  const HIT_RADIUS_BASE = 10;
  const CLICK_DRAG_THRESHOLD = 5;
  const TOOLTIP_WIDTH = 260;
  const TOOLTIP_HEIGHT = 100;
  const TOOLTIP_OFFSET = 12;

  // Day/night palette. Deliberately disjoint from every CATEGORY_COLORS value
  // so the terminator never visually collides with a milestone category.
  const DAY_TINT = 'rgba(140, 200, 255, 0.07)';
  const NIGHT_FILL = 'rgba(2, 6, 14, 0.45)';
  const SUNSET_BOUNDARY = 'rgba(255, 222, 178, ALPHA)';
  const SUNRISE_BOUNDARY = 'rgba(176, 188, 255, ALPHA)';
  const SUN_ICON = '#fff3c4';
  const SUN_ICON_GLOW = '#fff3c4';
  const MOON_ICON = '#c9d0ff';
  const MOON_ICON_GLOW = '#c9d0ff';

  // Operational layers (conflict zones + tracked deployments).
  const ZONE_COLOR = '#ff6d8a';
  const ZONE_FILL = 'rgba(255, 109, 138, 0.14)';
  const ZONE_STROKE = 'rgba(255, 109, 138, 0.9)';
  // Crisis zones (humanitarian): distinct purple to differentiate from conflict (red) and deployments (blue/amber)
  const CRISIS_COLOR = '#b388ff';
  const CRISIS_FILL = 'rgba(179, 136, 255, 0.14)';
  const CRISIS_STROKE = 'rgba(179, 136, 255, 0.9)';
  // Ground deployments: distinct amber/orange to avoid confusion with Biotechnology green
  const GROUND_COLOR = '#ffb347';
  const FLEET_COLOR = '#4fc3f7';
  // Very transparent arrow tail line (barely visible) — 8% opacity
  const ARROW_TAIL_OPACITY = 0.08;
  
  function withOpacity(hexColor, opacity) {
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }

  // ---- Layer lifecycle (active/concluded + duration) ----
  // Operational layers now carry an optional lifecycle: still-active zones,
  // crises and deployments are drawn with a distinct "fluo" glow, while
  // concluded ones render dim and expose their full duration in the tooltip.
  const STATUS_ACTIVE = 'active';
  const STATUS_CONCLUDED = 'concluded';
  const FLUO_GLOW_BLUR = 18;        // halo radius for live area rings
  const FLUO_LINE_GLOW_BLUR = 9;    // halo radius for vector tails + arrowheads
  const FLUO_PULSE_RADIUS = 6;      // how much the halo breathes (px)
  const CONCLUDED_OPACITY = 0.45;   // dimming applied to concluded markers

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
  let geocodeCache = {};
  try {
    const cached = localStorage.getItem(GEOCODE_CACHE_KEY);
    if (cached) geocodeCache = JSON.parse(cached);
  } catch (_) {}

  let geocodeCacheDirty = false;
  function saveGeocodeCache() {
    if (!geocodeCacheDirty) return;
    try {
      localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(geocodeCache));
      geocodeCacheDirty = false;
    } catch (_) {}
  }
  // Persist cache periodically and on unload
  setInterval(saveGeocodeCache, 30000);
  window.addEventListener('beforeunload', saveGeocodeCache);
  window.addEventListener('pagehide', saveGeocodeCache);

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
    'usaf': { lat: 38.8951, lon: -77.0364 },
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
  };

  function geocodeInstitution(source, title, category) {
    // Skip geocoding for placeholder/unknown values
    if (!source || source === 'Unknown' || source === 'unknown') return null;
    if (!title || title === 'Untitled' || title === 'untitled') return null;
    
    const cacheKey = `${source}|${title}|${category}`.toLowerCase();
    if (geocodeCache[cacheKey]) {
      return geocodeCache[cacheKey];
    }
    const text = `${source} ${title} ${category}`.toLowerCase();
    for (const [key, coords] of Object.entries(INSTITUTION_COORDS)) {
      // Use word-boundary-ish matching to avoid false positives on short keys
      const pattern = `(^|[^a-z0-9])${key.toLowerCase()}([^a-z0-9]|$)`;
      if (new RegExp(pattern).test(text)) {
        // Enforce cache size limit (LRU-ish: delete oldest entry)
        if (Object.keys(geocodeCache).length >= GEOCODE_CACHE_MAX_SIZE) {
          const firstKey = Object.keys(geocodeCache)[0];
          delete geocodeCache[firstKey];
        }
        geocodeCache[cacheKey] = coords;
        geocodeCacheDirty = true;
        return coords;
      }
    }
    // Fallback: try to extract from known patterns
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
  try {
    const fr = localStorage.getItem(STORAGE_KEY_FILTER_RECENT);
    const fm = localStorage.getItem(STORAGE_KEY_FILTER_MILITARY);
    const fc = localStorage.getItem(STORAGE_KEY_FILTER_CRISIS);
    const sz = localStorage.getItem(STORAGE_KEY_SHOW_ZONES);
    const sf = localStorage.getItem(STORAGE_KEY_SHOW_FLEETS);
    const sc = localStorage.getItem(STORAGE_KEY_SHOW_CRISES);
    if (fr !== null) filterRecentDefault = fr === 'true';
    if (fm !== null) filterMilitaryDefault = fm === 'true';
    if (fc !== null) filterCrisisDefault = fc === 'true';
    if (sz !== null) showZonesDefault = sz === 'true';
    if (sf !== null) showFleetsDefault = sf === 'true';
    if (sc !== null) showCrisesDefault = sc === 'true';
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
      pressX: null,
      pressY: null,
      events: [],
      showTerminator: true,
      hiddenCategories: new Set(),
      foldedCategories: false,  // whether the entire categories section is folded
      zones: [],
      fleets: [],
      crises: [],
      // Filter states
      filterRecent: filterRecentDefault,  // breakthroughs this week only
      filterMilitary: filterMilitaryDefault, // conflict zones & deployments
      filterCrisis: filterCrisisDefault,   // crisis zones
      // Layer visibility (persisted, default OFF)
      showZones: showZonesDefault,
      showFleets: showFleetsDefault,
      showCrises: showCrisesDefault,
      // Cached terminator data (geo-space: sun angle barely moves, but the
      // screen projection must be recomputed for every draw since pan/zoom
      // changes the transform).
      terminatorCache: {
        sunLon: null,
        sunLat: null,
        sunsetGeo: null,
        sunriseGeo: null,
        computedAt: 0
      }
    };

  const CATEGORY_COLORS = {
    'Biotechnology': '#00e676',
    'Computing & AGI': '#448aff',
    'Quantum Physics': '#b388ff',
    'Renewable Energy': '#ffd740',
    'Cybersecurity': '#ff5252',
    'Spaceflight & Aeronautics': '#00d4ff',
    'Military & Defense': '#ff9100'
  };

  const CATEGORY_STAT_MAP = {
    'Biotechnology': { statId: 'map-stat-active', label: 'breakthroughs this week' },
    'Cybersecurity': { statId: 'map-stat-conflicts', label: 'active conflict zones' },
    'Military & Defense': { statId: 'map-stat-fleets', label: 'fleet movements tracked' },
    'Renewable Energy': { statId: 'map-stat-active', label: 'breakthroughs this week' },
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
    'Spaceflight & Aeronautics': 'Spaceflight & Aeronautics'
  };

  // Canonical category order used by the legend (color, label).
  const CATEGORY_LEGEND = [
    { key: 'Biotechnology', label: 'Biotechnology' },
    { key: 'Computing & AGI', label: 'Computing & AGI' },
    { key: 'Quantum Physics', label: 'Quantum Physics' },
    { key: 'Renewable Energy', label: 'Renewable Energy' },
    { key: 'Cybersecurity', label: 'Cybersecurity' },
    { key: 'Spaceflight & Aeronautics', label: 'Spaceflight & Aeronautics' },
    { key: 'Military & Defense', label: 'Military & Defense' }
  ];

function canonicalCategory(cat) {
    return CATEGORY_ALIASES[cat] || cat;
  }

  function isCategoryVisible(cat) {
    const canonical = canonicalCategory(cat);
    return !state.hiddenCategories.has(canonical);
  }

  function toggleCategory(cat) {
    const canonical = canonicalCategory(cat);
    if (state.hiddenCategories.has(canonical)) {
      state.hiddenCategories.delete(canonical);
    } else {
      state.hiddenCategories.add(canonical);
    }
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
  function project(lon, lat) {
    const x = (lon + 180) / 360 * state.width;
    const y = (90 - lat) / 180 * state.height;
    return { x: x * state.transform.scale + state.transform.tx, y: y * state.transform.scale + state.transform.ty };
  }

  // ---- Sample data (fallback) ----
  // Note: Dates are kept recent (within last 7 days of typical deploy) so the "this week" filter works in local dev.
  // For production, real data is loaded from /data/events.json via fetch.
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

    for (let i = 0; i <= TERMINATOR_SAMPLES; i++) {
      const lat = 90 - (i / TERMINATOR_SAMPLES) * 180;
      const latRad = lat * Math.PI / 180;
      const declRad = sunLat * Math.PI / 180;

      const cosHourAngle = -Math.tan(latRad) * Math.tan(declRad);

      let lon;
      if (cosHourAngle >= 1) {
        lon = effLon - 180;
      } else if (cosHourAngle <= -1) {
        lon = effLon;
      } else {
        const hourAngle = Math.acos(Math.max(-1, Math.min(1, cosHourAngle)));
        lon = effLon + (hourAngle * 180 / Math.PI);
      }

      geo[i] = { lon: normalizeLon(lon), lat };
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
      cache.sunLon = sunLon;
      cache.sunLat = sunLat;
      cache.computedAt = now;
    }
    return { sunset: cache.sunsetGeo, sunrise: cache.sunriseGeo };
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
    const { sunset, sunrise } = getCachedTerminatorGeo(sun.lat, sun.lon);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    // Determine which side is night for sunset terminator
    const sunLonNorm = normalizeLon(sun.lon);
    const sunOnLeft = sunLonNorm < 0;

    // Brighten the sunlit side of the map beneath the night shade so daytime
    // hemispheres read clearly brighter than the night side.
    ctx.fillStyle = DAY_TINT;
    ctx.fillRect(0, 0, w, h);

    // ---- Night shading: area between sunset and sunrise terminators ----
    // Night is the region between the two terminators on the side opposite the sun.
    ctx.beginPath();
    
    if (sunOnLeft) {
      // Sun is on left: night is on the right side (between sunset on right, sunrise on left)
      // Start at top-right, go down sunset terminator (right edge of night)
      ctx.moveTo(w, 0);
      for (let i = 0; i < sunset.length; i++) {
        const p = project(sunset[i].lon, sunset[i].lat);
        ctx.lineTo(p.x, p.y);
      }
      // Go across bottom to sunrise terminator
      ctx.lineTo(w, h);
      // Go up sunrise terminator (left edge of night) - reverse order
      for (let i = sunrise.length - 1; i >= 0; i--) {
        const p = project(sunrise[i].lon, sunrise[i].lat);
        ctx.lineTo(p.x, p.y);
      }
      // Close at top
      ctx.lineTo(0, 0);
    } else {
      // Sun is on right: night is on the left side
      // Start at top-left, go down sunrise terminator (left edge of night)
      ctx.moveTo(0, 0);
      for (let i = 0; i < sunrise.length; i++) {
        const p = project(sunrise[i].lon, sunrise[i].lat);
        ctx.lineTo(p.x, p.y);
      }
      // Go across bottom to sunset terminator
      ctx.lineTo(0, h);
      // Go up sunset terminator (right edge of night) - reverse order
      for (let i = sunset.length - 1; i >= 0; i--) {
        const p = project(sunset[i].lon, sunset[i].lat);
        ctx.lineTo(p.x, p.y);
      }
      // Close at top
      ctx.lineTo(w, 0);
    }

    ctx.closePath();
    ctx.fillStyle = NIGHT_FILL;
    ctx.fill();

    // ---- Day/night boundary lines: soft, blended and very transparent ----
    strokeSoftBoundary(sunset, SUNSET_BOUNDARY);
    strokeSoftBoundary(sunrise, SUNRISE_BOUNDARY);

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
    state.width = rect.width;
    state.height = rect.height;
    // Refresh DPR on every resize: the device scale can change (window moved to
    // another monitor, OS display zoom) and that alone fires a resize event.
    state.dpr = window.devicePixelRatio || 1;
    canvas.width = state.width * state.dpr;
    canvas.height = state.height * state.dpr;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
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

    drawTerminator();

    // Filter events: if filterRecent is active, only show last 7 days events
    const todayISO = new Date().toISOString().slice(0, 10);
    state.events.forEach(ev => {
      if (state.filterRecent && !isInRolling7Days(ev.date, todayISO)) return;
      drawEvent(ev);
    });

    // Only draw military layers if filterMilitary is active
    if (state.filterMilitary) {
      if (state.showZones) state.zones.forEach(z => drawZone(z));
      if (state.showFleets) state.fleets.forEach(f => drawFleet(f));
    }

    // Only draw crisis zones if filterCrisis is active
    if (state.filterCrisis) {
      if (state.showCrises) state.crises.forEach(c => drawCrisis(c));
    }
  }

function drawEvent(ev) {
     // Skip if hidden by timeline filter
     if (ev._hiddenByTimeline) return;
     
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

  // Conflict zone: translucent area ring + dashed outline + center marker.
  // Still-active zones get a fluo (glow) treatment so they read as "live";
  // concluded zones render flat and dim, with their duration surfaced in the
  // tooltip. Zones outside the timeline year are skipped entirely.
  function drawZone(zone) {
    if (!state.showZones) return;
    if (zone._hiddenByTimeline) return;
    const p = project(zone.lon, zone.lat);
    const degToPx = state.height / 180;
    const r = Math.max(4, (zone.radiusDeg || 3) * degToPx * state.transform.scale);
    const active = isLayerActive(zone);

    if (active) {
      // Fluo halo: soft breathing glow emitted outward from the ring, plus a
      // stronger luminous shadow on the ring itself.
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 900 + zone.lon);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = ZONE_COLOR;
      ctx.shadowBlur = FLUO_GLOW_BLUR + FLUO_PULSE_RADIUS * pulse;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 1.14, 0, Math.PI * 2);
      ctx.fillStyle = withOpacity(ZONE_COLOR, 0.055);
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = ZONE_FILL;
      ctx.fill();

      ctx.save();
      ctx.shadowColor = ZONE_COLOR;
      ctx.shadowBlur = FLUO_LINE_GLOW_BLUR;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = ZONE_STROKE;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else {
      // Concluded: a frozen, dim footprint — no glow, thinner dashed ring.
      ctx.save();
      ctx.globalAlpha = CONCLUDED_OPACITY;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = ZONE_FILL;
      ctx.fill();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = withOpacity(ZONE_COLOR, 0.45);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = active ? ZONE_COLOR : withOpacity(ZONE_COLOR, 0.5);
    ctx.fill();
  }

  // Crisis zone (humanitarian): translucent area ring + dashed outline + center marker.
  // Distinct purple color to differentiate from conflict zones (red) and deployments.
  // Same fluo/dim lifecycle split as conflict zones.
  function drawCrisis(crisis) {
    if (!state.showCrises) return;
    if (crisis._hiddenByTimeline) return;
    const p = project(crisis.lon, crisis.lat);
    const degToPx = state.height / 180;
    const r = Math.max(4, (crisis.radiusDeg || 3) * degToPx * state.transform.scale);
    const active = isLayerActive(crisis);

    if (active) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 900 + crisis.lon);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = CRISIS_COLOR;
      ctx.shadowBlur = FLUO_GLOW_BLUR + FLUO_PULSE_RADIUS * pulse;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 1.14, 0, Math.PI * 2);
      ctx.fillStyle = withOpacity(CRISIS_COLOR, 0.055);
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = CRISIS_FILL;
      ctx.fill();

      ctx.save();
      ctx.shadowColor = CRISIS_COLOR;
      ctx.shadowBlur = FLUO_LINE_GLOW_BLUR;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = CRISIS_STROKE;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.save();
      ctx.globalAlpha = CONCLUDED_OPACITY;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = CRISIS_FILL;
      ctx.fill();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = withOpacity(CRISIS_COLOR, 0.45);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = active ? CRISIS_COLOR : withOpacity(CRISIS_COLOR, 0.5);
    ctx.fill();
  }

  // Tracked deployment: solid colored vector from origin to destination with a
  // solid arrowhead indicating direction of travel. Ground/troop movements
  // render distinct amber, naval/fleet movements solid blue — never dashed or
  // dotted, and the arrowhead matches the line colour. Arrow tail is barely visible.
  // Still-active movements glow ("fluo"); concluded ones are dimmed and their
  // arrowhead stays flat. Movements outside the timeline year are skipped.
  function drawFleet(fleet) {
    if (!state.showFleets) return;
    if (fleet._hiddenByTimeline) return;
    const a = project(fleet.from.lon, fleet.from.lat);
    const b = project(fleet.to.lon, fleet.to.lat);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    const ang = Math.atan2(dy, dx);
    const headLen = 8;
    const color = fleet.kind === 'ground' ? GROUND_COLOR : FLEET_COLOR;
    const active = isLayerActive(fleet);

    // Very transparent arrow tail line (barely visible); very active movements
    // get a luminous second pass over the tail so the whole vector reads live.
    ctx.save();
    ctx.strokeStyle = withOpacity(color, ARROW_TAIL_OPACITY * (active ? 1 : 0.35));
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (active) {
      ctx.shadowColor = color;
      ctx.shadowBlur = FLUO_LINE_GLOW_BLUR;
      ctx.strokeStyle = withOpacity(color, 0.3);
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();

    // Solid arrowhead; the halo makes active heads breathe slightly.
    ctx.save();
    if (active) {
      ctx.shadowColor = color;
      ctx.shadowBlur = FLUO_LINE_GLOW_BLUR + 5 * (0.5 + 0.5 * Math.sin(Date.now() / 650 + a.x));
    } else {
      ctx.globalAlpha = CONCLUDED_OPACITY;
    }
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - headLen * Math.cos(ang - 0.4), b.y - headLen * Math.sin(ang - 0.4));
    ctx.lineTo(b.x - headLen * Math.cos(ang + 0.4), b.y - headLen * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fillStyle = color;
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
    const todayISO = (typeof window !== 'undefined' && window.__WORLDMAP_TEST__?.getTodayISO)
      ? window.__WORLDMAP_TEST__.getTodayISO()
      : new Date().toISOString().slice(0, 10);
    for (let i = state.events.length - 1; i >= 0; i--) {
      const ev = state.events[i];
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
      const a = project(fleet.from.lon, fleet.from.lat);
      const b = project(fleet.to.lon, fleet.to.lat);
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

  // ---- Mouse ----
  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (state.isDragging) {
      state.transform.tx += e.movementX;
      state.transform.ty += e.movementY;
      requestDraw();
      return;
    }

    // A pinned (selected) event keeps its popup persistent so the pointer can
    // travel to it and click the "View source" link; hovering a different dot
    // re-pins it in place instead of letting the popup chase the cursor.
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
        }
      }
    }

    canvas.style.cursor = hit ? 'pointer' : 'grab';
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
      } else {
        moveTooltip(e.clientX - rect.left, e.clientY - rect.top);
      }
    }
  });

  canvas.addEventListener('mousedown', e => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    state.pressX = Number.isFinite(x) ? x : null;
    state.pressY = Number.isFinite(y) ? y : null;
    state.isDragging = true;
    canvas.style.cursor = 'grabbing';
    dismissTooltip();
  });

  window.addEventListener('mouseup', e => {
    state.isDragging = false;
    canvas.style.cursor = 'grab';
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (!Number.isFinite(x) || !Number.isFinite(y)) { state.pressX = null; state.pressY = null; return; }
    // A press/release with (almost) no movement selects the event under the
    // cursor and pins its popup, keeping "View source" reachable and clickable.
    const moved = Math.hypot((state.pressX ?? x) - x, (state.pressY ?? y) - y);
    if (moved <= CLICK_DRAG_THRESHOLD) {
      const hit = findEvent(x, y);
      if (hit) {
        state.selectedEvent = hit;
        pinTooltipToEvent(hit);
        draw();
      }
    }
    state.pressX = null;
    state.pressY = null;
  });

  // Double-click to zoom in around the cursor
  canvas.addEventListener('dblclick', e => {
    const rect = canvas.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, 1.5);
  });

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

  canvas.addEventListener('wheel', e => {
    // Scroll zoom disabled per UX request — use zoom buttons or keyboard instead
    // e.preventDefault(); // Don't prevent default to allow page scrolling
  }, { passive: true });

  // ---- Keyboard accessibility ----
  canvas.addEventListener('keydown', e => {
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
        handled = true;
        break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      dismissTooltip();
      draw();
    }
  });

  // Make canvas focusable for keyboard interaction
  canvas.setAttribute('tabindex', '0');
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', 'Interactive world map with transhumanist milestones');

  // ---- Tooltip ----
  function createTooltipElement(ev) {
    const color = CATEGORY_COLORS[canonicalCategory(ev.category)] || '#00d4ff';
    const wrapper = document.createElement('div');
    const cat = document.createElement('div');
    cat.className = 'tt-category';
    cat.style.color = color;
    cat.textContent = canonicalCategory(ev.category);
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

    if (ev.url && /^https?:\/\//i.test(ev.url)) {
      const link = document.createElement('a');
      link.href = ev.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'tt-link';
      link.textContent = 'View source ↗';
      wrapper.appendChild(link);
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
    tooltip.replaceChildren(createTooltipElement(ev));
    tooltip.classList.add('visible');
    moveTooltip(x, y);
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
    tooltip.replaceChildren(createTooltipElement(ev));
    tooltip.classList.add('visible');
  }

  // Remove the tooltip AND forget which event it pointed at (including any
  // pinned selection). Forgetting is what lets the next mousemove re-open it
  // cleanly after a pan/zoom/drag moved the dots underneath the pointer.
  function dismissTooltip() {
    state.selectedEvent = null;
    state.hoveredEvent = null;
    state.hoveredType = null;
    hideTooltip();
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
    if (zone.source && zone.url && /^https?:\/\//i.test(zone.url)) {
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
    cat.style.color = fleet.kind === 'ground' ? GROUND_COLOR : FLEET_COLOR;
    cat.textContent = fleet.kind === 'ground' ? 'Ground Deployment' : 'Fleet Deployment';
    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = fleet.label;
    const meta = document.createElement('div');
    meta.style.cssText = 'color: var(--fg-subtle); font-size: 0.7rem; margin-top: 4px;';
    meta.textContent = fleet.source || 'Unknown source';
    wrapper.append(cat, title, meta);
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
    if (crisis.source && crisis.url && /^https?:\/\//i.test(crisis.url)) {
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

  // ---- Stats computation ----
  // Current week = Monday..Sunday (ISO week) containing `todayISO` (YYYY-MM-DD).
  // Rolling 7-day window from today (inclusive)
  function rolling7DayBounds(todayISO) {
    const end = new Date(todayISO + 'T00:00:00Z');
    const start = new Date(end.getTime() - 6 * 86400000); // 6 days back = 7 days total
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
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
     const todayISO = new Date().toISOString().slice(0, 10);
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
    updateFilterButton('filter-military', state.filterMilitary);
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
    updateFilterButton('filter-crisis', state.filterCrisis);
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
    // A layer toggle can flip a filter (zones/deployments turn the military
    // filter on, crises turn the crisis filter on); keep the filter buttons'
    // brightness in sync so an enabled layer always lights up its button.
    updateFilterButton('filter-military', state.filterMilitary);
    updateFilterButton('filter-crisis', state.filterCrisis);
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
    let unknown = 0;
      state.events.forEach(ev => {
        const key = canonicalCategory(ev.category);
        if (CATEGORY_COLORS[key]) {
          counts[key] = (counts[key] || 0) + 1;
        } else {
          unknown++;
        }
      });

const fragment = document.createDocumentFragment();
      const title = document.createElement('div');
      title.className = 'map-legend-title';
      title.textContent = 'CATEGORIES';
      title.setAttribute('role', 'button');
      title.setAttribute('tabindex', '0');
      title.setAttribute('aria-pressed', String(state.foldedCategories));
      title.setAttribute('aria-label', 'Toggle categories visibility');
      title.style.cursor = 'pointer';
      title.addEventListener('click', () => {
        state.foldedCategories = !state.foldedCategories;
        renderLegend();
      });
      title.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          state.foldedCategories = !state.foldedCategories;
          renderLegend();
        }
      });
      fragment.appendChild(title);

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
        const dot = document.createElement('span');
        dot.className = 'map-legend-dot';
        dot.style.background = CATEGORY_COLORS[cat.key];
        dot.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.className = 'map-legend-label';
        label.textContent = cat.label;
        const count = document.createElement('span');
        count.className = 'map-legend-count';
        count.textContent = String(counts[cat.key] || 0);
        count.setAttribute('aria-hidden', 'true');
        row.append(dot, label, count);
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
        label: 'Deployments',
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

      // Explain the lifecycle glyphs without cluttering the toggleable rows.
      const note = document.createElement('div');
      note.className = 'map-legend-note';
      note.setAttribute('aria-hidden', 'true');
      note.textContent = '● glow = still active · ○ dim = concluded (hover shows duration)';
      fragment.appendChild(note);

    if (unknown > 0) {
      const row = document.createElement('div');
      row.className = 'map-legend-row map-legend-row--static';
      row.setAttribute('role', 'listitem');
      row.setAttribute('aria-label', `Other, ${unknown} events`);
      const dot = document.createElement('span');
      dot.className = 'map-legend-dot';
      dot.style.background = '#00d4ff';
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'map-legend-label';
      label.textContent = 'Other';
      const count = document.createElement('span');
      count.className = 'map-legend-count';
      count.textContent = String(unknown);
      count.setAttribute('aria-hidden', 'true');
      row.append(dot, label, count);
      fragment.appendChild(row);
    }

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
        // Icon shows what clicking will do: ☀ = will show day (turn off), ☾ = will show night (turn on)
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
    // Intelligent geocoding fallback if coordinates missing OR invalid (0,0 indicates missing)
    const hasValidCoords = Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
    if (!hasValidCoords) {
      const geo = geocodeInstitution(e.source, e.title, e.category);
      if (geo) {
        lat = geo.lat;
        lon = geo.lon;
      }
    }
    return {
      lat,
      lon,
      title: e.title ?? 'Untitled',
      category: e.category ?? 'Unknown',
      value: e.value ?? '',
      source: e.source ?? 'Unknown',
      url: e.url ?? '',
      date: e.date ?? ''
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
      } else {
        state.events = [];
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('[worldmap] Failed to load events.json, using sample data:', err);
      state.events = SAMPLE_EVENTS;
    }
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
      source: f.source || ''
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

  // A fleet arrow needs both endpoints valid; a missing/malformed endpoint
  // drops the whole movement instead of drawing a degenerate arrow. (0,0) is
  // the "unlocated" marker (same convention as normalizeEvent) and is rejected.
  const isLocatedCoord = (c) =>
    Number.isFinite(c?.lat) && c?.lat >= -90 && c?.lat <= 90 &&
    Number.isFinite(c?.lon) && c?.lon >= -180 && c?.lon <= 180 &&
    !(c?.lat === 0 && c?.lon === 0);

  function isFleetPlottable(f) {
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
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('[worldmap] Failed to load world_layers.json, using empty layers:', err);
      state.zones = [];
      state.fleets = [];
      state.crises = [];
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

// Timeline slider state. The floor is a deliberate UI/perf choice: a first-time
// visitor sees the full set and the slider clusters within a recent window, so a
// layer concluded wholly before TIMELINE_MIN_YEAR would never be reachable at any
// position. Current data has no such entry (the oldest layer, Papua 1962, is
// still active); if one ever appears it will need a data-level decision.
let timelineYear = new Date().getFullYear(); // current year by default
const TIMELINE_MIN_YEAR = 2020;
const TIMELINE_MAX_YEAR = new Date().getFullYear();

// Cluster milestone events by year: only events dated in that year stay visible.
// Like filterLayersByYear, this is intentionally inert until the slider moves so
// a first-time visitor sees the whole milestone set.
function filterEventsByYear(year) {
  state.events.forEach(ev => {
    if (ev.date) {
      ev._hiddenByTimeline = parseInt(ev.date.slice(0, 4), 10) !== year;
    }
  });
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
}

// Timeline slider initialization
function initTimelineSlider() {
  const timeline = document.getElementById('map-timeline');
  const track = document.getElementById('map-timeline-track');
  const handle = document.getElementById('map-timeline-handle');
  const yearsContainer = document.getElementById('map-timeline-years');
  
  if (!timeline || !track || !handle) return;
  
  // Generate year labels
  renderTimelineYears();
  
  // Set initial handle position
  updateTimelineHandle();
  
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
  
  track.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointerdown', onPointerDown);
  
  // Click on track to jump
  track.addEventListener('click', (e) => {
    if (e.target === track) {
      updateTimelineFromClientX(e.clientX);
    }
  });
  
  // Keyboard support
  handle.addEventListener('keydown', (e) => {
    let changed = false;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        timelineYear = Math.max(TIMELINE_MIN_YEAR, timelineYear - 1);
        changed = true;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        timelineYear = Math.min(TIMELINE_MAX_YEAR, timelineYear + 1);
        changed = true;
        break;
      case 'Home':
        timelineYear = TIMELINE_MIN_YEAR;
        changed = true;
        break;
      case 'End':
        timelineYear = TIMELINE_MAX_YEAR;
        changed = true;
        break;
    }
    if (changed) {
      e.preventDefault();
      updateTimelineHandle();
      applyTimelineFilter();
    }
  });
  
  function updateTimelineFromClientX(clientX) {
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    timelineYear = Math.round(TIMELINE_MIN_YEAR + ratio * (TIMELINE_MAX_YEAR - TIMELINE_MIN_YEAR));
    updateTimelineHandle();
    applyTimelineFilter();
  }
  
  function updateTimelineHandle() {
    const ratio = (timelineYear - TIMELINE_MIN_YEAR) / (TIMELINE_MAX_YEAR - TIMELINE_MIN_YEAR);
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
    yearsContainer.innerHTML = '';
    for (let year = TIMELINE_MIN_YEAR; year <= TIMELINE_MAX_YEAR; year++) {
      const label = document.createElement('span');
      label.textContent = year.toString();
      label.style.position = 'absolute';
      label.style.left = `${((year - TIMELINE_MIN_YEAR) / (TIMELINE_MAX_YEAR - TIMELINE_MIN_YEAR)) * 100}%`;
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
    draw();
    updateStatsDisplay();
  }
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

    // Initialize filter buttons
    const filterRecentBtn = document.getElementById('filter-recent');
    const filterMilitaryBtn = document.getElementById('filter-military');
    if (filterRecentBtn) {
      filterRecentBtn.setAttribute('aria-pressed', String(state.filterRecent));
      filterRecentBtn.style.opacity = state.filterRecent ? '1' : '0.5';
      filterRecentBtn.addEventListener('click', toggleFilterRecent);
    }
    if (filterMilitaryBtn) {
      filterMilitaryBtn.setAttribute('aria-pressed', String(state.filterMilitary));
      filterMilitaryBtn.style.opacity = state.filterMilitary ? '1' : '0.5';
      filterMilitaryBtn.addEventListener('click', toggleFilterMilitary);
    }

    // Initialize crisis filter button
    const filterCrisisBtn = document.getElementById('filter-crisis');
    if (filterCrisisBtn) {
      filterCrisisBtn.setAttribute('aria-pressed', String(state.filterCrisis));
      filterCrisisBtn.style.opacity = state.filterCrisis ? '1' : '0.5';
      filterCrisisBtn.addEventListener('click', toggleFilterCrisis);
    }

    // Initialize timeline slider
    initTimelineSlider();

    // Keep tooltip open while the pointer is over it so the source link is clickable
    if (tooltip) {
      tooltip.addEventListener('mouseenter', () => { state.tooltipHover = true; });
      tooltip.addEventListener('mouseleave', () => {
        state.tooltipHover = false;
        state.hoveredEvent = null;
        // Leave a pinned popup open so its link stays reachable.
        if (state.selectedEvent) return;
        hideTooltip();
        draw();
      });
    }
  }

  function cleanup() {
    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
    if (scheduledDrawId) { cancelAnimationFrame(scheduledDrawId); scheduledDrawId = null; }
    if (terminatorInterval) clearInterval(terminatorInterval);
    if (eventsAbortController) eventsAbortController.abort();
    if (layersAbortController) layersAbortController.abort();
    if (resizeTimeout) clearTimeout(resizeTimeout);
    window.removeEventListener('resize', scheduleResize);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  // ---- Test hook (inert in production; enabled only when the harness pre-sets the flag) ----
  if (typeof window !== 'undefined' && window.__WORLDMAP_TEST__) {
    const existingTestHook = window.__WORLDMAP_TEST__;
    window.__WORLDMAP_TEST__ = {
      canonicalCategory,
      CATEGORY_COLORS,
      CATEGORY_STAT_MAP,
      CATEGORY_LEGEND,
      CATEGORY_ALIASES,
      normalizeEvent,
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
      setFilterRecent: (val) => { state.filterRecent = val; updateFilterButton('filter-recent', state.filterRecent); draw(); updateStatsDisplay(); renderLegend(); },
      setFilterMilitary: (val) => { state.filterMilitary = val; state.showZones = val; state.showFleets = val; updateFilterButton('filter-military', state.filterMilitary); draw(); updateStatsDisplay(); renderLegend(); },
      // Layer lifecycle helpers + stats (fluo/concluded split).
      layerStatus,
      isLayerActive,
      layerActivityLabel,
      layerVisibleInYear,
      normalizeLayerDate,
      computeStats,
      layerCountTitle,
      // Replace the loaded layer data (used to exercise fluo/dim + timeline
      // clustering deterministically without mutating the shared fixtures).
      setLayers: (zones, fleets, crises) => {
        state.zones = (zones || []).map(normalizeZone).filter(isZonePlottable);
        state.fleets = (fleets || []).map(normalizeFleet).filter(isFleetPlottable);
        state.crises = (crises || []).map(normalizeZone).filter(isZonePlottable);
        updateStatsDisplay();
        renderLegend();
      },
      getLayers: () => ({ zones: state.zones, fleets: state.fleets, crises: state.crises }),
      // Drive the same year-clustering code path as the timeline slider.
      setTimelineYear: (year) => {
        timelineYear = Math.max(TIMELINE_MIN_YEAR, Math.min(TIMELINE_MAX_YEAR, year));
        filterEventsByYear(timelineYear);
        filterLayersByYear(timelineYear);
        draw();
        updateStatsDisplay();
      },
      getTimelineYear: () => timelineYear
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