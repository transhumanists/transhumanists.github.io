/**
 * World map unit/integration tests.
 * Runs under `bun test` (no external deps): loads the real assets/js/worldmap.js
 * inside a minimal fake DOM/canvas and asserts behaviour end-to-end, including
 * the category-name canonicalization fix (Quantum Physics / Renewable Energy /
 * Military & Defense) that stats, colors and the legend all depend on.
 */
import { describe, expect, test, beforeAll } from 'bun:test';

const EVENT_PAYLOAD = {
  last_update: '2026-09-20T00:00:00+00:00',
  version: '1.0.0',
  events: [
    { id: 'bio-001', title: 'Bio A', category: 'Biotechnology', value: '1', source: 'S1', url: 'https://example.com/1', date: '2026-08-01', geolocation: { lat: 42.3375, lon: -71.1061 } },
    { id: 'en-old', title: 'Energy (old name)', category: 'Energy', value: '2', source: 'S2', url: 'https://example.com/2', date: '2026-08-02', geolocation: { lat: 40.7, lon: -74.0 } },
    { id: 'q-old', title: 'Quantum (old name)', category: 'Quantum', value: '3', source: 'S3', url: '', date: '2026-08-03', geolocation: { lat: 47.3769, lon: 8.5417 } },
    { id: 'en-001', title: 'RNE', category: 'Renewable Energy', value: '4', source: 'S4', url: 'https://example.com/4', date: '2026-08-04', geolocation: { lat: -33.8688, lon: 151.2093 } },
    { id: 'def-old', title: 'Defense (old name)', category: 'Defense', value: '5', source: 'S5', url: 'https://example.com/5', date: '2026-08-05', geolocation: { lat: -1.2864, lon: 36.8172 } },
    { id: 'def-001', title: 'M&D', category: 'Military & Defense', value: '6', source: 'S6', url: 'https://example.com/6', date: '2026-08-06', geolocation: { lat: 50.8609, lon: 4.3676 } },
    { id: 'cyber-001', title: 'Cyber', category: 'Cybersecurity', value: '7', source: 'S7', url: 'https://example.com/7', date: '2026-08-07', geolocation: { lat: 51.5074, lon: -0.1278 } },
    { id: 'unk-001', title: 'UnknownX', category: 'Totally Unknown', value: 'UnknownX', source: 'S8', url: '', date: '2026-08-08', geolocation: { lat: 0, lon: 0 } },
  ],
};

// Operational layers (matching data/world_layers.json shape) fetched by load().
const LAYER_PAYLOAD = {
  version: '1.0.0',
  last_update: '2026-09-20T00:00:00+00:00',
  conflict_zones: [
    { id: 'z1', name: 'Zone A', region: 'R1', lat: 48.0, lon: 37.8, radiusDeg: 5.5, status: 'active' },
    { id: 'z2', name: 'Zone B', region: 'R2', lat: 31.3, lon: 34.3, radiusDeg: 2.2, status: 'active' },
    { id: 'z3', name: 'Zone C', region: 'R3', lat: 13.5, lon: 43.0, radiusDeg: 4.0, status: 'active' },
  ],
  crisis_zones: [
    { id: 'c1', name: 'Crisis A', region: 'R1', lat: 10.0, lon: 20.0, radiusDeg: 3.0, status: 'active' },
    { id: 'c2', name: 'Crisis B', region: 'R2', lat: 15.0, lon: 25.0, radiusDeg: 2.5, status: 'active' },
    { id: 'c3', name: 'Crisis C', region: 'R3', lat: 20.0, lon: 30.0, radiusDeg: 3.5, status: 'active' },
    { id: 'c4', name: 'Crisis D', region: 'R4', lat: 25.0, lon: 35.0, radiusDeg: 2.0, status: 'active' },
    { id: 'c5', name: 'Crisis E', region: 'R5', lat: 30.0, lon: 40.0, radiusDeg: 4.0, status: 'active' },
  ],
  deployments: [
    { id: 'f1', label: 'Fleet 1', from: { lat: 33.5, lon: 33.5 }, to: { lat: 27.0, lon: 52.5 }, kind: 'fleet', note: '', source: '' },
    { id: 'f2', label: 'Fleet 2', from: { lat: 18.5, lon: 39.5 }, to: { lat: 12.5, lon: 58.5 }, kind: 'fleet', note: '', source: '' },
    { id: 'f3', label: 'Fleet 3', from: { lat: 34.3, lon: 132.4 }, to: { lat: 12.5, lon: 115.0 }, kind: 'fleet', note: '', source: '' },
    { id: 'f4', label: 'Fleet 4', from: { lat: 24.5, lon: 126.5 }, to: { lat: 25.0, lon: 120.5 }, kind: 'fleet', note: '', source: '' },
    { id: 'f5', label: 'Fleet 5', from: { lat: 50.8, lon: -1.1 }, to: { lat: 57.0, lon: 18.0 }, kind: 'fleet', note: '', source: '' },
    { id: 'f6', label: 'Fleet 6', from: { lat: 54.7, lon: 20.5 }, to: { lat: 58.0, lon: 20.0 }, kind: 'fleet', note: '', source: '' },
    { id: 'f7', label: 'Fleet 7', from: { lat: 43.1, lon: 131.9 }, to: { lat: 38.7, lon: 137.0 }, kind: 'fleet', note: '', source: '' },
    { id: 'f8', label: 'Fleet 8', from: { lat: 26.7, lon: 114.0 }, to: { lat: 31.2, lon: 122.5 }, kind: 'fleet', note: '', source: '' },
    { id: 'f9', label: 'Fleet 9', from: { lat: 19.0, lon: 72.8 }, to: { lat: 12.5, lon: 45.0 }, kind: 'fleet', note: '', source: '' },
  ],
};

// ---- Minimal fake DOM / canvas ------------------------------------------

function makeClassList() {
  const set = new Set();
  return {
    add(c) { set.add(c); },
    remove(c) { set.delete(c); },
    contains(c) { return set.has(c); },
  };
}

function makeEl() {
  const el = {
    style: {},
    children: [],
    attrs: {},
    className: '',
    listeners: {},
    classList: makeClassList(),
    offsetWidth: 0,
    offsetHeight: 0,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    hasAttribute(k) { return k in this.attrs; },
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { this.children.push(...cs); },
    // Browser-accurate: a DocumentFragment passed to replaceChildren is
    // flattened (its children are reparented), not nested.
    replaceChildren(...cs) {
      this.children = [];
      for (const c of cs) {
        if (c && c.isFragment) this.children.push(...c.children);
        else this.children.push(c);
      }
    },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    fire(type, ev) { for (const fn of this.listeners[type] || []) fn(ev); },
    // Real DOM: a node contains itself (used by the keyboard handler guard).
    contains(c) { return c === this; },
    // Enough of querySelector for the tooltip pager: '.class' lookups, deepest
    // match wins left-to-right, searched depth-first over descendants.
    querySelector(sel) {
      const want = sel.replace(/^\./, '');
      const matches = (n) => (n && n.className ? n.className.split(' ').includes(want) : false);
      const walk = (nodes) => {
        for (const n of nodes || []) {
          if (matches(n)) return n;
          const hit = walk(n.children);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this.children);
    },
  };
  // textContent mirrors the DOM string property setter.
  Object.defineProperty(el, 'textContent', {
    get() { return this._text === undefined ? '' : this._text; },
    set(v) { this._text = String(v); },
  });
  return el;
}

// Canvas element needs a few extra bits vs a plain DOM node.
function makeCanvas() {
  const el = makeEl();
  el.width = 0;
  el.height = 0;
  el.getBoundingClientRect = () => ({ width: 800, height: 520, left: 0, top: 0, right: 800, bottom: 520 });
  el.setAttribute('tabindex', '0');
  return el;
}

function makeCtx() {
  const ctx = {
    listeners: [],
    counters: { fills: 0, strokes: 0, lineTos: 0, arcs: 0, moves: 0 },
    // Fill log: { style: ctx.fillStyle, path: [{x,y},...] } for every fill(),
    // so tests can assert exactly what shade covered which polygon (used by
    // the day/night terminator tests).
    fillsLog: [],
    // Text log: { text, x, y } for every fillText() (stack count badges).
    textsLog: [],
    _path: [],
    resetCounters() { for (const k in this.counters) this.counters[k] = 0; this.fillsLog.length = 0; this.textsLog.length = 0; },
  };
  ctx.createLinearGradient = () => ({ addColorStop() {} });
  for (const m of ['fillRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'closePath', 'setLineDash', 'arc', 'fillText', 'save', 'restore', 'setTransform']) {
    ctx[m] = (...args) => {
      if (m === 'fill') {
        ctx.counters.fills++;
        ctx.fillsLog.push({ style: ctx.fillStyle, path: ctx._path.map((p) => ({ x: p.x, y: p.y })) });
      } else if (m === 'stroke') ctx.counters.strokes++;
      else if (m === 'lineTo') { ctx.counters.lineTos++; ctx._path.push({ x: args[0], y: args[1] }); }
      else if (m === 'moveTo') { ctx.counters.moves++; ctx._path.push({ x: args[0], y: args[1] }); }
      else if (m === 'arc') ctx.counters.arcs++;
      else if (m === 'fillText') ctx.textsLog.push({ text: String(args[0]), x: args[1], y: args[2] });
      else if (m === 'beginPath') ctx._path = [];
    };
  }
  return ctx;
}

const registeredEls = {};
const windowObj = {
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false }),
  _listeners: {},
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
  removeEventListener() {},
  fire(type, ev) { for (const fn of this._listeners[type] || []) fn(ev); },
};

const tooltip = makeEl();
tooltip.offsetWidth = 150;
tooltip.offsetHeight = 200;
const canvas = makeCanvas();
const ctx = makeCtx();
canvas.getContext = () => ctx;

