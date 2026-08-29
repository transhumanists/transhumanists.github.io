---
layout: default
title: transhumanists — Human Progress Dashboard
description: "Tracking milestones across biotech, AGI, quantum, energy, cyber, space & defense. Live world map of human progress."
---

<div class="hero" id="home">
  <div class="container">
    <div class="hero-content">
      <div class="hero-badges" aria-label="Categories">
        <span class="badge badge-fpm">FrenzyPenguin Media</span>
        <span class="badge badge-milestone">7 categories · 50+ subcategories</span>
      </div>

      <h1 class="hero-title">Human Progress. Quantified.</h1>
      <p class="hero-subtitle">
        A live dashboard of scientific, technological, and strategic breakthroughs
        — scraped, scored, and pinned on a world map.
      </p>

      <div class="hero-cta">
        <a href="#milestones" class="btn btn-primary">View Milestones</a>
        <a href="#world-map" class="btn btn-secondary">World Map</a>
        <a href="https://github.com/transhumanists/milestones" class="btn btn-secondary" target="_blank" rel="noopener">Open Data</a>
      </div>
    </div>
  </div>
</div>

<!-- WORLD MAP -->
<section class="section" id="world-map">
  <div class="container">
    <header class="section-header">
      <h2>Global Activity Map</h2>
      <p class="section-subtitle">Breakthroughs, defense movements, and frontier engineering — by geolocation</p>
    </header>

    <div id="world-map">
      <canvas id="world-map-canvas"></canvas>
      <div class="map-overlay" aria-live="polite">
        <div class="map-stat">
          <span class="map-stat-dot" style="background: var(--green);"></span>
          <span id="map-stat-active">—</span>
          <span>breakthroughs this week</span>
        </div>
        <div class="map-stat">
          <span class="map-stat-dot" style="background: var(--red);"></span>
          <span id="map-stat-conflicts">—</span>
          <span>active conflict zones</span>
        </div>
        <div class="map-stat">
          <span class="map-stat-dot" style="background: var(--accent);"></span>
          <span id="map-stat-fleets">—</span>
          <span>fleet movements tracked</span>
        </div>
      </div>
      <div class="map-tooltip" id="map-tooltip" role="tooltip"></div>
    </div>
  </div>
</section>

<!-- CATEGORY OVERVIEW -->
<section class="section section-alt" id="milestones">
  <div class="container">
    <header class="section-header">
      <h2>Milestone Categories</h2>
      <p class="section-subtitle">The 7 verticals that drive human progress</p>
    </header>

    <div class="milestones-grid">
      <a href="{{ '/milestones/biotechnology/' | relative_url }}" class="milestone-card" style="text-decoration: none; color: inherit;">
        <div class="milestone-card-header">
          <div class="milestone-card-icon" aria-hidden="true">🧬</div>
          <span class="milestone-card-category">Bio</span>
        </div>
        <h3>Biotechnology</h3>
        <p style="font-size: 0.85rem; color: var(--fg-muted);">Microscopy, macroscopy, medical exploration, human implants, gene editing, longevity, synthetic biology</p>
      </a>

      <a href="{{ '/milestones/computing-agi/' | relative_url }}" class="milestone-card" style="text-decoration: none; color: inherit;">
        <div class="milestone-card-header">
          <div class="milestone-card-icon" aria-hidden="true">🧠</div>
          <span class="milestone-card-category">Tech</span>
        </div>
        <h3>Computing & AGI</h3>
        <p style="font-size: 0.85rem; color: var(--fg-muted);">Frontier model benchmarks, agentic capabilities, GPU efficiency, time-to-train</p>
      </a>

      <a href="{{ '/milestones/quantum/' | relative_url }}" class="milestone-card" style="text-decoration: none; color: inherit;">
        <div class="milestone-card-header">
          <div class="milestone-card-icon" aria-hidden="true">⚛️</div>
          <span class="milestone-card-category">Quantum</span>
        </div>
        <h3>Quantum Physics</h3>
        <p style="font-size: 0.85rem; color: var(--fg-muted);">Qubit counts, error correction, time crystals, supremacy benchmarks</p>
      </a>

      <a href="{{ '/milestones/energy/' | relative_url }}" class="milestone-card" style="text-decoration: none; color: inherit;">
        <div class="milestone-card-header">
          <div class="milestone-card-icon" aria-hidden="true">⚡</div>
          <span class="milestone-card-category">Energy</span>
        </div>
        <h3>Renewable Energy</h3>
        <p style="font-size: 0.85rem; color: var(--fg-muted);">Fusion records, photovoltaic efficiency, battery density, capacity factors</p>
      </a>

      <a href="{{ '/milestones/cybersecurity/' | relative_url }}" class="milestone-card" style="text-decoration: none; color: inherit;">
        <div class="milestone-card-header">
          <div class="milestone-card-icon" aria-hidden="true">🛡️</div>
          <span class="milestone-card-category">Cyber</span>
        </div>
        <h3>Cybersecurity</h3>
        <p style="font-size: 0.85rem; color: var(--fg-muted);">CVSS records, mitigations, exploit chains, encryption standards</p>
      </a>

      <a href="{{ '/milestones/spaceflight/' | relative_url }}" class="milestone-card" style="text-decoration: none; color: inherit;">
        <div class="milestone-card-header">
          <div class="milestone-card-icon" aria-hidden="true">🚀</div>
          <span class="milestone-card-category">Space</span>
        </div>
        <h3>Spaceflight & Aeronautics</h3>
        <p style="font-size: 0.85rem; color: var(--fg-muted);">Landing records, payload to orbit, hypersonic tests, deep-space missions</p>
      </a>

      <a href="{{ '/milestones/defense/' | relative_url }}" class="milestone-card" style="text-decoration: none; color: inherit;">
        <div class="milestone-card-header">
          <div class="milestone-card-icon" aria-hidden="true">🌍</div>
          <span class="milestone-card-category">Defense</span>
        </div>
        <h3>Military & Defense</h3>
        <p style="font-size: 0.85rem; color: var(--fg-muted);">Range, radius, fleet movements, contracts, defense intelligence, NATO/CIA/MI6/Mossad</p>
      </a>

      <a href="{{ '/milestones/all/' | relative_url }}" class="milestone-card" style="text-decoration: none; color: inherit; background: var(--accent-dim); border-color: var(--accent);">
        <div class="milestone-card-header">
          <div class="milestone-card-icon" aria-hidden="true">📊</div>
          <span class="milestone-card-category">All</span>
        </div>
        <h3>All Metrics</h3>
        <p style="font-size: 0.85rem; color: var(--fg-muted);">Complete dashboard, full leaderboards, timegraph, activity spikes</p>
      </a>
    </div>
  </div>
