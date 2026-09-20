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
  const TOOLTIP_WIDTH = 260;
  const TOOLTIP_HEIGHT = 100;
  const TOOLTIP_OFFSET = 12;

  // ---- State ----
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const state = {
    width: 0,
    height: 0,
    dpr: window.devicePixelRatio || 1,
    transform: { scale: 1, tx: 0, ty: 0 },
    isDragging: false,
    hoveredEvent: null,
    tooltipHover: false,
    events: [],
    showTerminator: true,
    // Cached terminator data
    terminatorCache: {
      sunLon: null,
      sunLat: null,
      sunsetPoints: null,
      sunrisePoints: null,
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
    'Quantum Physics': 'Quantum Physics',
    'Renewable Energy': 'Renewable Energy',
    'Military & Defense': 'Military & Defense'
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
  const SAMPLE_EVENTS = [
    { lat: 37.7749, lon: -122.4194, title: 'CRISPR Cas-13b phase-3 trial cleared', category: 'Biotechnology', value: '50 patients', source: 'Stanford', date: '2026-08-25' },
    { lat: 47.3769, lon: 8.5417, title: 'ETH Zurich - 137 qubit entanglement', category: 'Quantum', value: '137 qubits', source: 'ETH Zurich', date: '2026-08-26' },
    { lat: 35.6762, lon: 139.6503, title: 'JT-60SA sustained fusion: 100 MJ', category: 'Energy', value: '100 MJ', source: 'NIFS Japan', date: '2026-08-22' },
    { lat: 51.5074, lon: -0.1278, title: 'GCHQ cyber threat advisory - 9.8 CVSS', category: 'Cybersecurity', value: 'CVSS 9.8', source: 'NCSC UK', date: '2026-08-24' },
    { lat: 28.5728, lon: -80.6490, title: 'SpaceX Starship: 156t to LEO', category: 'Spaceflight & Aeronautics', value: '156 tonnes', source: 'SpaceX', date: '2026-08-23' },
    { lat: 50.4501, lon: 30.5234, title: 'NATO exercise - 12,000 troops', category: 'Defense', value: '12k troops', source: 'NATO', date: '2026-08-21' },
    { lat: 39.9042, lon: 116.4074, title: 'Beijing hypersonic test: Mach 13', category: 'Defense', value: 'Mach 13', source: 'PLASSF', date: '2026-08-20' },
    { lat: 31.9686, lon: 35.5064, title: 'Mossad joint cyber op with NSA', category: 'Cybersecurity', value: 'Tier-1', source: 'Mossad', date: '2026-08-27' },
    { lat: 52.5200, lon: 13.4050, title: 'Wendelstein 7-X - 6 min plasma record', category: 'Energy', value: '6 min', source: 'IPP', date: '2026-08-19' },
    { lat: 32.0853, lon: 34.7818, title: 'Tel Aviv biotech: in-vivo organoid', category: 'Biotechnology', value: 'patent-pending', source: 'Tel Aviv U', date: '2026-08-28' },
    { lat: -33.8688, lon: 151.2093, title: 'CSIRO solar cell: 33.2% efficiency', category: 'Energy', value: '33.2%', source: 'CSIRO', date: '2026-08-18' },
    { lat: 1.3521, lon: 103.8198, title: 'ST Engineering drone swarm test', category: 'Defense', value: '1000 UAVs', source: 'CSA', date: '2026-08-17' }
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

  function getTerminatorPoints(sunLat, sunLon, offsetLon = 0) {
    const points = [];
    const effLon = normalizeLon(sunLon + offsetLon);

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

      const p = project(normalizeLon(lon), lat);
      points.push(p);
    }
    return points;
  }

  function getCachedTerminatorPoints(sunLat, sunLon) {
    const now = Date.now();
    const cache = state.terminatorCache;

    // Recompute if sun position changed significantly (>0.01°) or cache expired (>1 min)
    const sunMoved = Math.abs(cache.sunLon - sunLon) > 0.01 || Math.abs(cache.sunLat - sunLat) > 0.01;
    const cacheExpired = now - cache.computedAt > TERMINATOR_UPDATE_MS;

    if (!cache.sunsetPoints || sunMoved || cacheExpired) {
      cache.sunsetPoints = getTerminatorPoints(sunLat, sunLon, 0);
      cache.sunrisePoints = getTerminatorPoints(sunLat, sunLon, 180);
      cache.sunLon = sunLon;
      cache.sunLat = sunLat;
      cache.computedAt = now;
    }
    return { sunsetPoints: cache.sunsetPoints, sunrisePoints: cache.sunrisePoints };
  }

  function drawTerminator() {
    if (!state.showTerminator) return;

    const sun = getSunPosition();
    const w = state.width;
    const h = state.height;

    // Use cached terminator points (recomputes only when sun moves significantly or cache expires)
    const { sunsetPoints, sunrisePoints } = getCachedTerminatorPoints(sun.lat, sun.lon);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    // Determine which side is night for sunset terminator
    const sunLonNorm = normalizeLon(sun.lon);
    const sunOnLeft = sunLonNorm < 0;

    // ---- Night shading (sunset terminator) ----
    ctx.beginPath();
    ctx.moveTo(0, 0);

    if (sunOnLeft) {
      ctx.lineTo(w, 0);
      ctx.lineTo(w, h);
      for (let i = sunsetPoints.length - 1; i >= 0; i--) {
        ctx.lineTo(sunsetPoints[i].x, sunsetPoints[i].y);
      }
    } else {
      for (let i = 0; i < sunsetPoints.length; i++) {
        ctx.lineTo(sunsetPoints[i].x, sunsetPoints[i].y);
      }
      ctx.lineTo(0, h);
    }

    ctx.closePath();
    ctx.fillStyle = 'rgba(6, 11, 20, 0.35)';
    ctx.fill();

    // ---- Sunset line (day -> night): warm gold, solid ----
    ctx.beginPath();
    for (let i = 0; i < sunsetPoints.length; i++) {
      const p = sunsetPoints[i];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = 'rgba(255, 180, 0, 0.85)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // ---- Sunrise line (night -> day): cool cyan, dashed ----
    ctx.beginPath();
    for (let i = 0; i < sunrisePoints.length; i++) {
      const p = sunrisePoints[i];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([10, 6]);
    ctx.stroke();
    ctx.setLineDash([]);

    // ---- Sun position marker ----
    const sunPos = project(sun.lon, sun.lat);
    if (sunPos.x >= -50 && sunPos.x <= w + 50 && sunPos.y >= -50 && sunPos.y <= h + 50) {
      ctx.beginPath();
      ctx.arc(sunPos.x, sunPos.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 215, 64, 0.95)';
      ctx.shadowColor = '#ffd740';
      ctx.shadowBlur = 14;
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.font = '11px ui-monospace, SFMono-Regular, monospace';
      ctx.fillStyle = '#ffd740';
      ctx.textAlign = 'center';
      ctx.fillText('☀', sunPos.x, sunPos.y + 17);
    }

    // ---- Anti-sun (sunrise) marker ----
    const antiSunLon = normalizeLon(sun.lon + 180);
    const antiSunLat = -sun.lat;
    const antiSunPos = project(antiSunLon, antiSunLat);
    if (antiSunPos.x >= -50 && antiSunPos.x <= w + 50 && antiSunPos.y >= -50 && antiSunPos.y <= h + 50) {
      ctx.beginPath();
      ctx.arc(antiSunPos.x, antiSunPos.y, 7, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.7)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
      ctx.fillStyle = '#00d4ff';
      ctx.textAlign = 'center';
      ctx.fillText('☽', antiSunPos.x, antiSunPos.y + 15);
    }

    ctx.restore();
  }

  // ---- Resize ----
  let resizeTimeout = null;
  function applyResize() {
    const rect = canvas.getBoundingClientRect();
    state.width = rect.width;
    state.height = rect.height;
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

    state.events.forEach(ev => drawEvent(ev));
  }

  function drawEvent(ev) {
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

    if (state.hoveredEvent === ev) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // ---- Hit-test ----
  function findEvent(px, py) {
    const hitRadius = HIT_RADIUS_BASE / state.transform.scale;
    const hitRadiusSq = hitRadius * hitRadius;
    for (let i = state.events.length - 1; i >= 0; i--) {
      const ev = state.events[i];
      const p = project(ev.lon, ev.lat);
      const dx = p.x - px;
      const dy = p.y - py;
      if (dx * dx + dy * dy < hitRadiusSq) return ev;
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
      draw();
      return;
    }

    const hit = findEvent(x, y);
    canvas.style.cursor = hit ? 'pointer' : (state.isDragging ? 'grabbing' : 'grab');
    if (hit !== state.hoveredEvent) {
      state.hoveredEvent = hit;
      if (hit) showTooltip(hit, e.clientX - rect.left, e.clientY - rect.top);
      else if (!state.tooltipHover) hideTooltip();
      draw();
    } else if (hit) {
      moveTooltip(e.clientX - rect.left, e.clientY - rect.top);
    }
  });

  canvas.addEventListener('mousedown', () => {
    state.isDragging = true;
    canvas.style.cursor = 'grabbing';
    dismissTooltip();
  });

  window.addEventListener('mouseup', () => {
    state.isDragging = false;
    canvas.style.cursor = 'grab';
  });

  // Double-click to zoom in around the cursor
  canvas.addEventListener('dblclick', e => {
    const rect = canvas.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, 1.5);
  });

  // ---- Zoom helpers (used by controls, wheel, keyboard, double-click) ----
  function zoomAt(x, y, factor) {
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, state.transform.scale * factor));
    const wx = (x - state.transform.tx) / state.transform.scale;
    const wy = (y - state.transform.ty) / state.transform.scale;
    state.transform.scale = newScale;
    state.transform.tx = x - wx * state.transform.scale;
    state.transform.ty = y - wy * state.transform.scale;
    dismissTooltip();
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
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    zoomAt(x, y, e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR);
  }, { passive: false });

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

    if (ev.value) {
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

  // Remove the tooltip AND forget which event it pointed at. Forgetting is what
  // lets the next mousemove re-open it cleanly after a pan/zoom/drag moved the
  // dots underneath the pointer.
  function dismissTooltip() {
    state.hoveredEvent = null;
    hideTooltip();
  }

  // ---- Stats computation ----
  function computeStats() {
    const counts = { breakthroughs: 0, conflicts: 0, fleets: 0 };
    state.events.forEach(ev => {
      const statMap = CATEGORY_STAT_MAP[canonicalCategory(ev.category)];
      if (!statMap) return;
      if (statMap.statId === 'map-stat-active') counts.breakthroughs++;
      else if (statMap.statId === 'map-stat-conflicts') counts.conflicts++;
      else if (statMap.statId === 'map-stat-fleets') counts.fleets++;
    });
    return counts;
  }

  function updateStatsDisplay() {
    const stats = computeStats();
    const active = document.getElementById('map-stat-active');
    const conflicts = document.getElementById('map-stat-conflicts');
    const fleets = document.getElementById('map-stat-fleets');
    if (active) active.textContent = stats.breakthroughs;
    if (conflicts) conflicts.textContent = stats.conflicts;
    if (fleets) fleets.textContent = stats.fleets;
  }

  // ---- Legend ----
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
      if (CATEGORY_COLORS[key]) counts[key] = (counts[key] || 0) + 1;
      else unknown++;
    });

    const fragment = document.createDocumentFragment();
    const title = document.createElement('div');
    title.className = 'map-legend-title';
    title.textContent = 'Categories · live';
    fragment.appendChild(title);

    CATEGORY_LEGEND.forEach(cat => {
      const row = document.createElement('div');
      row.className = 'map-legend-row';
      row.setAttribute('role', 'listitem');
      row.setAttribute('aria-label', `${cat.label}, ${counts[cat.key] || 0} events`);
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
      fragment.appendChild(row);
    });

    if (unknown > 0) {
      const row = document.createElement('div');
      row.className = 'map-legend-row';
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

    legendEl.replaceChildren(fragment);
  }

  // ---- Data loading ----
  let eventsAbortController = null;

  async function loadEvents() {
    if (eventsAbortController) eventsAbortController.abort();
    eventsAbortController = new AbortController();

    const eventsUrl = '/data/events.json';
    try {
      const r = await fetch(eventsUrl, { cache: 'no-store', signal: eventsAbortController.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (data && Array.isArray(data.events)) {
        state.events = data.events
          .map(e => ({
            lat: e.geolocation?.lat,
            lon: e.geolocation?.lon,
            title: e.title ?? 'Untitled',
            category: e.category ?? 'Unknown',
            value: e.value ?? '',
            source: e.source ?? 'Unknown',
            url: e.url ?? '',
            date: e.date ?? ''
          }))
          .filter(e =>
            typeof e.lat === 'number' &&
            typeof e.lon === 'number' &&
            typeof e.title === 'string' &&
            typeof e.category === 'string'
          );
      } else {
        state.events = [];
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('[worldmap] Failed to load events.json, using sample data:', err);
      state.events = SAMPLE_EVENTS;
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

  // ---- Init ----
  async function load() {
    await loadEvents();
    updateStatsDisplay();
    renderLegend();
    resize();
    window.addEventListener('resize', scheduleResize);
    document.addEventListener('visibilitychange', onVisibilityChange);
    animationFrameId = requestAnimationFrame(loop);
    startTerminatorInterval();

    // Keep tooltip open while the pointer is over it so the source link is clickable
    if (tooltip) {
      tooltip.addEventListener('mouseenter', () => { state.tooltipHover = true; });
      tooltip.addEventListener('mouseleave', () => {
        state.tooltipHover = false;
        state.hoveredEvent = null;
        hideTooltip();
        draw();
      });
    }

    const zoomIn = document.getElementById('zoom-in');
    const zoomOut = document.getElementById('zoom-out');
    const resetViewBtn = document.getElementById('reset-view');
    if (zoomIn) zoomIn.addEventListener('click', () => zoomAt(state.width / 2, state.height / 2, 1.4));
    if (zoomOut) zoomOut.addEventListener('click', () => zoomAt(state.width / 2, state.height / 2, 1 / 1.4));
    if (resetViewBtn) resetViewBtn.addEventListener('click', resetView);

    const terminatorToggle = document.getElementById('terminator-toggle');
    const terminatorIcon = document.getElementById('terminator-icon');
    const terminatorLabel = document.getElementById('terminator-label');
    if (terminatorToggle) {
      terminatorToggle.addEventListener('click', () => {
        state.showTerminator = !state.showTerminator;
        terminatorToggle.setAttribute('aria-pressed', state.showTerminator);
        if (terminatorIcon) terminatorIcon.textContent = state.showTerminator ? '☀' : '☾';
        if (terminatorLabel) terminatorLabel.textContent = state.showTerminator ? 'Day/Night' : 'Day/Night (off)';
        draw();
      });
    }
  }

  function cleanup() {
    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
    if (terminatorInterval) clearInterval(terminatorInterval);
    if (eventsAbortController) eventsAbortController.abort();
    if (resizeTimeout) clearTimeout(resizeTimeout);
    window.removeEventListener('resize', scheduleResize);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  // ---- Test hook (inert in production; enabled only when the harness pre-sets the flag) ----
  if (typeof window !== 'undefined' && window.__WORLDMAP_TEST__) {
    window.__WORLDMAP_TEST__ = {
      canonicalCategory,
      CATEGORY_COLORS,
      CATEGORY_STAT_MAP,
      CATEGORY_LEGEND,
      CATEGORY_ALIASES
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