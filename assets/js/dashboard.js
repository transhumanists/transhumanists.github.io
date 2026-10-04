/* Dashboard data loader — fetches milestones.json + activity.json */
(function() {
  'use strict';

  const CATEGORY_CONFIG = {
    biotechnology: { name: 'Biotechnology & Biohacking', icon: '🧬', color: '#00e676', toneColor: '#00a651', tone: 'Biohacking' },
    computing_agi: { name: 'Computing & AGI', icon: '🧠', color: '#448aff' },
    quantum: { name: 'Quantum Physics', icon: '⚛️', color: '#b388ff' },
    energy: { name: 'Renewable Energy', icon: '⚡', color: '#ffd740' },
    mobility: { name: 'Mobility & Logistics', icon: '🚚', color: '#ff5c9a' },
    cybersecurity: { name: 'Cybersecurity', icon: '🛡️', color: '#ff5252' },
    robotics: { name: 'Robotics & Drones', icon: '🤖', color: '#6c7a89' },
    spaceflight: { name: 'Spaceflight & Aeronautics', icon: '🚀', color: '#00d4ff' },
    defense: { name: 'Military & Defense', icon: '🌍', color: '#ff9100' }
  };

  // Two-tone categories render a second swatch so the split is visible without
  // opening a card. Kept in step with CATEGORY_SUBTONES in worldmap.js and
  // CATEGORY_SUBTONES in scripts/sync_milestones.py.
  const SUBCATEGORY_CONFIG = {
    'Biohacking': { color: '#00a651', label: 'Biohacking' }
  };

  // Category display name -> site key. The dashboard reads milestones.json, whose
  // categories are keyed by snake_case but carry the display name on each
  // category, so this resolves a record's category to its palette entry.
  const DISPLAY_TO_CONFIG_KEY = Object.entries(CATEGORY_CONFIG).reduce((acc, [key, cfg]) => {
    acc[cfg.name] = key;
    return acc;
  }, {});

  function categoryConfigFor(category) {
    const key = DISPLAY_TO_CONFIG_KEY[category];
    return key ? CATEGORY_CONFIG[key] : null;
  }

  // ---- Sample data (fallback) ----
  const SAMPLE_MILESTONES = [
    { title: 'CRISPR Cas-13b FDA phase-3', category: 'Biotechnology', value: '50', unit: 'patients treated', source: 'Stanford', date: '2026-08-25', icon: '🧬', is_new: true },
    { title: 'Qubits entangled', category: 'Quantum', value: '137', unit: 'qubits', source: 'ETH Zurich', date: '2026-08-26', icon: '⚛️', is_new: true },
    { title: 'JT-60SA fusion yield', category: 'Energy', value: '100', unit: 'MJ sustained', source: 'NIFS', date: '2026-08-22', icon: '⚡' },
    { title: 'Top CVSS score', category: 'Cybersecurity', value: '9.8', unit: 'CRITICAL', source: 'NCSC', date: '2026-08-24', icon: '🛡️', is_new: true },
    { title: 'Starship payload to LEO', category: 'Spaceflight', value: '156', unit: 'tonnes', source: 'SpaceX', date: '2026-08-23', icon: '🚀' },
    { title: 'Hypersonic glide vehicle', category: 'Defense', value: '13', unit: 'Mach', source: 'PLASSF', date: '2026-08-20', icon: '🌍', is_new: true },
    { title: 'GPT-6 MMLU', category: 'Computing & AGI', value: '94.7', unit: '%', source: 'OpenAI', date: '2026-08-19', icon: '🧠' },
    { title: 'Drone swarm coordinated', category: 'Defense', value: '1000', unit: 'UAVs', source: 'CSA', date: '2026-08-17', icon: '🌍' }
  ];

  // ---- DOM helpers ----
  function createEl(tag, className, content) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (content !== undefined) el.textContent = content;
    return el;
  }

  function createSkeletonCard(className) {
    const card = createEl('div', className);
    ['long', 'medium', 'short'].forEach(type => {
      const line = createEl('div', `skeleton-line ${type}`);
      card.appendChild(line);
    });
    return card;
  }

  // ---- Pure helpers (unit-tested via window.__DASHBOARD_TEST__) ----
  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  // Every date string the two pipelines write is normalised to YYYY-MM-DD before
  // it reaches a chart or a date comparison. The layer payloads use three
  // precisions - "YYYY-MM-DD", "YYYY-MM" and bare "YYYY" - so a strict
  // YYYY-MM-DD test alone would silently drop two thirds of the tactical series,
  // and the chart would be quietly wrong rather than obviously empty.
  function parseDateToISO(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{4})-(\d{2})$/);
    if (m) return `${m[1]}-${m[2]}-01`;
    m = s.match(/^(\d{4})$/);
    if (m) return `${m[1]}-01-01`;
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    return null;
  }

  // Layer dates arrive as strings only, but going through the same coercion keeps
  // one definition of "a usable layer date" across the site.
  function normalizeLayerDate(value) { return parseDateToISO(value); }

  function parseDateOrNull(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(s + 'T00:00:00Z');
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function daysSinceISO(dateStr, todayStr) {
    const a = parseDateOrNull(dateStr);
    const b = parseDateOrNull(todayStr);
    if (!a || !b) return null;
    return Math.round((b - a) / 86400000);
  }

  function metricKey(rec) {
    return (rec.category || 'Unknown') + ' / ' + (rec.subcategory || 'general');
  }

  // Milestones with no numeric metric show nothing in the value area: the
  // milestone title already conveys the info (never a summary-as-metric text).
  function milestoneValueText(m) {
    if (!m) return '';
    const v = m.value;
    if (v === null || v === undefined || v === '') {
      return '';
    }
    return v;
  }

  function numericMilestoneValue(m) {
    if (!m) return null;
    const v = m.value;
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(v);
    return Number.isNaN(n) ? null : n;
  }

  // "Value unit" for headers/badges; empty when the milestone has no metric.
  function milestoneMetricText(m) {
    return [milestoneValueText(m), m && m.unit].filter(Boolean).join(' ');
  }

  // Subcategories where lower numeric value = better (e.g., resolution, time, days)
  const LOWER_IS_BETTER_SUBCATEGORIES = new Set([
    'microscopy',
    'error_correction',
    'time_to_train',
    'encryption',
    'defense_scores',
    'range',
    'radius',
    'air_defense',
  ]);

  function isLowerIsBetter(subcategory) {
    return LOWER_IS_BETTER_SUBCATEGORIES.has(subcategory);
  }

  function findBeatenMilestones(milestones) {
    const beaten = new Map();
    if (!Array.isArray(milestones) || milestones.length < 2) return beaten;

    const byMetric = new Map();
    milestones.forEach(m => {
      const subcat = m.subcategory || 'general';
      const metricKey = normalizeMetricTitle(m.title);
      const key = `${subcat}|${metricKey}`;
      if (!byMetric.has(key)) byMetric.set(key, []);
      byMetric.get(key).push(m);
    });

    byMetric.forEach(group => {
      if (group.length < 2) return;
      const sorted = group.slice().sort((a, b) => {
        const dateA = parseDateOrNull(a.date || '');
        const dateB = parseDateOrNull(b.date || '');
        if (!dateA && !dateB) return 0;
        if (!dateA) return 1;
        if (!dateB) return -1;
        return dateB - dateA;
      });

      const lowerBetter = isLowerIsBetter(sorted[0].subcategory);
      for (let i = 1; i < sorted.length; i++) {
        const older = sorted[i];
        const newer = sorted[i - 1];
        if (typeof older.value === 'number' && typeof newer.value === 'number') {
          const isBeaten = lowerBetter ? newer.value < older.value : newer.value > older.value;
          if (isBeaten) beaten.set(older.id, newer);
        }
      }
    });

    return beaten;
  }

  function normalizeMetricTitle(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  }

  // Newest milestone DATE in the archive, not file freshness: this is what
  // "no milestones after 25-8" actually looks like.
  function computeStaleness(history, todayStr) {
    let max = null;
    for (const r of history || []) {
      const d = parseDateOrNull(r.date);
      if (d && (!max || d > max)) max = d;
    }
    if (!max) return { maxDate: null, days: null };
    const maxDateStr = max.toISOString().slice(0, 10);
    return { maxDate: maxDateStr, days: daysSinceISO(maxDateStr, todayStr) };
  }

  // One option per metric (category / subcategory), newest recorded date first.
  function buildMetricOptionList(history, todayStr) {
    const byMetric = new Map();
    for (const r of history || []) {
      const key = metricKey(r);
      if (!byMetric.has(key)) byMetric.set(key, []);
      byMetric.get(key).push(r);
    }
    const options = [];
    for (const [key, recs] of byMetric.entries()) {
      const sorted = recs.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      const st = computeStaleness(sorted, todayStr);
      options.push({
        value: key,
        label: `${key} (${sorted.length} record${sorted.length !== 1 ? 's' : ''})`,
        count: sorted.length,
        newestDate: st.maxDate,
        staleDays: st.days,
        records: sorted,
      });
    }
    options.sort((a, b) => (a.newestDate < b.newestDate ? 1 : a.newestDate > b.newestDate ? -1 : 0));
    return options;
  }

  // Chronological per-metric counts {date, count} - feeds the mini sparkline.
  function metricCountsByDate(records) {
    const counts = new Map();
    for (const r of records || []) {
      if (!parseDateOrNull(r.date)) continue;
      counts.set(r.date, (counts.get(r.date) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  // ---- Constants ----
  // ResizeObservers held so cleanup() can disconnect them. A timeline frame that
  // re-aggregates on resize must not keep observing a node the page has torn
  // down, and cleanup() runs on pagehide - which is exactly when that matters.
  const timelineResizeObservers = [];

  const ANIMATION_DURATION = 1200;
  const COUNTER_THRESHOLD = 0.2;
  const AUTO_SLIDE_INTERVAL = 5000;

  // ---- Counter animation utility ----
  const counterObserver = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      const el = en.target;
      const target = parseFloat(el.dataset.counterTarget);
      const duration = parseInt(el.dataset.counterDuration, 10) || ANIMATION_DURATION;
      const integer = el.dataset.counterInteger !== 'false';
      if (isNaN(target)) return;

      const start = performance.now();
      const tick = now => {
        const t = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        const val = target * eased;
        el.textContent = integer ? Math.round(val) : val.toFixed(1);
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      counterObserver.unobserve(el);
    });
  }, { threshold: COUNTER_THRESHOLD });

  function animateCounter(el, target, options = {}) {
    const { duration = ANIMATION_DURATION, integer = true } = options;
    
    // Handle scientific notation and very large numbers
    if (!isFinite(target) || Math.abs(target) > 1e15) {
      // For very large numbers or infinity, just display formatted value
      el.textContent = formatLargeNumber(target);
      return;
    }
    
    el.textContent = '0';
    el.dataset.counterTarget = target;
    el.dataset.counterDuration = duration;
    el.dataset.counterInteger = integer;
    counterObserver.observe(el);
  }

  function formatLargeNumber(num) {
    if (!isFinite(num)) return String(num);
    if (Math.abs(num) >= 1e12) {
      // Use scientific notation for very large numbers
      return num.toExponential(2).replace('+', '');
    }
    if (Math.abs(num) >= 1e6) {
      // Use compact notation for millions/billions
      if (num >= 1e9) return (num / 1e9).toFixed(2).replace(/\.00$/, '') + 'B';
      if (num >= 1e6) return (num / 1e6).toFixed(2).replace(/\.00$/, '') + 'M';
    }
    return num.toLocaleString();
  }

  // ---- Milestone detail modal ----
  let modalElements = null;
  let modalKeyHandler = null;
  let modalClickHandler = null;

  function getModalElements() {
    if (modalElements) return modalElements;
    modalElements = {
      modal: document.getElementById('milestone-modal'),
      title: document.getElementById('milestone-modal-title'),
      icon: document.getElementById('milestone-modal-icon'),
      value: document.getElementById('milestone-modal-value'),
      unit: document.getElementById('milestone-modal-unit'),
      source: document.getElementById('milestone-modal-source'),
      date: document.getElementById('milestone-modal-date'),
      geoSection: document.getElementById('milestone-modal-geo-section'),
      geo: document.getElementById('milestone-modal-geo'),
      descSection: document.getElementById('milestone-modal-desc-section'),
      desc: document.getElementById('milestone-modal-description'),
      close: document.getElementById('milestone-modal-close'),
    };
    return modalElements;
  }

  function setupModalEventListeners() {
    const { modal, close } = getModalElements();
    if (!modal) return;

    modalKeyHandler = e => {
      if (e.key === 'Escape' && modal.classList.contains('open')) closeMilestoneModal();
    };
    document.addEventListener('keydown', modalKeyHandler);

    modalClickHandler = e => {
      if (e.target === modal) closeMilestoneModal();
    };
    modal.addEventListener('click', modalClickHandler);

    if (close) {
      close.addEventListener('click', closeMilestoneModal);
    }
  }

  function removeModalEventListeners() {
    const { modal, close } = getModalElements();
    if (modalKeyHandler) document.removeEventListener('keydown', modalKeyHandler);
    if (modalClickHandler && modal) modal.removeEventListener('click', modalClickHandler);
    if (close) close.removeEventListener('click', closeMilestoneModal);
    modalKeyHandler = null;
    modalClickHandler = null;
  }

  function getCategoryConfig(milestone) {
    const rawKey = milestone.category_key || milestone.category;
    const key = String(rawKey).toLowerCase().replace(/\s+/g, '_').replace(/&/g, '');
    return CATEGORY_CONFIG[key] || { icon: '📌', color: '#00d4ff' };
  }

  function openMilestoneModal(milestone) {
    const { modal, title, icon, value, unit, source, date, geoSection, geo, descSection, desc, close } = getModalElements();
    if (!modal) return;

    const config = getCategoryConfig(milestone);

    title.textContent = milestone.title || 'Untitled';
    icon.textContent = milestone.icon || config.icon;
    icon.style.background = config.color + '22';
    value.textContent = milestoneValueText(milestone);
    unit.textContent = milestone.unit || '';
    date.textContent = milestone.date || '—';

    source.replaceChildren();
    if (milestone.source) {
      const sourceLabel = createEl('span', '', milestone.source);
      source.appendChild(sourceLabel);
    }
    if (milestone.url && /^https?:\/\//i.test(milestone.url)) {
      const link = createEl('a', '', 'Open source ↗');
      link.href = milestone.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.referrerPolicy = 'no-referrer';
      source.appendChild(link);
    }

    if (milestone.geolocation && typeof milestone.geolocation.lat === 'number' && typeof milestone.geolocation.lon === 'number') {
      geoSection.style.display = 'block';
      geo.textContent = `📍 ${milestone.geolocation.lat.toFixed(2)}, ${milestone.geolocation.lon.toFixed(2)}`;
    } else {
      geoSection.style.display = 'none';
    }

    if (milestone.description) {
      descSection.style.display = 'block';
      desc.textContent = milestone.description;
    } else {
      descSection.style.display = 'none';
    }

    const wasOpen = modal.classList.contains('open');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    // Focus management
    const focusable = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable.length) focusable[0].focus();

    // Trap focus (only add listener if modal wasn't already open)
    modal._focusable = focusable;
    modal._firstFocusable = focusable[0];
    modal._lastFocusable = focusable[focusable.length - 1];
    if (!wasOpen) {
      modal.addEventListener('keydown', trapFocus);
    }
  }

  function trapFocus(e) {
    if (e.key !== 'Tab') return;
    const { modal } = getModalElements();
    if (!modal || !modal.classList.contains('open')) return;

    const { _firstFocusable, _lastFocusable } = modal;
    if (e.shiftKey) {
      if (document.activeElement === _firstFocusable) {
        e.preventDefault();
        _lastFocusable?.focus();
      }
    } else {
      if (document.activeElement === _lastFocusable) {
        e.preventDefault();
        _firstFocusable?.focus();
      }
    }
  }

  function closeMilestoneModal() {
    const { modal } = getModalElements();
    if (!modal) return;

    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    modal.removeEventListener('keydown', trapFocus);
    delete modal._focusable;
    delete modal._firstFocusable;
    delete modal._lastFocusable;
  }

  // Initialize modal event listeners when DOM is ready (idempotent)
  function initModal() {
    removeModalEventListeners();
    setupModalEventListeners();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initModal, { once: true });
  } else {
    initModal();
  }

  // ---- Shared milestone data cache ----
  let milestonesCache = null;
  let milestonesCachePromise = null;
  let historyCachePromise = null;
  let fetchAbortControllers = [];

  function abortAllFetches() {
    fetchAbortControllers.forEach(ac => ac.abort());
    fetchAbortControllers = [];
  }

  async function fetchJSON(url, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ac = new AbortController();
      fetchAbortControllers.push(ac);
      try {
        const r = await fetch(url, { cache: 'no-store', signal: ac.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        if (e.name === 'AbortError') return null;
        if (attempt === retries) {
          console.error(`[dashboard] fetchJSON failed for ${url}:`, e);
          return null;
        }
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      } finally {
        const idx = fetchAbortControllers.indexOf(ac);
        if (idx >= 0) fetchAbortControllers.splice(idx, 1);
      }
    }
    return null;
  }

  async function getHistoryData() {
    if (!historyCachePromise) {
      historyCachePromise = fetchJSON('/data/milestones_history.json');
    }
    return historyCachePromise;
  }
  async function getMilestonesData() {
    if (milestonesCache) return milestonesCache;
    if (!milestonesCachePromise) {
      milestonesCachePromise = fetchJSON('/data/milestones.json').then(data => {
        milestonesCache = data;
        return data;
      });
    }
    return milestonesCachePromise;
  }

// ---- Adaptive timeline chart -------------------------------------------------
  // One renderer, used by both timeline frames (milestones and tactical layers).
  //
  // This exists because the chart was out of bounds. activity.json publishes one
  // bucket per month since 1945 - 976 columns - and the stylesheet lays the bars
  // out in a flex row with `min-width: 8px` and a 3px gap. That is ~10,700px of
  // bars in a container under 1,000px wide, so the chart ran off the page and off
  // the document. The overflow was in the data's favour and the layout's
  // disfavour, and neither was going to give.
  //
  // The fix is to stop publishing a fixed granularity to a fixed-width frame:
  // pick the coarsest bucket that still fits the measured width, and re-pick when
  // the width changes. A chart that has to be aggregated to be readable is also
  // a chart whose zero-bars have to be honest, so buckets are generated
  // contiguously from the first record to the last - a gap is drawn as a gap
  // rather than silently closed up.
  const CHART_MIN_COL_PX = 9;   // bar + gap, the narrowest a column may become
  const CHART_MAX_COLUMNS = 160; // never more than this many columns, however wide
  const CHART_MIN_HEIGHT_PX = 4;

  // Ordered coarsest-last, so `find` picks the finest bucket that fits.
  const CHART_BUCKETS = ['day', 'week', 'month', 'quarter', 'year', 'decade'];
  const CHART_BUCKET_LABEL = {
    day: 'per day', week: 'per week', month: 'per month',
    quarter: 'per quarter', year: 'per year', decade: 'per decade',
  };

  function pad2(n) { return String(n).padStart(2, '0'); }

  // Bucket key + a human label for one ISO date at a given granularity.
  function chartBucket(iso, size) {
    const y = parseInt(iso.slice(0, 4), 10);
    const m = parseInt(iso.slice(5, 7), 10);
    const d = parseInt(iso.slice(8, 10), 10);
    switch (size) {
      case 'day':
        return { key: iso, label: iso.slice(5), title: iso };
      case 'week': {
        // ISO week, Monday-start, labelled by the Monday of that week.
        const dt = new Date(Date.UTC(y, m - 1, d));
        const dow = (dt.getUTCDay() + 6) % 7;
        dt.setUTCDate(dt.getUTCDate() - dow);
        const k = dt.toISOString().slice(0, 10);
        return { key: k, label: k.slice(5), title: 'Week of ' + k };
      }
      case 'month':
        return { key: `${y}-${pad2(m)}`, label: `${pad2(m)}/${String(y).slice(2)}`, title: `${y}-${pad2(m)}` };
      case 'quarter':
        return { key: `${y}-Q${Math.floor((m - 1) / 3) + 1}`, label: `Q${Math.floor((m - 1) / 3) + 1} ${String(y).slice(2)}`, title: `Q${Math.floor((m - 1) / 3) + 1} ${y}` };
      case 'year':
        return { key: String(y), label: String(y), title: String(y) };
      case 'decade': {
        const base = Math.floor(y / 10) * 10;
        return { key: `${base}s`, label: `${base}s`, title: `${base}-${base + 9}` };
      }
      default:
        return { key: iso, label: iso.slice(5), title: iso };
    }
  }

// Step one bucket forward, so a contiguous run can be generated without a
// scanning every candidate granularity.
//
// Each key format is parsed by its OWN scheme rather than by slicing the key at
// fixed offsets. Quarter keys are "YYYY-Qn" - a slice at 5..7 yields "Q4", which
// parses as NaN, and the increment then produced keys like "2025-NaN" and spun to
// the guard without ever reaching the last bucket. Reading the format the same
// way it is written is the only version that cannot drift from it.
function nextChartBucket(key, size) {
  switch (size) {
    case 'day': {
      const [y, m, d] = key.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d + 1));
      return dt.toISOString().slice(0, 10);
    }
    case 'week': {
      const dt = new Date(key + 'T00:00:00Z');
      dt.setUTCDate(dt.getUTCDate() + 7);
      return dt.toISOString().slice(0, 10);
    }
    case 'month': {
      const [y, m] = key.split('-').map(Number);
      return m === 12 ? `${y + 1}-01` : `${y}-${pad2(m + 1)}`;
    }
    case 'quarter': {
      const qm = key.match(/^(\d{4})-Q([1-4])$/);
      if (!qm) return key;
      const y = Number(qm[1]);
      const q = Number(qm[2]);
      return q === 4 ? `${y + 1}-01` : `${y}-${pad2((q - 1) * 3 + 4)}`;
    }
    case 'year': {
      const y = parseInt(key, 10);
      return Number.isFinite(y) ? String(y + 1) : key;
    }
    case 'decade': {
      const y = parseInt(key, 10);
      return Number.isFinite(y) ? `${y + 10}s` : key;
    }
    default:
      return key;
  }
}

  // Contiguous buckets from the first record to the last, with counts filled in.
  // `records` is [{date, count}]; a count may be absent (treat as 1) so the same
  // function serves a count series and a plain list of dated records.
  function bucketCounts(records, size) {
    const counts = new Map();
    let first = null;
    let last = null;
    for (const r of records) {
      if (!r || typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
      const { key } = chartBucket(r.date, size);
      const n = Number.isFinite(r.count) ? r.count : 1;
      counts.set(key, (counts.get(key) || 0) + n);
      if (first === null || r.date < first) first = r.date;
      if (last === null || r.date > last) last = r.date;
    }
    if (first === null || last === null) return [];

    const out = [];
    let key = chartBucket(first, size).key;
    // Hard cap on the number of columns a single run may generate, so a corrupt
    // date (year 9999) cannot spin this into a multi-million-iteration loop.
    for (let guard = 0; guard < CHART_MAX_COLUMNS * 40; guard++) {
      const meta = chartBucket(key.length === 4 ? `${key}-01-01` : key, size);
      out.push({ key, label: meta.label, title: meta.title, count: counts.get(key) || 0 });
      if (key === chartBucket(last, size).key) break;
      key = nextChartBucket(key, size);
    }
    return out;
  }

  // How many columns fit in `width` px at the chart's own minimum column width.
  function chartColumnBudget(width) {
    const usable = Math.max(120, Math.floor(width || 0));
    return Math.max(6, Math.min(CHART_MAX_COLUMNS, Math.floor(usable / CHART_MIN_COL_PX)));
  }

  // The finest bucket whose column count fits, coarsening until it does.
  function chooseChartBucket(records, width) {
    const budget = chartColumnBudget(width);
    let chosen = CHART_BUCKETS[CHART_BUCKETS.length - 1];
    let buckets = [];
    for (const size of CHART_BUCKETS) {
      const candidate = bucketCounts(records, size);
      // A series that collapses to one column conveys nothing; keep looking for a
      // finer one until there is something to see.
      if (candidate.length > 1 && candidate.length <= budget) {
        return { size, buckets: candidate };
      }
      if (candidate.length > 1) { chosen = size; buckets = candidate; }
      if (candidate.length <= budget) break;
    }
    return { size: chosen, buckets };
  }

  /**
   * Render one timeline frame.
   *
   * `opts`: { bars, labels, records, width, unitNoun, onBucketClick }
   * Returns the chosen bucket size so the caller can label the heading.
   */
  function renderTimelineChart(opts) {
    const { bars, labels, records, width } = opts;
    if (!bars || !labels) return 'month';
    const { size, buckets } = chooseChartBucket(records || [], width);
    const max = Math.max(1, ...buckets.map((b) => b.count));
    const plural = (n) => `${n} ${opts.unitNoun || 'record'}${n === 1 ? '' : 's'}`;

    const barsFrag = document.createDocumentFragment();
    const labelsFrag = document.createDocumentFragment();
    // One label per ~6 columns, plus always the last, so the axis is readable
    // without the text turning into a smear of overlapping dates.
    const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));

    buckets.forEach((b, i) => {
      const bar = document.createElement('div');
      bar.className = 'chart-bar' + (b.count > 0 ? '' : ' chart-bar--empty');
      bar.style.height = (CHART_MIN_HEIGHT_PX + (b.count / max) * (CHART_BAR_MAX_PX - CHART_MIN_HEIGHT_PX)) + 'px';
      bar.title = `${b.title}: ${plural(b.count)}`;
      bar.dataset.bucket = b.key;
      if (opts.onBucketClick) bar.addEventListener('click', () => opts.onBucketClick(b));
      barsFrag.appendChild(bar);

      const lbl = document.createElement('div');
      lbl.className = 'chart-label';
      lbl.textContent = (i % labelEvery === 0 || i === buckets.length - 1) ? b.label : '';
      labelsFrag.appendChild(lbl);
    });

    bars.replaceChildren(barsFrag);
    labels.replaceChildren(labelsFrag);
    // Published so CSS and the resize handler can both see the granularity; the
    // frame is 1.2.0-shaped without it and the heading would otherwise have to
    // hardcode a granularity it no longer knows.
    bars.dataset.bucket = size;
    bars.dataset.columns = String(buckets.length);
    return size;
  }

  const CHART_BAR_MAX_PX = 116;

  // ---- Milestones timeline ---------------------------------------------------
  // Series is built from the archive's dated records rather than from
  // activity.json's pre-bucketed months. The archive is the same 110 records the
  // catalog shows, it carries real dates, and building from it means the chart
  // can be per-day inside a year instead of inheriting a granularity chosen
  // months ago by a different process.
  async function loadActivity() {
    const bars = document.getElementById('activity-bars');
    const labels = document.getElementById('activity-labels');
    const yearFilter = document.getElementById('activity-year-filter');
    const heading = document.getElementById('activity-bucket-note');
    if (!bars || !labels) return;

    bars.replaceChildren(...Array.from({ length: 24 }, () => createEl('div', 'chart-bar skeleton', '')));
    labels.replaceChildren(createEl('div', 'chart-label', 'loading…'));

    const [activity, history] = await Promise.all([
      fetchJSON('/data/activity.json'),
      getHistoryData(),
    ]);

    const records = (history || [])
      .map((r) => ({ date: parseDateToISO(r.date), count: 1 }))
      .filter((r) => r.date);
    // No archive is a broken feed, not an empty dataset: say so rather than
    // drawing a flat zero chart that reads as "no progress".
    if (records.length === 0) {
      bars.replaceChildren(createEl('p', 'chart-empty', 'Milestone history is unavailable right now.'));
      labels.replaceChildren();
      return;
    }

    const years = [...new Set(records.map((r) => r.date.slice(0, 4)))]
      .filter((y) => /^\d{4}$/.test(y))
      .sort((a, b) => b - a);
    if (yearFilter) {
      yearFilter.replaceChildren();
      const all = createEl('option', '', 'All years');
      all.value = 'all';
      yearFilter.appendChild(all);
      years.forEach((y) => {
        const o = createEl('option', '', y);
        o.value = y;
        yearFilter.appendChild(o);
      });
    }

    let currentYearFilter = 'all';
    function series() {
      return currentYearFilter === 'all'
        ? records
        : records.filter((r) => r.date.startsWith(currentYearFilter));
    }
    function draw() {
      const subset = series();
      const size = renderTimelineChart({
        bars, labels, records: subset, unitNoun: 'milestone',
        width: bars.clientWidth || bars.parentElement?.clientWidth || 0,
      });
      if (heading) {
        heading.textContent = CHART_BUCKET_LABEL[size] || '';
      }
    }

    if (yearFilter) yearFilter.addEventListener('change', (e) => {
      currentYearFilter = e.target.value;
      draw();
    });
    draw();

    const ts = document.getElementById('activity-update-time');
    if (ts) {
      ts.textContent = activity && activity.last_update
        ? ` (updated ${activity.last_update})`
        : ' (archive)';
    }

    // Staleness banner: newest milestone DATE across the archive vs today.
    const stale = computeStaleness(history || [], todayISO());
    const staleEl = document.getElementById('activity-staleness');
    if (staleEl && stale.maxDate) {
      if (stale.days === null) {
        staleEl.hidden = true;
      } else if (stale.days > 3) {
        staleEl.textContent = `No new milestones since ${stale.maxDate} (${stale.days} days ago) — scraping or extraction may have stalled upstream.`;
        staleEl.hidden = false;
      } else {
        staleEl.textContent = `Latest milestone recorded on ${stale.maxDate}.`;
        staleEl.hidden = false;
      }
    }

    // Re-aggregate when the frame changes width: the bucket size is chosen from
    // the measured width, so without this a chart chosen for a desktop frame
    // would keep its granularity (and its 160 columns) on a phone.
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => draw());
      ro.observe(bars);
      timelineResizeObservers.push(ro);
    } else {
      window.addEventListener('resize', draw);
    }
  }

  // ---- Tactical layers timeline ---------------------------------------------
  // A second frame over the operational layers, built from world_layers.json -
  // the same payload the map draws. Every layer entry carries a `start_date`, so
  // "when did this layer change" is answerable without a new pipeline, and
  // answering it next to the milestone timeline is the point: the milestone chart
  // says what was achieved, this one says what was deployed, and a reader can see
  // at a glance whether the two move together.
  //
  // End dates count as a change too: a concluded zone is a datapoint on the day it
  // ended, not only on the day it began. Counting only starts would make the
  // series fall away exactly when things were resolving.
  function tacticalRecords(layers) {
    const out = [];
    const add = (list) => (list || []).forEach((item) => {
      const start = parseDateToISO(normalizeLayerDate(item.start_date));
      if (start) out.push({ date: start, count: 1 });
      const end = parseDateToISO(normalizeLayerDate(item.end_date));
      if (end && end !== start) out.push({ date: end, count: 1 });
    });
    add(layers.conflict_zones);
    add(layers.crisis_zones);
    add(layers.deployments);
    add(layers.alliance_dots);
    add(layers.human_rights_violations);
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  async function loadTacticalTimeline() {
    const bars = document.getElementById('tactical-bars');
    const labels = document.getElementById('tactical-labels');
    const heading = document.getElementById('tactical-bucket-note');
    const total = document.getElementById('tactical-total');
    if (!bars || !labels) return;

    const data = await fetchJSON('/data/world_layers.json');
    if (!data) {
      bars.replaceChildren(createEl('p', 'chart-empty', 'Operational layer data is unavailable right now.'));
      labels.replaceChildren();
      return;
    }
    const records = tacticalRecords(data);
    if (records.length === 0) {
      bars.replaceChildren(createEl('p', 'chart-empty', 'No dated operational layer changes published yet.'));
      labels.replaceChildren();
      return;
    }
    if (total) {
      const sum = records.length;
      const span = `${records[0].date} → ${records[records.length - 1].date}`;
      total.textContent = `${sum} dated layer change${sum === 1 ? '' : 's'} · ${span}`;
    }

    function draw() {
      const size = renderTimelineChart({
        bars, labels, records, unitNoun: 'layer change',
        width: bars.clientWidth || bars.parentElement?.clientWidth || 0,
      });
      if (heading) heading.textContent = CHART_BUCKET_LABEL[size] || '';
    }
    draw();
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => draw());
      ro.observe(bars);
      timelineResizeObservers.push(ro);
    } else {
      window.addEventListener('resize', draw);
    }
  }
  // Per-metric timeline: pick one metric and see its full history, so a broken
  // or stale metric is easy to trace back to the beginning of scraping.
  async function loadMetricTimeline() {
    const sel = document.getElementById('metric-select');
    const list = document.getElementById('metric-timeline-list');
    const sparkEl = document.getElementById('metric-sparkline');
    const staleEl = document.getElementById('metric-staleness');
    const yearFilter = document.getElementById('metric-year-filter');
    if (!sel || !list) return;

    const history = await getHistoryData();
    const options = buildMetricOptionList(history || [], todayISO());
    const optFrag = document.createDocumentFragment();
    options.forEach(opt => {
      const o = createEl('option', '', opt.label);
      o.value = opt.value;
      optFrag.appendChild(o);
    });
    sel.appendChild(optFrag);

    let currentYearFilter = 'all';

    // Populate year filter based on selected metric
    function populateYearFilter(opt) {
      if (!yearFilter) return;
      const years = new Set();
      opt.records.forEach(rec => {
        if (rec.date && rec.date.match(/^\d{4}-\d{2}-\d{2}$/)) {
          years.add(rec.date.slice(0, 4));
        }
      });
      const sortedYears = Array.from(years).sort((a, b) => b - a);
      yearFilter.innerHTML = '<option value="all">All years</option>';
      sortedYears.forEach(y => {
        const opt = createEl('option', '', y);
        opt.value = y;
        yearFilter.appendChild(opt);
      });
      yearFilter.value = 'all';
      currentYearFilter = 'all';
    }

    function filterRecordsByYear(records, year) {
      if (year === 'all') return records;
      return records.filter(rec => rec.date && rec.date.startsWith(year));
    }

    function render() {
      const key = sel.value;
      list.replaceChildren();
      if (sparkEl) sparkEl.hidden = true;
      if (staleEl) staleEl.hidden = true;
      if (!key) {
        if (yearFilter) yearFilter.innerHTML = '<option value="all">All years</option>';
        return;
      }

      const opt = options.find(o => o.value === key);
      if (!opt) return;

      // Populate year filter for this metric
      populateYearFilter(opt);

      if (staleEl && opt.staleDays !== null && opt.staleDays > 3) {
        staleEl.textContent = `No new ${key} record since ${opt.newestDate} (${opt.staleDays} days ago).`;
        staleEl.hidden = false;
      }

      const filteredRecords = filterRecordsByYear(opt.records, currentYearFilter);

      if (sparkEl) {
        const counts = metricCountsByDate(filteredRecords);
        const sMax = Math.max(1, ...counts.map(c => c.count));
        const sparkFrag = document.createDocumentFragment();
        counts.forEach(c => {
          const b = createEl('div', 'metric-spark-bar');
          b.title = `${c.date}: ${c.count}`;
          b.style.height = (2 + (c.count / sMax) * 26) + 'px';
          sparkFrag.appendChild(b);
        });
        sparkEl.replaceChildren(sparkFrag);
        sparkEl.hidden = false;
      }

      const listFrag = document.createDocumentFragment();
      filteredRecords.forEach(rec => {
        const li = createEl('li', 'metric-timeline-item');
        const dateEl = createEl('span', 'metric-timeline-date', rec.date);
        const titleEl = createEl('a', 'metric-timeline-title', rec.title || 'Untitled');
        if (rec.url) {
          titleEl.href = rec.url;
          titleEl.target = '_blank';
          titleEl.rel = 'noopener noreferrer';
        }
        li.appendChild(dateEl);
        li.appendChild(titleEl);
        const val = `${rec.value ?? ''} ${rec.unit ?? ''}`.trim();
        if (val) {
          const vEl = createEl('span', 'metric-timeline-value', val);
          li.appendChild(vEl);
        }
        if (rec.source) {
          li.appendChild(createEl('span', 'metric-timeline-source', rec.source));
        }
        listFrag.appendChild(li);
      });
      list.replaceChildren(listFrag);
    }

    sel.addEventListener('change', render);
    if (yearFilter) {
      yearFilter.addEventListener('change', e => {
        currentYearFilter = e.target.value;
        render();
      });
    }
    render();
  }

  function generateSampleActivity() {
    const today = new Date();
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const dow = d.getDay();
      const base = [3, 5, 8, 12, 14, 9, 6][dow];
      const noise = Math.floor(Math.random() * 6);
      days.push({ date: d.toISOString().slice(0, 10), count: base + noise });
    }
    return days;
  }

  // Newest milestones across all categories, flattened from the site-format
  // categories container (milestones.json has no top-level "recent" key).
  function recentMilestones(data, n = 8) {
    if (!data || !data.categories) return null;
    const out = [];
    for (const [catKey, catData] of Object.entries(data.categories)) {
      const config = CATEGORY_CONFIG[catKey] || {};
      (catData.milestones || []).forEach(m => {
        out.push({
          ...m,
          category: m.category || catData.name || config.name || catKey,
          category_key: catKey,
          category_name: catData.name || config.name || catKey,
          icon: m.icon || config.icon || '📌',
          // A two-tone category carries a sub-tone on the record (written by
          // sync_milestones.classify_tone). Surface it so a card can be tinted with
          // the darker colour instead of pretending every biohacking milestone is
          // plain biotech.
          tone: m.tone || null,
          tone_color: (m.tone && SUBCATEGORY_CONFIG[m.tone])
            ? SUBCATEGORY_CONFIG[m.tone].color
            : null,
        });
      });
    }
    if (!out.length) return null;
    out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    return out.slice(0, n);
  }

  // Milestone cards (top 8 of "all")
  async function loadTopMilestones() {
    const grid = document.getElementById('top-milestones');
    if (!grid) return;

    // Show skeleton cards while loading
    grid.replaceChildren(...Array.from({ length: 8 }, () => createSkeletonCard('milestone-card skeleton-card')));

    const data = await getMilestonesData();
    const items = recentMilestones(data) || SAMPLE_MILESTONES;
    const frag = document.createDocumentFragment();
    items.slice(0, 8).forEach(function(m) {
      const card = createEl('div');
      card.className = 'milestone-card milestone-card-interactive';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `View details for ${m.title || 'milestone'}`);

      const header = createEl('div', 'milestone-card-header');
      const icon = createEl('div', 'milestone-card-icon', m.icon || '\u{1F4CC}');
      icon.setAttribute('aria-hidden', 'true');
      const cat = createEl('span', 'milestone-card-category', m.category || '');
      header.appendChild(icon);
      header.appendChild(cat);
      // Two-tone categories show a second swatch beside the icon, so a biohacking
      // card is distinguishable from a biotech one without opening it.
      if (m.tone && m.tone_color) {
        const toneSwatch = createEl('span', 'milestone-card-tone');
        toneSwatch.style.background = m.tone_color;
        toneSwatch.title = m.tone;
        toneSwatch.setAttribute('aria-label', m.tone);
        header.appendChild(toneSwatch);
      }

      const titleEl = createEl('h3', '', m.title || '');
      const valueEl = createEl('div', 'milestone-card-value', milestoneValueText(m));
      const cardNum = numericMilestoneValue(m);
      if (cardNum !== null) valueEl.dataset.counter = cardNum;
      const unitEl = createEl('div', 'milestone-card-unit', m.unit || '');

      const meta = createEl('div', 'milestone-card-meta');
      const src = createEl('span', '', m.source || '\u2014');
      const dot = createEl('span', '', '\u00B7');
      const date = createEl('span', '', m.date || '');
      meta.appendChild(src);
      meta.appendChild(dot);
      meta.appendChild(date);

      card.appendChild(header);
      card.appendChild(titleEl);
      card.appendChild(valueEl);
      card.appendChild(unitEl);
      card.appendChild(meta);

      if (m.is_new) {
        const badge = createEl('span', 'milestone-card-new');
        badge.title = 'New this week';
        card.appendChild(badge);
      }

      card.addEventListener('click', () => openMilestoneModal(m));
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openMilestoneModal(m);
        }
      });

      frag.appendChild(card);
    });

    grid.replaceChildren(frag);

    grid.querySelectorAll('[data-counter]').forEach(el => {
      const target = parseFloat(el.dataset.counter);
      if (!isNaN(target)) animateCounter(el, target, { integer: Number.isInteger(target) });
    });
  }

  // Category Toggle — expandable milestone lists
  async function initCategoryToggles() {
    const toggles = document.querySelectorAll('.category-toggle');
    if (!toggles.length) return;

    const data = await getMilestonesData();
    if (!data || !data.categories) return;

    toggles.forEach(btn => {
      const catKey = btn.dataset.category;
      const catData = data.categories[catKey];
      // A category can exist on the map and still have no tracked milestones yet.
      // Rendering its card anyway would leave the hardcoded placeholder count in the
      // markup and an expand control that opens onto nothing - so the card is hidden
      // instead, and comes back on its own the first time the scraper files a
      // milestone under it. Covers both "no such category" and "category is empty".
      if (!catData || !catData.milestones || !catData.milestones.length) {
        btn.style.display = 'none';
        return;
      }

      const milestonesContainer = btn.querySelector('.category-milestones');
      const indicator = btn.querySelector('.category-expand-indicator .expand-arrow');
      const countSpan = btn.querySelector('.category-expand-indicator span');
      if (countSpan) countSpan.textContent = `${catData.milestones.length} milestone${catData.milestones.length !== 1 ? 's' : ''}`;

      let hasRendered = false;

      function renderMilestones() {
        if (!milestonesContainer || hasRendered) return;
        const config = CATEGORY_CONFIG[catKey] || { icon: '📌', color: '#00d4ff' };
        const beatenMap = findBeatenMilestones(catData.milestones || []);
        const frag = document.createDocumentFragment();
        (catData.milestones || []).forEach(m => {
          const isBeaten = beatenMap.has(m.id);
          const item = createEl('div', 'category-milestone-item');
          item.style.cssText = 'animation: slideDown 0.3s ease;';
          if (isBeaten) item.classList.add('category-milestone-beaten');

          const info = createEl('div', 'category-milestone-info');
          const iconSpan = createEl('span', 'icon', config.icon);
          const details = createEl('div', 'category-milestone-details');
          const title = createEl('div', 'category-milestone-title', m.title);
          if (isBeaten) title.classList.add('beaten-title');
          const meta = createEl('div', 'category-milestone-meta');
          const sourceSpan = createEl('span', '', m.source);
          const dotSpan = createEl('span', '', ' · ');
          const dateSpan = createEl('span', '', m.date);
          meta.appendChild(sourceSpan);
          meta.appendChild(dotSpan);
          meta.appendChild(dateSpan);
          if (m.geolocation && typeof m.geolocation.lat === 'number' && typeof m.geolocation.lon === 'number') {
            const geoSpan = createEl('span', '', ` · 📍 ${m.geolocation.lat.toFixed(2)}, ${m.geolocation.lon.toFixed(2)}`);
            meta.appendChild(geoSpan);
          }
          details.appendChild(title);
          details.appendChild(meta);
          info.appendChild(iconSpan);
          info.appendChild(details);

          const valueDiv = createEl('div', 'category-milestone-value');
          const valEl = createEl('span', 'value', milestoneValueText(m));
          const catNum = numericMilestoneValue(m);
          if (catNum !== null) valEl.dataset.counter = catNum;
          const unitEl = createEl('span', 'unit', m.unit);
          valueDiv.appendChild(valEl);
          valueDiv.appendChild(unitEl);

          if (isBeaten) {
            const newer = beatenMap.get(m.id);
            const beatenBadge = createEl('div', 'category-milestone-beaten-badge');
            const arrow = createEl('span', '', '⤴ ');
            const label = createEl('span', '', 'Superseded by ');
            const link = createEl('a', '', newer.title);
            link.href = newer.url || '#';
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.style.cssText = 'color:var(--orange);font-weight:600;text-decoration:none;';
            const beatVal = milestoneMetricText(newer);
            beatenBadge.append(arrow, label, link);
            if (beatVal) {
              beatenBadge.appendChild(createEl('span', '', ` (${beatVal})`));
            }
            item.appendChild(beatenBadge);
          }

          if (m.is_new) {
            const badge = createEl('span', 'category-milestone-new-badge');
            badge.title = 'New this week';
            item.appendChild(badge);
          }

          item.appendChild(info);
          item.appendChild(valueDiv);
          frag.appendChild(item);

          const target = parseFloat(valEl.dataset.counter);
          if (!isNaN(target)) animateCounter(valEl, target, { integer: Number.isInteger(target) });
        });
        milestonesContainer.replaceChildren(frag);
        hasRendered = true;
      }

      // Keyboard accessibility
      btn.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          btn.click();
        }
      });

      btn.addEventListener('click', () => {
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', !expanded);
        if (indicator) indicator.style.transform = expanded ? 'rotate(0deg)' : 'rotate(180deg)';
        if (milestonesContainer && !expanded) renderMilestones();
        // CSS handles display via aria-expanded attribute
      });
    });
  }

  // Milestones Catalog (all milestones)
  async function loadMilestonesCatalog() {
    const grid = document.getElementById('catalog-grid');
    const filter = document.getElementById('catalog-category-filter');
    const countEl = document.getElementById('catalog-count');
    const yearFilter = document.getElementById('catalog-year-filter');
    const yearPrevBtn = document.getElementById('catalog-year-prev');
    const yearNextBtn = document.getElementById('catalog-year-next');
    if (!grid) return;

    // Show skeleton cards while loading
    grid.replaceChildren(...Array.from({ length: 12 }, () => createSkeletonCard('catalog-card skeleton-card')));

    const data = await getMilestonesData();
    if (!data || !data.categories) {
      grid.replaceChildren(createEl('p', '', 'No milestone data available'));
      grid.firstElementChild.style.cssText = 'color: var(--fg-muted); text-align: center; padding: 40px; width: 100%;';
      return;
    }

    // Flatten all milestones
    let allMilestones = [];
    for (const [catKey, catData] of Object.entries(data.categories)) {
      (catData.milestones || []).forEach(m => {
        allMilestones.push({
          ...m,
          category_key: catKey,
          category_name: catData.name,
          category_icon: catData.icon,
          category_color: catData.color
        });
      });
    }

    // Compute beaten milestones across all categories (by subcategory within category)
    const beatenMapAll = new Map();
    for (const [catKey, catData] of Object.entries(data.categories)) {
      const beaten = findBeatenMilestones(catData.milestones || []);
      beaten.forEach((newer, olderId) => beatenMapAll.set(olderId, newer));
    }

    // Sort by date descending (newest first)
    allMilestones.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Determine available years from milestone data
    const yearsSet = new Set();
    allMilestones.forEach(m => {
      const d = m.date && m.date.slice(0, 4);
      if (d && /^\d{4}$/.test(d)) yearsSet.add(parseInt(d, 10));
    });
    const availableYears = Array.from(yearsSet).sort((a, b) => b - a);
    const currentYear = new Date().getFullYear();

    // Find the best year to display: current year if it has milestones,
    // otherwise fall back to the most recent past year that has milestones.
    let displayYear = currentYear;
    if (!availableYears.includes(currentYear)) {
      const pastYears = availableYears.filter(y => y < currentYear);
      if (pastYears.length > 0) {
        displayYear = pastYears[0]; // most recent past year with milestones
      } else if (availableYears.length > 0) {
        displayYear = availableYears[0];
      }
    }

    // Build year filter options
    if (yearFilter) {
      yearFilter.innerHTML = '';
      availableYears.forEach(y => {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = y;
        if (y === displayYear) opt.selected = true;
        yearFilter.appendChild(opt);
      });
      // Add "All years" option at the end
      const allOpt = document.createElement('option');
      allOpt.value = 'all';
      allOpt.textContent = 'All years';
      yearFilter.appendChild(allOpt);
    }

    const CATALOG_PAGE_SIZE = 250;
    let allYearsPage = 1;

    function render(filterKey, year) {
      const targetYear = year !== undefined ? year : displayYear;
      let filtered = filterKey === 'all'
        ? allMilestones
        : allMilestones.filter(m => m.category_key === filterKey);

      // Filter by year if not 'all'
      if (year !== 'all') {
        const y = String(year);
        filtered = filtered.filter(m => m.date && m.date.startsWith(y));
      }

      if (countEl) countEl.textContent = `${filtered.length} milestone${filtered.length !== 1 ? 's' : ''}`;

      if (filtered.length === 0) {
        grid.replaceChildren(createEl('p', '', 'No milestones in this category/year'));
        grid.firstElementChild.style.cssText = 'color: var(--fg-muted); text-align: center; padding: 40px; width: 100%;';
        return;
      }

      const isAllYears = year === 'all';
      const visibleCount = isAllYears ? Math.min(filtered.length, allYearsPage * CATALOG_PAGE_SIZE) : filtered.length;
      const visible = filtered.slice(0, visibleCount);

      const frag = document.createDocumentFragment();
      visible.forEach(m => {
        const isBeaten = beatenMapAll.has(m.id);
        const catConfig = CATEGORY_CONFIG[m.category_key] || { name: m.category_name, icon: '📌', color: '#00d4ff' };

        const card = createEl('div', 'catalog-card');
        card.style.setProperty('--catalog-accent', catConfig.color);
        card.style.setProperty('--catalog-accent-alpha', catConfig.color + '33');
        if (isBeaten) card.classList.add('catalog-card-beaten');

        const header = createEl('div', 'catalog-card__header');

        const left = createEl('div', 'catalog-card__left');
        const icon = createEl('span', 'catalog-card__icon', catConfig.icon);
        const catInfo = createEl('div', 'catalog-card__cat-info');
        const catName = createEl('div', 'catalog-card__cat-name', catConfig.name);
        catName.style.color = catConfig.color;
        const title = createEl('h4', 'catalog-card__title', m.title);
        catInfo.appendChild(catName);
        catInfo.appendChild(title);
        left.appendChild(icon);
        left.appendChild(catInfo);

        const right = createEl('div', 'catalog-card__right');
        const valueEl = createEl('div', 'catalog-card__value', milestoneValueText(m));
        valueEl.style.color = catConfig.color;
        const catNum = numericMilestoneValue(m);
        if (catNum !== null) valueEl.dataset.counter = catNum;
        const unitEl = createEl('div', 'catalog-card__unit', m.unit);
        right.appendChild(valueEl);
        right.appendChild(unitEl);

        header.appendChild(left);
        header.appendChild(right);
        card.appendChild(header);

        const meta = createEl('div', 'catalog-card__meta');
        const sourceSpan = createEl('span', '', m.source);
        const dotSpan = createEl('span', '', ' · ');
        const dateSpan = createEl('span', '', m.date);
        meta.appendChild(sourceSpan);
        meta.appendChild(dotSpan);
        meta.appendChild(dateSpan);
        if (m.geolocation && typeof m.geolocation.lat === 'number' && typeof m.geolocation.lon === 'number') {
          const geoSpan = createEl('span', '', ` · 📍 ${m.geolocation.lat.toFixed(2)}, ${m.geolocation.lon.toFixed(2)}`);
          meta.appendChild(geoSpan);
        }
        card.appendChild(meta);

        if (isBeaten) {
          const newer = beatenMapAll.get(m.id);
          const beatenBadge = createEl('div', 'catalog-card__beaten-badge');
          const arrow = createEl('span', '', '⤴ ');
          const label = createEl('span', '', 'Superseded by ');
          const link = createEl('a', '', newer.title);
          link.href = newer.url || '#';
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          const beatVal = milestoneMetricText(newer);
          beatenBadge.append(arrow, label, link);
          if (beatVal) {
            beatenBadge.appendChild(createEl('span', '', ` (${beatVal})`));
          }
          card.appendChild(beatenBadge);
        }

        if (m.is_new) {
          const badge = createEl('span', 'milestone-card-new');
          badge.title = 'New this week';
          card.appendChild(badge);
        }

        card.addEventListener('click', () => openMilestoneModal(m));
        card.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openMilestoneModal(m);
          }
        });
        card.addEventListener('mouseenter', () => {
          card.style.transform = 'translateY(-2px)';
          card.style.boxShadow = 'var(--shadow), 0 0 20px ' + catConfig.color + '33';
          card.style.borderColor = catConfig.color;
        });
        card.addEventListener('mouseleave', () => {
          card.style.transform = 'none';
          card.style.boxShadow = 'none';
          card.style.borderColor = 'var(--border)';
        });
        card.style.cursor = 'pointer';
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');

        frag.appendChild(card);

        const target = parseFloat(valueEl.dataset.counter);
        if (!isNaN(target)) {
          animateCounter(valueEl, target, { integer: Number.isInteger(target) });
        }
      });

      grid.replaceChildren(frag);

      // "Load more" pagination for the All-years view
      if (isAllYears && visibleCount < filtered.length) {
        const loadMoreBtn = createEl('button', 'catalog-load-more');
        loadMoreBtn.textContent = `Load more (${filtered.length - visibleCount} remaining)`;
        loadMoreBtn.addEventListener('click', () => {
          allYearsPage++;
          render(filterKey, year);
        });
        grid.appendChild(loadMoreBtn);
      }

      // Update year navigation button states
      if (yearPrevBtn) {
        const hasPrev = availableYears.some(y => y > targetYear);
        yearPrevBtn.disabled = !hasPrev;
        yearPrevBtn.style.opacity = hasPrev ? '1' : '0.4';
      }
      if (yearNextBtn) {
        const hasNext = availableYears.some(y => y < targetYear && y >= Math.min(...availableYears));
        yearNextBtn.disabled = !hasNext;
        yearNextBtn.style.opacity = hasNext ? '1' : '0.4';
      }
    }

    // Initial render
    render('all', displayYear);

    // Category filter handler (debounced)
    if (filter) {
      let filterTimeout = null;
      filter.addEventListener('change', e => {
        if (filterTimeout) clearTimeout(filterTimeout);
        filterTimeout = setTimeout(() => render(e.target.value, displayYear), 100);
      });
    }

    // Year filter handler
    if (yearFilter) {
      yearFilter.addEventListener('change', e => {
        const year = e.target.value;
        if (year === 'all') {
          allYearsPage = 1;
          render(filter?.value || 'all', 'all');
        } else {
          allYearsPage = 1;
          render(filter?.value || 'all', parseInt(year, 10));
        }
      });
    }

    // Year navigation buttons
    if (yearPrevBtn) {
      yearPrevBtn.addEventListener('click', () => {
        const idx = availableYears.indexOf(displayYear);
        if (idx > 0) {
          displayYear = availableYears[idx - 1];
          if (yearFilter) yearFilter.value = displayYear;
          render(filter?.value || 'all', displayYear);
        }
      });
    }
    if (yearNextBtn) {
      yearNextBtn.addEventListener('click', () => {
        const idx = availableYears.indexOf(displayYear);
        if (idx < availableYears.length - 1) {
          displayYear = availableYears[idx + 1];
          if (yearFilter) yearFilter.value = displayYear;
          render(filter?.value || 'all', displayYear);
        }
      });
    }
  }

  // ---- Cleanup ----
  function cleanup() {
    counterObserver.disconnect();
    abortAllFetches();
    removeModalEventListeners();
    timelineResizeObservers.forEach((ro) => ro.disconnect());
    timelineResizeObservers.length = 0;
    // Stop the highlights rotation and release its timer. The old code replaced
    // the carousel with a shallow clone to drop its listeners, which also threw
    // away the rendered cards and the live region - a "cleanup" that damages the
    // page it is cleaning. Stopping the timer is the whole job: the listeners are
    // on nodes that are being discarded with the document anyway.
    const carousel = document.getElementById('highlights-carousel');
    if (carousel && carousel._highlights) {
      carousel._highlights.stop();
      carousel._highlights = null;
    }
  }

