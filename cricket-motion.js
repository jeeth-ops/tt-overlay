/* =====================================================================
   CRICKET PANEL MOTION — the small script half of cricket-motion.css,
   loaded (deferred) by Cricket Panel and Cricket Panel3.

   It only ever adds motion on top of what the panel already did. It never
   writes a number, never calls the scoring engine, never stops or delays a
   click or a key, and never waits for anything: every effect starts after
   the panel has handled the action, on the compositor (Web Animations on
   transform-family properties and opacity — nothing to lay out). With
   reduced motion, or in a hidden tab, it does nothing at all.

   - A scoring key sends a ring out once its tap has been handled, in the
     key's own colour (two for a FOUR or a SIX). A key pressed from the
     keyboard (0–6, W, S, U, H) or by the phone remote also dips on screen,
     so the operator sees which key took it.
   - A live number that changed (score, overs, rates, partnership, balls
     left, the batters' and the bowler's figures) settles in: from below
     when it went up, from above when it went down (an Undo, a falling run
     rate). A FOUR or a SIX on the score pops it. A re-render that leaves a
     number as it was plays nothing; a fast run of balls plays only the
     latest.
   - The ball just bowled pops into "this over".

   <script src="/cricket-motion.js" defer data-cm-tick="id,…" data-cm-pop="id,…"></script>
   ===================================================================== */
