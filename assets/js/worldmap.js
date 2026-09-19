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
    countries: [],
    showTerminator: true
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

  // ---- Terminator (Day/Night boundary) ----
  function getSunPosition() {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const day = now.getUTCDate();
    const hour = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;

    // Approximate solar declination and equation of time
    const dayOfYear = Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 0)) / 86400000);
    const declination = -23.44 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10)) * Math.PI / 180; // radians
    const equationOfTime = 9.87 * Math.sin(2 * Math.PI * (dayOfYear - 81) / 365) - 7.53 * Math.cos(Math.PI * (dayOfYear - 81) / 184) - 1.5 * Math.sin(Math.PI * (dayOfYear - 81) / 184); // minutes
    const solarTime = hour + equationOfTime / 60;
    const hourAngle = (solarTime - 12) * 15 * Math.PI / 180; // radians

    // Sub-solar point (where sun is directly overhead)
    const subSolarLat = declination;
    const subSolarLon = -hourAngle * 180 / Math.PI;

    return { lat: subSolarLat, lon: subSolarLon };
  }

  function drawTerminator() {
    if (!state.showTerminator) return;

    const sun = getSunPosition();
    const w = state.width;
    const h = state.height;

    // Draw night side as a semi-transparent overlay
    // The terminator is a great circle - we approximate with a cosine curve
    const points = [];
    const samples = 180; // one point per degree of latitude

    for (let i = 0; i <= samples; i++) {
      const lat = 90 - (i / samples) * 180; // 90 to -90
      const latRad = lat * Math.PI / 180;
      const declRad = sun.lat;

      // Calculate longitude of terminator at this latitude
      // cos(hourAngle) = -tan(lat) * tan(declination)
      const cosHourAngle = -Math.tan(latRad) * Math.tan(declRad);

      let lon;
      if (cosHourAngle >= 1) {
        // 24-hour daylight (polar day)
        lon = sun.lon;
      } else if (cosHourAngle <= -1) {
        // 24-hour night (polar night)
        lon = sun.lon + 180;
      } else {
        const hourAngle = Math.acos(Math.max(-1, Math.min(1, cosHourAngle)));
        lon = sun.lon + (hourAngle * 180 / Math.PI);
      }

      // Normalize longitude to -180..180
      while (lon > 180) lon -= 360;
      while (lon < -180) lon += 360;

      const p = project(lon, lat);
      points.push(p);
    }

    // Draw night side (the side away from the sun)
    // We'll create a polygon covering the night side
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    // Night gradient overlay
    const nightGrad = ctx.createLinearGradient(0, 0, w, 0);
    nightGrad.addColorStop(0, 'rgba(6, 11, 20, 0.35)');
    nightGrad.addColorStop(0.5, 'rgba(6, 11, 20, 0.15)');
    nightGrad.addColorStop(1, 'rgba(6, 11, 20, 0.35)');

    // Draw night side polygon
    ctx.beginPath();
    // Start from top-left, trace terminator, go to bottom-left
    ctx.moveTo(0, 0);
    for (let i = 0; i < points.length; i++) {
      // Only draw the night side (left of terminator in our coordinate system)
      // The night side is west of the sub-solar point
      const p = points[i];
      ctx.lineTo(p.x, p.y);
    }
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(6, 11, 20, 0.4)';
    ctx.fill();

    // Draw terminator line (the edge of day/night)
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = 'rgba(255, 215, 64, 0.6)'; // golden terminator
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw sub-solar point (sun marker)
    const sunPos = project(sun.lon, sun.lat);
    ctx.beginPath();
    ctx.arc(sunPos.x, sunPos.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 215, 64, 0.9)';
    ctx.shadowColor = '#ffd740';
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Sun label
    ctx.font = '10px var(--font-mono)';
    ctx.fillStyle = '#ffd740';
    ctx.textAlign = 'center';
    ctx.fillText('☀', sunPos.x, sunPos.y + 16);

    ctx.restore();
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

    // Day/Night Terminator
    drawTerminator();

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

  // Update terminator position every minute (sun moves)
  setInterval(() => {
    if (state.showTerminator && state.events.length) draw();
  }, 60000);

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

    // Terminator toggle
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

  // Defer load to allow other DOM stuff
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