// ---- Recent Highlights: single-highlight spotlight carousel ----------------
  // Replaces a continuous marquee.
  //
  // The marquee was broken in three ways that all show up immediately on the
  // page: it duplicated every card and translated -50%, which is only seamless
  // when the track's content is exactly two identical halves - with a 16px gap
  // between the last card of each half it jumps 8px every cycle; its duration
  // was `contentWidth / 30`, so twelve 320px cards took 134 SECONDS to come round
  // once; and at the mobile breakpoint `flex: 0 0 100%` made every card a full
  // screen wide, turning a slow drift into an unreadable crawl.
  //
  // What is here instead: one highlight at a time, a new one every 2s, an
  // overshoot-and-settle at the end of each slide, and a wrap straight back to
  // the first card. Same DOM ids as before, so nothing else has to change.
  const HIGHLIGHT_INTERVAL_MS = 2000;
  // Long enough to read a title and a source, short enough that the section feels
  // live rather than like a slideshow you have to wait out.
  const HIGHLIGHT_SLIDE_MS = 520;

  function initHighlightsCarousel() {
    const carousel = document.getElementById('highlights-carousel');
    const track = document.getElementById('highlights-carousel-track');
    if (!carousel || !track) return null;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let cards = [];
    let index = 0;
    let timer = null;
    let paused = false;
    // Set while a slide is in flight so a fast click cannot interleave two
    // transitions on the same pair of cards and leave one stranded off-stage.
    let animating = false;

    function renderIndicators() {
      const dots = carousel.querySelector('.highlights-dots');
      if (!dots) return;
      const frag = document.createDocumentFragment();
      cards.forEach((_, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'highlights-dot' + (i === index ? ' is-active' : '');
        b.setAttribute('aria-label', 'Show highlight ' + (i + 1) + ' of ' + cards.length);
        b.setAttribute('aria-current', i === index ? 'true' : 'false');
        b.addEventListener('click', () => { show(i, true); });
        frag.appendChild(b);
      });
      dots.replaceChildren(frag);
    }

    // Move to `target`. `immediate` skips the transition (first paint, and the
    // reduced-motion path), so nothing animates on load.
    function show(target, immediate) {
      if (cards.length === 0) return;
      const count = cards.length;
      // Modulo, so a click on "next" from the last card returns to the first and
      // the timer wrapping does the same: the loop is one code path, not two.
      const next = ((target % count) + count) % count;
      const prevIndex = index;
      index = next;
      if (next === prevIndex && !immediate) return;

      const outgoing = cards[prevIndex];
      const incoming = cards[next];

      // Stage every card. `.is-current` is the only visible one; `.is-out` is the
      // card on its way off. Using classes rather than inline transforms keeps the
      // motion in CSS, where prefers-reduced-motion can switch it off in one place.
      cards.forEach((c, i) => {
        c.classList.remove('is-current', 'is-out', 'is-enter');
        c.setAttribute('aria-hidden', i === next ? 'false' : 'true');
        // Only the visible card is reachable by keyboard; the rest are decoration
        // while off-stage, and leaving them focusable put tab stops on invisible
        // cards.
        c.setAttribute('tabindex', i === next ? '0' : '-1');
      });
      incoming.classList.add('is-current');
      if (!immediate && !prefersReducedMotion && prevIndex !== next) {
        outgoing.classList.add('is-out');
        incoming.classList.add('is-enter');
        animating = true;
        const settle = () => {
          animating = false;
          outgoing.classList.remove('is-out');
          incoming.classList.remove('is-enter');
        };
        // The timeout is a backstop for the transition, not the animation itself:
        // if `transitionend` never fires (a dropped frame, a hidden tab) the card
        // must still come back on-stage rather than stay invisible forever.
        incoming._settleTimer = setTimeout(settle, HIGHLIGHT_SLIDE_MS + 120);
        incoming.addEventListener('transitionend', function done(ev) {
          if (ev && ev.propertyName && ev.propertyName !== 'transform'
              && ev.propertyName !== 'opacity') return;
          clearTimeout(incoming._settleTimer);
          incoming.removeEventListener('transitionend', done);
          settle();
        });
      }
      renderIndicators();
      const live = carousel.querySelector('.highlights-live');
      if (live && incoming) {
        const title = incoming.querySelector('.milestone-card-title');
        live.textContent = (title && title.textContent) || '';
      }
    }

    function tick() {
      if (paused || animating || cards.length < 2) return;
      show(index + 1, false);
    }

    function start() {
      stop();
      if (cards.length < 2) return;
      // setInterval rather than a self-rescheduling timeout: the cadence has to be
      // exactly HIGHLIGHT_INTERVAL_MS apart, and a chained timeout drifts by the
      // duration of whatever the last slide did.
      timer = setInterval(tick, HIGHLIGHT_INTERVAL_MS);
    }
    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
    }

    function pause() { paused = true; }
    function resume() { paused = false; }

    function buildCard(m) {
      const catConfig = CATEGORY_CONFIG[m.category_key]
        || { name: m.category_name, icon: '📌', color: '#00d4ff' };
      const card = document.createElement('div');
      card.className = 'milestone-card highlights-card';

      const header = document.createElement('div');
      header.className = 'milestone-card-header';

      const icon = document.createElement('span');
      icon.className = 'milestone-card-icon';
      icon.textContent = catConfig.icon;
      icon.setAttribute('aria-hidden', 'true');

      const catInfo = document.createElement('div');
      catInfo.className = 'milestone-card-cat-info';
      const catName = document.createElement('div');
      catName.className = 'milestone-card-cat-name';
      catName.textContent = catConfig.name;
      catName.style.color = catConfig.color;
      const title = document.createElement('h4');
      title.className = 'milestone-card-title';
      title.textContent = m.title;
      catInfo.append(catName, title);
      header.append(icon, catInfo);
      card.appendChild(header);

      const meta = document.createElement('div');
      meta.className = 'milestone-card-meta';
      const sourceSpan = document.createElement('span');
      sourceSpan.textContent = m.source;
      const dateSpan = document.createElement('span');
      dateSpan.textContent = m.date;
      meta.append(sourceSpan, document.createTextNode(' · '), dateSpan);
      card.appendChild(meta);

      if (m.value) {
        const value = document.createElement('div');
        value.className = 'milestone-card-value';
        value.textContent = milestoneValueText(m);
        card.appendChild(value);
      }
      return { card, catConfig };
    }

    function populate(list) {
      // One card on stage at a time, so a narrow viewport needs no special case
      // and there is nothing to scroll.
      cards = [];
      const frag = document.createDocumentFragment();
      list.forEach((m) => {
        const built = buildCard(m);
        const card = built.card;
        card.style.setProperty('--catalog-accent', built.catConfig.color);
        card.style.setProperty('--catalog-accent-alpha', built.catConfig.color + '33');
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '-1');
        card.addEventListener('click', () => {
          pause();
          openMilestoneModal(m);
        });
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pause();
            openMilestoneModal(m);
          }
        });
        frag.appendChild(card);
        cards.push(card);
      });
      track.replaceChildren(frag);
    }

    // Chrome: dots + prev/next + a live region. Built here rather than in
    // index.md so the carousel owns its own affordances and they cannot drift
    // out of step with the card count.
    function buildChrome() {
      const dots = document.createElement('div');
      dots.className = 'highlights-dots';
      dots.setAttribute('role', 'tablist');
      dots.setAttribute('aria-label', 'Choose a highlight');

      const prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'highlights-nav highlights-nav--prev';
      prev.setAttribute('aria-label', 'Previous highlight');
      prev.textContent = '‹';
      prev.addEventListener('click', () => { pause(); show(index - 1, false); });

      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'highlights-nav highlights-nav--next';
      next.setAttribute('aria-label', 'Next highlight');
      next.textContent = '›';
      next.addEventListener('click', () => { pause(); show(index + 1, false); });

      const live = document.createElement('p');
      live.className = 'highlights-live';
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');

      const controls = document.createElement('div');
      controls.className = 'highlights-controls';
      controls.append(prev, dots, next);

      carousel.append(controls, live);
    }

    async function init() {
      let list = [];
      try {
        const data = await getMilestonesData();
        if (data && data.categories) {
          const all = [];
          for (const [catKey, catData] of Object.entries(data.categories)) {
            (catData.milestones || []).forEach(m => all.push({
              ...m, category_key: catKey, category_name: catData.name,
              category_icon: catData.icon, category_color: catData.color,
            }));
          }
          all.sort((a, b) => new Date(b.date) - new Date(a.date));
          list = all.slice(0, 12);
        }
      } catch (e) {
        console.warn('[dashboard] highlights carousel: populate failed', e);
      }
      if (list.length === 0) {
        carousel.style.display = 'none';
        return false;
      }
      populate(list);
      buildChrome();
      index = 0;
      show(0, true);

      // Hovering or focusing the section pauses the rotation: a visitor reaching
      // for the dots or the modal should not have the card change under them.
      carousel.addEventListener('mouseenter', pause);
      carousel.addEventListener('mouseleave', resume);
      carousel.addEventListener('focusin', pause);
      carousel.addEventListener('focusout', (e) => {
        if (!carousel.contains(e.relatedTarget)) resume();
      });
      carousel.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); pause(); show(index + 1, false); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); pause(); show(index - 1, false); }
      });
      start();
      return true;
    }

    const api = {
      show: (i) => show(i, false),
      next: () => show(index + 1, false),
      prev: () => show(index - 1, false),
      pause,
      resume,
      start,
      stop,
      get index() { return index; },
      get length() { return cards.length; },
    };
    carousel._highlights = api;
    init();
    return api;
  }

  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('pagehide', cleanup);

  if (typeof window.__DASHBOARD_TEST__ === 'undefined') {
    window.__DASHBOARD_TEST__ = {
      todayISO,
      parseDateOrNull,
      daysSinceISO,
      metricKey,
      milestoneValueText,
      numericMilestoneValue,
      milestoneMetricText,
      computeStaleness,
      buildMetricOptionList,
      metricCountsByDate,
      // Adaptive timeline chart: exported because the out-of-bounds bug this
      // replaces was a pure function of (records, width) and is far cheaper to
      // pin down here than through the DOM.
      chartBucket,
      nextChartBucket,
      bucketCounts,
      chartColumnBudget,
      chooseChartBucket,
      tacticalRecords,
      CHART_BUCKETS,
      CHART_BUCKET_LABEL,
      CHART_MIN_COL_PX,
      CHART_MAX_COLUMNS,
      parseDateToISO,
      normalizeLayerDate,
      HIGHLIGHT_INTERVAL_MS: 2000,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      loadActivity();
      loadTacticalTimeline();
      loadTopMilestones();
      loadMilestonesCatalog();
      initCategoryToggles();
      loadMetricTimeline();
      initHighlightsCarousel();
    });
  } else {
    loadActivity();
    loadTacticalTimeline();
    loadTopMilestones();
    loadMilestonesCatalog();
    initCategoryToggles();
    loadMetricTimeline();
    initHighlightsCarousel();
  }
})();