(function(){
  'use strict';
  if (window.__cricketMotion) return;          // (one copy, however it is loaded)
  window.__cricketMotion = true;
  const script = document.currentScript;
  const list = (name) => ((script && script.dataset[name]) || '').split(',').map(s => s.trim()).filter(Boolean);
  const TICK = list('cmTick'), POP = new Set(list('cmPop'));
  const reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const canAnimate = typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
  const quiet = () => reduce.matches || !canAnimate || document.hidden;
  const OUT = 'cubic-bezier(.22, 1, .36, 1)', SPRING = 'cubic-bezier(.34, 1.45, .64, 1)';
  const play = (el, frames, timing) => { try { return el.animate(frames, timing); } catch (e) { return null; } };

  /* ------------------------------------------------ numbers that changed */
  const firstNumber = (s) => { const m = /-?\d+(?:\.\d+)?/.exec(s || ''); return m ? parseFloat(m[0]) : null; };
  function watch(el){
    let last = el.textContent, anim = null;
    new MutationObserver(() => {
      const now = el.textContent;
      if (now === last) return;
      const a = firstNumber(last), b = firstNumber(now);
      last = now;
      if (quiet()) return;
      if (anim) anim.cancel();                  // (the latest one only, never a queue)
      const down = a != null && b != null && b < a;
      if (POP.has(el.id) && a != null && b != null && b - a >= 4) {
        anim = play(el, [{ opacity: 0.5, scale: 1, translate: '0 4px' }, { opacity: 1, scale: 1.09, translate: '0 0', offset: 0.45 }, { opacity: 1, scale: 1, translate: '0 0' }], { duration: 460, easing: OUT });
      } else {
        anim = play(el, [{ opacity: 0.35, translate: down ? '0 -3px' : '0 3px' }, { opacity: 1, translate: '0 0' }], { duration: 230, easing: OUT });
      }
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }

  /* ------------------------------------------------- the ball just bowled */
  function watchOver(box){
    const FRAMES = [{ opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1.16, offset: 0.6 }, { opacity: 1, scale: 1 }], TIMING = { duration: 360, easing: OUT };
    let n = box.children.length, popAt = -1, popEl = null;
    new MutationObserver(() => {
      const m = box.children.length, last = box.lastElementChild;
      if (quiet()) { n = m; return; }
      if (m > n && last) { popAt = performance.now(); popEl = last; play(last, FRAMES, TIMING); }
      else if (m === n && last && popEl && last !== popEl && performance.now() - popAt < TIMING.duration) {
        // the panel draws "this over" twice for one ball: the pop carries on on the new pip
        const a = play(last, FRAMES, TIMING);
        if (a) a.currentTime = performance.now() - popAt;
        popEl = last;
      }
      n = m;
    }).observe(box, { childList: true });
  }

  /* --------------------------------------------- the keys: ring and dip */
  const KEYS = '.lc-key, #card-ball-outcome .balls-grid button, #card-ball-outcome .ev-btn';
  const EXTRA = '#undo-btn';                    // (pressed by U as well)
  const rings = [];
  let nextRing = 0;
  function ringFrom(btn){
    const r = btn.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const cs = getComputedStyle(btn), ball = btn.dataset.ball || '';
    const big = ball === '4' || ball === '6';
    let c = cs.getPropertyValue('--k').trim();
    if (ball === 'W' || btn.matches('.kw, .b-wicket')) c = '#ef4444';
    if (!c) c = cs.color;
    for (let i = 0; i < (big ? 2 : 1); i++) {
      let el = rings[nextRing];
      if (!el) { el = rings[nextRing] = document.createElement('div'); el.className = 'cm-ring'; el.setAttribute('aria-hidden', 'true'); document.body.appendChild(el); }
      nextRing = (nextRing + 1) % 4;
      if (el._a) el._a.cancel();
      const s = el.style;
      s.left = r.left + 'px'; s.top = r.top + 'px'; s.width = r.width + 'px'; s.height = r.height + 'px'; s.borderRadius = cs.borderRadius;
      s.setProperty('--cm-c', c);
      const grow = big ? (i ? 26 : 14) : 9;     // px outward on every side, whatever the key's shape
      // it grows at once and keeps its glow for a moment before it fades — a burst, not a flicker
      const end = `${(r.width + 2 * grow) / r.width} ${(r.height + 2 * grow) / r.height}`;
      el._a = play(el, [{ opacity: big ? 0.9 : 0.7, scale: '1 1', easing: 'cubic-bezier(.2, .8, .3, 1)' }, { opacity: big ? 0.6 : 0.4, offset: 0.4 }, { opacity: 0, scale: end }],
        { duration: big ? 640 : 440, delay: i * 110, fill: 'backwards' });
    }
  }
  // a ring is pinned to where its key was: if the page scrolls under it, it goes
  window.addEventListener('scroll', () => { for (const el of rings) if (el && el._a) { el._a.cancel(); el._a = null; } }, { passive: true, capture: true });
  function dip(btn){ play(btn, [{ scale: 0.95 }, { scale: 1 }], { duration: 320, easing: SPRING }); }
  // after the panel's own handler (capture only to see the tap; the effect waits for the next frame)
  document.addEventListener('click', (e) => {
    const t = e.target, btn = t && t.closest && t.closest(KEYS + ', ' + EXTRA);
    if (!btn || btn.disabled || quiet()) return;
    const fromKeyOrRemote = e.detail === 0;     // a real mouse / finger tap is pressed by CSS already
    requestAnimationFrame(() => { if (fromKeyOrRemote) dip(btn); if (btn.matches(KEYS)) ringFrom(btn); });
  }, true);
  // a scoring shortcut: show it on its key. Read before the panel acts on it
  // (it scores nothing while a question is open), shown once it has.
  const SHORTCUT = { w: '[data-ball="W"]', s: '#lc-swap-btn, #swap-strike', h: '#highlight-btn, #save-highlight-btn' };
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || quiet()) return;
    const t = e.target, tag = ((t && t.tagName) || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || (t && t.isContentEditable)) return;
    const k = (e.key || '').toLowerCase();
    const sel = /^[0-6]$/.test(k) ? `[data-ball="${k}"]` : SHORTCUT[k];
    if (!sel || (k === 'h' && e.repeat)) return;   // (a held key scores again — and shows again; H does not)
    // the panels score nothing behind an open question (Panel 3's H works over one)
    const asking = document.querySelector('.wicket-modal-overlay.show:not(#auto-card-modal-overlay), .tc-overlay.show');
    if (asking && !(k === 'h' && document.getElementById('save-highlight-btn'))) return;
    const btn = [...document.querySelectorAll(sel)].find(b => b.offsetParent !== null && !b.disabled);
    if (!btn) return;
    requestAnimationFrame(() => { dip(btn); if (btn.matches(KEYS)) ringFrom(btn); });
  }, true);

  function start(){
    TICK.forEach(id => { const el = document.getElementById(id); if (el) watch(el); });
    const over = document.getElementById('over-preview');
    if (over) watchOver(over);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
