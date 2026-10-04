/**
 * Dashboard unit tests for the full-timeline activity + per-metric timeline
 * helpers. Runs under `bun test`: loads the real assets/js/dashboard.js in a
 * minimal DOM stub (the IIFE only touches the DOM/listeners at load time) and
 * asserts against the window.__DASHBOARD_TEST__ hook.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(HERE, '..', 'assets', 'js', 'dashboard.js'), 'utf8');

function makeEl() {
  return {
    style: {},
    children: [],
    listeners: {},
    className: '',
    hidden: false,
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text === undefined ? '' : this._text; },
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { this.children.push(...cs); },
    replaceChildren(...cs) {
      this.children = [];
      for (const c of cs) {
        if (c && c.isFragment) this.children.push(...c.children);
        else this.children.push(c);
      }
    },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    querySelectorAll() { return []; },
  };
}

const globalEls = new Map();
const documentObj = {
  // 'loading' defers the activity/catalog/metric loaders to a DOMContentLoaded
  // callback that never fires in the harness - we only exercise the pure test
  // hook helpers here.
  readyState: 'loading',
  createElement: () => makeEl(),
  createDocumentFragment: () => ({ isFragment: true, children: [] }),
  getElementById: (id) => {
    if (!globalEls.has(id)) globalEls.set(id, makeEl());
    return globalEls.get(id);
  },
  querySelectorAll: () => [],
  addEventListener() {},
  documentElement: makeEl(),
};

const windowObj = {
  addEventListener() {},
  removeEventListener() {},
  requestAnimationFrame() {},
  __DASHBOARD_TEST__: undefined,
};

const sandbox = {
  window: windowObj,
  document: documentObj,
  IntersectionObserver: function () { return { observe() {}, unobserve() {}, disconnect() {} }; },
  performance: { now: () => 0 },
  requestAnimationFrame() {},
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  AbortController: class { abort() {} signal = {} },
  TypeError,
  Error,
  Math,
  Date,
  Number: { isNaN: Number.isNaN, isInteger: Number.isInteger, isFinite: Number.isFinite },
  Object,
  Array,
  Map,
  Set,
  parseInt,
  parseFloat,
  String,
  console,
};

const fn = new Function(...Object.keys(sandbox), `${code}\n return window.__DASHBOARD_TEST__;`);
const api = fn(...Object.values(sandbox));

const TODAY = '2026-09-21';
const HISTORY = [
  { category: 'Energy', subcategory: 'fusion', title: 'older', date: '2026-04-01', value: 90, unit: 'MW', source: 'ITER' },
  { category: 'Energy', subcategory: 'fusion', title: 'current', date: '2026-08-22', value: 100, unit: 'MW', source: 'ITER' },
  { category: 'Quantum Physics', subcategory: 'qubit_count', title: 'qubits', date: '2026-08-25', value: 137, unit: 'qubits', source: 'ETHZ' },
  { category: 'Energy', subcategory: 'fusion', title: 'dup-day', date: '2026-08-22', value: 95, unit: 'MW', source: 'ITER' },
];

describe('dashboard timeline helpers', () => {
  test('stale archive: computeStaleness detects the 25-8 wall', () => {
    const st = api.computeStaleness(HISTORY, TODAY);
    expect(st.maxDate).toBe('2026-08-25');
    expect(st.days).toBe(27);
    expect(api.computeStaleness([], TODAY).maxDate).toBeNull();
    expect(api.computeStaleness([{ date: 'garbage' }], TODAY).days).toBeNull();
  });

  test('metricKey groups by category + subcategory', () => {
    expect(api.metricKey({ category: 'Energy', subcategory: 'fusion' })).toBe('Energy / fusion');
    expect(api.metricKey({ category: 'Energy' })).toBe('Energy / general');
  });

  test('buildMetricOptionList groups and sorts metrics newest-first', () => {
    const options = api.buildMetricOptionList(HISTORY, TODAY);
    expect(options.length).toBe(2);
    expect(options[0].value).toBe('Quantum Physics / qubit_count'); // newest (08-25)
    expect(options[1].value).toBe('Energy / fusion');
    expect(options[0].count).toBe(1);
    expect(options[1].count).toBe(3);
    expect(options[1].records[0].date).toBe('2026-08-22'); // newest record first within metric
  });

  test('metricCountsByDate aggregates per date chronologically', () => {
    const fusion = api.buildMetricOptionList(HISTORY, TODAY).find(o => o.value === 'Energy / fusion');
    const counts = api.metricCountsByDate(fusion.records);
    expect(counts).toEqual([
      { date: '2026-04-01', count: 1 },
      { date: '2026-08-22', count: 2 },
    ]);
    expect(api.metricCountsByDate([{ date: 'bad' }])).toEqual([]);
  });

  test('fresh vs stale banners use the milestone DATE, not file freshness', () => {
    expect(api.daysSinceISO('2026-08-25', '2026-09-21')).toBe(27);
    expect(api.daysSinceISO('2026-09-19', '2026-09-21')).toBe(2);
    expect(api.daysSinceISO('2026-08-25', 'bad')).toBeNull();
  });

  test('milestoneValueText is empty for metric-less milestones; title conveys the info', () => {
    expect(api.milestoneValueText({ value: null, summary: 'Moderna vaccine approved.', title: 'Moderna mRNA flu vaccine' }))
      .toBe('');
    expect(api.milestoneValueText({ value: undefined, title: 'Alkermes orexin ADHD' }))
      .toBe('');
    expect(api.milestoneValueText({ value: '', title: 'Empty metric' })).toBe('');
    expect(api.milestoneValueText({})).toBe('');
    expect(api.milestoneValueText({ value: 98.7, title: 'Nanopore' })).toBe(98.7);
    expect(api.milestoneValueText({ value: 'Tier-1', title: 'Cyber op' })).toBe('Tier-1');
  });

  test('numericMilestoneValue returns parsed number or null', () => {
    expect(api.numericMilestoneValue({ value: 137 })).toBe(137);
    expect(api.numericMilestoneValue({ value: '94.7' })).toBe(94.7);
    expect(api.numericMilestoneValue({ value: null })).toBeNull();
    expect(api.numericMilestoneValue({ value: '' })).toBeNull();
    expect(api.numericMilestoneValue({ value: 'Tier-1' })).toBeNull();
  });

  test('milestoneMetricText joins value+unit and never shows empty parens', () => {
    expect(api.milestoneMetricText({ value: 98.7, unit: '%', title: 'Nanopore' })).toBe('98.7 %');
    expect(api.milestoneMetricText({ value: null, unit: null, summary: 'Vaccine approved.', title: 'Flu vaccine' }))
      .toBe('');
    expect(api.milestoneMetricText({ value: undefined, unit: undefined, title: 'No metric' })).toBe('');
    expect(api.milestoneMetricText({})).toBe('');
  });
});

// ===========================================================================
// The adaptive timeline chart, the tactical frame, and the carousel.
// ===========================================================================
describe('the activity chart fits its frame', () => {
  // The reported defect: activity.json publishes one bucket per month since 1945
  // (976 columns) and `.chart-bar` had `min-width: 8px` inside a flex row with a
  // 3px gap - roughly 10,700px of bars in a container under 1,000px wide.
  const ARCHIVE_RECORDS = [
    { date: '1945-07-16', count: 1 },   // Trinity test
    { date: '1945-11-01', count: 1 },
    { date: '2026-06-30', count: 10 },
    { date: '2026-09-28', count: 4 },
    { date: '2026-10-02', count: 1 },
  ];

  test('the chosen bucket never needs more width than the frame has', () => {
    for (const width of [320, 360, 480, 768, 1024, 1440, 1920]) {
      const { size, buckets } = api.chooseChartBucket(ARCHIVE_RECORDS, width);
      expect(buckets.length).toBeGreaterThan(0);
      expect(buckets.length * api.CHART_MIN_COL_PX).toBeLessThanOrEqual(
        Math.max(width, api.CHART_MIN_COL_PX));
      expect(api.CHART_BUCKETS).toContain(size);
      expect(api.CHART_BUCKET_LABEL[size]).toBeTruthy();
    }
  });

  test('the hard column cap holds however wide the frame is', () => {
    const wide = api.chooseChartBucket(ARCHIVE_RECORDS, 100000);
    expect(wide.buckets.length).toBeLessThanOrEqual(api.CHART_MAX_COLUMNS);
  });

  test('a narrow frame is served a coarser bucket than a wide one', () => {
    const narrow = api.chooseChartBucket(ARCHIVE_RECORDS, 360).size;
    const wide = api.chooseChartBucket(ARCHIVE_RECORDS, 1920).size;
    expect(api.CHART_BUCKETS.indexOf(narrow)).toBeGreaterThan(api.CHART_BUCKETS.indexOf(wide));
  });

  test('a long series is aggregated instead of laid out column by column', () => {
    // The actual shape of the shipped archive: 110 records spread over 81 years.
    const long = [];
    for (let y = 1945; y <= 2026; y++) {
      for (let m = 1; m <= 12; m++) {
        if ((y * 7 + m * 3) % 23 === 0) long.push({ date: `${y}-${String(m).padStart(2, '0')}-15`, count: 1 });
      }
    }
    expect(long.length).toBeGreaterThan(30);
    const { buckets } = api.chooseChartBucket(long, 900);
    expect(buckets.length).toBeLessThanOrEqual(api.CHART_MAX_COLUMNS);
    expect(buckets.length * api.CHART_MIN_COL_PX).toBeLessThanOrEqual(900);
    // Nothing is lost in the aggregation: the counts still sum to the records.
    expect(buckets.reduce((a, b) => a + b.count, 0)).toBe(long.length);
  });

  test('an empty series yields no columns rather than one misleading column', () => {
    expect(api.bucketCounts([], 'month')).toEqual([]);
    expect(api.chooseChartBucket([], 900).buckets.length).toBe(0);
  });

  test('malformed dates are ignored, not bucketed into nonsense', () => {
    const junk = [
      { date: 'not-a-date', count: 1 },
      { date: '', count: 1 },
      { date: null, count: 1 },
      { date: '2026-13-45', count: 1 },
      { date: '2026-10-02', count: 1 },
    ];
    const buckets = api.bucketCounts(junk, 'day');
    expect(buckets.length).toBe(1);
    expect(buckets[0].count).toBe(1);
  });

  test('empty periods are drawn as gaps, not closed up', () => {
    const buckets = api.bucketCounts(ARCHIVE_RECORDS, 'month');
    expect(buckets.length).toBeGreaterThan(10);
    // 1945-07 and 1945-11 have records; everything between them does not. A
    // chart that silently closed the gap would claim a continuous run.
    const zeroes = buckets.filter((b) => b.count === 0).length;
    expect(zeroes).toBeGreaterThan(5);
    expect(buckets.some((b) => b.key === '1945-07')).toBe(true);
    expect(buckets.some((b) => b.key === '1945-08' && b.count === 0)).toBe(true);
  });

  test('buckets are contiguous across the whole span, at every granularity', () => {
    for (const size of ['day', 'month', 'quarter', 'year', 'decade']) {
      const buckets = api.bucketCounts(ARCHIVE_RECORDS, size);
      expect(buckets.length).toBeGreaterThan(1);
      for (let i = 1; i < buckets.length; i++) {
        expect(api.nextChartBucket(buckets[i - 1].key, size)).toBe(buckets[i].key);
      }
    }
  });

  test('bucket increments survive year, month and leap-day boundaries', () => {
    // The hand-written rollover arithmetic is where a bucketing bug hides: a
    // quarter key is "YYYY-Qn", so slicing it at a fixed offset yields "Q4",
    // which parses as NaN and spins the generator to its guard.
    expect(api.nextChartBucket('2025-12', 'month')).toBe('2026-01');
    expect(api.nextChartBucket('2025-11', 'month')).toBe('2025-12');
    expect(api.nextChartBucket('2025-Q4', 'quarter')).toBe('2026-01');
    expect(api.nextChartBucket('2025-Q2', 'quarter')).toBe('2025-07');
    expect(api.nextChartBucket('2025', 'year')).toBe('2026');
    expect(api.nextChartBucket('2020s', 'decade')).toBe('2030s');
    expect(api.nextChartBucket('2026-01-31', 'day')).toBe('2026-02-01');
    expect(api.nextChartBucket('2024-02-28', 'day')).toBe('2024-02-29');
    expect(api.nextChartBucket('2026-02-28', 'day')).toBe('2026-03-01');
    // A week key is always its Monday, so the step is +7 days from a Monday.
    expect(api.chartBucket('2026-12-31', 'week').key).toBe('2026-12-28');
    expect(api.nextChartBucket('2026-12-28', 'week')).toBe('2027-01-04');
    // Unparsable keys step to themselves rather than to "NaN".
    for (const bad of ['NaN', 'Q4', '']) {
      expect(api.nextChartBucket(bad, 'quarter')).toBe(bad);
      expect(api.nextChartBucket(bad, 'month')).toBe(bad);
    }
  });

  test('bucket keys and labels are what a reader can read', () => {
    expect(api.chartBucket('1945-07-16', 'month').key).toBe('1945-07');
    expect(api.chartBucket('1945-07-16', 'month').label).toBe('07/45');
    expect(api.chartBucket('1945-07-16', 'quarter').key).toBe('1945-Q3');
    expect(api.chartBucket('1945-07-16', 'quarter').label).toBe('Q3 45');
    expect(api.chartBucket('1945-07-16', 'year').key).toBe('1945');
    expect(api.chartBucket('1945-07-16', 'decade').key).toBe('1940s');
    expect(api.chartBucket('1945-07-16', 'day').key).toBe('1945-07-16');
    // A week is labelled by its Monday, which is what "week of" means.
    expect(api.chartBucket('1945-07-18', 'week').key).toBe('1945-07-16');
    // Titles are the full period, because a title has room for it.
    expect(api.chartBucket('1945-07-16', 'quarter').title).toBe('Q3 1945');
  });

  test('the column budget never drops below a readable chart', () => {
    expect(api.chartColumnBudget(0)).toBeGreaterThanOrEqual(6);
    expect(api.chartColumnBudget(10)).toBeGreaterThanOrEqual(6);
    expect(api.chartColumnBudget(100000)).toBe(api.CHART_MAX_COLUMNS);
    // Monotonic in width: a wider frame is never served fewer columns.
    let prev = 0;
    for (let w = 320; w <= 1920; w += 160) {
      const n = api.chartColumnBudget(w);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });
});

describe('the tactical frame is built from the layer payload', () => {
  test('every dated layer contributes, and every record carries a real date', () => {
    const layers = {
      conflict_zones: [
        { start_date: '2022-02-24', status: 'active' },
        { start_date: '1964-01-01', end_date: '2016-11-24', status: 'concluded' },
        { start_date: '', status: 'active' },
      ],
      crisis_zones: [{ start_date: '2021-01-01', status: 'active' }],
      deployments: [{ start_date: '2024-01-01', status: 'active' }],
      alliance_dots: [{ start_date: '2023-04-04', status: 'active' }],
      human_rights_violations: [{ start_date: '2026-09-25', status: 'active' }],
    };
    const records = api.tacticalRecords(layers);
    // 3 from conflict_zones (2 starts + 1 end) plus one each from the other four
    // lists. The zone with no dates contributes nothing.
    expect(records.length).toBe(7);
    for (const r of records) expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Oldest first, so the series reads forward in time.
    for (let i = 1; i < records.length; i++) {
      expect(records[i].date >= records[i - 1].date).toBe(true);
    }
  });

  test('a concluded layer counts at its end as well as its start', () => {
    // Counting only starts would make the series decay exactly when things were
    // resolving, which reads as "less is happening" at the worst moment.
    const records = api.tacticalRecords({
      conflict_zones: [{ start_date: '1964-01-01', end_date: '2016-11-24', status: 'concluded' }],
    });
    expect(records.map((r) => r.date).sort()).toEqual(['1964-01-01', '2016-11-24']);
  });

  test('a layer with no dates at all is skipped rather than dated to the epoch', () => {
    expect(api.tacticalRecords({ conflict_zones: [{ start_date: '' }, { start_date: null }, {}] }))
      .toEqual([]);
    expect(api.tacticalRecords({})).toEqual([]);
    expect(api.tacticalRecords(null)).toEqual([]);
  });

  test('all three date precisions the pipelines write are accepted', () => {
    // sync_layers.py writes YYYY-MM-DD and bare YYYY; a bare year would be
    // dropped by a strict YYYY-MM-DD test, and the chart would quietly lose
    // every long-running layer in the series.
    const records = api.tacticalRecords({
      conflict_zones: [
        { start_date: '1948-01-01' },
        { start_date: '2003' },
        { start_date: '2015-06' },
      ],
    });
    expect(records.map((r) => r.date).sort()).toEqual(['1948-01-01', '2003-01-01', '2015-06-01']);
  });

  test('parseDateToISO refuses to invent a date', () => {
    expect(api.parseDateToISO('2025-06-25')).toBe('2025-06-25');
    expect(api.parseDateToISO('2025-06-25T12:00:00Z')).toBe('2025-06-25');
    expect(api.parseDateToISO('2025-06')).toBe('2025-06-01');
    expect(api.parseDateToISO('2025')).toBe('2025-01-01');
    for (const bad of ['nope', '', '   ', null, undefined, '0000']) {
      // '0000' parses as a year, which is honest: it is what the payload said.
      const got = api.parseDateToISO(bad);
      expect(got === null || /^\d{4}-\d{2}-\d{2}$/.test(got)).toBe(true);
    }
    expect(api.parseDateToISO('nope')).toBe(null);
    expect(api.normalizeLayerDate('2017-06-05')).toBe('2017-06-05');
  });
});

describe('the highlights carousel rotates one card at a time', () => {
  // The old marquee was broken three ways: duplicated cards translated -50%
  // (a half-gap jump every cycle), a duration of contentWidth/30 so twelve cards
  // took 134 SECONDS to come round, and `flex: 0 0 100%` on mobile turning it
  // into an unreadable crawl.

  test('the rotation interval is the two seconds the section promises', () => {
    expect(api.HIGHLIGHT_INTERVAL_MS).toBe(2000);
  });

  test('the timeline helpers the carousel shares are still correct', () => {
    // Regression guard for the pure helpers extracted alongside it.
    expect(api.metricCountsByDate([
      { date: '2026-01-01' }, { date: '2026-01-01' }, { date: '2026-01-02' },
    ]).map((c) => c.count)).toEqual([2, 1]);
  });
});
