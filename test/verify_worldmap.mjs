/**
 * End-to-end verification of the shipped world map against the REAL published
 * data files. Runs under plain `node` (no Bun, no Playwright), which matters
 * because the unit suite is Bun-only and cannot be executed in every
 * environment - so this is the check that the production payload actually
 * produces the behaviour the product promises.
 *
 * What it asserts, in order of how badly a regression would hurt:
 *   1. the Ukraine conflict zone is NOT dimmed (the reported bug),
 *   2. every operational layer has a recency signal, so "bright" means something,
 *   3. the datalayer is renamed everywhere, legend included,
 *   4. the alliance-dot sublayer exists, is hittable, and suppresses its arrows,
 *   5. responsible-actor flags resolve for the real records, and do NOT invent
 *      an actor from a publisher,
 *   6. the hover/stick/unstick contract holds for every landmark type.
 *
 * Usage: node test/verify_worldmap.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ---- Minimal DOM / canvas fake -------------------------------------------
// Same shape as the Bun suite's fake: it records what the renderer asked for
// without rendering anything, which is enough to assert tier-driven styling.
function makeClassList() {
  const set = new Set();
  return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) };
}
function makeEl() {
  const el = {
    // A real CSSStyleDeclaration: the legend sets a custom property through
    // setProperty, and a plain object without it throws mid-render.
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    children: [], attrs: {}, className: '', listeners: {},
    classList: makeClassList(), offsetWidth: 240, offsetHeight: 140,
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    hasAttribute(k) { return k in this.attrs; },
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { this.children.push(...cs); },
    replaceChildren(...cs) {
      this.children = [];
      for (const c of cs) {
        if (c && c.isFragment) this.children.push(...c.children);
        else this.children.push(c);
      }
    },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    removeEventListener() {},
    fire(type, ev) {
      const event = Object.assign({ stopped: false, defaultPrevented: false }, ev);
      event.stopPropagation = () => { event.stopped = true; };
      event.preventDefault = () => { event.defaultPrevented = true; };
      for (const fn of this.listeners[type] || []) fn(event);
      return event;
    },
    contains(c) { return c === this; },
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
  Object.defineProperty(el, 'textContent', {
    get() { return this._text === undefined ? '' : this._text; },
    set(v) { this._text = String(v); },
  });
  return el;
}
function makeCanvas() {
  const el = makeEl();
  el.width = 0; el.height = 0;
  el.getBoundingClientRect = () => ({ width: 900, height: 560, left: 0, top: 0, right: 900, bottom: 560 });
  return el;
}
function makeCtx() {
  const ctx = { fills: 0, strokes: 0, arcs: 0, arcsLog: [] };
  ctx.createLinearGradient = () => ({ addColorStop() {} });
  ctx.createRadialGradient = () => ({ addColorStop() {} });
  for (const m of ['fillRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'closePath',
    'setLineDash', 'fillText', 'save', 'restore', 'setTransform', 'rect', 'clip',
    'clearRect', 'fillRect', 'strokeRect', 'translate', 'rotate', 'scale', 'arc', 'fillRect']) {
    ctx[m] = (...a) => {
      if (m === 'fill') ctx.fills++;
      else if (m === 'stroke') ctx.strokes++;
      else if (m === 'arc') { ctx.arcs++; ctx.arcsLog.push({ x: a[0], y: a[1], r: a[2] }); }
    };
  }
  return ctx;
}

const registeredEls = {};
const windowObj = {
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false }),
  location: { hostname: 'localhost' },
  _listeners: {},
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); },
  removeEventListener() {},
  fire(t, ev) { for (const fn of this._listeners[t] || []) fn(ev); },
};
globalThis.localStorage = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => m.set(String(k), String(v)),
    removeItem: (k) => m.delete(String(k)),
    clear: () => m.clear(),
  };
})();

const tooltip = makeEl();
const canvas = makeCanvas();
const ctx = makeCtx();
canvas.getContext = () => ctx;
for (const id of ['world-map-canvas', 'map-tooltip', 'map-stat-active', 'map-stat-conflicts',
  'map-stat-fleets', 'map-stat-crises', 'world-map', 'zoom-in', 'zoom-out', 'reset-view',
  'terminator-toggle', 'terminator-icon', 'terminator-label', 'filter-recent', 'filter-military',
  'filter-crisis', 'filter-recent-label', 'filter-military-conflict-label',
  'filter-military-fleet-label']) {
  registeredEls[id] = id === 'map-tooltip' ? tooltip
    : id === 'world-map-canvas' ? canvas : makeEl();
}
const worldMap = registeredEls['world-map'];
const worldMapAppend = worldMap.appendChild.bind(worldMap);
worldMap.appendChild = (c) => { if (c && c.id) registeredEls[c.id] = c; return worldMapAppend(c); };
const documentObj = {
  readyState: 'complete',
  hidden: false,
  getElementById: (id) => registeredEls[id] ?? null,
  querySelector: (sel) => ({
    '#filter-recent .map-hint-title span:last-child': registeredEls['filter-recent-label'],
    '#filter-military .map-hint-title span:nth-child(2)': registeredEls['filter-military-conflict-label'],
    '#filter-military .map-hint-title span:last-child': registeredEls['filter-military-fleet-label'],
  })[sel] ?? null,
  addEventListener() {}, removeEventListener() {},
  createElement: (tag) => Object.assign(makeEl(), { tagName: String(tag || '').toUpperCase() }),
  createElementNS: (ns, tag) => Object.assign(makeEl(), {
    tagName: String(tag || '').toUpperCase(), namespaceURI: String(ns || ''),
  }),
  createDocumentFragment() {
    const f = { isFragment: true, children: [] };
    f.appendChild = (c) => { f.children.push(c); return c; };
    return f;
  },
};

// ---- Real data -----------------------------------------------------------
const EVENTS = JSON.parse(readFileSync(join(ROOT, 'data', 'events.json'), 'utf8'));
const LAYERS = JSON.parse(readFileSync(join(ROOT, 'data', 'world_layers.json'), 'utf8'));

// Must be set BEFORE the import: worldmap.js checks for the flag at module scope
// and only then augments it with its internals. It also pins "today", so the
// rolling-7-day window is deterministic.
const TEST_DAY = '2026-10-04';
windowObj.__WORLDMAP_TEST__ = { getTodayISO: () => TEST_DAY };

globalThis.window = windowObj;
globalThis.document = documentObj;
globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.AbortController = class { abort() {} signal = {}; };
globalThis.setInterval = () => 1;
globalThis.clearInterval = () => {};
globalThis.setTimeout = setTimeout;
globalThis.fetch = async (url) => ({
  ok: true,
  json: async () => (String(url).includes('world_layers') ? LAYERS : EVENTS),
});

await import('../assets/js/worldmap.js');
const api = windowObj.__WORLDMAP_TEST__;
const deadline = Date.now() + 5000;
while (api.getLayers().zones.length === 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5));
}

// ---- Assertions ----------------------------------------------------------
let failures = 0;
let checks = 0;
function ok(label, cond, detail) {
  checks++;
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
}
function eq(label, actual, expected) {
  ok(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function section(name) { console.log(`\n${name}`); }

function tooltipText() {
  const walk = (n, out) => {
    if (!n) return out;
    if (n.textContent) out.push(n.textContent);
    for (const c of n.children || []) walk(c, out);
    return out;
  };
  return walk(tooltip, []).join(' | ');
}
function pt(lon, lat) { return api.project(lon, lat); }
// Wipe every transient anchor/selection so one section's hover cannot suppress
// the next section's (an anchor within PROXIMITY_RADIUS deliberately keeps its
// popup, which is right for a visitor and wrong for a test that wants a clean
// slate).
function clearHover() {
  const st = api.getState();
  st.selectedEvent = null; st.selectedLayer = null; st.selectedLayerType = null;
  st.selectedHumanRight = null; st.hoverAnchor = null; st.hoverAnchorType = null;
  st.hoveredEvent = null; st.hoveredType = null; st.tooltipHover = false;
  st.stackIndex = 0;
  tooltip.classList.remove('visible');
  tooltip.classList.remove('is-sticky');
}
// Pick the canvas pixel of an entry that is genuinely the topmost hit at its own
// location. Hardcoding a record and assuming it wins the hit test is how a test
// suite starts asserting the fixture rather than the behaviour - Gaza carries a
// milestone on its pixel, so "the zone" is not necessarily what a click there
// reaches.
function pixelWhere(type, entries) {
  for (const entry of entries) {
    const p = pt(entry.lon, entry.lat);
    const hit = api.findLandmarkAt(p.x, p.y);
    if (hit && hit.type === type && hit.entry === entry) return { entry, p };
  }
  return null;
}
function hoverAt(x, y) {
  canvas.fire('mousemove', { clientX: x, clientY: y, movementX: 0, movementY: 0 });
}
function legendRows() {
  const legend = registeredEls['map-legend'];
  return legend ? legend.children : [];
}

// Turn the operational layers on the way a visitor would.
api.setFilterMilitary(true);
// The sublayer defaults ON with its parent, so only force it on if something
// turned it off. Toggling unconditionally would switch it back off.
api.getState().showAllianceDots = true;

const layers = api.getLayers();

section('1. the reported bug: Ukraine must not render dimmed');
{
  const ukraine = layers.zones.find((z) => /Ukraine/.test(z.name || ''));
  ok('Ukraine conflict zone exists in the normalised data', !!ukraine);
  if (ukraine) {
    eq('Ukraine zone keeps last_news_year through normalisation',
      ukraine.last_news_year, LAYERS.conflict_zones.find((z) => /Ukraine/.test(z.name)).last_news_year);
    eq('Ukraine zone is in the hot (glowing) tier', api.layerPaintTier(ukraine), 'hot');
    ok('Ukraine zone is not treated as stale', api.isStaleLayer(ukraine) === false);
  }
  const gaza = layers.zones.find((z) => /Gaza/.test(z.name || ''));
  eq('Gaza Strip is also hot (same normalisation defect)', api.layerPaintTier(gaza), 'hot');
  const redSea = layers.zones.find((z) => /Red Sea/.test(z.name || ''));
  eq('Red Sea is also hot', api.layerPaintTier(redSea), 'hot');
}

section('2. recency signals reach the client for every active layer');
{
  const activeZones = layers.zones.filter((z) => api.isLayerActive(z));
  ok('every active conflict zone carries a recency year',
    activeZones.every((z) => Number.isFinite(api.layerRecencyYear(z))),
    activeZones.filter((z) => !Number.isFinite(api.layerRecencyYear(z)))
      .map((z) => z.name).join(', '));
  const activeCrises = layers.crises.filter((c) => api.isLayerActive(c));
  ok('every active crisis zone carries a recency year',
    activeCrises.every((c) => Number.isFinite(api.layerRecencyYear(c))),
    activeCrises.filter((c) => !Number.isFinite(api.layerRecencyYear(c)))
      .map((c) => c.name).join(', '));
  const activeDots = layers.allianceDots.filter((d) => api.isLayerActive(d));
  ok('every active policy seal carries a recency year',
    activeDots.every((d) => Number.isFinite(api.layerRecencyYear(d))));
}

section('3. the datalayer is renamed, legend included');
{
  eq('deployments legend label', api.LAYER_LABELS.deployments, 'Ground & Fleet Deployments');
  const rows = legendRows();
  const labels = rows.map((r) => (r.children.find((c) => c.className === 'map-legend-label') || {}).textContent);
  ok('legend shows the new name', labels.includes('Ground & Fleet Deployments'), labels.join(' / '));
  ok('legend no longer shows the old name', !labels.includes('Ground Deployments & Fleet Movements'));
  const dotRow = rows.find((r) => r.getAttribute('data-layer') === 'alliance_dots');
  ok('legend carries the dot sublayer row', !!dotRow);
  ok('sublayer row is marked nested', dotRow && dotRow.className.includes('map-legend-row--nested'));
  const parent = rows.find((r) => r.getAttribute('data-layer') === 'deployments');
  const dotIndex = rows.indexOf(dotRow);
  ok('sublayer row sits directly under its parent', rows.indexOf(parent) + 1 === dotIndex);
}

section('4. the alliance-dot sublayer');
{
  ok('payload publishes alliance_dots', Array.isArray(LAYERS.alliance_dots));
  ok('client normalised them', layers.allianceDots.length === LAYERS.alliance_dots.length,
    `${layers.allianceDots.length} vs ${LAYERS.alliance_dots.length}`);
  const fi = layers.allianceDots.find((d) => /Finland/.test(d.name));
  const se = layers.allianceDots.find((d) => /Sweden/.test(d.name));
  ok('Finland NATO accession is present', !!fi);
  ok('Sweden NATO accession is present', !!se);
  eq('Finland accession date', fi.start_date, '2023-04-04');
  eq('Sweden accession date', se.start_date, '2024-03-07');
  ok('the promoted movements are gone from deployments',
    !layers.fleets.some((f) => f.id === 'inf-finland-2023-nato' || f.id === 'inf-sweden-2024-nato'));
  ok('a seal with no matching id does not suppress anything',
    layers.fleets.some((f) => f.id === 'inf-poland-2023-expansion'));
  // Hittable through the same finder the pointer uses.
  const p = pt(fi.lon, fi.lat);
  const hit = api.findLandmarkAt(p.x, p.y);
  eq('the Finland seal is the hover target at its own pixel', hit && hit.type, 'alliance');
  // And its tooltip says what it is.
  hoverAt(p.x, p.y);
  ok('seal tooltip is open', tooltip.classList.contains('visible'));
  const text = tooltipText();
  ok('seal tooltip names the accession', /Alliance Accession/.test(text), text.slice(0, 120));
  ok('seal tooltip shows the date', text.includes('2023-04-04'), text.slice(0, 160));
}

section('5. responsible-actor flags');
{
  eq('US flag glyph from an ISO code', api.flagGlyph('US'), '\u{1F1FA}\u{1F1F8}');
  eq('GB flag glyph', api.flagGlyph('GB'), '\u{1F1EC}\u{1F1E7}');
  eq('a malformed code yields no glyph', api.flagGlyph('ZZZ'), '');
  eq('a non-nation chip code is not turned into a flag', api.flagGlyph('NATO'), '');

  const usni = layers.fleets.find((f) => f.source === 'USNI');
  eq('a US Navy carrier group resolves to the United States',
    (api.resolveActor(usni) || {}).flag, 'US');
  const russian = layers.fleets.find((f) => /Russian Baltic/.test(f.label || ''));
  eq('a Russian fleet resolves from its own label, not its publisher',
    (api.resolveActor(russian) || {}).flag, 'RU');
  const poland = layers.fleets.find((f) => f.country === 'Poland' && /Expansion/.test(f.label || ''));
  eq('a ground deployment resolves from its country', (api.resolveActor(poland) || {}).flag, 'PL');
  const un = layers.fleets.find((f) => /UN Peacekeeping/.test(f.label || f.name || ''));
  const unActor = api.resolveActor(un);
  eq('UN peacekeeping resolves to the UN body', unActor.flag, 'UN');
  eq('...and is typed as a UN actor, not a nation', unActor.kind, 'un');
  const nato = layers.allianceDots.find((d) => /Hague/.test(d.name));
  eq('an alliance seal resolves to NATO', (api.resolveActor(nato) || {}).flag, 'NATO');
  eq('...typed as an alliance', (api.resolveActor(nato) || {}).kind, 'alliance');

  // A publisher is not an actor. This is the misattribution the table exists to
  // stop: an ISW-sourced Russian fleet must not be filed under ISW.
  const iswOnly = { label: 'Unnamed movement', note: '', source: 'ISW', country: '' };
  eq('a publisher alone resolves to no actor', api.resolveActor(iswOnly), null);
  // ...but an ISW-sourced *real* record still resolves via its own label.
  ok('...while the real ISW-sourced fleet resolves via its label',
    api.resolveActor(russian) !== null);

  // The flag lands in the popup's top-right corner. The target is found by asking
  // the hit test which mark actually owns a pixel, not by assuming one does.
  const dep = pixelWhere('deployment', layers.fleets.filter(
    (f) => f.country === 'Poland' && /Expansion/.test(f.label || '')));
  const fall = dep || pixelWhere('deployment', layers.fleets.filter((f) => f.country === 'Poland'));
  clearHover();
  ok('a Polish ground deployment is reachable on its own pixel', !!fall);
hoverAt(fall.p.x, fall.p.y);
  const card = tooltip.children[0];
  ok('the popup root is a named card', card && card.className === 'tt-card', card ? String(card.className) : 'empty');
  const head = card && card.children[0];
  ok('the popup opens with a header row', head && head.className === 'tt-head',
    head ? `got className ${JSON.stringify(head.className)}` : 'popup empty');
  const actorEl = head && head.children[1];
  ok('the header carries the actor badge', actorEl && actorEl.className.startsWith('tt-actor'),
    actorEl ? String(actorEl.className) : 'no second child in the header');
  // Assert the badge renders EXACTLY what resolveActor decided, rather than a
  // hardcoded glyph: two Polish deployments share one pixel, so which one wins
  // the hit test is a detail of the data, and a test that pins the winner is
  // asserting the fixture instead of the wiring.
  const want = api.resolveActor(fall.entry);
  const wantText = !want ? null
    : /^[A-Z]{2}$/.test(want.flag) ? api.flagGlyph(want.flag)
    : want.flag;
  ok('the badge renders exactly the resolved actor',
    actorEl && actorEl.children[0] && wantText !== null && actorEl.children[0].textContent === wantText,
    `badge=${actorEl && JSON.stringify(actorEl.children.map((c) => c.textContent))} want=${JSON.stringify(wantText)}`);
  ok('the badge names the actor for assistive tech',
    actorEl && typeof actorEl.getAttribute('aria-label') === 'string'
      && actorEl.getAttribute('aria-label').includes(':'),
    actorEl ? String(actorEl.getAttribute('aria-label')) : 'no badge');
}

section('6. hover / stick / unstick, for every landmark type');
{
  const spot = pixelWhere('zone', layers.zones);
  ok('a conflict zone is reachable on its own pixel', !!spot);
  if (!spot) throw new Error('no conflict zone is independently clickable');
  const z = spot.entry;
  const zp = spot.p;
  const d = layers.allianceDots.find((dd) => /Sweden/.test(dd.name));
  const st = api.getState();
  const reset = () => {
    st.selectedEvent = null; st.selectedLayer = null; st.selectedLayerType = null;
    st.selectedHumanRight = null; st.hoverAnchor = null; st.hoverAnchorType = null;
    st.hoveredEvent = null; st.hoveredType = null; st.tooltipHover = false;
    st.stackIndex = 0; st.showHumanRights = true;
    tooltip.classList.remove('visible');
  };

  reset();
  // Hover a zone: popup opens, not pinned.
  hoverAt(zp.x, zp.y);
  ok('hovering a zone opens its popup', tooltip.classList.contains('visible'));
  eq('...and does not pin it', api.pinnedAnchor(), null);

  // Travel onto the popup itself (pointer is over the popup, not the map).
  tooltip.fire('mouseenter', {});
  eq('pointer over the popup marks the hover', st.tooltipHover, true);
  tooltip.fire('mouseleave', {});
  ok('leaving the popup keeps it open (links stay clickable)',
    tooltip.classList.contains('visible'));
  ok('...and it is still anchored to its zone',
    (api.hoverAnchor() || {}).entry === z);

  // Now pin it, then travel far away over empty ocean.
  reset();
  hoverAt(zp.x, zp.y);
  canvas.fire('mousedown', { clientX: zp.x, clientY: zp.y });
  windowObj.fire('mouseup', { target: canvas, clientX: zp.x, clientY: zp.y });
  ok('clicking a zone pins it', (api.pinnedAnchor() || {}).entry === z);
  ok('a pinned popup is marked sticky', tooltip.classList.contains('is-sticky'));

  const empty = pt(140, -60);
  hoverAt(empty.x, empty.y);
  ok('travelling far away over empty ocean keeps a pinned popup open',
    tooltip.classList.contains('visible'));
  ok('...and it still describes the pinned zone',
    (api.pinnedAnchor() || {}).entry === z);
  ok('...with the zone named in the popup', tooltipText().includes(z.name.slice(0, 12)), tooltipText().slice(0,80));

  // Hovering another landmark outside the range hands over - and stays pinned.
  hoverAt(pt(d.lon, d.lat).x, pt(d.lon, d.lat).y);
  eq('hovering a far landmark takes the popup over', (api.pinnedAnchor() || {}).entry, d);
  ok('...and the handover stays pinned', api.pinnedAnchor() !== null);
  ok('...showing the new landmark', /Sweden/.test(tooltipText()));

  // Clicking the pinned landmark again unpins it.
  canvas.fire('mousedown', { clientX: pt(d.lon, d.lat).x, clientY: pt(d.lon, d.lat).y });
  windowObj.fire('mouseup', { target: canvas, clientX: pt(d.lon, d.lat).x, clientY: pt(d.lon, d.lat).y });
  eq('clicking the pinned landmark again unpins it', api.pinnedAnchor(), null);
  ok('...and the sticky marker is cleared', !tooltip.classList.contains('is-sticky'));

  // A nearby-but-different landmark must NOT steal a pinned popup.
  reset();
  hoverAt(zp.x, zp.y);
  canvas.fire('mousedown', { clientX: zp.x, clientY: zp.y });
  windowObj.fire('mouseup', { target: canvas, clientX: zp.x, clientY: zp.y });
  const near = pt(z.lon + 0.15, z.lat);
  hoverAt(near.x, near.y);
  ok('drifting a few px from a pinned landmark keeps its popup', (api.pinnedAnchor() || {}).entry === z);
  reset();
}

section('7. the timeline reaches the new sublayer');
{
  const d = layers.allianceDots.find((dd) => /Sweden/.test(dd.name));
  api.setTimelineYear(2026);
  ok('a 2024 seal is visible in 2026', d._hiddenByTimeline === false);
  api.setTimelineYear(2015);
  ok('the same seal is hidden in 2015', d._hiddenByTimeline === true);
  ok('the layer reports it hidden', api.anchorIsVisible({ entry: d, type: 'alliance' }) === false);
  api.setTimelineYear(2026);
}

section('8. stats include the new sublayer');
{
  const stats = api.computeStats();
  ok('deployment total counts arrows + seals',
    stats.fleets === layers.fleets.length + layers.allianceDots.length,
    `${stats.fleets} vs ${layers.fleets.length + layers.allianceDots.length}`);
  ok('active split covers both', stats.fleetsActive
    <= stats.fleets && stats.fleetsConcluded === stats.fleets - stats.fleetsActive);
}

// ---- Report --------------------------------------------------------------
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