for (const id of ['world-map-canvas', 'map-tooltip', 'map-stat-active', 'map-stat-conflicts', 'map-stat-fleets', 'map-stat-crises', 'world-map', 'zoom-in', 'zoom-out', 'reset-view', 'terminator-toggle', 'terminator-icon', 'terminator-label', 'filter-recent', 'filter-military', 'filter-crisis', 'filter-recent-label', 'filter-military-conflict-label', 'filter-military-fleet-label']) {
  registeredEls[id] = id === 'map-tooltip' ? tooltip : (id === 'world-map-canvas' ? canvas : makeEl());
}

// Mirror the markup in index.md so behaviour tests start from the same DOM state.
registeredEls['terminator-toggle'].setAttribute('aria-pressed', 'true');
registeredEls['terminator-icon'].textContent = '☀';
registeredEls['terminator-label'].textContent = 'Day/Night';
// New filter buttons default state (filterRecent=false, filterMilitary=false,
// filterCrisis=false) — the fresh-visitor experience, per the markup.
registeredEls['filter-recent'].setAttribute('aria-pressed', 'false');
registeredEls['filter-military'].setAttribute('aria-pressed', 'false');
registeredEls['filter-crisis'].setAttribute('aria-pressed', 'false');

// world-map children registry: legend is created at runtime and appended here.
const worldMap = registeredEls['world-map'];
const worldMapAppend = worldMap.appendChild.bind(worldMap);
worldMap.appendChild = (c) => { if (c && c.id) registeredEls[c.id] = c; return worldMapAppend(c); };

const documentObj = {
  readyState: 'complete',
  hidden: false,
  getElementById: (id) => registeredEls[id] ?? null,
  querySelector: (sel) => {
    // Simple selector support for test needs
    if (sel === '#filter-recent .map-hint-title span:last-child') {
      return registeredEls['filter-recent-label'];
    }
    if (sel === '#filter-military .map-hint-title span:nth-child(2)') {
      return registeredEls['filter-military-conflict-label'];
    }
    if (sel === '#filter-military .map-hint-title span:last-child') {
      return registeredEls['filter-military-fleet-label'];
    }
    return null;
  },
  addEventListener() {},
  removeEventListener() {},
  // tagName is what decides whether `disabled`/`:disabled` mean anything in a
  // real browser, so the fake records it instead of pretending every node is
  // the same element.
  createElement: (tag) => Object.assign(makeEl(), { tagName: String(tag || '').toUpperCase() }),
  createDocumentFragment() {
    const f = { isFragment: true, children: [] };
    f.appendChild = (c) => { f.children.push(c); return c; };
    return f;
  },
};

let load;
// The clock the module reads for its rolling 7-day window. Kept as a named
// object (rather than an inline literal) so a test can move "today" forward and
// restore it, exercising the day-rollover path without waiting for real time.
const testClock = { getTodayISO: () => '2026-08-08' };
const TEST_DAY = '2026-08-08';
const setTestDay = (iso) => { testClock.getTodayISO = () => iso; };

beforeAll(async () => {
  // Set up test hook mock BEFORE import so the module can use it
  // Use 2026-08-08 to include all test fixture events (2026-08-01 to 2026-08-08) in the 7-day window
  windowObj.__WORLDMAP_TEST__ = testClock;

  globalThis.window = windowObj;
  globalThis.document = documentObj;
  globalThis.devicePixelRatio = 1;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.AbortController = class { abort() {} signal = {}; };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('world_layers') ? LAYER_PAYLOAD : EVENT_PAYLOAD),
  });

  await import('../assets/js/worldmap.js');
  // Let the async load() settle (it awaits fetch then calls draw).
  await new Promise((r) => setTimeout(r, 20));
});

// Canvas-space point for a lon/lat, derived from the module's own projection.
// Pointer tests used to hardcode screen coordinates, which silently rotted the
// moment the default latitude window changed (the dots all moved) and the
// failures looked like product bugs. Deriving the target from the same
// projection the renderer uses keeps these tests about interaction, not layout.
function pt(lon, lat) {
  return windowObj.__WORLDMAP_TEST__.project(lon, lat);
}

// The London cybersecurity fixture, in canvas space.
const LONDON = () => pt(-0.1278, 51.5074);
// A point guaranteed to have no marker near it, in canvas space.
const EMPTY_CANVAS = () => pt(135, -61);

function legendRows() {
  const legend = registeredEls['map-legend'];
  if (!legend) return [];
  // Check direct children and also children of the categories wrapper
  const allChildren = [...legend.children];
  const wrapper = legend.children.find(c => c.className === 'map-legend-categories');
  if (wrapper) allChildren.push(...wrapper.children);
  return allChildren.filter((c) => {
    const cn = c.className || '';
    return cn.split(' ').includes('map-legend-row');
  });
}

function legendValue(label) {
  const rows = legendRows();
  for (const row of rows) {
    const lab = row.children.find((c) => c.className === 'map-legend-label');
    if (lab && lab.textContent.trim() === label) {
      return row.children.find((c) => c.className === 'map-legend-count').textContent;
    }
  }
  return undefined;
}

