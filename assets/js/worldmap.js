/* Interactive world map — projection + event plotting
 * No external dependencies. Equirectangular projection with smooth pan/zoom.
 * Includes day/night terminator overlay (sun position).
 */
(function() {
  'use strict';

  const canvas = document.getElementById('world-map-canvas');
  if (!canvas) return;

  const tooltip = document.getElementById('map-tooltip');
  const ctx = canvas.getContext('2d');

  // ---- State ----
  const state = {
    width: 0,
    height: 0,
    dpr: window.devicePixelRatio || 1,
    transform: { scale: 1, tx: 0, ty: 0 },
    isDragging: false,
    dragStart: { x: 0, y: 0 },
    hoveredEvent: null,
    events: [],
    showTerminator: true
  };

  const CATEGORY_COLORS = {
    'Biotechnology': '#00e676',
    'Computing & AGI': '#448aff',
    'Quantum': '#b388ff',
    'Energy': '#ffd740',
    'Cybersecurity': '#ff5252',
    'Spaceflight & Aeronautics': '#00d4ff',
    'Defense': '#ff9100'
  };

  const CATEGORY_STAT_MAP = {
    'Biotechnology': { statId: 'map-stat-active', label: 'breakthroughs this week' },
    'Cybersecurity': { statId: 'map-stat-conflicts', label: 'active conflict zones' },
    'Defense': { statId: 'map-stat-fleets', label: 'fleet movements tracked' },
    'Energy': { statId: 'map-stat-active', label: 'breakthroughs this week' },
    'Spaceflight & Aeronautics': { statId: 'map-stat-fleets', label: 'fleet movements tracked' },
    'Quantum': { statId: 'map-stat-active', label: 'breakthroughs this week' },
    'Computing & AGI': { statId: 'map-stat-active', label: 'breakthroughs this week' }
  };

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

  // ---- XSS-safe helper ----
  function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  function drawTerminator() {
    if (!state.showTerminator) return;

    const sun = getSunPosition();
    const w = state.width;
    const h = state.height;

    const points = [];
    const samples = 180;

    for (let i = 0; i <= samples; i++) {
      const lat = 90 - (i / samples) * 180;
      const latRad = lat * Math.PI / 180;
      const declRad = sun.lat * Math.PI / 180;

      const cosHourAngle = -Math.tan(latRad) * Math.tan(declRad);

      let lon;
      if (cosHourAngle >= 1) {
        lon = sun.lon - 180;
      } else if (cosHourAngle <= -1) {
        lon = sun.lon;
      } else {
        const hourAngle = Math.acos(Math.max(-1, Math.min(1, cosHourAngle)));
        lon = sun.lon + (hourAngle * 180 / Math.PI);
      }

      while (lon > 180) lon -= 360;
      while (lon < -180) lon += 360;

      const p = project(lon, lat);
      points.push(p);
    }

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    const sunLonNorm = ((sun.lon + 180) % 360 + 360) % 360 - 180;
    const sunOnLeft = sunLonNorm < 0;

    ctx.beginPath();
    ctx.moveTo(0, 0);

    if (sunOnLeft) {
      ctx.lineTo(w, 0);
      ctx.lineTo(w, h);
      for (let i = points.length - 1; i >= 0; i--) {
        ctx.lineTo(points[i].x, points[i].y);
      }
    } else {
      for (let i = 0; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.lineTo(0, h);
    }

    ctx.closePath();
    ctx.fillStyle = 'rgba(6, 11, 20, 0.4)';
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = 'rgba(255, 215, 64, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    const sunPos = project(sun.lon, sun.lat);
    if (sunPos.x >= -50 && sunPos.x <= w + 50 && sunPos.y >= -50 && sunPos.y <= h + 50) {
      ctx.beginPath();
      ctx.arc(sunPos.x, sunPos.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 215, 64, 0.9)';
      ctx.shadowColor = '#ffd740';
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.font = '10px var(--font-mono)';
      ctx.fillStyle = '#ffd740';
      ctx.textAlign = 'center';
      ctx.fillText('☀', sunPos.x, sunPos.y + 16);
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
    const color = CATEGORY_COLORS[ev.category] || '#00d4ff';
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
    const hitRadius = 10 / state.transform.scale;
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
      else hideTooltip();
      draw();
    } else if (hit) {
      moveTooltip(e.clientX - rect.left, e.clientY - rect.top);
    }
  });

  canvas.addEventListener('mousedown', () => {
    state.isDragging = true;
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('mouseup', () => {
    state.isDragging = false;
    canvas.style.cursor = 'grab';
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const delta = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = state.transform.scale * delta;

    const wx = (x - state.transform.tx) / state.transform.scale;
    const wy = (y - state.transform.ty) / state.transform.scale;
    state.transform.scale = Math.max(0.5, Math.min(8, newScale));
    state.transform.tx = x - wx * state.transform.scale;
    state.transform.ty = y - wy * state.transform.scale;
    draw();
  }, { passive: false });

  // ---- Tooltip ----
  function createTooltipElement(ev) {
    const color = CATEGORY_COLORS[ev.category] || '#00d4ff';
    const wrapper = document.createElement('div');
    const cat = document.createElement('div');
    cat.className = 'tt-category';
    cat.style.color = color;
    cat.textContent = ev.category;
    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = ev.title;
    const value = document.createElement('div');
    value.className = 'tt-value';
    value.textContent = ev.value;
    const meta = document.createElement('div');
    meta.style.cssText = 'color: var(--fg-subtle); font-size: 0.7rem; margin-top: 4px;';
    meta.textContent = `${ev.source} · ${ev.date}`;
    wrapper.append(cat, title, value, meta);
    return wrapper;
  }

  function showTooltip(ev, x, y) {
    if (!tooltip) return;
    tooltip.replaceChildren(createTooltipElement(ev));
    tooltip.classList.add('visible');
    moveTooltip(x, y);
  }

  function moveTooltip(x, y) {
    if (!tooltip) return;
    const offset = 12;
    let tx = x + offset;
    let ty = y + offset;
    if (tx + 260 > state.width) tx = x - 270;
    if (ty + 100 > state.height) ty = y - 100;
    tooltip.style.left = tx + 'px';
    tooltip.style.top = ty + 'px';
  }

  function hideTooltip() {
    if (tooltip) tooltip.classList.remove('visible');
  }

  // ---- Stats computation ----
  function computeStats() {
    const counts = { breakthroughs: 0, conflicts: 0, fleets: 0 };
    state.events.forEach(ev => {
      const statMap = CATEGORY_STAT_MAP[ev.category];
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
  const DRAW_INTERVAL = 100;

  function loop() {
    if (document.hidden) {
      animationFrameId = null;
      return;
    }
    const now = Date.now();
    if (state.events.length && now - lastDrawTime >= DRAW_INTERVAL) {
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
    if (terminatorInterval) clearInterval(terminatorInterval);
    terminatorInterval = setInterval(() => {
      if (!document.hidden && state.showTerminator && state.events.length) draw();
    }, 60000);
  }

  // ---- Init ----
  async function load() {
    await loadEvents();
    updateStatsDisplay();
    resize();
    window.addEventListener('resize', scheduleResize);
    document.addEventListener('visibilitychange', onVisibilityChange);
    animationFrameId = requestAnimationFrame(loop);
    startTerminatorInterval();

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
      terminatorToggle.addEventListener('mouseenter', () => {
        terminatorToggle.style.borderColor = 'var(--accent)';
        terminatorToggle.style.background = 'var(--accent-dim)';
      });
      terminatorToggle.addEventListener('mouseleave', () => {
        terminatorToggle.style.borderColor = 'var(--border)';
        terminatorToggle.style.background = 'none';
      });
    }
  }

  function cleanup() {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    if (terminatorInterval) clearInterval(terminatorInterval);
    if (eventsAbortController) eventsAbortController.abort();
    if (resizeTimeout) clearTimeout(resizeTimeout);
    window.removeEventListener('resize', scheduleResize);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('pagehide', cleanup);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();