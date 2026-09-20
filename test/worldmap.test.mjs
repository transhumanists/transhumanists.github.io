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
    { id: 'unk-001', title: 'UnknownX', category: 'Totally Unknown', value: '8', source: 'S8', url: '', date: '2026-08-08', geolocation: { lat: 0, lon: 0 } },
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
  const ctx = { listeners: [] };
  ctx.createLinearGradient = () => ({ addColorStop() {} });
  for (const m of ['fillRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'closePath', 'setLineDash', 'arc', 'fillText', 'save', 'restore', 'setTransform']) {
    ctx[m] = () => {};
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

for (const id of ['world-map-canvas', 'map-tooltip', 'map-stat-active', 'map-stat-conflicts', 'map-stat-fleets', 'world-map', 'zoom-in', 'zoom-out', 'reset-view', 'terminator-toggle', 'terminator-icon', 'terminator-label']) {
  registeredEls[id] = id === 'map-tooltip' ? tooltip : (id === 'world-map-canvas' ? canvas : makeEl());
}

// Mirror the markup in index.md so behaviour tests start from the same DOM state.
registeredEls['terminator-toggle'].setAttribute('aria-pressed', 'true');
registeredEls['terminator-icon'].textContent = '☀';
registeredEls['terminator-label'].textContent = 'Day/Night';

// world-map children registry: legend is created at runtime and appended here.
const worldMap = registeredEls['world-map'];
const worldMapAppend = worldMap.appendChild.bind(worldMap);
worldMap.appendChild = (c) => { if (c && c.id) registeredEls[c.id] = c; return worldMapAppend(c); };

const documentObj = {
  readyState: 'complete',
  hidden: false,
  getElementById: (id) => registeredEls[id] ?? null,
  addEventListener() {},
  removeEventListener() {},
  createElement: () => makeEl(),
  createDocumentFragment() {
    const f = { isFragment: true, children: [] };
    f.appendChild = (c) => { f.children.push(c); return c; };
    return f;
  },
};

let load;
beforeAll(async () => {
  windowObj.__WORLDMAP_TEST__ = true;

  globalThis.window = windowObj;
  globalThis.document = documentObj;
  globalThis.devicePixelRatio = 1;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.AbortController = class { abort() {} signal = {}; };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.fetch = async () => ({ ok: true, json: async () => EVENT_PAYLOAD });

  await import('../assets/js/worldmap.js');
  // Let the async load() settle (it awaits fetch then calls draw).
  await new Promise((r) => setTimeout(r, 20));
});

function legendRows() {
  const legend = registeredEls['map-legend'];
  return legend ? legend.children.filter((c) => c.className === 'map-legend-row') : [];
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
    expect(Number(registeredEls['map-stat-active'].textContent)).toBe(4);   // Bio + Energy + Quantum + Renewable Energy
    expect(Number(registeredEls['map-stat-conflicts'].textContent)).toBe(1); // Cybersecurity
    expect(Number(registeredEls['map-stat-fleets'].textContent)).toBe(2);    // Defense(alias) + Military & Defense
  });

  test('renders legend rows for all 7 categories plus Other', () => {
    const legend = registeredEls['map-legend'];
    expect(legend).toBeDefined();
    expect(legend.getAttribute('role')).toBe('list');
    const rows = legendRows();
    expect(rows.length).toBe(8);
    expect(legendValue('Biotechnology')).toBe('1');
    expect(legendValue('Computing & AGI')).toBe('0');
    expect(legendValue('Quantum Physics')).toBe('1');      // aliased 'Quantum'
    expect(legendValue('Renewable Energy')).toBe('2');     // aliased 'Energy' + canonical
    expect(legendValue('Cybersecurity')).toBe('1');
    expect(legendValue('Spaceflight & Aeronautics')).toBe('0');
    expect(legendValue('Military & Defense')).toBe('2');   // aliased 'Defense' + canonical
    expect(legendValue('Other')).toBe('1');
  });

  test('renders tooltip with canonical category, value and clickable source link', () => {
    // Cybersecurity event in London (lon -0.1278, lat 51.5074) → (400, 111) on the 800x520
    // stub; it is far from every other dot so the hit is unambiguous.
    canvas.fire('mousemove', { clientX: 400, clientY: 111, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
    const wrapper = tooltip.children[0];
    expect(wrapper.children.find((c) => c.className === 'tt-category').textContent).toBe('Cybersecurity');
    expect(wrapper.children.find((c) => c.className === 'tt-title').textContent).toBe('Cyber');
    expect(wrapper.children.find((c) => c.className === 'tt-value').textContent).toBe('7');
    const link = wrapper.children.find((c) => c.className === 'tt-link');
    expect(link).toBeDefined();
    expect(link.href).toBe('https://example.com/7');
    expect(link.target).toBe('_blank');
    // mousedown dismisses the tooltip and starts a drag; release it for later tests.
    canvas.fire('mousedown', {});
    expect(tooltip.classList.contains('visible')).toBe(false);
    windowObj.fire('mouseup', {});
  });

test('tooltip canonicalizes legacy category names', () => {
    // 'Energy (old name)' at lon -74, lat 40.7 → (236, 143) on the 800x520 stub.
    canvas.fire('mousemove', { clientX: 236, clientY: 143, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
    const wrapper = tooltip.children[0];
    expect(wrapper.children.find((c) => c.className === 'tt-category').textContent).toBe('Renewable Energy');
    expect(wrapper.children.find((c) => c.className === 'tt-title').textContent).toBe('Energy (old name)');
    const link = wrapper.children.find((c) => c.className === 'tt-link');
    expect(link).toBeDefined();
    expect(link.href).toBe('https://example.com/2');
  });

  test('tooltip omits the source link when the event has no url', () => {
    // 'Quantum (old name)' at lon 8.5417, lat 47.3769 → (419, 123); isolated dot.
    canvas.fire('mousemove', { clientX: 419, clientY: 123, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
    const wrapper = tooltip.children[0];
    expect(wrapper.children.find((c) => c.className === 'tt-category').textContent).toBe('Quantum Physics');
    expect(wrapper.children.find((c) => c.className === 'tt-link')).toBeUndefined();
  });

  test('terminator toggle flips aria-pressed state', () => {
    const toggle = registeredEls['terminator-toggle'];
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.fire('click', {});
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(registeredEls['terminator-icon'].textContent).toBe('☾');
    toggle.fire('click', {});
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
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
    // Renewable Energy event at lon 151.21 / lat -33.87 → (736, 358) on the 800x520
    // stub, near both the right and bottom edges. With measured 150x200 the tooltip
    // must flip to the left of the cursor (574px) and above it (146px) instead of
    // overflowing the map.
    registeredEls['reset-view'].fire('click', {});
    canvas.fire('mousemove', { clientX: 736, clientY: 358, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
    expect(tooltip.style.left).toBe('574px');
    expect(tooltip.style.top).toBe('146px');
  });

  test('zoom dismisses a stale tooltip and hover re-opens it', () => {
    registeredEls['reset-view'].fire('click', {});
    // London Cyber event at (400, 111); zoom anchored at (400, 260) relocates it
    // to screen (400, 260), so the old tooltip position would be stale.
    canvas.fire('mousemove', { clientX: 400, clientY: 111, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
    canvas.fire('dblclick', { clientX: 400, clientY: 260 });
    expect(tooltip.classList.contains('visible')).toBe(false);
    // A fresh hover over the relocated dot must re-open the tooltip.
    canvas.fire('mousemove', { clientX: 400, clientY: 260, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
  });

  test('drag clears hover state so a re-hover after drag re-opens', () => {
    registeredEls['reset-view'].fire('click', {});
    canvas.fire('mousemove', { clientX: 400, clientY: 111, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
    canvas.fire('mousedown', {});
    expect(tooltip.classList.contains('visible')).toBe(false);
    windowObj.fire('mouseup', {});
    // Pointing at the same dot again after the drag must re-open (previously the
    // stale hoveredEvent made the second hover only nudge the hidden tooltip).
    canvas.fire('mousemove', { clientX: 400, clientY: 111, movementX: 0, movementY: 0 });
    expect(tooltip.classList.contains('visible')).toBe(true);
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

  test('normalizeEvent fills defaults and isPlottable filters unusable events', () => {
    const api = windowObj.__WORLDMAP_TEST__;
    const full = api.normalizeEvent({
      title: 'T', category: 'X', value: 'v', source: 'S', url: 'https://a.b', date: '2026-01-01',
      geolocation: { lat: 1, lon: 2 },
    });
    expect(full).toEqual({
      lat: 1, lon: 2, title: 'T', category: 'X', value: 'v', source: 'S', url: 'https://a.b', date: '2026-01-01',
    });
    // Missing geolocation and optional fields get safe defaults.
    const bare = api.normalizeEvent({ geolocation: {} });
    expect(bare).toEqual({
      lat: undefined, lon: undefined, title: 'Untitled', category: 'Unknown', value: '', source: 'Unknown', url: '', date: '',
    });
    expect(api.isPlottable(full)).toBe(true);
    expect(api.isPlottable(bare)).toBe(false);                       // no coordinates
    expect(api.isPlottable(api.normalizeEvent({ geolocation: { lat: '1', lon: 2 }, title: 'T', category: 'X' }))).toBe(false); // string lat
    expect(api.isPlottable(api.normalizeEvent({ geolocation: { lat: 1 }, title: 'T', category: 'X' }))).toBe(false);           // missing lon
    expect(api.isPlottable(api.normalizeEvent({ title: 42, geolocation: { lat: 1, lon: 2 } }))).toBe(false);                  // non-string title falls through
    expect(api.isPlottable(api.normalizeEvent({ geolocation: { lat: 0, lon: 0 }, title: '', category: 'X' }))).toBe(true);    // numeric 0 and '' are valid
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
});