</section>

<!-- ACTIVITY CHART -->
<section class="section">
  <div class="container">
    <header class="section-header">
      <h2>Activity Timeline</h2>
      <p class="section-subtitle">Breakthrough frequency over the last 30 days</p>
    </header>

    <div class="activity-chart">
      <h3>📈 Daily milestone activity <span style="color: var(--fg-subtle); font-weight: 400; font-size: 0.8rem; font-family: var(--font-mono);" id="activity-update-time">—</span></h3>
      <div class="chart-bars" id="activity-bars"></div>
      <div class="chart-labels" id="activity-labels"></div>
    </div>
  </div>
</section>

<!-- REPOSITORIES -->
<section class="section section-alt">
  <div class="container">
    <header class="section-header">
      <h2>Open Repositories</h2>
      <p class="section-subtitle">All data, scrapers, and dashboard code is open source</p>
    </header>

    <div class="milestones-grid">
      <a href="https://github.com/transhumanists/milestones" class="milestone-card" style="text-decoration: none; color: inherit;">
        <div class="milestone-card-header">
          <div class="milestone-card-icon" aria-hidden="true">📋</div>
          <span class="milestone-card-category">Data</span>
        </div>
        <h3>milestones</h3>
        <p style="font-size: 0.85rem; color: var(--fg-muted);">Categorized milestone database, JSON + Markdown, updated by automated scrapers</p>
      </a>

      <a href="https://github.com/transhumanists/apis" class="milestone-card" style="text-decoration: none; color: inherit;">
        <div class="milestone-card-header">
          <div class="milestone-card-icon" aria-hidden="true">⚙️</div>
          <span class="milestone-card-category">Engine</span>
        </div>
        <h3>apis</h3>
        <p style="font-size: 0.85rem; color: var(--fg-muted);">News scrapers, LLM milestone scoring, self-healing schedulers, social media post queue</p>
      </a>

      <a href="https://github.com/transhumanists/transhumanists.github.io" class="milestone-card" style="text-decoration: none; color: inherit;">
        <div class="milestone-card-header">
          <div class="milestone-card-icon" aria-hidden="true">🌐</div>
          <span class="milestone-card-category">Web</span>
        </div>
        <h3>transhumanists.github.io</h3>
        <p style="font-size: 0.85rem; color: var(--fg-muted);">This dashboard — world map, leaderboards, live SVGs</p>
      </a>
    </div>
  </div>
</section>

<!-- SCRIPTS -->
<script src="{{ '/assets/js/worldmap.js' | relative_url }}"></script>
<script src="{{ '/assets/js/dashboard.js' | relative_url }}"></script>

