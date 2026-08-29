/* Interactive world map — projection + event plotting
 * No external dependencies. Equirectangular projection with smooth pan/zoom.
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
    countries: []
  };

  // ---- Sample data (replaced by data/scraped-events.json at build time) ----
  const SAMPLE_EVENTS = [
    { lat: 37.7749, lon: -122.4194, title: 'CRISPR Cas-13b phase-3 trial cleared', category: 'Biotechnology', value: '50 patients', source: 'Stanford', date: '2026-08-25' },
    { lat: 47.3769, lon: 8.5417, title: 'ETH Zurich - 137 qubit entanglement', category: 'Quantum', value: '137 qubits', source: 'ETH Zurich', date: '2026-08-26' },
    { lat: 35.6762, lon: 139.6503, title: 'JT-60SA sustained fusion: 100 MJ', category: 'Energy', value: '100 MJ', source: 'NIFS Japan', date: '2026-08-22' },
    { lat: 51.5074, lon: -0.1278, title: 'GCHQ cyber threat advisory - 9.8 CVSS', category: 'Cybersecurity', value: 'CVSS 9.8', source: 'NCSC UK', date: '2026-08-24' },
    { lat: 28.5728, lon: -80.6490, title: 'SpaceX Starship: 156t to LEO', category: 'Spaceflight', value: '156 tonnes', source: 'SpaceX', date: '2026-08-23' },
    { lat: 50.4501, lon: 30.5234, title: 'NATO exercise - 12,000 troops', category: 'Defense', value: '12k troops', source: 'NATO', date: '2026-08-21' },
    { lat: 39.9042, lon: 116.4074, title: 'Beijing hypersonic test: Mach 13', category: 'Defense', value: 'Mach 13', source: 'PLASSF', date: '2026-08-20' },
    { lat: 31.9686, lon: 35.5064, title: 'Mossad joint cyber op with NSA', category: 'Cybersecurity', value: 'Tier-1', source: 'Mossad', date: '2026-08-27' },
    { lat: 52.5200, lon: 13.4050, title: 'Wendelstein 7-X - 6 min plasma record', category: 'Energy', value: '6 min', source: 'IPP', date: '2026-08-19' },
    { lat: 32.0853, lon: 34.7818, title: 'Tel Aviv biotech: in-vivo organoid', category: 'Biotechnology', value: 'patent-pending', source: 'Tel Aviv U', date: '2026-08-28' },
    { lat: -33.8688, lon: 151.2093, title: 'CSIRO solar cell: 33.2% efficiency', category: 'Energy', value: '33.2%', source: 'CSIRO', date: '2026-08-18' },
    { lat: 1.3521, lon: 103.8198, title: 'ST Engineering drone swarm test', category: 'Defense', value: '1000 UAVs', source: 'CSA', date: '2026-08-17' }
  ];

  const CATEGORY_COLORS = {
    'Biotechnology': '#00e676',
    'Tech': '#448aff',
    'Quantum': '#b388ff',
    'Energy': '#ffd740',
    'Cybersecurity': '#ff5252',
    'Spaceflight': '#00d4ff',
    'Defense': '#ff9100'
  };

  // ---- Country outlines (simplified continent path) ----
  // Real production would load topojson. This is a stylized silhouette.
  const CONTINENTS = [
    // North America
    [[ -170, 70], [-150, 70], [-95, 60], [-80, 50], [-65, 25], [-80, 15], [-95, 18], [-105, 30], [-118, 35], [-125, 45], [-130, 55], [-165, 60]],
    // South America
    [[ -80, 12], [-60, 5], [-50, -5], [-35, -10], [-40, -25], [-55, -35], [-70, -55], [-80, -45], [-82, -20], [-80, 0]],
    // Europe
    [[ -10, 60], [5, 65], [30, 70], [40, 60], [30, 45], [15, 38], [0, 40], [-10, 50]],
    // Africa
    [[ -15, 35], [10, 35], [30, 30], [40, 15], [50, -10], [40, -30], [20, -35], [10, -25], [0, -10], [-10, 10], [-15, 25]],
    // Asia
    [[ 40, 60], [80, 70], [120, 70], [140, 55], [130, 35], [110, 25], [95, 15], [75, 25], [55, 35], [45, 45]],
    // Australia
    [[ 115, -12], [140, -12], [152, -20], [148, -38], [120, -35], [115, -22]],
    // Antarctica (faint)
    [[ -180, -65], [180, -65], [180, -85], [-180, -85]]
  ];

  // ---- Projection ----
  function project(lon, lat) {
    const x = (lon + 180) / 360 * state.width;
    const y = (90 - lat) / 180 * state.height;
    return { x: x * state.transform.scale + state.transform.tx, y: y * state.transform.scale + state.transform.ty };
  }

  function unproject(px, py) {
    const x = (px - state.transform.tx) / state.transform.scale;
    const y = (py - state.transform.ty) / state.transform.scale;
    const lon = x / state.width * 360 - 180;
    const lat = 90 - y / state.height * 180;
    return { lon, lat };
  }

  // ---- Resize ----
  function resize() {
    const rect = canvas.getBoundingClientRect();
    state.width = rect.width;
    state.height = rect.height;
    canvas.width = state.width * state.dpr;
    canvas.height = state.height * state.dpr;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    draw();
  }

  // ---- Draw ----
  function draw() {
    const w = state.width;
    const h = state.height;

    // Background gradient
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#0a1424');
    grad.addColorStop(1, '#060b14');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Grid (lat/lon)
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

    // Continents
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

    // Events
    state.events.forEach(ev => drawEvent(ev));
  }

  function drawEvent(ev) {
    const p = project(ev.lon, ev.lat);
    const color = CATEGORY_COLORS[ev.category] || '#00d4ff';
    const pulse = 0.5 + 0.5 * Math.sin((Date.now() / 1000 + ev.lon) * 2);
    const r = 4 + pulse * 2;

    // Outer ring (pulse)
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 2, 0, Math.PI * 2);
    ctx.fillStyle = color + '20';
    ctx.fill();

    // Core
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // Highlight if hovered
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
    for (let i = state.events.length - 1; i >= 0; i--) {
      const ev = state.events[i];
      const p = project(ev.lon, ev.lat);
      const dx = p.x - px;
      const dy = p.y - py;
      if (dx * dx + dy * dy < 100) return ev;
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

    // Zoom toward cursor
    const wx = (x - state.transform.tx) / state.transform.scale;
    const wy = (y - state.transform.ty) / state.transform.scale;
    state.transform.scale = Math.max(0.5, Math.min(8, newScale));
    state.transform.tx = x - wx * state.transform.scale;
    state.transform.ty = y - wy * state.transform.scale;
    draw();
  }, { passive: false });

  // ---- Tooltip ----
  function showTooltip(ev, x, y) {
    if (!tooltip) return;
    const color = CATEGORY_COLORS[ev.category] || '#00d4ff';
    tooltip.innerHTML = `
      <div class="tt-category" style="color: ${color};">${ev.category}</div>
      <div class="tt-title">${ev.title}</div>
      <div class="tt-value">${ev.value}</div>
      <div style="color: var(--fg-subtle); font-size: 0.7rem; margin-top: 4px;">${ev.source} · ${ev.date}</div>
    `;
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

  // ---- Animation loop ----
  function loop() {
    if (state.events.length) draw();
    requestAnimationFrame(loop);
  }

  // ---- Init ----
  function load() {
    // Try to load scraped events, fallback to sample
    if (window.TRANSHUMANISTS_CONFIG && window.TRANSHUMANISTS_CONFIG.eventsUrl) {
      fetch(window.TRANSHUMANISTS_CONFIG.eventsUrl)
        .then(r => r.json())
        .then(d => state.events = d)
        .catch(() => state.events = SAMPLE_EVENTS);
    } else {
      state.events = SAMPLE_EVENTS;
    }
    resize();
    window.addEventListener('resize', resize);
    requestAnimationFrame(loop);

    // Update overlay stats
    const active = document.getElementById('map-stat-active');
    const conflicts = document.getElementById('map-stat-conflicts');
    const fleets = document.getElementById('map-stat-fleets');
    if (active) active.textContent = '12';
    if (conflicts) conflicts.textContent = '3';
    if (fleets) fleets.textContent = '7';
  }

  // Defer load to allow other DOM stuff
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
