/* transhumanists — page-level motion, reveals and the hero neon re-light.
 *
 * One place for everything that moves because the reader moved, so there is a
 * single honours-preferences switch (below) rather than one per feature.
 */
(function() {
  'use strict';

  var reduceMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Scroll reveal ------------------------------------------------------
  // Sections fade and lift into place as they come up. Applied to the section
  // SHELL rather than to everything inside it: animating a grid of 40 catalog
  // cards individually costs a style recalc per card on the way in and looks
  // like a wave, not like a page settling.
  var revealTargets = document.querySelectorAll(
    '.section > .container > .section-header, ' +
    '#world-map, .highlights-carousel, .catalog-controls, .catalog-grid, ' +
    '.milestones-grid, .activity-chart, .metric-timeline, .network-grid, .feed-panel'
  );
  if (!reduceMotion && revealTargets.length && 'IntersectionObserver' in window) {
    if (!document.documentElement.classList.contains('reveal-ready')) {
      document.documentElement.classList.add('reveal-ready');
    }
    var revealObserver = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-revealed');
        revealObserver.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    revealTargets.forEach(function(el) { revealObserver.observe(el); });
    // Anything already on screen at load reveals immediately: a section that
    // animates in while the reader is already looking at it is a flicker, not an
    // entrance. The observer fires for these on its first callback anyway, which
    // is within a frame - close enough, and it keeps one code path.
  }

  // ---- Hero: "Human Progress. Quantified." neon re-light --------------------
  // Fires once on landing, then again every time the hero scrolls back fully
  // into view after having left it entirely. Three pulses, then it returns to
  // rest - the point is to draw the eye back to the headline, not to make the
  // headline unusable.
  //
  // The "fully" conditions are the whole design and are why this is not just an
  // IntersectionObserver toggle:
  //   * it must have gone fully past the top of the viewport (`below` is true
  //     only when the hero's bottom edge is above the viewport top). A hero that
  //     is merely 90% visible has not "gone", so scrolling up one notch does not
  //     re-trigger;
  //   * it must be fully back (`ratio` near 1) before the next pulse. Partly
  //     visible means the reader is still arriving, and re-firing then would
  //     restart the animation they are scrolling into;
  //   * a cooldown, so a reader bouncing on the last few pixels of the hero -
  //     which is exactly what a trackpad does - gets one pulse, not thirty.
  var hero = document.querySelector('.hero-title');
  var HERO_COOLDOWN_MS = 9000;
  var HERO_MIN_RATIO = 0.98;

  if (hero && !reduceMotion && 'IntersectionObserver' in window) {
    var leftFully = false;
    var lastRunAt = -Infinity;

    function canRun() {
      return (Date.now() - lastRunAt) > HERO_COOLDOWN_MS;
    }

    function run() {
      if (!canRun()) return;
      lastRunAt = Date.now();
      // Restart cleanly: remove, force a reflow, re-add. Without the reflow a
      // second call while the class is still present is a no-op and the reader
      // gets nothing the second time they scroll up.
      hero.classList.remove('is-neon');
      void hero.offsetWidth;
      hero.classList.add('is-neon');
      hero.addEventListener('animationend', function done() {
        hero.removeEventListener('animationend', done);
        hero.classList.remove('is-neon');
      });
    }

    var heroObserver = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        // `below` is not standard everywhere; fall back to the rect when the
        // property is missing rather than silently never re-triggering.
        var below = entry.boundingClientRect
          ? entry.boundingClientRect.bottom < 0
          : false;
        if (below || entry.intersectionRatio === 0) {
          leftFully = true;
          return;
        }
        if (leftFully && entry.intersectionRatio >= HERO_MIN_RATIO) {
          leftFully = false;
          run();
        }
      });
    }, { threshold: [0, 0.5, 0.9, 1] });

    heroObserver.observe(hero);
    // Landing: one pulse as soon as the page is ready.
    if (document.readyState === 'complete') {
      run();
    } else {
      window.addEventListener('load', run, { once: true });
    }
  } else if (hero) {
    // Reduced motion: the title simply sits there. Adding the class with the
    // animation disabled would be equivalent, but doing nothing is clearer.
    hero.classList.add('is-neon-static');
  }

  // ---- Activity-chart bar hover --------------------------------------------
  // Delegated on the container rather than bound per bar: the chart bars are
  // re-rendered whenever the frame changes width or the year filter moves, and
  // per-bar listeners attached once at load were therefore attached to nodes
  // that no longer existed - the hover stopped working the first time the chart
  // re-aggregated.
  document.addEventListener('mouseover', function(e) {
    var bar = e.target && e.target.closest ? e.target.closest('.chart-bar') : null;
    if (bar) bar.classList.add('active');
  });
  document.addEventListener('mouseout', function(e) {
    var bar = e.target && e.target.closest ? e.target.closest('.chart-bar') : null;
    if (bar) bar.classList.remove('active');
  });

  // ---- Header shrink on scroll ---------------------------------------------
  var header = document.querySelector('.site-header');
  if (header) {
    window.addEventListener('scroll', function() {
      header.style.background = window.scrollY > 20
        ? 'rgba(6, 11, 20, 0.95)'
        : 'rgba(6, 11, 20, 0.85)';
    }, { passive: true });
  }
})();
