---
---

# 🚀 transhumanists

### **Human Progress. Quantified.**

A live dashboard of scientific, technological, and strategic breakthroughs — scraped, scored, and pinned on a world map.

🌐 **[transhumanists.github.io](https://transhumanists.github.io)** · **[GitHub org](https://github.com/transhumanists)** · **[facebook.com/transhumanistsBE](https://facebook.com/transhumanistsBE)**

---

## Dashboard world map

The front page renders a live equirectangular world map (`assets/js/worldmap.js`) with no external
dependencies. The world is fitted inside the canvas at its natural 360:142 ratio and centred
rather than stretched, so a phone-shaped canvas is never distorted and a degree of longitude is
always the same number of pixels as a degree of latitude; geography is clipped to that fitted
plate. The map provides:

- **Event dots** colored by category (`data/events.json`), with a day/night terminator overlay and sun position
- **Click-to-pin tooltips** — category, metric value, source, date, and a *View source* link to the
  original report. A popup stays docked at its marker so that link is reachable, for milestones and
  for Human Rights landmarks alike
- **Category legend** (`CATEGORIES`) with per-vertical event counts, plus a bulk-visibility eye that
  hides or restores every category at once. It follows the per-row switches in both directions —
  hiding categories one at a time closes it, re-selecting a single one reopens it — and
  deliberately leaves the operational layers below it alone
- **Operational layers**, each with its own switch and count: Conflict Zones, Ground Deployments &
  Fleet Movements, Crisis Zones, and Human Rights Violations. These are map layers rather than
  categories, and all four are off by default
- **Interaction** — drag to pan, wheel/double-click/`+`/`-` to zoom, `0` to reset, and `+` / `−` / `⟲` buttons in the overlay
- **Keyboard accessible** (arrow keys pan, `+`/`-` zoom, `0` reset)

Legend colors, stat tiles and tooltips all resolve categories through a canonical alias map, so legacy names such as `Energy`, `Quantum` and `Defense` are treated as `Renewable Energy`, `Quantum Physics` and `Military & Defense`.

**Tests.** The unit suites need nothing but [Bun](https://bun.sh) and Python:

```sh
python -m pytest scripts/ -q     # pipeline, validator, workflow lint
bun test test/                   # map widget unit tests
```

`python scripts/verify_release.py` runs everything CI runs, in CI's order, plus the
determinism gate, and is what a local `pre-push` hook calls. It compares your Bun
against the version CI pins and says so, because a green run on the wrong Bun is the
failure mode it exists to catch. `--skip-determinism` is the fast inner loop and
`--also-bun /path/to/other-bun` cross-checks the JS suite against a second toolchain.
The pinned version itself lives in `.bun-version`, so the toolchain is declared once
in the repository instead of only in the workflow YAML. `verify_release.py` treats
that file as the local expectation and still compares it against the version CI
installs, so the two drifting apart is reported rather than silently accepted.

**Auditing the data.** `python scripts/check_data.py` validates every published
data file, including the append-only archive. `python scripts/coverage_report.py`
answers the two questions validation cannot: which milestones are unlocated or
wrongly geocoded, and which years are empty on the slider. Read-only; `--json` for
CI. It fails the build only on null-island - a coordinate of exactly (0, 0), which
is upstream's "location unknown" sentinel and plots a dot in the Gulf of Guinea.
Low coverage and unlocated records are reported but never fail anything, because
they are a filling backlog rather than a regression:

```
$ python scripts/coverage_report.py
  unique milestones      106  (from 254 records, 148 duplicated across files)
  geocoded              92
  unlocated             14   (no dot on the map - correct, not a bug)

  years 1945-2026  populated 31 / 82   empty 51
  empty years: 1946-1952, 1955-1956, ... 2024-2025
```

Point it at a candidate data set with `WORLDMAP_DATA_DIR=/path/to/data`. The
unlocated list is the geocoding backlog: each row is a record with evidence
(title, summary, source, subcategory) that `geocode_milestone()` can work from.

GitHub Actions runs six jobs on every push/PR to `main`: the JS suite and a static parse
check, the Python suites, data validation, a determinism gate over two regenerations,
a Jekyll build for Pages, and real-browser layout checks.

**Browser checks.** `e2e/` holds Playwright specs that measure the layout a browser
actually produces, at 1440px and 390px, against the shipped CSS and JS. They assert
measurements rather than pixel baselines — a baseline needs a human to approve the
current appearance and then fails on every legitimate restyle — and CI publishes the
screenshots as artifacts for anyone who wants to look.

```sh
bun install
bunx playwright install chromium
bunx playwright test
```

The unit suite runs against a hand-written DOM fake, which is fast but cannot see a
frame that is too tall or a legend that leaves its container. Both shipped once. The
browser checks are what caught them.

Note: `bun install` under a newer Bun rewrites `bun.lock` in a format CI's pinned Bun
cannot read. Regenerate it with the pinned version; a test enforces this.

---

## The 9 Verticals We Track

Listed in legend order. `CATEGORY_LEGEND` in `assets/js/worldmap.js` is the authority.

🧬 **Biotechnology & Biohacking** — gene editing, implants, microscopy, longevity, synthetic biology, neuroscience, grinder/DIY biohacking
🧠 **Computing & AGI** — frontier models, agentic AI, GPU efficiency, benchmarks
⚛️ **Quantum Physics** — qubit counts, error correction, time crystals, supremacy, networking
⚡ **Renewable Energy** — fusion, solar efficiency, battery density, wind, storage
🚚 **Mobility & Logistics** — autonomy, freight, ports, rail, aviation, last-mile
🛡️ **Cybersecurity** — exploits, mitigations, encryption, threat intel, zero-days
🤖 **Robotics & Drones** — humanoids, manipulation, industrial and surgical robotics, and drone flight time, range, endurance and payload records
🚀 **Spaceflight & Aeronautics** — launch, payload, deep space, hypersonic, reusability
🌍 **Military & Defense** — range, radius, fleet movements, contracts, air defense, naval, cyber ops

Biotechnology & Biohacking is one category drawn in two colors, not two categories.

---

## Pipeline

```
80+ RSS feeds → LLM scoring → milestones.json → dashboard + Facebook
                  ↑
          self-healing source checker
```

Every 6 hours, [`transhumanists/apis`](https://github.com/transhumanists/apis) runs the pipeline and commits new data here and to [`transhumanists/milestones`](https://github.com/transhumanists/milestones).

---

## Repositories

| Repo | What |
|---|---|
| [transhumanists](https://github.com/transhumanists) | The organization — profile, dashboard SVG, cross-repo branding |
| [transhumanists/milestones](https://github.com/transhumanists/milestones) | Canonical milestone database (Markdown + JSON) |
| [transhumanists/apis](https://github.com/transhumanists/apis) | RSS scraper, LLM scorer, Facebook poster, self-healer |
| [transhumanists/transhumanists.github.io](https://github.com/transhumanists/transhumanists.github.io) | This dashboard site |

---

## Cross-Profile Branding

All SVGs across the transhumanists, [FrenzyPenguin Media](https://github.com/frenzypenguin-media), and [neohiro](https://github.com/neohiro) readmes/profile pages share a uniform design system: dark background, JetBrains Mono + Space Grotesk typography, color-coded category dots, and a tiny **`FrenzyPenguin Media`** watermark in the bottom-right corner that links back to [frenzypenguin-media.github.io](https://frenzypenguin-media.github.io).

---

*Made with ♥ by [FrenzyPenguin Media](https://frenzypenguin-media.github.io) — a [neohiro](https://github.com/neohiro) project.*

---

## 🔗 Related & Sponsorship

- 💖 [Sponsor neohiro on GitHub](https://github.com/sponsors/neohiro) — cover API + hosting costs
- 🌐 [neohiro.github.io](https://neohiro.github.io/) — main site
- 🎬 [FrenzyPenguin Media](https://frenzypenguin-media.github.io/) — video deep-dives

[![Visitors](https://api.visitorbadge.io/api/visitors?path=github.com%2Ftranshumanists%2Ftranshumanists.github.io&label=Visitors&countColor=%23263759)](https://visitorbadge.io/status?path=github.com%2Ftranshumanists%2Ftranshumanists.github.io)
