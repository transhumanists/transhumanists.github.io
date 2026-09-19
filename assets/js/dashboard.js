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

  async function fetchJSON(url) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (e) {
      return null;
    }
  }

  // Activity chart (30-day bars)
  async function loadActivity() {
    const bars = document.getElementById('activity-bars');
    const labels = document.getElementById('activity-labels');
    if (!bars || !labels) return;

    const data = await fetchJSON('/data/activity.json');
    const series = (data && data.days) || generateSampleActivity();
    const max = Math.max(1, ...series.map(d => d.count));

    bars.innerHTML = '';
    labels.innerHTML = '';

    series.forEach((d, i) => {
      const bar = document.createElement('div');
      bar.className = 'chart-bar';
      bar.style.height = (4 + (d.count / max) * 116) + 'px';
      bar.title = `${d.date}: ${d.count} milestones`;
      bars.appendChild(bar);

      if (i % 5 === 0 || i === series.length - 1) {
        const lbl = document.createElement('div');
        lbl.className = 'chart-label';
        lbl.textContent = d.date.slice(5);
        labels.appendChild(lbl);
      } else {
        const lbl = document.createElement('div');
        lbl.className = 'chart-label';
        lbl.textContent = '';
        labels.appendChild(lbl);
      }
    });

    const ts = document.getElementById('activity-update-time');
    if (ts) ts.textContent = data && data.last_update ? '(updated ' + data.last_update + ')' : '(seed data)';
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

  // Milestone cards (top 8 of "all")
  async function loadTopMilestones() {
    const grid = document.getElementById('top-milestones');
    if (!grid) return;
    const data = await fetchJSON('/data/milestones.json');
    const items = (data && data.recent) || SAMPLE_MILESTONES;
    grid.innerHTML = '';
    items.slice(0, 8).forEach(function(m) {
      var a = document.createElement('a');
      a.className = 'milestone-card';
      a.style.cssText = 'text-decoration: none; color: inherit;';
      a.href = (m.url || '/milestones/' + (m.category || '').toLowerCase().replace(/[^a-z]/g, '') + '/');
      a.setAttribute('aria-label', (m.title || '').trim());

      var header = document.createElement('div');
      header.className = 'milestone-card-header';

      var icon = document.createElement('div');
      icon.className = 'milestone-card-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = m.icon || '\u{1F4CC}';

      var cat = document.createElement('span');
      cat.className = 'milestone-card-category';
      cat.textContent = m.category || '';

      header.appendChild(icon);
      header.appendChild(cat);

      var titleEl = document.createElement('h3');
      titleEl.textContent = m.title || '';

      var valueEl = document.createElement('div');
      valueEl.className = 'milestone-card-value';
      valueEl.dataset.counter = m.value || '0';
      valueEl.textContent = m.value || '0';

      var unitEl = document.createElement('div');
      unitEl.className = 'milestone-card-unit';
      unitEl.textContent = m.unit || '';

      var meta = document.createElement('div');
      meta.className = 'milestone-card-meta';

      var src = document.createElement('span');
      src.textContent = m.source || '\u2014';

      var dot = document.createElement('span');
      dot.textContent = '\u00B7';

      var date = document.createElement('span');
      date.textContent = m.date || '';

      meta.appendChild(src);
      meta.appendChild(dot);
      meta.appendChild(date);

      a.appendChild(header);
      a.appendChild(titleEl);
      a.appendChild(valueEl);
      a.appendChild(unitEl);
      a.appendChild(meta);

      if (m.is_new) {
        var badge = document.createElement('span');
        badge.className = 'milestone-card-new';
        badge.title = 'New this week';
        a.appendChild(badge);
      }

      grid.appendChild(a);
    });

    // Trigger counter animation (same pattern as main.js for consistency)
    grid.querySelectorAll('[data-counter]').forEach(function(el) {
      el.textContent = '0';
      var target = parseFloat(el.dataset.counter);
      if (isNaN(target)) return;
      var io = new IntersectionObserver(function(entries) {
        entries.forEach(function(en) {
          if (!en.isIntersecting) return;
          var duration = 1500;
          var start = performance.now();
          var tick = function(now) {
            var t = Math.min((now - start) / duration, 1);
            var eased = 1 - Math.pow(1 - t, 3);
            var val = target * eased;
            el.textContent = Number.isInteger(target) ? Math.round(val) : val.toFixed(1);
            if (t < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          io.unobserve(el);
        });
      }, { threshold: 0.3 });
      io.observe(el);
    });
  }

  const SAMPLE_MILESTONES = [
    { title: 'CRISPR Cas-13b FDA phase-3', category: 'Biotechnology', value: '50', unit: 'patients treated', source: 'Stanford', date: '2026-08-25', icon: '🧬', is_new: true },
    { title: 'Qubits entangled', category: 'Quantum', value: '137', unit: 'qubits', source: 'ETH Zurich', date: '2026-08-26', icon: '⚛️', is_new: true },
    { title: 'JT-60SA fusion yield', category: 'Energy', value: '100', unit: 'MJ sustained', source: 'NIFS', date: '2026-08-22', icon: '⚡' },
    { title: 'Top CVSS score', category: 'Cybersecurity', value: '9.8', unit: 'CRITICAL', source: 'NCSC', date: '2026-08-24', icon: '🛡️', is_new: true },
    { title: 'Starship payload to LEO', category: 'Spaceflight', value: '156', unit: 'tonnes', source: 'SpaceX', date: '2026-08-23', icon: '🚀' },
    { title: 'Hypersonic glide vehicle', category: 'Defense', value: '13', unit: 'Mach', source: 'PLASSF', date: '2026-08-20', icon: '🌍', is_new: true },
    { title: 'GPT-6 MMLU', category: 'Tech', value: '94.7', unit: '%', source: 'OpenAI', date: '2026-08-19', icon: '🧠' },
    { title: 'Drone swarm coordinated', category: 'Defense', value: '1000', unit: 'UAVs', source: 'CSA', date: '2026-08-17', icon: '🌍' }
  ];

  // Category Toggle — expandable milestone lists
  async function initCategoryToggles() {
    const toggles = document.querySelectorAll('.category-toggle');
    if (!toggles.length) return;

    const data = await fetchJSON('/data/milestones.json');
    if (!data || !data.categories) return;

    toggles.forEach(btn => {
      const catKey = btn.dataset.category;
      const catData = data.categories[catKey];
      if (!catData) return;

      const milestonesContainer = btn.querySelector('.category-milestones');
      const indicator = btn.querySelector('.category-expand-indicator .expand-arrow');
      const countSpan = btn.querySelector('.category-expand-indicator span');
      if (countSpan) countSpan.textContent = `${catData.milestones.length} milestone${catData.milestones.length !== 1 ? 's' : ''}`;

      function renderMilestones() {
        if (!milestonesContainer) return;
        const config = CATEGORY_CONFIG[catKey] || { icon: '📌', color: '#00d4ff' };
        milestonesContainer.innerHTML = '';
        (catData.milestones || []).forEach(m => {
          const item = document.createElement('div');
          item.className = 'category-milestone-item';
          item.style.cssText = 'animation: slideDown 0.3s ease;';
          const isNew = m.is_new ? '<span class="category-milestone-new-badge" title="New this week"></span>' : '';
          item.innerHTML = `
            ${isNew}
            <div class="category-milestone-info">
              <span class="icon">${config.icon}</span>
              <div class="category-milestone-details">
                <div class="category-milestone-title">${m.title}</div>
                <div class="category-milestone-meta">
                  <span>${m.source}</span> · <span>${m.date}</span>
                  ${m.geolocation ? `<span>· 📍 ${m.geolocation.lat.toFixed(2)}, ${m.geolocation.lon.toFixed(2)}</span>` : ''}
                </div>
              </div>
            </div>
            <div class="category-milestone-value">
              <span class="value" data-counter="${m.value}">${m.value}</span>
              <span class="unit">${m.unit}</span>
            </div>
          `;
          milestonesContainer.appendChild(item);

          // Counter animation
          const valEl = item.querySelector('[data-counter]');
          if (valEl) {
            valEl.textContent = '0';
            const target = parseFloat(valEl.dataset.counter);
            if (!isNaN(target)) {
              const io = new IntersectionObserver(entries => {
                entries.forEach(en => {
                  if (!en.isIntersecting) return;
                  const duration = 1000;
                  const start = performance.now();
                  const tick = now => {
                    const t = Math.min((now - start) / duration, 1);
                    const eased = 1 - Math.pow(1 - t, 3);
                    const val = target * eased;
                    valEl.textContent = Number.isInteger(target) ? Math.round(val) : val.toFixed(1);
                    if (t < 1) requestAnimationFrame(tick);
                  };
                  requestAnimationFrame(tick);
                  io.unobserve(valEl);
                });
              }, { threshold: 0.2 });
              io.observe(valEl);
            }
          }
        });
      }

      btn.addEventListener('click', () => {
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', !expanded);
        if (indicator) indicator.style.transform = expanded ? 'rotate(0deg)' : 'rotate(180deg)';
        if (milestonesContainer) {
          milestonesContainer.style.display = expanded ? 'none' : 'block';
          if (!expanded) renderMilestones();
        }
      });
    });
  }

  // Milestones Catalog (all milestones)
  async function loadMilestonesCatalog() {
    const grid = document.getElementById('catalog-grid');
    const filter = document.getElementById('catalog-category-filter');
    const countEl = document.getElementById('catalog-count');
    if (!grid) return;

    const data = await fetchJSON('/data/milestones.json');
    if (!data || !data.categories) {
      grid.innerHTML = '<p style="color: var(--fg-muted); text-align: center; padding: 40px;">No milestone data available</p>';
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

    // Sort by date descending (newest first)
    allMilestones.sort((a, b) => new Date(b.date) - new Date(a.date));

    function render(filterKey) {
      const filtered = filterKey === 'all'
        ? allMilestones
        : allMilestones.filter(m => m.category_key === filterKey);

      if (countEl) countEl.textContent = `${filtered.length} milestone${filtered.length !== 1 ? 's' : ''}`;

      grid.innerHTML = '';
      if (filtered.length === 0) {
        grid.innerHTML = '<p style="color: var(--fg-muted); text-align: center; padding: 40px;">No milestones in this category</p>';
        return;
      }

      filtered.forEach(m => {
        const catConfig = CATEGORY_CONFIG[m.category_key] || { name: m.category_name, icon: '📌', color: '#00d4ff' };

        const card = document.createElement('div');
        card.className = 'catalog-card';
        card.style.cssText = `
          background: var(--bg-card);
          border: 1px solid var(--border);
          border-left: 4px solid ${catConfig.color};
          border-radius: var(--radius);
          padding: 16px;
          transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
        `;

        const isNew = m.is_new ? '<span class="milestone-card-new" style="position:absolute;top:12px;right:12px;width:8px;height:8px;border-radius:50%;background:var(--orange);animation:pulse 2s infinite;" title="New this week"></span>' : '';

        card.innerHTML = `
          ${isNew}
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px;">
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="font-size:1.3rem;">${catConfig.icon}</span>
              <div>
                <div style="font-family:var(--font-mono);font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${catConfig.color};">${catConfig.name}</div>
                <h4 style="font-size:0.95rem;font-weight:600;color:var(--fg);margin-top:2px;">${m.title}</h4>
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0;">
              <div class="milestone-card-value" data-counter="${m.value}" style="font-family:var(--font-mono);font-size:1.3rem;font-weight:700;color:${catConfig.color};">${m.value}</div>
              <div class="milestone-card-unit" style="font-size:0.75rem;color:var(--fg-muted);">${m.unit}</div>
            </div>
          </div>
          <div style="font-size:0.7rem;color:var(--fg-subtle);display:flex;gap:12px;flex-wrap:wrap;">
            <span>${m.source}</span>
            <span>·</span>
            <span>${m.date}</span>
            ${m.geolocation ? `<span>· 📍 ${m.geolocation.lat.toFixed(2)}, ${m.geolocation.lon.toFixed(2)}</span>` : ''}
          </div>
        `;

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

        grid.appendChild(card);
      });

      // Trigger counter animations
      grid.querySelectorAll('[data-counter]').forEach(el => {
        el.textContent = '0';
        const target = parseFloat(el.dataset.counter);
        if (isNaN(target)) return;
        const io = new IntersectionObserver(entries => {
          entries.forEach(en => {
            if (!en.isIntersecting) return;
            const duration = 1200;
            const start = performance.now();
            const tick = now => {
              const t = Math.min((now - start) / duration, 1);
              const eased = 1 - Math.pow(1 - t, 3);
              const val = target * eased;
              el.textContent = Number.isInteger(target) ? Math.round(val) : val.toFixed(1);
              if (t < 1) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
            io.unobserve(el);
          });
        }, { threshold: 0.2 });
        io.observe(el);
      });
    }

    // Initial render
    render('all');

    // Filter handler
    if (filter) {
      filter.addEventListener('change', e => render(e.target.value));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      loadActivity();
      loadTopMilestones();
      loadMilestonesCatalog();
      initCategoryToggles();
    });
  } else {
    loadActivity();
    loadTopMilestones();
    loadMilestonesCatalog();
    initCategoryToggles();
  }
})();
