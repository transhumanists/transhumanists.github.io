/* transhumanists — minimal interactivity */
(function() {
  'use strict';

  // Smooth-scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const id = a.getAttribute('href');
      if (id.length < 2) return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // Animated number counter for milestone values
  const counters = document.querySelectorAll('[data-counter]');
  if (counters.length && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const target = parseFloat(el.dataset.counter);
        const decimals = (el.dataset.counter.split('.')[1] || '').length;
        const duration = 1200;
        const start = performance.now();
        const tick = (now) => {
          const t = Math.min((now - start) / duration, 1);
          const eased = 1 - Math.pow(1 - t, 3);
          el.textContent = (target * eased).toFixed(decimals);
          if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        io.unobserve(el);
      });
    }, { threshold: 0.3 });
    counters.forEach(c => io.observe(c));
  }

  // Activity-chart bar hover
  document.querySelectorAll('.chart-bar').forEach(bar => {
    bar.addEventListener('mouseenter', () => bar.classList.add('active'));
    bar.addEventListener('mouseleave', () => bar.classList.remove('active'));
  });

  // Header shrink on scroll
  const header = document.querySelector('.site-header');
  if (header) {
    let lastY = 0;
    window.addEventListener('scroll', () => {
      const y = window.scrollY;
      header.style.background = y > 20
        ? 'rgba(6, 11, 20, 0.95)'
        : 'rgba(6, 11, 20, 0.85)';
      lastY = y;
    }, { passive: true });
  }
})();