describe('worldmap', () => {
  test('loads events and renders stat tiles with canonical category mapping', () => {
    // "breakthroughs this week" counts only the categories mapped to
    // map-stat-active, inside the rolling 7-day window of the *test* clock
    // (2026-08-08 -> 08-02..08-08). That is en-old + en-001 (Renewable Energy)
    // and q-old (Quantum, via the legacy alias). Deliberately excluded:
    // bio-001 (08-01, one day before the window), def-old/def-001 (routed to
    // map-stat-fleets) and cyber-001 (routed to map-stat-conflicts).
    expect(Number(registeredEls['map-stat-active'].textContent)).toBe(3);
    // Conflicts/fleets now always show actual counts regardless of filterMilitary
    expect(Number(registeredEls['map-stat-conflicts'].textContent)).toBe(3);
    expect(Number(registeredEls['map-stat-fleets'].textContent)).toBe(9);
  });

  test('renders legend rows for all 7 categories plus layers', () => {
    const legend = registeredEls['map-legend'];
    expect(legend).toBeDefined();
    expect(legend.getAttribute('role')).toBe('list');
    const rows = legendRows();
    expect(rows.length).toBe(10);
    expect(legendValue('Biotechnology')).toBe('1');
    expect(legendValue('Computing & AGI')).toBe('0');
    expect(legendValue('Quantum Physics')).toBe('1');      // aliased 'Quantum'
    expect(legendValue('Renewable Energy')).toBe('2');     // aliased 'Energy' + canonical
    expect(legendValue('Cybersecurity')).toBe('1');
    expect(legendValue('Spaceflight & Aeronautics')).toBe('0');
    expect(legendValue('Military & Defense')).toBe('2');   // aliased 'Defense' + canonical
    // Military layers now show simple labels with actual counts
    expect(legendValue('Conflict Zones')).toBe('3');
    expect(legendValue('Deployments')).toBe('9');
    expect(legendValue('Crisis Zones')).toBe('5');
  });

  test('conflict and fleet layer rows toggle their stats and redraw', () => {
    const rowByLayer = (key) => legendRows().find((r) => (r.attrs['data-layer'] || '') === key);
    const zonesRow = rowByLayer('zones');
    // Military layers are off by default (filterMilitary=false), so aria-pressed is false
    expect(zonesRow.getAttribute('aria-pressed')).toBe('false');
    ctx.resetCounters();
    zonesRow.fire('click', {});                               // legend rebuilds itself - toggles zones
    expect(rowByLayer('zones').getAttribute('aria-pressed')).toBe('true');
    // After clicking zones row: toggleLayer enables filterMilitary, which enables both zones and fleets
    expect(Number(registeredEls['map-stat-conflicts'].textContent)).toBe(3);
    expect(ctx.counters.arcs).toBeGreaterThan(0);              // redraw happened
    expect(Number(registeredEls['map-stat-fleets'].textContent)).toBe(9); // fleets also enabled
    expect(legendValue('Deployments')).toBe('9');          // deployments layer present

    rowByLayer('zones').fire('click', {});                     // toggle zones back off
    expect(rowByLayer('zones').getAttribute('aria-pressed')).toBe('false');
    expect(Number(registeredEls['map-stat-conflicts'].textContent)).toBe(3); // stats still show actual count

    const fleetsRow = rowByLayer('deployments');
    fleetsRow.fire('click', {});
    expect(rowByLayer('deployments').getAttribute('aria-pressed')).toBe('true');
    expect(Number(registeredEls['map-stat-fleets'].textContent)).toBe(9);
    // Zones still off from previous toggle, but stats show actual count
    expect(Number(registeredEls['map-stat-conflicts'].textContent)).toBe(3);
    fleetsRow.fire('click', {});                               // toggle fleets back off
    expect(rowByLayer('deployments').getAttribute('aria-pressed')).toBe('false');
    expect(Number(registeredEls['map-stat-fleets'].textContent)).toBe(9); // stats still show actual count
    // Restore both for later tests via test hook (button click not reliable in mock)
    const api = windowObj.__WORLDMAP_TEST__;
    api.setFilterMilitary(true);        // enables both
    expect(Number(registeredEls['map-stat-conflicts'].textContent)).toBe(3);
    expect(Number(registeredEls['map-stat-fleets'].textContent)).toBe(9);
  });

  test('current-week helpers bound an ISO week and gate dates', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    // Wed 2026-09-23 → Mon 2026-09-21 .. Sun 2026-09-27.
    expect(api.weekBoundsISO('2026-09-23')).toEqual({ start: '2026-09-21', end: '2026-09-27' });
    expect(api.weekBoundsISO('2026-09-27')).toEqual({ start: '2026-09-21', end: '2026-09-27' });
    expect(api.weekBoundsISO('2026-09-28')).toEqual({ start: '2026-09-28', end: '2026-10-04' });
    expect(api.isInCurrentWeek('2026-09-22', '2026-09-23')).toBe(true);
    expect(api.isInCurrentWeek('2026-09-28', '2026-09-23')).toBe(false);
    expect(api.isInCurrentWeek('2026-08-01', '2026-09-23')).toBe(false);
    expect(api.isInCurrentWeek('', '2026-09-23')).toBe(false);
    expect(api.isInCurrentWeek('not-a-date', '2026-09-23')).toBe(false);
  });

  test('renders tooltip with canonical category, value and clickable source link', () => {
    // Cybersecurity event in London (lon -0.1278, lat 51.5074) → (400, 54) on the 800x520
    // stub; it is far from every other dot so the hit is unambiguous.
    canvas.fire('mousemove', { clientX: LONDON().x, clientY: LONDON().y, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
    const wrapper = tooltip.children[0];
    expect(wrapper.children.find((c) => c.className === 'tt-category').textContent).toBe('Cybersecurity');
    expect(wrapper.children.find((c) => c.className === 'tt-title').textContent).toBe('Cyber');
    expect(wrapper.children.find((c) => c.className === 'tt-value').textContent).toBe('7');
    const link = wrapper.children.find((c) => c.className === 'tt-link');
    expect(link).toBeDefined();
    expect(link.href).toBe('https://example.com/7');
    expect(link.target).toBe('_blank');
    // A press alone no longer dismisses; clicking empty canvas closes the popup.
    canvas.fire('mousedown', { clientX: EMPTY_CANVAS().x, clientY: EMPTY_CANVAS().y });
    windowObj.fire('mouseup', { clientX: EMPTY_CANVAS().x, clientY: EMPTY_CANVAS().y });
    expect(tooltip.classList.contains('visible')).toBe(false);
  });

test('tooltip canonicalizes legacy category names', () => {
    // 'Energy (old name)' at lon -74, lat 40.7; isolated dot.
    canvas.fire('mousemove', { clientX: pt(-74, 40.7).x, clientY: pt(-74, 40.7).y, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
    const wrapper = tooltip.children[0];
    expect(wrapper.children.find((c) => c.className === 'tt-category').textContent).toBe('Renewable Energy');
    expect(wrapper.children.find((c) => c.className === 'tt-title').textContent).toBe('Energy (old name)');
    const link = wrapper.children.find((c) => c.className === 'tt-link');
    expect(link).toBeDefined();
    expect(link.href).toBe('https://example.com/2');
  });

  test('tooltip omits the source link when the event has no url', () => {
    // 'Quantum (old name)' at lon 8.5417, lat 47.3769; isolated dot.
    canvas.fire('mousemove', { clientX: pt(8.5417, 47.3769).x, clientY: pt(8.5417, 47.3769).y, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
    const wrapper = tooltip.children[0];
    expect(wrapper.children.find((c) => c.className === 'tt-category').textContent).toBe('Quantum Physics');
    expect(wrapper.children.find((c) => c.className === 'tt-link')).toBeUndefined();
  });

  test('tooltip hides a value that merely repeats the title (metric-less)', () => {
    registeredEls['reset-view'].fire('click', {});
    // 'UnknownX' at lat 0 / lon 0 → (400, 260), isolated dot. Its value equals its
    // title (metric-less events publish the title), so no .tt-value row is rendered.
    canvas.fire('mousemove', { clientX: 400, clientY: 260, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
    const wrapper = tooltip.children[0];
    expect(wrapper.children.find((c) => c.className === 'tt-title').textContent).toBe('UnknownX');
    expect(wrapper.children.find((c) => c.className === 'tt-value')).toBeUndefined();
    // Leave no hover/popup state behind for the tests that follow.
    canvas.fire('mousedown', { clientX: EMPTY_CANVAS().x, clientY: EMPTY_CANVAS().y });
    windowObj.fire('mouseup', { clientX: EMPTY_CANVAS().x, clientY: EMPTY_CANVAS().y });
    expect(tooltip.classList.contains('visible')).toBe(false);
  });

  test('terminator toggle flips aria-pressed state', () => {
    const toggle = registeredEls['terminator-toggle'];
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.fire('click', {});
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    // Icon shows what clicking will do: ☀ = will show day (turn off), ☾ = will show night (turn on)
    expect(registeredEls['terminator-icon'].textContent).toBe('☀');
    toggle.fire('click', {});
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(registeredEls['terminator-icon'].textContent).toBe('☾');
  });

test('zoom controls, keyboard and double-click do not throw', () => {
    registeredEls['zoom-in'].fire('click', {});
    registeredEls['zoom-out'].fire('click', {});
    registeredEls['reset-view'].fire('click', {});
    canvas.fire('dblclick', { clientX: 400, clientY: 260 });
    canvas.fire('wheel', { clientX: 400, clientY: 260, deltaY: -100, preventDefault() {} });
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '0']) {
      canvas.fire('keydown', { key, target: canvas, preventDefault() {} });
    }
  });

  test('tooltip clamps to the map edges using its measured size', () => {
    // Renewable Energy event at lon 151.21 / lat -33.87, near both the right and
    // bottom edges. With measured 150x200 the tooltip must flip to the left of
    // the cursor and above it instead of overflowing the map.
    registeredEls['reset-view'].fire('click', {});
    const target = pt(151.2093, -33.8688);
    canvas.fire('mousemove', { clientX: target.x, clientY: target.y, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
    // Clamped against the canvas edges, not the old hardcoded numbers.
    expect(parseFloat(tooltip.style.left)).toBe(target.x - 150 - 12);
    expect(parseFloat(tooltip.style.top)).toBe(target.y - 200 - 12);
  });

  test('zoom dismisses a stale tooltip and hover re-opens it', () => {
    registeredEls['reset-view'].fire('click', {});
    // London Cyber event at (400, 54); zoom anchored at (400, 260) relocates it
    // to screen (400, 260), so the old tooltip position would be stale.
    canvas.fire('mousemove', { clientX: LONDON().x, clientY: LONDON().y, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
    canvas.fire('dblclick', { clientX: 400, clientY: 260 });
    expect(tooltip.classList.contains('visible')).toBe(false);
    // A fresh hover over the relocated dot must re-open the tooltip.
    canvas.fire('mousemove', { clientX: 400, clientY: 260, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
  });

  test('drag clears hover state so a re-hover after drag re-opens', () => {
    registeredEls['reset-view'].fire('click', {});
    canvas.fire('mousemove', { clientX: LONDON().x, clientY: LONDON().y, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
    // A real drag (press, travel, release) leaves the dot somewhere else, so the
    // popup is stale and must be dropped on release.
    canvas.fire('mousedown', { clientX: LONDON().x, clientY: LONDON().y });
    windowObj.fire('mouseup', { clientX: 430, clientY: 83 });
    expect(tooltip.classList.contains('visible')).toBe(false);
    // Pointing at the same dot again after the drag must re-open (previously the
    // stale hoveredEvent made the second hover only nudge the hidden tooltip).
    canvas.fire('mousemove', { clientX: LONDON().x, clientY: LONDON().y, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
  });

  test('clicking a dot pins the popup so the source link stays reachable', () => {
    registeredEls['reset-view'].fire('click', {});
    // Cyber dot at (400, 54). Hover then click (press+release without moving).
    canvas.fire('mousemove', { clientX: LONDON().x, clientY: LONDON().y, movementX: 0, movementY: 0 });
    canvas.fire('mousedown', { clientX: LONDON().x, clientY: LONDON().y });
    expect(tooltip.classList.contains('visible')).toBe(true);      // press keeps it
    windowObj.fire('mouseup', { clientX: LONDON().x, clientY: LONDON().y });
    expect(tooltip.classList.contains('visible')).toBe(true);       // release pins it
    const link = tooltip.children[0].children.find((c) => c.className === 'tt-link');
    expect(link).toBeDefined();
    expect(link.href).toBe('https://example.com/7');
    // Moving to an empty part of the map must NOT close the pinned popup.
    canvas.fire('mousemove', { clientX: EMPTY_CANVAS().x, clientY: EMPTY_CANVAS().y, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
    // Clicking empty canvas dismisses the pinned popup.
    canvas.fire('mousedown', { clientX: EMPTY_CANVAS().x, clientY: EMPTY_CANVAS().y });
    windowObj.fire('mouseup', { clientX: EMPTY_CANVAS().x, clientY: EMPTY_CANVAS().y });
    expect(tooltip.classList.contains('visible')).toBe(false);
  });

  test('clicking the pinned dot again unpins it', () => {
    registeredEls['reset-view'].fire('click', {});
    canvas.fire('mousemove', { clientX: LONDON().x, clientY: LONDON().y, movementX: 0, movementY: 0 });
    canvas.fire('mousedown', { clientX: LONDON().x, clientY: LONDON().y });
    windowObj.fire('mouseup', { clientX: LONDON().x, clientY: LONDON().y });
    expect(tooltip.classList.contains('visible')).toBe(true);
    // Second click on the same dot toggles the popup off (it used to be a no-op
    // because the press had already forgotten the selection).
    canvas.fire('mousedown', { clientX: LONDON().x, clientY: LONDON().y });
    windowObj.fire('mouseup', { clientX: LONDON().x, clientY: LONDON().y });
    expect(tooltip.classList.contains('visible')).toBe(false);
    // And the selection is gone, so hovering the dot again re-opens a plain popup.
    canvas.fire('mousemove', { clientX: LONDON().x, clientY: LONDON().y, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
    expect(tooltip.querySelector('.tt-pager')).toBe(null);
  });

  test('Escape clears a pinned popup selection', () => {
    registeredEls['reset-view'].fire('click', {});
    canvas.fire('mousemove', { clientX: LONDON().x, clientY: LONDON().y, movementX: 0, movementY: 0 });
    canvas.fire('mousedown', { clientX: LONDON().x, clientY: LONDON().y });
    windowObj.fire('mouseup', { clientX: LONDON().x, clientY: LONDON().y });
    expect(tooltip.classList.contains('visible')).toBe(true);
    canvas.fire('keydown', { key: 'Escape', target: canvas, preventDefault() {} });
    expect(tooltip.classList.contains('visible')).toBe(false);
  });

  test('a click that drags does not pin the dot', () => {
    registeredEls['reset-view'].fire('click', {});
    canvas.fire('mousemove', { clientX: LONDON().x, clientY: LONDON().y, movementX: 0, movementY: 0 });
    canvas.fire('mousedown', { clientX: LONDON().x, clientY: LONDON().y });
    windowObj.fire('mouseup', { clientX: 420, clientY: 73 });      // > threshold = drag
    expect(tooltip.classList.contains('visible')).toBe(false);
  });

  test('internal invariants: every legend/stat key has a color', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    expect(api).toBeDefined();
    for (const cat of api.CATEGORY_LEGEND) {
      expect(api.CATEGORY_COLORS[cat.key]).toBeDefined();
    }
    for (const key of Object.keys(api.CATEGORY_STAT_MAP)) {
      expect(api.CATEGORY_COLORS[key]).toBeDefined();
    }
  });

  test('no "Other" legend row: every plottable event lands in a legend category', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    const legendKeys = api.CATEGORY_LEGEND.map((c) => c.key);
    // The site has no catch-all bucket, so an alias must always resolve to a
    // legend key - otherwise the dot renders with no colour and no count.
    expect(legendKeys.length).toBe(7);
    expect(legendKeys).not.toContain('Other');
    for (const alias of Object.keys(api.CATEGORY_ALIASES)) {
      expect(legendKeys).toContain(api.CATEGORY_ALIASES[alias]);
    }
    // A category with no alias and no legend row is exactly the "Other" bug.
    expect(api.CATEGORY_ALIASES['Mathematics']).toBe('Computing & AGI');
    expect(api.CATEGORY_ALIASES['Quantum Gravity']).toBe('Quantum Physics');
    // Fixture events carry old short names and a fully unknown category; the
    // unknown one is located at (0,0) so isPlottable drops it, but every
    // remaining event must still map onto a legend row.
    const plotted = EVENT_PAYLOAD.events
      .map((e) => api.normalizeEvent(e))
      .filter((e) => api.isPlottable(e));
    expect(plotted.length).toBeGreaterThan(0);
    for (const ev of plotted) {
      const canonical = api.CATEGORY_ALIASES[ev.category] || ev.category;
      if (canonical === 'Totally Unknown') continue;
      expect(legendKeys).toContain(canonical);
    }
    // Legend counts sum to the plottable events that carry a known category.
    const known = plotted.filter((e) => {
      const canonical = api.CATEGORY_ALIASES[e.category] || e.category;
      return canonical !== 'Totally Unknown';
    });
    const sum = legendKeys.reduce((acc, k) => acc + Number(legendValue(k)), 0);
    expect(sum).toBe(known.length);
  });

  test('stats window on the same day the map does, not the wall clock', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    // computeStats() used to read new Date() directly while the stack map and
    // hit-testing read currentDayISO(). Move the clock a week forward and the
    // two must still agree: no fixture event may fall in the new window.
    const before = api.computeStats().breakthroughs;
    expect(before).toBe(3);
    setTestDay('2026-09-30');
    try {
      expect(api.computeStats().breakthroughs).toBe(0);
      // The rolling bounds cache is keyed on the day, so it must not serve
      // the previous day's window after the clock moves.
      expect(api.isInCurrentWeek('2026-08-03', '2026-09-30')).toBe(false);
    } finally {
      setTestDay(TEST_DAY);
    }
    expect(api.computeStats().breakthroughs).toBe(3);
  });

  test('a corrupt geocode cache entry cannot take the whole map down', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    // A well-formed object is used as-is.
    expect(api.parseGeocodeCache('{"a|b|c":{"lat":1,"lon":2}}')).toEqual({ 'a|b|c': { lat: 1, lon: 2 } });
    // JSON.parse("null") succeeds and yields null; without a type guard every
    // later geocodeCache[key] read throws, loadEvents catches it and the map
    // silently falls back to four sample events.
    expect(api.parseGeocodeCache('null')).toEqual({});
    expect(api.parseGeocodeCache('42')).toEqual({});
    expect(api.parseGeocodeCache('"a string"')).toEqual({});
    // Genuinely malformed JSON still starts empty rather than throwing.
    expect(api.parseGeocodeCache('{not json')).toEqual({});
    expect(api.parseGeocodeCache('')).toEqual({});
  });

  test('normalizeEvent drops any cached stack key from the payload', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    // A stale/hostile `_stackKey` must not survive normalisation: it would make
    // this event share a stack (and therefore a count badge) with an unrelated
    // location, hiding one of them from the map.
    const ev = api.normalizeEvent({
      title: 'T', category: 'Biotechnology', value: 'v', source: 'S',
      url: 'https://a.b', date: '2026-01-01',
      geolocation: { lat: 10, lon: 20 },
      _stackKey: '999,999',
    });
    expect(ev._stackKey).toBeUndefined();
    expect(Object.keys(ev).sort()).toEqual([
      'category', 'date', 'id', 'lat', 'lon', 'source', 'title', 'url', 'value',
    ]);
  });

  test('normalizeEvent fills defaults and isPlottable filters unusable events', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    const full = api.normalizeEvent({
      title: 'T', category: 'X', value: 'v', source: 'S', url: 'https://a.b', date: '2026-01-01',
      geolocation: { lat: 1, lon: 2 },
    });
    expect(full).toEqual({
      id: '1,2,T', lat: 1, lon: 2, title: 'T', category: 'X', value: 'v', source: 'S', url: 'https://a.b', date: '2026-01-01',
    });
    // Missing geolocation and optional fields get safe defaults.
    const bare = api.normalizeEvent({ geolocation: {} });
    expect(bare).toEqual({
      id: 'undefined,undefined,Untitled', lat: undefined, lon: undefined, title: 'Untitled', category: 'Unknown', value: '', source: 'Unknown', url: '', date: '',
    });
    expect(api.isPlottable(full)).toBe(true);
    expect(api.isPlottable(bare)).toBe(false);                       // no coordinates
    expect(api.isPlottable(api.normalizeEvent({ geolocation: { lat: '1', lon: 2 }, title: 'T', category: 'X' }))).toBe(false); // string lat
    expect(api.isPlottable(api.normalizeEvent({ geolocation: { lat: 1 }, title: 'T', category: 'X' }))).toBe(false);           // missing lon
    expect(api.isPlottable(api.normalizeEvent({ title: 42, geolocation: { lat: 1, lon: 2 } }))).toBe(false);                  // non-string title falls through
    expect(api.isPlottable(api.normalizeEvent({ geolocation: { lat: 0, lon: 0 }, title: '', category: 'X' }))).toBe(true);    // numeric 0 and '' are valid
    // NaN/Infinity pass a typeof 'number' check but break geometry; reject them
    // and coordinates outside the valid ranges.
    expect(api.isPlottable(api.normalizeEvent({ geolocation: { lat: Number.NaN, lon: 0 }, title: 'T', category: 'X' }))).toBe(false);
    expect(api.isPlottable(api.normalizeEvent({ geolocation: { lat: 0, lon: Infinity }, title: 'T', category: 'X' }))).toBe(false);
    expect(api.isPlottable(api.normalizeEvent({ geolocation: { lat: 120, lon: 0 }, title: 'T', category: 'X' }))).toBe(false);  // lat > 90
    expect(api.isPlottable(api.normalizeEvent({ geolocation: { lat: 0, lon: 190 }, title: 'T', category: 'X' }))).toBe(false);  // lon > 180
    expect(api.isPlottable(api.normalizeEvent({ geolocation: { lat: 90, lon: -180 }, title: 'T', category: 'X' }))).toBe(true); // boundary values are valid
  });

  test('a redraw renders the full scene (background, terminator, dots)', () => {
    // Disable filterRecent so all test events (dated 2026-08) are visible
    const api = windowObj.__WORLDMAP_TEST__;
    api.setFilterRecent(false);
    ctx.resetCounters();
    registeredEls['reset-view'].fire('click', {});
    expect(ctx.counters.fills).toBeGreaterThan(0);
    expect(ctx.counters.strokes).toBeGreaterThan(0);
    // Graticule (17 segments) + continents + both terminator boundary lines.
    expect(ctx.counters.lineTos).toBeGreaterThan(20);
    // Each of the 8 payload events draws a glow arc + a dot arc.
    expect(ctx.counters.arcs).toBeGreaterThanOrEqual(16);
  });

  test('terminator draws both boundaries as layered translucent bands', () => {
    ctx.resetCounters();
    registeredEls['reset-view'].fire('click', {});
    const strokesOn = ctx.counters.strokes;
    // Turning the terminator off must remove the band strokes from a redraw.
    registeredEls['terminator-toggle'].fire('click', {});
    ctx.resetCounters();
    registeredEls['reset-view'].fire('click', {});
    const strokesOff = ctx.counters.strokes;
    // Terminator adds ~6 strokes (2 boundaries × 3 passes). Allow some variance.
    expect(strokesOn).toBeGreaterThan(strokesOff);
    registeredEls['terminator-toggle'].fire('click', {}); // restore for later tests
    expect(registeredEls['terminator-toggle'].getAttribute('aria-pressed')).toBe('true');
  });

  test('night band shading: sun overhead stays bright, the antipode is dark', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    // Point-in-polygon (ray casting) over the band's equirectangular coords.
    const pip = (pt, poly) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].lon, yi = poly[i].lat, xj = poly[j].lon, yj = poly[j].lat;
        const hit = ((yi > pt.y) !== (yj > pt.y)) &&
          (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
        if (hit) inside = !inside;
      }
      return inside;
    };
    const nightAt = (sunLat, sunLon, qLat, qLon) => {
      const sunset = api.buildTerminatorGeo(sunLat, sunLon, 0);
      const band = api.buildNightBand(sunset);
      const q = { x: qLon, y: qLat };
      // The band is one 180deg-wide hemisphere; test each lon-shifted copy
      // (spaced 360deg apart, so a point can sit in at most one).
      for (const shift of [-360, 0, 360]) {
        if (pip(q, band.map((pt) => ({ lon: pt.lon + shift, lat: pt.lat })))) return true;
      }
      return false;
    };
    // Equinox noon, sun over Greenwich. Night straddles the dateline — the
    // mid-day meridian must stay bright (corner-sewn bug painted it dark).
    expect(nightAt(0, 0, 0, 0)).toBe(false);       // sub-solar point: noon
    expect(nightAt(0, 0, 0, 180)).toBe(true);      // 180E is midnight
    expect(nightAt(0, 0, 0, 40)).toBe(false);      // Europe/Africa at midday
    expect(nightAt(0, 0, 0, -91)).toBe(true);      // Americas just past sunset
    // Offset sun at 90E.
    expect(nightAt(0, 90, 0, 180)).toBe(true);
    expect(nightAt(0, 90, 0, -90)).toBe(true);
    expect(nightAt(0, 90, 0, 90)).toBe(false);
    // Declined sun (−20° over the Atlantic) — antipode shifts to (20, 120).
    expect(nightAt(-20, -60, -20, -60)).toBe(false);
    expect(nightAt(-20, -60, 20, 120)).toBe(true);
  });

  test('night band is painted from 3 longitude-shifted copies, never screen corners', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    api.setSunPosition(0, 0); // deterministic noon over Greenwich
    ctx.resetCounters();
    registeredEls['reset-view'].fire('click', {});
    const nightFills = ctx.fillsLog.filter((f) => f.style === api.NIGHT_FILL);
    // Exactly three copies of the unwrapped band get painted per draw.
    expect(nightFills.length).toBe(3);
    const xs = nightFills.flatMap((f) => f.path.map((p) => p.x));
    // Together the copies cover the full canvas width at the default view.
    expect(Math.min(...xs)).toBeLessThanOrEqual(0);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(800);
    // No band may start by sewing to a screen corner (the old bug's shape).
    const corners = [[0, 0], [800, 0], [0, 520], [800, 520]];
    for (const f of nightFills) {
      const first = f.path[0];
      corners.forEach(([x, y]) => expect(first.x === x && first.y === y).toBe(false));
    }
    api.setSunPosition(null, null); // restore the live clock
    registeredEls['reset-view'].fire('click', {});
  });

  test('legend no longer carries the lifecycle note row', () => {
    const flat = (node, out = []) => {
      for (const c of node.children || []) { out.push(c); flat(c, out); }
      return out;
    };
    const notes = flat(registeredEls['map-legend'])
      .filter((c) => (c.className || '').split(' ').includes('map-legend-note'));
    // The note was removed both to declutter and to shrink the bottom-left
    // frame back to its previous footprint.
    expect(notes.length).toBe(0);
  });

  test('zoom clamps to [0.5, 8] and keyboard 0 resets the view', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    registeredEls['reset-view'].fire('click', {});
    expect(api.getView().scale).toBe(1);
    for (let i = 0; i < 12; i++) registeredEls['zoom-in'].fire('click', {});
    expect(api.getView().scale).toBe(8);                            // overflow clamps to MAX_SCALE
    for (let i = 0; i < 12; i++) registeredEls['zoom-out'].fire('click', {});
    expect(api.getView().scale).toBe(0.5);                          // underflow clamps to MIN_SCALE
    canvas.fire('keydown', { key: '0', target: canvas, preventDefault() {} });
    expect(api.getView().scale).toBe(1);
    expect(api.getView().tx).toBe(0);
    expect(api.getView().ty).toBe(0);
  });

  test('canonicalCategory maps legacy short names to data names', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    expect(api.canonicalCategory('Defense')).toBe('Military & Defense');
    expect(api.canonicalCategory('Energy')).toBe('Renewable Energy');
    expect(api.canonicalCategory('Quantum')).toBe('Quantum Physics');
    expect(api.canonicalCategory('Quantum Physics')).toBe('Quantum Physics');
    expect(api.canonicalCategory('Cybersecurity')).toBe('Cybersecurity');
    expect(api.canonicalCategory('Something Weird')).toBe('Something Weird');
  });

  test('normalizeZone clamps degenerate radiusDeg and isZonePlottable rejects bad coordinates', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    expect(api.normalizeZone({ id: 'z10', lat: 40, lon: 25, radiusDeg: 'abc' }).radiusDeg).toBe(3);
    expect(api.normalizeZone({ id: 'z11', lat: 40, lon: 25, radiusDeg: 400 }).radiusDeg).toBe(30);
    expect(api.normalizeZone({ id: 'z12', lat: 40, lon: 25, radiusDeg: -5 }).radiusDeg).toBe(3);
    const z = api.normalizeZone({ id: 'z13', lat: 40, lon: 25, radiusDeg: 2.2 });
    expect(z.radiusDeg).toBeCloseTo(2.2);
    expect(api.isZonePlottable(z)).toBe(true);
    expect(api.isZonePlottable({ ...z, lat: 1e400 })).toBe(false);  // Infinity
    expect(api.isZonePlottable({ ...z, lat: Number.NaN })).toBe(false);
    expect(api.isZonePlottable({ ...z, lon: -190 })).toBe(false);
    expect(api.isZonePlottable({ ...z, name: 42 })).toBe(false);
    expect(api.isZonePlottable({ ...z, lat: undefined })).toBe(false);
    expect(api.isZonePlottable(api.normalizeZone({ ...z, lat: 0, lon: 0 }))).toBe(false);  // unlocated marker
  });

  test('isFleetPlottable requires two valid endpoints', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    const ok = api.normalizeFleet({ id: 'f10', from: { lat: 50, lon: 10 }, to: { lat: 51, lon: 11 } });
    expect(api.isFleetPlottable(ok)).toBe(true);
    expect(api.isFleetPlottable(api.normalizeFleet({ id: 'f11', from: { lat: 50, lon: 10 } }))).toBe(false);
    expect(api.isFleetPlottable(api.normalizeFleet({ id: 'f12', from: { lat: 50, lon: 999 }, to: { lat: 51, lon: 11 } }))).toBe(false);
    expect(api.isFleetPlottable(api.normalizeFleet({ id: 'f13', from: { lat: 50, lon: 10 }, to: { lat: 1e400, lon: 11 } }))).toBe(false);
    expect(api.isFleetPlottable(api.normalizeFleet({ id: 'f14', from: { lat: 0, lon: 0 }, to: { lat: 51, lon: 11 } }))).toBe(false);  // unlocated marker
    expect(api.isFleetPlottable(api.normalizeFleet({ id: 'f15', from: { lat: 50, lon: 10 }, to: { lat: 0, lon: 0 } }))).toBe(false);
  });

  test('isFleetPlottable accepts infantry deployments with lat/lon', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    const ok = api.normalizeFleet({ id: 'inf-01', kind: 'mobilization', lat: 50, lon: 10 });
    expect(api.isFleetPlottable(ok)).toBe(true);
    expect(api.isFleetPlottable(api.normalizeFleet({ id: 'inf-02', kind: 'deployment', lat: 999, lon: 10 }))).toBe(false);
    expect(api.isFleetPlottable(api.normalizeFleet({ id: 'inf-03', kind: 'rotation', lat: 50, lon: 1e400 }))).toBe(false);
    expect(api.isFleetPlottable(api.normalizeFleet({ id: 'inf-04', kind: 'infantry', lat: 0, lon: 0 }))).toBe(false);  // unlocated marker
  });

  test('new visitors see ALL milestones by default (breakthrough filter off)', () => {
    expect(registeredEls['filter-recent'].getAttribute('aria-pressed')).toBe('false');
    const api = windowObj.__WORLDMAP_TEST__;
    api.setFilterRecent(true);
    expect(registeredEls['filter-recent'].getAttribute('aria-pressed')).toBe('true');
    expect(registeredEls['filter-recent'].style.opacity).toBe('1');
    api.setFilterRecent(false);
    expect(registeredEls['filter-recent'].getAttribute('aria-pressed')).toBe('false');
    expect(registeredEls['filter-recent'].style.opacity).toBe('0.5');
  });

  test('crisis filter button lights up bright when toggled active', () => {
    const btn = registeredEls['filter-crisis'];
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    btn.fire('click', {});
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.style.opacity).toBe('1');
    expect(Number(registeredEls['map-stat-crises'].textContent)).toBe(5);
    btn.fire('click', {});
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.style.opacity).toBe('0.5');
  });

  test('layer lifecycle helpers: status, duration label and date parsing', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    // Status normalization.
    expect(api.layerStatus({})).toBe('active');
    expect(api.layerStatus({ status: 'ongoing' })).toBe('active');
    expect(api.layerStatus({ status: 'concluded' })).toBe('concluded');
    expect(api.layerStatus({ status: 'inactive' })).toBe('concluded');
    expect(api.isLayerActive({ status: 'active' })).toBe(true);
    expect(api.isLayerActive({ status: 'ended' })).toBe(false);
    // Date parsing accepts YYYY, YYYY-MM and YYYY-MM-DD.
    expect(api.normalizeLayerDate('2022')).toBe('2022-01-01');
    expect(api.normalizeLayerDate('2022-03')).toBe('2022-03-01');
    expect(api.normalizeLayerDate('2022-03-05')).toBe('2022-03-05');
    expect(api.normalizeLayerDate('nonsense')).toBeNull();
    expect(api.normalizeLayerDate('')).toBeNull();
    // Tooltip copy: active = "since", concluded = full duration span.
    expect(api.layerActivityLabel({ status: 'active', start_date: '2022-02-24' })).toBe('Active since 2022-02-24');
    expect(api.layerActivityLabel({ status: 'active' })).toBe('Active');
    expect(api.layerActivityLabel({ status: 'concluded', start_date: '2022-02-24', end_date: '2024-02-24' }))
      .toBe('Concluded · 731 days (2022-02-24 → 2024-02-24)');
    expect(api.layerActivityLabel({ status: 'concluded', start_date: '2022-01-01' })).toBe('Concluded · ran from 2022-01-01');
    expect(api.layerActivityLabel({ status: 'concluded', end_date: '2024-01-01' })).toBe('Concluded · ended 2024-01-01');
    expect(api.layerActivityLabel({ status: 'concluded' })).toBe('Concluded');
  });

  test('year clustering: active layers persist, concluded ones stay in their window', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    api.setLayers(
      [
        { id: 'z-old', name: 'Concluded war', lat: 40, lon: 25, status: 'concluded', start_date: '2022-01-01', end_date: '2024-12-31' },
        { id: 'z-new', name: 'War since 2026', lat: 41, lon: 26, status: 'active', start_date: '2026-01-01' },
        { id: 'z-any', name: 'Dataless zone', lat: 42, lon: 27 },
      ],
      [],
      []
    );
    api.setFilterMilitary(true);
    // 2023: concluded zone inside its window → visible; 2026 zone not yet started → hidden.
    api.setTimelineYear(2023);
    expect(api.getTimelineYear()).toBe(2023);
    const stateAt2023 = api.getLayers().zones;
    expect(stateAt2023.find((z) => z.id === 'z-old')._hiddenByTimeline).toBe(false);
    expect(stateAt2023.find((z) => z.id === 'z-new')._hiddenByTimeline).toBe(true);
    expect(stateAt2023.find((z) => z.id === 'z-any')._hiddenByTimeline).toBe(false); // no dates → all years
    // 2026: concluded zone ended in 2024 → dropped; active-from-2026 → visible.
    api.setTimelineYear(2026);
    const stateAt2026 = api.getLayers().zones;
    expect(stateAt2026.find((z) => z.id === 'z-old')._hiddenByTimeline).toBe(true);
    expect(stateAt2026.find((z) => z.id === 'z-new')._hiddenByTimeline).toBe(false);
    // Restore the shared fixtures for later tests.
    api.setTimelineYear(2026);
    api.setLayers(LAYER_PAYLOAD.conflict_zones, LAYER_PAYLOAD.deployments, LAYER_PAYLOAD.crisis_zones);
  });

  test('timeline clustering normalizes non-ISO event dates before grouping by year', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    api.setEvents([
      { id: 'e-iso', title: 'ISO', category: 'Biotechnology', date: '2026-03-15', geolocation: { lat: 1, lon: 1 } },
      { id: 'e-dmy', title: 'DMY', category: 'Biotechnology', date: '15/03/2026', geolocation: { lat: 2, lon: 1 } },
      { id: 'e-2025', title: 'Last year', category: 'Biotechnology', date: '2025-12-01', geolocation: { lat: 3, lon: 1 } },
      { id: 'e-garbage', title: 'Garbage', category: 'Biotechnology', date: 'banana', geolocation: { lat: 4, lon: 1 } },
    ]);
    api.setTimelineYear(2026);
    const events = api.getEvents();
    const byTitle = (t) => events.find((e) => e.title === t);
    expect(byTitle('ISO')._hiddenByTimeline).toBe(false);
    // A DMY date grouped under the wrong year (15, via raw .slice(0,4)) was the bug.
    expect(byTitle('DMY')._hiddenByTimeline).toBe(false);
    expect(byTitle('Last year')._hiddenByTimeline).toBe(true);
    expect(byTitle('Garbage')._hiddenByTimeline).toBe(true);
    // Leave the timeline at the current year for later tests.
    api.setTimelineYear(2026);
  });

  test('stats split active vs concluded layers and labels reflect it', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    api.setLayers(
      [
        { id: 'a1', name: 'Active zone', lat: 40, lon: 25, status: 'active' },
        { id: 'c1', name: 'Concluded zone', lat: 41, lon: 26, status: 'concluded', start_date: '2022-01-01', end_date: '2024-01-01' },
      ],
      [{ id: 'f-old', label: 'Old op', from: { lat: 50, lon: 10 }, to: { lat: 55, lon: 15 }, status: 'concluded', end_date: '2023-06-01' }],
      [{ id: 'cr1', name: 'Active crisis', lat: 10, lon: 20, status: 'active' }]
    );
    const stats = api.computeStats();
    expect(stats.conflicts).toBe(2);
    expect(stats.conflictsActive).toBe(1);
    expect(stats.conflictsConcluded).toBe(1);
    expect(stats.fleets).toBe(1);
    expect(stats.fleetsActive).toBe(0);
    expect(stats.fleetsConcluded).toBe(1);
    expect(stats.crises).toBe(1);
    expect(stats.crisesActive).toBe(1);
    expect(stats.crisesConcluded).toBe(0);
    // The zone legend row title gives the active/concluded breakdown.
    const rowByLayer = (key) => legendRows().find((r) => (r.attrs['data-layer'] || '') === key);
    expect(rowByLayer('zones').getAttribute('title')).toBe('1 active, 1 concluded');
    // Concluded deployments produce the detailed fleet label.
    expect(registeredEls['filter-military-fleet-label'].textContent).toContain('concluded');
    // Restore shared fixtures.
    api.setLayers(LAYER_PAYLOAD.conflict_zones, LAYER_PAYLOAD.deployments, LAYER_PAYLOAD.crisis_zones);
    expect(Number(registeredEls['map-stat-conflicts'].textContent)).toBe(3);
  });

  // ---- Co-located milestones (stack) ----

  // Three milestones at one spot; "Stack C" is a year older than the others so
  // the timeline-slider interaction is observable. lat 10 / lon 20 projects to
  // (444, 220) on the 800x520 stub.
  const STACK_SPOT = { lat: 10, lon: 20 };
  const STACKED_EVENTS = [
    { id: 'st-a', title: 'Stack A', category: 'Biotechnology', value: '1', source: 'S', url: 'https://example.com/a', date: '2026-04-01', geolocation: { ...STACK_SPOT } },
    { id: 'st-b', title: 'Stack B', category: 'Renewable Energy', value: '2', source: 'S', url: '', date: '2026-05-01', geolocation: { ...STACK_SPOT } },
    { id: 'st-c', title: 'Stack C', category: 'Cybersecurity', value: '3', source: 'S', url: '', date: '2025-05-01', geolocation: { ...STACK_SPOT } },
  ];
  // Only the stack count badges are numeric; the terminator draws ☀/☽ glyphs.
  const badgeTexts = () => ctx.textsLog.filter((t) => /^\d+$/.test(t.text)).map((t) => t.text);
  const tooltipTitle = () => tooltip.children[0].children.find((c) => c.className === 'tt-title').textContent;
  const pagerBtn = (cls) => tooltip.querySelector('.tt-pager').querySelector('.' + cls);
  const pagerIndex = () => tooltip.querySelector('.tt-pager-index').textContent;
  const clickAt = (x, y) => {
    canvas.fire('mousedown', { clientX: x, clientY: y });
    windowObj.fire('mouseup', { clientX: x, clientY: y });
  };

  test('co-located milestones share one count badge and one hit target', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    api.setFilterRecent(false);
    api.setEvents(STACKED_EVENTS);
    api.setTimelineYear(2026);
    // Two of the three milestones are on the map in 2026.
    expect(api.stackForEvent(api.getEvents()[0]).map((e) => e.title)).toEqual(['Stack A', 'Stack B']);
    // One location = one badge + one fan, no matter how many milestones it holds
    // (each member used to redraw the whole cluster on top of the others).
    ctx.resetCounters();
    registeredEls['reset-view'].fire('click', {});
    expect(badgeTexts()).toEqual(['2']);
    // The dot under the cursor resolves to one of the visible members, never to
    // the milestone the timeline clustered away.
    canvas.fire('mousemove', { clientX: 444, clientY: 220, movementX: 0, movementY: 0 });
    expect(tooltipTitle()).toBe('Stack B');
    // Focusing a member (hover/pin) replaces the cluster with that single dot, so
    // the count badge is not painted on top of the milestone being described.
    // Drop the hover onto empty canvas (not another marker) so the next move is a
    // genuine re-entry rather than a move between two visible dots.
    canvas.fire('mousemove', { clientX: EMPTY_CANVAS().x, clientY: EMPTY_CANVAS().y, movementX: 0, movementY: 0 });
    ctx.resetCounters();
    canvas.fire('mousemove', { clientX: 444, clientY: 220, movementX: 0, movementY: 0 });
    expect(tooltipTitle()).toBe('Stack B');
    expect(badgeTexts()).toEqual([]);
  });

  test('the stack pager walks the co-located milestones from the one clicked', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    api.setFilterRecent(false);
    api.setEvents(STACKED_EVENTS);
    api.setTimelineYear(2026);
    canvas.fire('mousemove', { clientX: 444, clientY: 220, movementX: 0, movementY: 0 });
    clickAt(444, 220);
    // Opens on the member that was clicked (topmost), not always on 1/N.
    expect(tooltipTitle()).toBe('Stack B');
    expect(pagerIndex()).toBe('2/2');
    expect(pagerBtn('tt-pager-prev').disabled).toBe(false);
    expect(pagerBtn('tt-pager-next').disabled).toBe(true);
    // Back to the first member; the index keeps up instead of snapping back.
    pagerBtn('tt-pager-prev').fire('click', { stopPropagation() {} });
    expect(tooltipTitle()).toBe('Stack A');
    expect(pagerIndex()).toBe('1/2');
    expect(pagerBtn('tt-pager-prev').disabled).toBe(true);
    expect(pagerBtn('tt-pager-next').disabled).toBe(false);
    // And forward again.
    pagerBtn('tt-pager-next').fire('click', { stopPropagation() {} });
    expect(tooltipTitle()).toBe('Stack B');
    expect(pagerIndex()).toBe('2/2');
    // Pressing the pinned dot again unpins the whole popup, pager included.
    clickAt(444, 220);
    expect(tooltip.classList.contains('visible')).toBe(false);
    // Re-opened by hover rather than pinned: leaving the dot closes it again.
    canvas.fire('mousemove', { clientX: 444, clientY: 220, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
    canvas.fire('mousemove', { clientX: EMPTY_CANVAS().x, clientY: EMPTY_CANVAS().y, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(false);
  });

  test('a release over the popup does not dismiss it, so the pager stays clickable', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    api.setFilterRecent(false);
    api.setEvents(STACKED_EVENTS);
    api.setTimelineYear(2026);
    const spot = pt(STACK_SPOT.lon, STACK_SPOT.lat);
    // The popup is a sibling overlaying the map, so the release coordinates hit
    // the very dot that opened it. Treating that release as a canvas gesture
    // un-pinned the popup and tore the pager out of the DOM before its click
    // could fire, which is why "previous milestone" was unreachable. Deselecting
    // is the lower-priority behaviour: a release over the popup must be ignored.
    canvas.fire('mousemove', { clientX: spot.x, clientY: spot.y, movementX: 0, movementY: 0 });
    clickAt(spot.x, spot.y);
    expect(tooltip.classList.contains('visible')).toBe(true);
    expect(pagerIndex()).toBe('2/2');

    // Simulate the pointer being over the popup: mouseenter, then a release at the
    // same spot (as the window-level mouseup listener sees it).
    tooltip.fire('mouseenter', {});
    canvas.fire('mousedown', { clientX: spot.x, clientY: spot.y });
    windowObj.fire('mouseup', { clientX: spot.x, clientY: spot.y });
    expect(tooltip.classList.contains('visible')).toBe(true);

    // The pager is still live and the previous arrow still steps back.
    const prev = pagerBtn('tt-pager-prev');
    expect(prev.disabled).toBe(false);
    prev.fire('click', { stopPropagation() {} });
    expect(tooltipTitle()).toBe('Stack A');
    expect(pagerIndex()).toBe('1/2');
    tooltip.fire('mouseleave', {});
  });

  test('the upper-left tiles dim when every layer under them is switched off', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    const tile = (id) => registeredEls[id];
    api.setFilterMilitary(true);
    api.setFilterRecent(false);
    expect(api.militaryVisible()).toBe(true);
    expect(tile('filter-military').style.opacity).toBe('1');

    // Turning one of the two military layers off still leaves the other drawing,
    // so the tile must stay lit.
    api.toggleLayer('zones');
    expect(api.militaryVisible()).toBe(true);
    expect(tile('filter-military').style.opacity).toBe('1');

    // Turning the last one off must dim it. This used to read the filter flag
    // instead of effective visibility and stayed at full brightness, so the tile
    // looked selected with an empty map behind it.
    api.toggleLayer('deployments');
    expect(api.militaryVisible()).toBe(false);
    expect(tile('filter-military').style.opacity).toBe('0.5');
    expect(tile('filter-military').getAttribute('aria-pressed')).toBe('false');

    // Re-enabling a single layer lights it again.
    api.toggleLayer('zones');
    expect(api.militaryVisible()).toBe(true);
    expect(tile('filter-military').style.opacity).toBe('1');

    // Same rule for the crisis tile.
    api.setFilterMilitary(false);
    api.toggleLayer('crises');
    expect(api.crisisVisible()).toBe(true);
    expect(tile('filter-crisis').style.opacity).toBe('1');
    api.toggleLayer('crises');
    expect(api.crisisVisible()).toBe(false);
    expect(tile('filter-crisis').style.opacity).toBe('0.5');

    // The breakthroughs tile tracks only its own filter.
    expect(tile('filter-recent').style.opacity).toBe('0.5');
    api.setFilterRecent(true);
    expect(tile('filter-recent').style.opacity).toBe('1');
    api.setFilterRecent(false);
  });

  test('an infantry arrow is hoverable and does not break hover for other layers', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    api.setFilterRecent(false);
    api.setTimelineYear(2026);
    // Start from an empty map: other tests leave co-located fixtures behind, and a
    // leftover dot near the arrow would win the hit-test and mask the real subject.
    api.setEvents([]);
    // A pinned milestone makes handleMouseMove take the pin branch, which only
    // hit-tests milestones, so clear any pin left by an earlier test.
    canvas.fire('keydown', { key: 'Escape', target: canvas, preventDefault() {} });
    expect(tooltip.classList.contains('visible')).toBe(false);
    // An infantry entry carries lat/lon + direction, never from/to. findDeployment
    // used to read fleet.from/fleet.to unconditionally, so hovering a map that
    // contained one threw inside the mousemove handler and killed hover for events,
    // zones, deployments and crises alike.
    api.setLayers(
      [],
      [{ id: 'inf-1', kind: 'infantry', name: 'Brigade move', lat: 40, lon: 20, direction: 'east',
         status: 'active', troops: 5000, start_date: '2026-02-01', source: 'MoD',
         url: 'https://example.com/inf', country: 'Testland', note: 'Exercise' }],
      []
    );
    api.setFilterMilitary(true);
    expect(api.getLayers().fleets.length).toBe(1);

    // Hover the infantry arrow's midpoint. It must produce a popup, not a throw.
    const inf = api.getLayers().fleets[0];
    const midLon = (20 + (20 - 5)) / 2;
    const mid = pt(midLon, 40);
    expect(() => canvas.fire('mousemove', { clientX: mid.x, clientY: mid.y, movementX: 0, movementY: 0 })).not.toThrow();
    expect(tooltip.classList.contains('visible')).toBe(true);
    const wrapper = tooltip.children[0];
    const text = wrapper.children.map((c) => c.textContent).join(' | ');
    expect(text).toContain('Ground Deployment');
    expect(text).toContain('Brigade move');
    expect(text).toContain('Nation: Testland');
    expect(text).toContain('Troops: 5,000');
    expect(text).toContain('Heading: east');
    // Route is reported from the derived endpoints even though the payload has
    // no from/to at all.
    expect(text).toMatch(/From: 40\.0/);
    expect(text).toMatch(/To: 40\.0/);
    // The source link is preserved end to end and rendered as a real anchor. It
    // lives inside the meta row, not directly under the wrapper.
    const metaRow = wrapper.children[2];
    const anchor = metaRow.children.find((c) => c.tagName === 'A');
    expect(anchor).toBeDefined();
    expect(anchor.textContent).toBe('MoD');
    // The renderer assigns href/target as properties (as it does for every other
    // tooltip link), so assert the property the browser will actually navigate to.
    expect(anchor.href).toBe('https://example.com/inf');
    expect(anchor.rel).toBe('noopener noreferrer');
    expect(anchor.target).toBe('_blank');

    // And a milestone dot elsewhere is still hoverable, proving the handler no
    // longer dies on the infantry entry.
    api.setEvents([{ id: 'm-1', title: 'Still hoverable', category: 'Biotechnology', value: '1',
                     source: 'S', url: 'https://example.com/m', date: '2026-04-01',
                     geolocation: { lat: -30, lon: 100 } }]);
    const m = pt(100, -30);
    canvas.fire('mousemove', { clientX: m.x, clientY: m.y, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
    expect(tooltip.children[0].children.find((c) => c.className === 'tt-title').textContent).toBe('Still hoverable');

    // fleetEndpoints is the shared geometry: it must produce a usable pair for an
    // infantry entry and refuse a fleet entry with a missing endpoint.
    const ends = api.fleetEndpoints(inf);
    expect(ends).not.toBeNull();
    expect(ends.to.lon).toBe(20);
    expect(ends.from.lon).toBe(15);
    expect(api.fleetEndpoints({ kind: 'fleet', from: { lat: 1, lon: 1 } })).toBeNull();
  });

  test('a concluded zone and arrow read dimmer than an active one', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    api.setFilterRecent(false);
    api.setTimelineYear(2026);
    // Ladder: active+fresh (glow) > active+stale (weak glow) > concluded (none).
    // Asserted on the constants the renderer actually uses, since the distinction
    // is carried by fill/stroke alpha and desaturation rather than by hue.
    expect(api.PASSIVE_OPACITY_LADDER).toEqual({ concluded: 0.10, stale: 0.16 });
    expect(api.CONCLUDED_STROKE_ALPHA).toBeGreaterThan(0.30);
    expect(api.CONCLUDED_DESAT).toBeGreaterThan(0);
    // A concluded arrowhead is desaturated as well as dimmed, so the three states
    // do not rely on alpha alone.
    expect(api.CONCLUDED_OPACITY).toBeLessThan(0.5);
  });

  test('pager arrows are real buttons so the disabled state and keyboard reach work', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    api.setFilterRecent(false);
    api.setEvents(STACKED_EVENTS);
    api.setTimelineYear(2026);
    canvas.fire('mousemove', { clientX: 444, clientY: 220, movementX: 0, movementY: 0 });
    clickAt(444, 220);
    const prev = pagerBtn('tt-pager-prev');
    const next = pagerBtn('tt-pager-next');
    // A <span> silently accepts `disabled` but never matches :disabled, so the
    // arrow kept looking clickable at the ends and could not be tabbed to.
    expect(prev.tagName).toBe('BUTTON');
    expect(next.tagName).toBe('BUTTON');
    // type=button keeps them from submitting anything if the tooltip is ever
    // nested in a form.
    expect(prev.type).toBe('button');
    expect(next.type).toBe('button');
    expect(prev.getAttribute('aria-label')).toBe('Previous milestone');
    expect(next.getAttribute('aria-label')).toBe('Next milestone');
    // Opened on 2/2: prev is live, next is genuinely disabled.
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(true);
  });

  test('the year slider re-sizes a stack to the milestones still on the map', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    api.setFilterRecent(false);
    api.setEvents(STACKED_EVENTS);
    // 2026 drops the 2025 milestone: badge counts 2 and the pager offers 2.
    api.setTimelineYear(2026);
    ctx.resetCounters();
    registeredEls['reset-view'].fire('click', {});
    expect(badgeTexts()).toEqual(['2']);
    // A lone milestone renders as a plain dot, with no badge and no pager.
    api.setTimelineYear(2025);
    expect(api.stackForEvent(api.getEvents()[0]).map((e) => e.title)).toEqual(['Stack C']);
    ctx.resetCounters();
    registeredEls['reset-view'].fire('click', {});
    expect(badgeTexts()).toEqual([]);
    canvas.fire('mousemove', { clientX: 444, clientY: 220, movementX: 0, movementY: 0 });
    expect(tooltipTitle()).toBe('Stack C');
    expect(tooltip.querySelector('.tt-pager')).toBe(null);
    // Back to the shared location: the badge returns.
    api.setTimelineYear(2026);
    ctx.resetCounters();
    registeredEls['reset-view'].fire('click', {});
    expect(badgeTexts()).toEqual(['2']);
  });

  test('hiding a category drops its milestone out of a shared stack', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    api.setFilterRecent(false);
    api.setEvents(STACKED_EVENTS);
    api.setTimelineYear(2026);
    expect(api.stackForEvent(api.getEvents()[0]).length).toBe(2);
    // Hiding Biotechnology leaves a single visible milestone at the location.
    api.toggleCategory('Biotechnology');
    expect(api.stackForEvent(api.getEvents()[0]).map((e) => e.title)).toEqual(['Stack B']);
    ctx.resetCounters();
    registeredEls['reset-view'].fire('click', {});
    expect(badgeTexts()).toEqual([]);
    // Showing it again merges the location back into a stack.
    api.toggleCategory('Biotechnology');
    expect(api.stackForEvent(api.getEvents()[0]).length).toBe(2);
    ctx.resetCounters();
    registeredEls['reset-view'].fire('click', {});
    expect(badgeTexts()).toEqual(['2']);
  });

  test('a pinned popup is dropped when the slider hides its milestone', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    api.setFilterRecent(false);
    api.setEvents(STACKED_EVENTS);
    api.setTimelineYear(2026);
    canvas.fire('mousemove', { clientX: 444, clientY: 220, movementX: 0, movementY: 0 });
    clickAt(444, 220);
    expect(tooltip.classList.contains('visible')).toBe(true);
    // Sliding to 2025 removes every member of this stack, so the popup must not
    // be left floating over empty canvas.
    api.setTimelineYear(2025);
    expect(tooltip.classList.contains('visible')).toBe(false);
    // Restore the shared fixtures for the record.
    api.setTimelineYear(2026);
    api.setEvents(EVENT_PAYLOAD.events);
  });

  test('the stack re-groups by itself when the rolling week moves on', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    setTestDay(TEST_DAY);
    api.setFilterRecent(true);
    api.setEvents([
      { id: 'rw-a', title: 'Fresh A', category: 'Biotechnology', date: '2026-08-07', geolocation: { ...STACK_SPOT } },
      { id: 'rw-b', title: 'Fresh B', category: 'Biotechnology', date: '2026-08-06', geolocation: { ...STACK_SPOT } },
      { id: 'rw-old', title: 'Aged out', category: 'Biotechnology', date: '2026-07-20', geolocation: { ...STACK_SPOT } },
    ]);
    api.setTimelineYear(2026);
    // Window is today-6 .. today, so "Aged out" is already outside it.
    expect(api.stackForEvent(api.getEvents()[0]).map((e) => e.title)).toEqual(['Fresh A', 'Fresh B']);
    // Move the clock five days forward with no filter interaction at all: the
    // window drops "Fresh B", so the count badge must stop including it (the map
    // used to keep the groups it built when the filter was last touched).
    setTestDay('2026-08-13');
    expect(api.stackForEvent(api.getEvents()[0]).map((e) => e.title)).toEqual(['Fresh A']);
    // And a milestone that ages out is no longer clickable either.
    registeredEls['reset-view'].fire('click', {});
    canvas.fire('mousemove', { clientX: 444, clientY: 220, movementX: 0, movementY: 0 });
    expect(tooltipTitle()).toBe('Fresh A');
    // Restore the shared fixtures.
    setTestDay(TEST_DAY);
    api.setFilterRecent(false);
    api.setTimelineYear(2026);
    api.setEvents(EVENT_PAYLOAD.events);
  });

  test('a popup pinned to a milestone that ages out is dropped without any interaction', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    setTestDay(TEST_DAY);
    api.setFilterRecent(true);
    api.setEvents([
      { id: 'pin-a', title: 'Pin A', category: 'Biotechnology', date: '2026-08-08', geolocation: { ...STACK_SPOT } },
      { id: 'pin-b', title: 'Pin B', category: 'Biotechnology', date: '2026-08-07', geolocation: { ...STACK_SPOT } },
    ]);
    api.setTimelineYear(2026);
    registeredEls['reset-view'].fire('click', {});
    canvas.fire('mousemove', { clientX: 444, clientY: 220, movementX: 0, movementY: 0 });
    clickAt(444, 220);
    expect(tooltip.classList.contains('visible')).toBe(true);
    expect(tooltipTitle()).toBe('Pin B');
    // Midnight: both milestones leave the rolling window. Nothing is clicked and
    // no filter is toggled. stackForEvent() is the frame loop's own freshness
    // check, so calling it is how the map notices the new day.
    setTestDay('2026-08-16');
    expect(api.stackForEvent(api.getEvents()[0])).toEqual([]);
    // The map noticed, but the popup pinned to an aged-out milestone used to stay
    // on screen over empty canvas with a stale "2/2" pager.
    expect(tooltip.classList.contains('visible')).toBe(false);
    // Restore the shared fixtures.
    setTestDay(TEST_DAY);
    api.setFilterRecent(false);
    api.setTimelineYear(2026);
    api.setEvents(EVENT_PAYLOAD.events);
  });

  test('the default view shows the polar caps but keeps the terminator out of them', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    registeredEls['reset-view'].fire('click', {});
    // Longitude still spans the full 360deg across the canvas width.
    expect(api.project(-180, 0).x).toBe(0);
    expect(api.project(180, 0).x).toBe(800);
    // Latitude spans the window, so the canvas edges are +/-MAP_LAT_LIMIT and the
    // equator stays centred.
    expect(api.MAP_LAT_LIMIT).toBe(72);
    expect(api.project(0, api.MAP_LAT_LIMIT).y).toBe(0);
    expect(api.project(0, 0).y).toBe(260);
    expect(api.project(0, -api.MAP_LAT_LIMIT).y).toBe(520);
    // The caps are on-canvas (that is the point: the map is recentred, not cropped
    // tight to the tropics) but the true poles are not.
    expect(api.project(0, 90).y).toBeLessThan(0);
    expect(api.project(0, -90).y).toBeGreaterThan(520);
    // The terminator stops strictly inside the saturation latitude, so the cap
    // band is left lit instead of being painted a degenerate constant longitude.
    expect(api.TERMINATOR_LAT_LIMIT).toBeLessThanOrEqual(66.5);
    expect(api.TERMINATOR_LAT_LIMIT).toBeLessThan(api.MAP_LAT_LIMIT);
    for (const decl of [23.44, -23.44, 0]) {
      for (const offset of [0, 180]) {
        const curve = api.buildTerminatorGeo(decl, 0, offset);
        expect(curve.length).toBe(181);
        let maxAbsLat = 0;
        for (const p of curve) {
          maxAbsLat = Math.max(maxAbsLat, Math.abs(p.lat));
          // Never degenerate: the hour angle stays in (0, 180) so no sample
          // collapses onto a single longitude and smears into a shadow band.
          expect(Number.isFinite(p.lon)).toBe(true);
          expect(p.lon).toBeGreaterThanOrEqual(-180);
          expect(p.lon).toBeLessThanOrEqual(180);
        }
        expect(maxAbsLat).toBeLessThanOrEqual(api.TERMINATOR_LAT_LIMIT);
      }
    }
    // "Reset view" restores exactly this window, not a zoomed-in one.
    canvas.fire('dblclick', { clientX: 400, clientY: 260 });
    expect(api.getView()).not.toEqual({ scale: 1, tx: 0, ty: 0 });
    registeredEls['reset-view'].fire('click', {});
    expect(api.getView()).toEqual({ scale: 1, tx: 0, ty: 0 });
    expect(api.project(0, api.MAP_LAT_LIMIT).y).toBe(0);
  });

  test('co-located grouping tolerates ~3 m coordinate noise but splits ~300 km', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    api.setFilterRecent(false);
    api.setTimelineYear(2026);
    // Same campus, quoted to slightly different precision (~3 m apart) — one cluster.
    api.setEvents([
      { id: 'np-1', title: 'Precise', category: 'Biotechnology', date: '2026-04-01', geolocation: { lat: 42.3375, lon: -71.1061 } },
      { id: 'np-2', title: 'Rounded', category: 'Biotechnology', date: '2026-04-02', geolocation: { lat: 42.33753, lon: -71.10609 } },
    ]);
    expect(api.stackForEvent(api.getEvents()[0]).length).toBe(2);
    // Boston vs New York is ~300 km away, so no cluster.
    api.setEvents([
      { id: 'np-3', title: 'Far', category: 'Biotechnology', date: '2026-04-01', geolocation: { lat: 42.3375, lon: -71.1061 } },
      { id: 'np-4', title: 'Elsewhere', category: 'Biotechnology', date: '2026-04-02', geolocation: { lat: 40.7128, lon: -74.006 } },
    ]);
    expect(api.stackForEvent(api.getEvents()[0]).length).toBe(1);
    // Restore the shared fixtures.
    api.setEvents(EVENT_PAYLOAD.events);
  });
});
