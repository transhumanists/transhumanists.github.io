/* Dashboard data loader — fetches milestones.json + activity.json */
(function() {
  'use strict';

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
    grid.innerHTML = items.slice(0, 8).map(m => `
      <a href="${m.url || '/milestones/' + m.category.toLowerCase().replace(/[^a-z]/g, '') + '/'}" class="milestone-card" style="text-decoration: none; color: inherit;">
        <div class="milestone-card-header">
          <div class="milestone-card-icon" aria-hidden="true">${m.icon || '📌'}</div>
          <span class="milestone-card-category">${m.category}</span>
        </div>
        <h3>${m.title}</h3>
        <div class="milestone-card-value" data-counter="${m.value}">${m.value}</div>
        <div class="milestone-card-unit">${m.unit || ''}</div>
        <div class="milestone-card-meta">
          <span>${m.source || '—'}</span>
          <span>·</span>
          <span>${m.date || ''}</span>
        </div>
        ${m.is_new ? '<span class="milestone-card-new" title="New this week"></span>' : ''}
      </a>
    `).join('');

    // Trigger counter animation
    grid.querySelectorAll('[data-counter]').forEach(el => {
      el.textContent = '0';
      const target = parseFloat(el.dataset.counter);
      if (!isNaN(target)) {
        const io = new IntersectionObserver(entries => {
          entries.forEach(en => {
            if (!en.isIntersecting) return;
            const duration = 1500;
            const start = performance.now();
            const tick = (now) => {
              const t = Math.min((now - start) / duration, 1);
              const eased = 1 - Math.pow(1 - t, 3);
              el.textContent = target * eased;
              if (t < 1) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
            io.unobserve(el);
          });
        }, { threshold: 0.3 });
        io.observe(el);
      }
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      loadActivity();
      loadTopMilestones();
    });
  } else {
    loadActivity();
    loadTopMilestones();
  }
})();
