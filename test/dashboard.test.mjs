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
  Number: { isNaN: Number.isNaN, isInteger: Number.isInteger },
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

  test('milestoneValueText shows info string instead of 0 for metric-less milestones', () => {
    expect(api.milestoneValueText({ value: null, summary: 'Moderna vaccine approved.', title: 'Moderna mRNA flu vaccine' }))
      .toBe('Moderna vaccine approved.');
    expect(api.milestoneValueText({ value: undefined, title: 'Alkermes orexin ADHD' }))
      .toBe('Alkermes orexin ADHD');
    expect(api.milestoneValueText({ value: '', title: 'Empty metric' })).toBe('Empty metric');
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
      .toBe('Vaccine approved.');
    expect(api.milestoneMetricText({ value: undefined, unit: undefined, title: 'No metric' })).toBe('No metric');
    expect(api.milestoneMetricText({})).toBe('');
  });
});