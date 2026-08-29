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