<!-- NETWORK CROSS-LINKS -->
<section class="section section-alt" id="network">
  <div class="container">
    <header class="section-header">
      <h2>neohiro Network</h2>
      <p class="section-subtitle">Sister sites that share data with this dashboard</p>
    </header>

    <div class="network-grid">
      <a class="network-card" href="https://neohiro.github.io/" rel="noopener" style="text-decoration: none; color: inherit;">
        <div class="network-card-icon" aria-hidden="true">👽</div>
        <h3>neohiro</h3>
        <p>Security hardening &amp; privacy tools for Windows and Linux</p>
      </a>
      <a class="network-card" href="https://neohiro.github.io/openstageisland.github.io/" rel="noopener" style="text-decoration: none; color: inherit;">
        <div class="network-card-icon" aria-hidden="true">🎤</div>
        <h3>Open Stage Island</h3>
        <p>Free 24/7 open-air music stage in Second Life &mdash; no booking, no fee</p>
      </a>
      <a class="network-card" href="https://neohiro.github.io/frenzypenguin-media/" rel="noopener" style="text-decoration: none; color: inherit;">
        <div class="network-card-icon" aria-hidden="true">🐧</div>
        <h3>FrenzyPenguin Media</h3>
        <p>Indie media &amp; creative studio behind all of this</p>
      </a>
      <a class="network-card" href="https://neohiro.github.io/links-secret/?to=github" rel="noopener" style="text-decoration: none; color: inherit;">
        <div class="network-card-icon" aria-hidden="true">🔗</div>
        <h3>links-secret</h3>
        <p>Whitelisted redirect service for promotional deep-links</p>
      </a>
    </div>

    <div class="feed-panel" aria-labelledby="feed-heading">
      <h3 id="feed-heading">📡 neohiro Network Activity Feed</h3>
      <p class="feed-subtitle">Latest releases &amp; activity from the neohiro network &mdash; cascaded live from GitHub</p>
      <ul class="feed-list" id="neohiro-feed" aria-live="polite">
        <li class="feed-item feed-loading">Loading latest activity&hellip;</li>
      </ul>
      <p class="feed-status" id="neohiro-feed-status" aria-live="polite"></p>
    </div>
  </div>
</section>

<script>
/* API-cascade feed: pulls latest release & repo events from neohiro network */
(function() {
  'use strict';
  if (document.getElementById('neohiro-feed') === null) return;

  var REPOS = [
    { owner: 'neohiro', name: 'windows',            label: '🛡️  windows (hardening)' },
    { owner: 'neohiro', name: 'neohiro.github.io',  label: '👽  neohiro.github.io' },
    { owner: 'neohiro', name: 'openstageisland.github.io', label: '🎤  openstageisland' },
    { owner: 'neohiro', name: 'frenzypenguin-media', label: '🐧  frenzypenguin-media' }
  ];
  var feed = document.getElementById('neohiro-feed');
  var status = document.getElementById('neohiro-feed-status');
  var items = [];
  var done = 0;

  function render() {
    done++;
    if (done < REPOS.length) return;
    if (items.length === 0) {
      feed.innerHTML = '<li class="feed-item feed-empty">No recent activity. Sources may be rate-limited.</li>';
      return;
    }
    items.sort(function(a, b) {
      return new Date(b.date) - new Date(a.date);
    });
    var top = items.slice(0, 8);
    feed.innerHTML = top.map(function(it) {
      return '<li class="feed-item">' +
        '<span class="feed-icon" aria-hidden="true">' + it.icon + '</span>' +
        '<span class="feed-label">' + it.label + '</span>' +
        '<a class="feed-title" href="' + it.url + '" target="_blank" rel="noopener">' + escapeHTML(it.title) + '</a>' +
        '<span class="feed-date">' + formatDate(it.date) + '</span>' +
      '</li>';
    }).join('');
    status.textContent = 'Showing ' + top.length + ' most recent. Cascade refreshed ' + new Date().toLocaleTimeString();
  }

  function escapeHTML(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function formatDate(s) {
    var d = new Date(s);
    if (isNaN(d)) return s;
    return d.toISOString().slice(0, 10);
  }

  REPOS.forEach(function(r) {
    var url = 'https://api.github.com/repos/' + r.owner + '/' + r.name + '/releases/latest';
    fetch(url, { headers: { 'Accept': 'application/vnd.github+json' } })
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(rel) {
        if (rel && rel.tag_name) {
          items.push({
            label: r.label,
            icon: '🚀',
            title: rel.name || rel.tag_name,
            url: rel.html_url,
            date: rel.published_at || rel.created_at
          });
        }
      })
      .catch(function() {
        var url2 = 'https://api.github.com/repos/' + r.owner + '/' + r.name + '/commits?per_page=1';
        return fetch(url2, { headers: { 'Accept': 'application/vnd.github+json' } })
          .then(function(r2) { if (!r2.ok) throw new Error('HTTP ' + r2.status); return r2.json(); })
          .then(function(commits) {
            if (commits && commits[0]) {
              items.push({
                label: r.label,
                icon: '🛠️',
                title: commits[0].commit.message.split('\n')[0].slice(0, 80),
                url: commits[0].html_url,
                date: commits[0].commit.author.date
              });
            }
          });
      })
      .finally(render);
  });
})();
</script>
