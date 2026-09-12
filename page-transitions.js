/* ============================================================
   All Sports Live — shared page-to-page transition system (JS half)
   See page-transitions.css for the full explanation.

   Public API:
     window.ptNavigate(url, { replace, x, y })
       Drop-in replacement for `location.href = url` /
       `location.replace(url)` that plays the fallback iris wipe on
       browsers without native View Transitions, and just performs
       the navigation directly everywhere else (the browser already
       animates it). `x`/`y` are the screen point the circle should
       grow from — pass a click's clientX/clientY when you have one,
       otherwise it defaults to the middle of the screen.

   Plain <a href="..."> clicks anywhere on the page are handled
   automatically — no per-link changes needed.
   ============================================================ */
(function () {
  'use strict';

  var SS_KEY = 'ptTransition';
  var supportsVT = typeof document.startViewTransition === 'function';
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function pageBg() {
    try {
      var c = getComputedStyle(document.body).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
      c = getComputedStyle(document.documentElement).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
    } catch (e) { /* ignore */ }
    return '#0a0e17';
  }

  function maxRadius(x, y) {
    var w = window.innerWidth, h = window.innerHeight;
    return Math.ceil(Math.hypot(Math.max(x, w - x), Math.max(y, h - y)));
  }

  function isSameDoc(url) {
    return url.origin === location.origin &&
           url.pathname === location.pathname &&
           url.search === location.search;
  }

  // ---- Reveal an overlay left covering the page by the critical
  // inline snippet in <head> (runs the instant this document became
  // interactive, before anything else gets a chance to flash). ----
  function revealIncoming() {
    var ov = document.getElementById('pt-overlay');
    if (!ov) return;
    var x = parseFloat(ov.dataset.x);
    var y = parseFloat(ov.dataset.y);
    if (isNaN(x)) x = window.innerWidth / 2;
    if (isNaN(y)) y = window.innerHeight / 2;
    var r = parseFloat(ov.dataset.r);
    if (isNaN(r)) r = maxRadius(x, y);

    if (reduceMotion || typeof ov.animate !== 'function') { ov.remove(); return; }

    var anim = ov.animate(
      [
        { clipPath: 'circle(' + r + 'px at ' + x + 'px ' + y + 'px)' },
        { clipPath: 'circle(0px at ' + x + 'px ' + y + 'px)' }
      ],
      { duration: 460, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'forwards' }
    );
    var done = function () { ov.remove(); };
    anim.onfinish = done;
    setTimeout(done, 620);
  }

  function init() {
    // Native browsers already animated the hop that got us here —
    // nothing left to do but tidy up.
    if (supportsVT) {
      try { sessionStorage.removeItem(SS_KEY); } catch (e) { /* ignore */ }
      return;
    }
    var hadPending = false;
    try { hadPending = !!sessionStorage.getItem(SS_KEY); } catch (e) { /* ignore */ }

    if (hadPending && document.getElementById('pt-overlay')) {
      revealIncoming();
    } else if (!reduceMotion) {
      document.documentElement.classList.add('pt-fallback-enter');
    }
    try { sessionStorage.removeItem(SS_KEY); } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ---- Outgoing navigation ----
  window.ptNavigate = function (url, opts) {
    opts = opts || {};
    var replace = !!opts.replace;
    var go = function () {
      if (replace) location.replace(url); else location.href = url;
    };

    var target;
    try { target = new URL(url, location.href); } catch (e) { go(); return; }

    // Cross-origin, same-document, or reduced-motion: just navigate,
    // nothing to animate (native VT browsers land here too — the
    // browser is already handling the whole transition itself).
    if (target.origin !== location.origin || isSameDoc(target) || supportsVT || reduceMotion || typeof Element === 'undefined' || typeof HTMLElement.prototype.animate !== 'function') {
      go();
      return;
    }

    var x = (typeof opts.x === 'number') ? opts.x : window.innerWidth / 2;
    var y = (typeof opts.y === 'number') ? opts.y : window.innerHeight / 2;
    var bg = pageBg();
    var r = maxRadius(x, y);

    var ov = document.getElementById('pt-overlay') || document.createElement('div');
    ov.id = 'pt-overlay';
    ov.setAttribute('aria-hidden', 'true');
    ov.style.background = bg;
    ov.dataset.x = x; ov.dataset.y = y; ov.dataset.r = r;
    if (!ov.isConnected) document.documentElement.appendChild(ov);

    try {
      sessionStorage.setItem(SS_KEY, JSON.stringify({ x: x, y: y, bg: bg }));
    } catch (e) { /* ignore */ }

    var navigated = false;
    var doGo = function () { if (navigated) return; navigated = true; go(); };

    var anim = ov.animate(
      [
        { clipPath: 'circle(0px at ' + x + 'px ' + y + 'px)' },
        { clipPath: 'circle(' + r + 'px at ' + x + 'px ' + y + 'px)' }
      ],
      { duration: 420, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' }
    );
    anim.onfinish = doGo;
    setTimeout(doGo, 480);
  };

  // ---- Intercept plain <a> clicks site-wide so every normal link
  // gets the same treatment without touching each one by hand. ----
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;

    var targetAttr = a.getAttribute('target');
    if (targetAttr && targetAttr !== '_self') return;
    if (a.hasAttribute('download')) return;

    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || href.indexOf('javascript:') === 0 ||
        href.indexOf('mailto:') === 0 || href.indexOf('tel:') === 0) return;

    var url;
    try { url = new URL(a.href, location.href); } catch (err) { return; }
    if (url.origin !== location.origin) return;
    if (isSameDoc(url) && url.hash) return; // in-page anchor jump — let the browser handle it

    e.preventDefault();
    window.ptNavigate(url.href, { x: e.clientX, y: e.clientY });
  }, true);
})();
