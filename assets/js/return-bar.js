/* Return-to-site bar.
 *
 * Arriving from a sister site and having no idea where you are is the one piece
 * of missing navigation that a shared brand cannot fix on its own. This is a
 * slim bar under the header that slides down ONLY when the visitor actually came
 * from a different site in the network, names both places, and offers one button
 * back. It never appears on a cold visit, on a refresh, or after it has been
 * dismissed for that origin in this tab session.
 *
 * Same file on every site in the network: the site list and this site's own name
 * are read from data attributes on the mount node, so nothing here is
 * site-specific and there is no per-site copy to forget to update.
 */
(function() {
  'use strict';

  var mount = document.getElementById('return-bar');
  if (!mount) return;

  // Read defensively: these are attributes in a Liquid include, and a typo there
  // should degrade to "no bar", never to a thrown error on every page.
  var here = mount.getAttribute('data-site') || '';
  var hereName = mount.getAttribute('data-site-name') || here;
  var rawSites = mount.getAttribute('data-sites') || '';
  var sites = [];
  try {
    sites = JSON.parse(rawSites);
  } catch (_) {
    sites = [];
  }
  if (!here || !Array.isArray(sites) || sites.length === 0) return;

  function hostOf(url) {
    try {
      return new URL(url, window.location.href).hostname.replace(/^www\./, '');
    } catch (_) {
      return '';
    }
  }

  function currentHost() {
    return (window.location.hostname || '').replace(/^www\./, '');
  }

  // Where did they come from? document.referrer is the honest answer; the `?from=`
  // parameter exists for the one case referrer cannot cover - a link opened in a
  // new tab or a redirect that strips the referrer - and is only honoured when it
  // names a site in this list, so it cannot be used to render arbitrary text.
  function originSite() {
    var candidates = [hostOf(document.referrer || '')];
    try {
      candidates.push(hostOf(new URLSearchParams(window.location.search).get('from') || ''));
    } catch (_) { /* no URLSearchParams, or a malformed query: referrer is enough */ }
    for (var i = 0; i < candidates.length; i++) {
      var host = candidates[i];
      if (!host) continue;
      for (var j = 0; j < sites.length; j++) {
        var s = sites[j];
        if (!s || !s.host) continue;
        if (host === String(s.host).replace(/^www\./, '')) {
          // Never announce a return to the site they are already on.
          return String(s.host).replace(/^www\./, '') === currentHost() ? null : s;
        }
      }
    }
    return null;
  }

  var from = originSite();
  if (!from) return;

  // Once dismissed for this origin, do not nag on every navigation within the
  // tab session. sessionStorage rather than localStorage: returning tomorrow
  // should show it again, because by then they may have forgotten where they are.
  var KEY = 'return_bar_dismissed:' + currentHost() + '<-' + from.host;
  try {
    if (sessionStorage.getItem(KEY)) return;
  } catch (_) { /* private mode: showing the bar is the safe failure */ }

  var reduceMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var bar = document.createElement('div');
  bar.className = 'return-bar';
  bar.setAttribute('role', 'status');
  bar.hidden = false;

  var text = document.createElement('span');
  text.className = 'return-bar__text';
  text.textContent = 'You came from ' + (from.name || from.host) + '. You are on ' + hereName + '.';
  bar.appendChild(text);

  var back = document.createElement('a');
  back.className = 'return-bar__action';
  back.href = from.url || ('https://' + from.host + '/');
  back.textContent = '← Return to ' + (from.name || from.host);
  bar.appendChild(back);

  var close = document.createElement('button');
  close.type = 'button';
  close.className = 'return-bar__close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', function() {
    try { sessionStorage.setItem(KEY, '1'); } catch (_) {}
    bar.classList.remove('is-open');
    // Remove after the slide so the layout does not jump. The timeout is the
    // transition duration; matching it in CSS and JS is the contract.
    setTimeout(function() { if (bar.parentNode) bar.parentNode.removeChild(bar); },
      reduceMotion ? 0 : 260);
  });
  bar.appendChild(close);

  mount.appendChild(bar);
  // Force layout so the initial state paints before the transition starts.
  void bar.offsetWidth;
  bar.classList.add('is-open');

  // Auto-dismiss. A bar that stays forever becomes furniture the reader stops
  // reading, which is worse than not having one. It stays put while the pointer
  // is on it, so a reader reaching for the button is not raced.
  var autoHide = setTimeout(function() { close.click(); }, 9000);
  bar.addEventListener('mouseenter', function() { clearTimeout(autoHide); });
  bar.addEventListener('focusin', function() { clearTimeout(autoHide); });
})();
