/**
 * Verification for the two timeline frames and the highlights carousel.
 * Runs under plain `node` against the REAL published data, for the same reason
 * as verify_worldmap.mjs: the Bun suite cannot run everywhere, and the bug that
 * made this necessary (a 976-column chart in a 900px frame) was only ever
 * visible in a real width.
 *
 * Usage: node test/verify_dashboard.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    // A real CSSStyleDeclaration: the catalog sets custom properties through
    // setProperty, and a plain object without it throws mid-render.
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    children: [], attrs: {}, dataset: {}, className: '',
    classList: (() => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) }; })(),
    offsetWidth: 0, offsetHeight: 0, clientWidth: 900, parentElement: null,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    hasAttribute(k) { return k in this.attrs; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { this.children.push(c); if (c && !c.parentElement) c.parentElement = this; return c; },
    append(...cs) { for (const c of cs) this.appendChild(c); },
    replaceChildren(...cs) {
      this.children = [];
      for (const c of cs) {
        if (c && c.isFragment) this.children.push(...c.children);
        else this.appendChild(c);
      }
    },
    addEventListener() {}, removeEventListener() {},
    focus() {}, contains(c) { return c === this; },
    querySelector() { return null; },
    // querySelectorAll is called on rendered cards by the counter wiring; an empty
    // result is the honest answer for a fake that never produced those elements.
    querySelectorAll() { return []; },
  };
  Object.defineProperty(el, 'textContent', {
    get() {
      if (this.children.length === 0) return this._text === undefined ? '' : this._text;
      return this.children.map((c) => c.textContent).join(' ');
    },
    set(v) { this._text = String(v); this.children = []; },
  });
  return el;
}

const els = {};
const documentObj = {
  readyState: 'complete',
  hidden: false,
  getElementById: (id) => els[id] ?? null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (t) => makeEl(t),
  createElementNS: (ns, t) => makeEl(t),
  // Text nodes are values, not elements: they carry no children and no class.
  createTextNode: (v) => { const n = makeEl('#text'); n._text = String(v); return n; },
  createDocumentFragment: () => { const f = { isFragment: true, children: [], appendChild(c) { this.children.push(c); return c; } }; return f; },
  addEventListener() {}, removeEventListener() {},
  body: makeEl('body'),
};
for (const id of [
  'activity-bars', 'activity-labels', 'activity-year-filter', 'activity-bucket-note',
  'activity-update-time', 'activity-staleness',
  'tactical-bars', 'tactical-labels', 'tactical-bucket-note', 'tactical-total',
  'metric-select', 'metric-timeline-list', 'metric-sparkline', 'metric-staleness',
  'metric-year-filter', 'top-milestones', 'catalog-grid', 'catalog-category-filter',
  'catalog-year-filter', 'catalog-year-prev', 'catalog-year-next', 'catalog-count',
  'highlights-carousel', 'highlights-carousel-track',
]) els[id] = makeEl('div');

globalThis.window = {
  matchMedia: () => ({ matches: false }),
  addEventListener() {}, removeEventListener() {},
  location: { hostname: 'localhost' },
};
globalThis.document = documentObj;
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.setInterval = () => 1;
globalThis.clearInterval = () => {};
globalThis.AbortController = class { abort() {} signal = {}; };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = undefined;   // exercise the window-resize fallback

const FILES = {
  '/data/events.json': JSON.parse(readFileSync(join(ROOT, 'data', 'events.json'), 'utf8')),
  '/data/milestones.json': JSON.parse(readFileSync(join(ROOT, 'data', 'milestones.json'), 'utf8')),
  '/data/milestones_history.json': JSON.parse(readFileSync(join(ROOT, 'data', 'milestones_history.json'), 'utf8')),
  '/data/activity.json': JSON.parse(readFileSync(join(ROOT, 'data', 'activity.json'), 'utf8')),
  '/data/world_layers.json': JSON.parse(readFileSync(join(ROOT, 'data', 'world_layers.json'), 'utf8')),
};
const fetched = [];
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  const key = Object.keys(FILES).find((k) => String(url).endsWith(k));
  return { ok: !!key, status: key ? 200 : 404, json: async () => FILES[key] || {} };
};

await import('../assets/js/dashboard.js');
const api = window.__DASHBOARD_TEST__;
const deadline = Date.now() + 8000;
// Wait for BOTH frames and the carousel: the carousel is populated by an async
// fetch that retries with backoff, so polling only the activity frame and then
// asserting on the carousel tests the scheduler, not the carousel.
while ((els['activity-bars'].children.length === 0
        || els['tactical-bars'].children.length === 0
        || els['highlights-carousel-track'].children.length === 0)
       && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5));
}

let failures = 0; let checks = 0;
function ok(label, cond, detail) {
  checks++;
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
}
function eq(label, actual, expected) {
  ok(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function section(n) { console.log(`\n${n}`); }

// ---------------------------------------------------------------------------
section('1. the out-of-bounds chart');
{
  const activity = JSON.parse(readFileSync(join(ROOT, 'data', 'activity.json'), 'utf8'));
  ok('the published activity file really is the 976-column problem',
    activity.days.length > 500, `${activity.days.length} monthly buckets`);

  const history = FILES['/data/milestones_history.json'];
  const records = history.map((r) => ({ date: r.date, count: 1 })).filter((r) => r.date);

  for (const width of [360, 480, 768, 1200, 1600]) {
    const { size, buckets } = api.chooseChartBucket(records, width);
    const cols = buckets.length;
    // The bar row is a flex row of `cols` columns with a 3px gap; every column
    // needs at least api.CHART_MIN_COL_PX to be legible.
    ok(`${width}px frame fits within its width (${cols} x ${size} columns)`,
      cols <= Math.floor(width / api.CHART_MIN_COL_PX),
      `${cols} columns need ${cols * api.CHART_MIN_COL_PX}px in ${width}px`);
    ok(`${width}px frame never exceeds the hard column cap`,
      cols <= api.CHART_MAX_COLUMNS, `${cols}`);
  }

  // A narrow frame must choose a coarser bucket than a wide one, or the size is
  // not actually following the width.
  const narrow = api.chooseChartBucket(records, 360);
  const wide = api.chooseChartBucket(records, 1600);
  ok('a narrow frame chooses a coarser bucket than a wide one',
    api.CHART_BUCKETS.indexOf(narrow.size) > api.CHART_BUCKETS.indexOf(wide.size),
    `narrow=${narrow.size} wide=${wide.size}`);

  // Buckets must be contiguous: a gap in the data has to render as a gap.
  const monthly = api.bucketCounts(records, 'month');
  const zeroes = monthly.filter((b) => b.count === 0).length;
  ok('empty periods are present as zero buckets, not closed up',
    zeroes > 100 && monthly.length === records.length ? false : zeroes > 100,
    `${zeroes} empty of ${monthly.length}`);
  let contiguous = true;
  for (let i = 1; i < monthly.length; i++) {
    if (api.nextChartBucket(monthly[i - 1].key, 'month') !== monthly[i].key) { contiguous = false; break; }
  }
  ok('monthly buckets are contiguous across the whole span', contiguous);

  // Quarter/year rollover is the classic off-by-one in hand-written bucketing.
  eq('quarter steps correctly across a year boundary',
    api.nextChartBucket('2025-Q4', 'quarter'), '2026-01');
  eq('month steps correctly across a year boundary',
    api.nextChartBucket('2025-12', 'month'), '2026-01');
  eq('year steps', api.nextChartBucket('2025', 'year'), '2026');
  eq('decade steps', api.nextChartBucket('2020s', 'decade'), '2030s');
  eq('day steps across a month boundary',
    api.nextChartBucket('2026-01-31', 'day'), '2026-02-01');
  eq('day steps across a leap day',
    api.nextChartBucket('2024-02-28', 'day'), '2024-02-29');
  eq('a year key is bucketed as a decade, not a month',
    api.chartBucket('1945-07-16', 'decade').key, '1940s');
  eq('a Trinity-test date lands in July 1945 monthly',
    api.chartBucket('1945-07-16', 'month').key, '1945-07');

  // The rendered DOM must actually be inside the frame.
  const bars = els['activity-bars'];
  ok('the milestone frame rendered bars', bars.children.length > 1, `${bars.children.length}`);
  ok('the rendered column count is the chosen one',
    Number(bars.dataset.columns) === bars.children.length,
    `dataset=${bars.dataset.columns} dom=${bars.children.length}`);
  ok('the rendered frame is inside its own width',
    bars.children.length * api.CHART_MIN_COL_PX <= 900 + api.CHART_MIN_COL_PX,
    `${bars.children.length} columns`);
  ok('the heading states the bucket size',
    /per (day|week|month|quarter|year|decade)/.test(els['activity-bucket-note'].textContent),
    els['activity-bucket-note'].textContent);
}

section('2. the tactical frame');
{
  const layers = FILES['/data/world_layers.json'];
  const records = api.tacticalRecords(layers);
  ok('tactical records were derived from the layer payload', records.length > 0, `${records.length}`);
  ok('every tactical record carries a real ISO date',
    records.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date)));
  ok('records are sorted oldest-first',
    records.every((r, i) => i === 0 || records[i - 1].date <= r.date));

  // Starts only would make the series decay exactly when things resolve, so a
  // concluded layer must contribute its end date too.
  const concluded = (layers.conflict_zones || []).find((z) => z.status === 'concluded' && z.end_date);
  ok('a concluded conflict zone contributes an end date',
    concluded && records.some((r) => r.date === concluded.end_date),
    concluded && concluded.end_date);
  ok('the alliance sublayer feeds the tactical frame',
    records.some((r) => r.date === '2023-04-04'));

  const bars = els['tactical-bars'];
  ok('the tactical frame rendered bars', bars.children.length > 1, `${bars.children.length}`);
  ok('the tactical frame fits its width',
    bars.children.length * api.CHART_MIN_COL_PX <= 900 + api.CHART_MIN_COL_PX,
    `${bars.children.length} columns`);
  ok('the tactical heading states the bucket size',
    /per (day|week|month|quarter|year|decade)/.test(els['tactical-bucket-note'].textContent),
    els['tactical-bucket-note'].textContent);
  ok('the tactical frame reports its total and span',
    /\d+ dated layer change/.test(els['tactical-total'].textContent),
    els['tactical-total'].textContent);
  ok('the two frames are distinguishable in the DOM',
    els['tactical-bars'] !== els['activity-bars']);
  ok('world_layers.json was actually fetched for it',
    fetched.some((u) => u.includes('world_layers.json')));
}

section('3. three-precision layer dates');
{
  eq('a full date passes through', api.parseDateToISO('2025-06-25'), '2025-06-25');
  eq('a year-month becomes the first of the month', api.parseDateToISO('2025-06'), '2025-06-01');
  eq('a bare year becomes January 1st', api.parseDateToISO('1945'), '1945-01-01');
  eq('an ISO datetime is truncated to the day', api.parseDateToISO('2025-06-25T12:00:00Z'), '2025-06-25');
  eq('nonsense is null, not a fake date', api.parseDateToISO('not a date'), null);
  eq('undefined is null', api.parseDateToISO(undefined), null);
  eq('an empty string is null', api.parseDateToISO(''), null);
}

section('4. the carousel is built and rotates');
{
  const carousel = els['highlights-carousel'];
  const track = els['highlights-carousel-track'];
  ok('cards were built', track.children.length > 0, `${track.children.length}`);
  ok('no card is duplicated for a seamless loop',
    new Set(track.children.map((c) => c.textContent)).size === track.children.length);
  ok('exactly one card is on stage',
    track.children.filter((c) => c.classList.contains('is-current')).length === 1);
  ok('off-stage cards are hidden from assistive tech',
    track.children.every((c) => c.hasAttribute('aria-hidden')));
  ok('only the visible card is in the tab order',
    track.children.filter((c) => c.getAttribute('tabindex') === '0').length === 1);
  ok('the carousel exposes controls', !!carousel._highlights);
  ok('it reports how many highlights it holds', carousel._highlights.length === track.children.length);

  // Advancing and wrapping are the two behaviours that were broken before.
  const apiH = carousel._highlights;
  const n = track.children.length;
  apiH.show(n - 1);
  eq('showing the last index works', track.children.filter((c) => c.classList.contains('is-current')).length, 1);
  eq('...and it is the last card',
    track.children[n - 1].classList.contains('is-current'), true);
  apiH.next();
  eq('advancing from the last wraps to the first',
    track.children[0].classList.contains('is-current'), true);
  eq('...with exactly one card on stage',
    track.children.filter((c) => c.classList.contains('is-current')).length, 1);
  apiH.prev();
  eq('stepping back from the first wraps to the last',
    track.children[n - 1].classList.contains('is-current'), true);
  apiH.show(0);
  eq('showing index 0 again settles', track.children[0].classList.contains('is-current'), true);
}

section('5. metric timeline helpers still work');
{
  const history = FILES['/data/milestones_history.json'];
  const opts = api.buildMetricOptionList(history, '2026-10-04');
  ok('metric options are derived from the archive', opts.length > 0, `${opts.length}`);
  ok('every option carries records', opts.every((o) => o.records.length > 0));
  const counts = api.metricCountsByDate(history);
  ok('per-date counts are produced', counts.length > 0, `${counts.length} days`);
  ok('staleness is computed against today',
    api.computeStaleness(history, '2026-10-04').days !== undefined);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
