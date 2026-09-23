/* Dashboard data loader — fetches milestones.json + activity.json */
(function() {
  'use strict';

  const CATEGORY_CONFIG = {
    biotechnology: { name: 'Biotechnology', icon: '🧬', color: '#00e676' },
    computing_agi: { name: 'Computing & AGI', icon: '🧠', color: '#448aff' },
    quantum: { name: 'Quantum Physics', icon: '⚛️', color: '#b388ff' },
    energy: { name: 'Renewable Energy', icon: '⚡', color: '#ffd740' },
    cybersecurity: { name: 'Cybersecurity', icon: '🛡️', color: '#ff5252' },
    spaceflight: { name: 'Spaceflight & Aeronautics', icon: '🚀', color: '#00d4ff' },
    defense: { name: 'Military & Defense', icon: '🌍', color: '#ff9100' }
  };

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
  const ANIMATION_DURATION = 1200;
  const COUNTER_THRESHOLD = 0.2;

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

  // Activity chart (full timeline, from the beginning of scraping)
  async function loadActivity() {
    const bars = document.getElementById('activity-bars');
    const labels = document.getElementById('activity-labels');
    if (!bars || !labels) return;

    // Skeleton while loading
    bars.replaceChildren(...Array.from({ length: 24 }, () => createEl('div', 'chart-bar skeleton', '')));
    labels.replaceChildren(createEl('div', 'chart-label', 'loading…'));

    const [data, history] = await Promise.all([
      fetchJSON('/data/activity.json'),
      getHistoryData(),
    ]);
    const series = (data && data.days) || generateSampleActivity();
    const bucket = (data && data.bucket) || 'day';
    const max = Math.max(1, ...series.map(d => d.count));
    const step = Math.max(1, Math.ceil(series.length / 12));

    const barsFrag = document.createDocumentFragment();
    const labelsFrag = document.createDocumentFragment();

    series.forEach((d, i) => {
      const bar = createEl('div', 'chart-bar');
      bar.style.height = (4 + (d.count / max) * 116) + 'px';
      bar.title = `${bucket === 'week' ? 'Week of ' : ''}${d.date}: ${d.count} milestone${d.count !== 1 ? 's' : ''}`;
      barsFrag.appendChild(bar);

      const lbl = createEl('div', 'chart-label');
      lbl.textContent = (i % step === 0 || i === series.length - 1) ? d.date.slice(5) : '';
      labelsFrag.appendChild(lbl);
    });

    bars.replaceChildren(barsFrag);
    labels.replaceChildren(labelsFrag);

    const ts = document.getElementById('activity-update-time');
    if (ts) ts.textContent = data && data.last_update ? ` (updated ${data.last_update})` : ' (seed data)';

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
  }

  // Per-metric timeline: pick one metric and see its full history, so a broken
  // or stale metric is easy to trace back to the beginning of scraping.
  async function loadMetricTimeline() {
    const sel = document.getElementById('metric-select');
    const list = document.getElementById('metric-timeline-list');
    const sparkEl = document.getElementById('metric-sparkline');
    const staleEl = document.getElementById('metric-staleness');
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

    function render() {
      const key = sel.value;
      list.replaceChildren();
      if (sparkEl) sparkEl.hidden = true;
      if (staleEl) staleEl.hidden = true;
      if (!key) return;

      const opt = options.find(o => o.value === key);
      if (!opt) return;

      if (staleEl && opt.staleDays !== null && opt.staleDays > 3) {
        staleEl.textContent = `No new ${key} record since ${opt.newestDate} (${opt.staleDays} days ago).`;
        staleEl.hidden = false;
      }

      if (sparkEl) {
        const counts = metricCountsByDate(opt.records);
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
      opt.records.forEach(rec => {
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
      if (!catData) return;

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

    function render(filterKey) {
      const filtered = filterKey === 'all'
        ? allMilestones
        : allMilestones.filter(m => m.category_key === filterKey);

      if (countEl) countEl.textContent = `${filtered.length} milestone${filtered.length !== 1 ? 's' : ''}`;

      if (filtered.length === 0) {
        grid.replaceChildren(createEl('p', '', 'No milestones in this category'));
        grid.firstElementChild.style.cssText = 'color: var(--fg-muted); text-align: center; padding: 40px; width: 100%;';
        return;
      }

      const frag = document.createDocumentFragment();
      filtered.forEach(m => {
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
    }

    // Initial render
    render('all');

    // Filter handler (debounced)
    if (filter) {
      let filterTimeout = null;
      filter.addEventListener('change', e => {
        if (filterTimeout) clearTimeout(filterTimeout);
        filterTimeout = setTimeout(() => render(e.target.value), 100);
      });
    }
  }

  // ---- Cleanup ----
  function cleanup() {
    counterObserver.disconnect();
    abortAllFetches();
    removeModalEventListeners();
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
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      loadActivity();
      loadTopMilestones();
      loadMilestonesCatalog();
      initCategoryToggles();
      loadMetricTimeline();
    });
  } else {
    loadActivity();
    loadTopMilestones();
    loadMilestonesCatalog();
    initCategoryToggles();
    loadMetricTimeline();
  }
})();