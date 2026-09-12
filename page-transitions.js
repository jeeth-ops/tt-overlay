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

     window.ptNavigateMorph(el, url, { replace })
       "Container transform" style navigation: clones `el` in place,
       then grows that clone to fill the whole screen (corners
       squaring off as it grows) before navigating, so the tapped
       element visually *becomes* the next page — the iOS/Material
       "shared element" look. Unlike ptNavigate this is the SAME
       hand-rolled animation on every browser (it does not defer to
       native View Transitions), so it looks and times identically
       on Chrome, Safari, Firefox, desktop, Android and iOS. Opt an
       element in with `data-pt-morph="1"` (this also tells the
       site-wide <a> click handler below to leave that element alone
       so the two systems never fire on the same click) and call
       this yourself from that element's own click handler.

   Plain <a href="..."> clicks anywhere on the page are handled
   automatically by ptNavigate — no per-link changes needed, unless
   the link opts into ptNavigateMorph instead (see above).
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

    // Morph arrivals: the overlay is already a plain full-screen color
    // (that's what the clone grew into on the previous page), so
    // "revealing" the real page underneath is a simple fade-out —
    // there's no point to shrink back down to, that would look like
    // the click running in reverse instead of a landing.
    if (ov.dataset.morph === '1') {
      if (reduceMotion || typeof ov.animate !== 'function') { ov.remove(); return; }
      var mAnim = ov.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: 380, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' }
      );
      var mDone = function () { ov.remove(); };
      mAnim.onfinish = mDone;
      setTimeout(mDone, 500);
      return;
    }

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
    var pending = null;
    try {
      var raw = sessionStorage.getItem(SS_KEY);
      if (raw) pending = JSON.parse(raw);
    } catch (e) { /* ignore */ }
    var wasMorph = !!(pending && pending.morph);

    // Native browsers already animated the hop that got us here —
    // nothing left to do but tidy up. Morph arrivals are the
    // exception: that overlay is our own hand-rolled animation, not
    // the native one, so it still needs revealing here regardless of
    // View Transition support.
    if (supportsVT && !wasMorph) {
      try { sessionStorage.removeItem(SS_KEY); } catch (e) { /* ignore */ }
      return;
    }

    if (pending && document.getElementById('pt-overlay')) {
      revealIncoming();
    } else if (!reduceMotion && !wasMorph) {
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

  // ---- Outgoing navigation: "card becomes the page" ----
  // Grows a pixel-perfect clone of `el` until it fills the screen
  // (its corners squaring off as it grows), then navigates. The
  // destination's pre-paint snippet paints the same flat color,
  // full-screen, the instant it loads, so there's nothing to see
  // until revealIncoming() above fades that color away — the illusion is
  // continuous the whole way through. Deliberately ignores
  // `supportsVT`: this exact animation is what we want everywhere,
  // not just as a fallback, so laptop/Android/iOS/Safari all get the
  // identical timing and feel.
  window.ptNavigateMorph = function (el, url, opts) {
    opts = opts || {};
    var replace = !!opts.replace;
    var go = function () {
      if (replace) location.replace(url); else location.href = url;
    };

    var target;
    try { target = new URL(url, location.href); } catch (e) { go(); return; }

    if (!el || target.origin !== location.origin || isSameDoc(target) || reduceMotion ||
        typeof Element === 'undefined' || typeof HTMLElement.prototype.animate !== 'function') {
      go();
      return;
    }

    var rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) { go(); return; }

    var cs = getComputedStyle(el);
    var radius = cs.borderRadius || '0px';
    var bg = pageBg();

    var clone = el.cloneNode(true);
    clone.removeAttribute('id');
    clone.setAttribute('aria-hidden', 'true');
    clone.style.cssText =
      'position:fixed;margin:0;box-sizing:border-box;' +
      'top:' + rect.top + 'px;left:' + rect.left + 'px;' +
      'width:' + rect.width + 'px;height:' + rect.height + 'px;' +
      'border-radius:' + radius + ';background:' + bg + ';' +
      'z-index:2147483647;overflow:hidden;pointer-events:none;' +
      'transform-origin:top left;transform:translate(0px,0px) scale(1,1);' +
      'will-change:transform,border-radius,opacity;';
    document.body.appendChild(clone);

    // The clone's own content fades out fast so it doesn't visibly
    // stretch while the box grows — a beat later it's just a clean
    // color panel morphing into place, exactly like the destination
    // page's cover overlay it hands off to.
    if (typeof clone.animate === 'function') {
      clone.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
    }

    var vw = window.innerWidth, vh = window.innerHeight;
    var scaleX = vw / rect.width, scaleY = vh / rect.height;
    var tx = -rect.left, ty = -rect.top;

    try {
      sessionStorage.setItem(SS_KEY, JSON.stringify({ morph: true, bg: bg }));
    } catch (e) { /* ignore */ }

    var navigated = false;
    var doGo = function () { if (navigated) return; navigated = true; go(); };

    var grow = clone.animate(
      [
        { transform: 'translate(0px,0px) scale(1,1)', borderRadius: radius },
        { transform: 'translate(' + tx + 'px,' + ty + 'px) scale(' + scaleX + ',' + scaleY + ')', borderRadius: '0px' }
      ],
      { duration: 480, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' }
    );
    grow.onfinish = doGo;
    setTimeout(doGo, 540);
  };

  // ---- Intercept plain <a> clicks site-wide so every normal link
  // gets the same treatment without touching each one by hand. ----
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    if (a.hasAttribute('data-pt-morph')) return; // handled by its own click listener via ptNavigateMorph

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
