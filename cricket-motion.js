/* =====================================================================
   CRICKET PANEL MOTION — the script half of cricket-motion.css (and of
   cricket-polish.css), loaded (deferred) by Cricket Panel and Cricket
   Panel3. Each panel says what it has in a small JSON block:

     <script type="application/json" id="cricket-motion-config">{ … }</script>
     <script src="/cricket-motion.js" defer></script>

   The rule: it only ever adds motion and feedback on top of what the panel
   already did. It never writes a number the panel did not write, never
   calls the scoring engine, never delays a click, a key or a ball, and
   never waits for anything. Every effect starts after the panel has acted
   and runs on the compositor (Web Animations on transform-family
   properties and opacity). With reduced motion, or in a hidden tab, it
   stays still. The one thing it may hold back is a SECOND click on a
   save / send kind of button whose first click is still waiting on the
   server (never a scoring key, Undo or Highlights).

   What it does:
   - scoring keys: a ring out of the key that scored (its own colour; two
     for a FOUR or a SIX); a key pressed from the keyboard or the phone
     remote dips on screen; an optional key-click sound (off by default);
   - numbers: a changed number settles in (from below when it rose, from
     above when it fell); the score rolls like an odometer; a wicket
     pulses the score red; a batter's 50 / 100 and a bowler's five-for get a
     gold burst; a FOUR / SIX pops the score where the panel does not;
   - the crease: when strike changes, the two batters slide past each
     other into their places;
   - the over: the ball just bowled pops into "this over"; when the over
     ends its balls gather and go;
   - buttons that wait on the server show a spinner, then ✓ or ✕;
   - cards with a heading fold and unfold (remembered on this laptop);
     cards far off screen are not drawn until they come near (only cards
     that are safe for it);
   - the quick-nav bar shows, with a sliding line, which section is in
     view;
   - a toast that replaces another pushes the old one up as it goes;
   - with cricket-polish.css: the timing chips become a segmented control
     with a sliding highlight.
   ===================================================================== */
(function(){
  'use strict';
  if (window.__cricketMotion) return;          // (one copy, however it is loaded)
  const STATS = { sounds: 0, rings: 0, odo: 0, swaps: 0, bursts: 0, gathers: 0, busy: 0, blocked: 0 };
  window.__cricketMotion = STATS;
  const script = document.currentScript;
  let CFG = {};
  try { const c = document.getElementById('cricket-motion-config'); if (c) CFG = JSON.parse(c.textContent || '{}'); } catch (e) { CFG = {}; }
  // (the first version took its list of numbers from the script tag)
  if (!CFG.tick && script && script.dataset.cmTick) CFG.tick = script.dataset.cmTick.split(',').map(s => s.trim()).filter(Boolean);
  if (!CFG.pop && script && script.dataset.cmPop) CFG.pop = script.dataset.cmPop.split(',').map(s => s.trim()).filter(Boolean);
  const arr = (k) => Array.isArray(CFG[k]) ? CFG[k] : [];
  const $ = (id) => document.getElementById(id);
  const reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const canAnimate = typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
  const quiet = () => reduce.matches || !canAnimate || document.hidden;
  const OUT = 'cubic-bezier(.22, 1, .36, 1)', SPRING = 'cubic-bezier(.34, 1.45, .64, 1)', GLIDE = 'cubic-bezier(.32, .72, 0, 1)';
  const play = (el, frames, timing) => { try { return el.animate(frames, timing); } catch (e) { return null; } };
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const firstNumber = (s) => { const m = /-?\d+(?:\.\d+)?/.exec(s || ''); return m ? parseFloat(m[0]) : null; };
  const store = { get(k, d){ try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } } };
  const PAGE = location.pathname.replace(/\W+/g, '') || 'panel';

  /* --------------------------------------------- floating effects layer
     Rings, bursts, gathering pips: elements of their own, fixed on screen,
     never taking a click. A scroll removes them (they belong to where
     something was). */
  const fx = new Set();
  function fxEl(cls){ const el = document.createElement('div'); el.className = cls; el.setAttribute('aria-hidden', 'true'); document.body.appendChild(el); return el; }
  function fxDone(el, anim, ms){ fx.add(el); const end = () => { fx.delete(el); el.remove(); }; if (anim) { anim.onfinish = end; anim.oncancel = end; } setTimeout(end, ms + 200); }
  window.addEventListener('scroll', () => { for (const el of fx) { el.getAnimations({ subtree: true }).forEach(a => a.cancel()); el.remove(); } fx.clear(); }, { passive: true, capture: true });
  // a ring the shape of an element, growing `grow` px out on every side as it fades
  function ring(target, colour, o){
    o = o || {};
    const r = target.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const el = fxEl('cm-ring');
    const s = el.style;
    s.left = r.left + 'px'; s.top = r.top + 'px'; s.width = r.width + 'px'; s.height = r.height + 'px';
    s.borderRadius = o.radius || getComputedStyle(target).borderRadius; s.setProperty('--cm-c', colour);
    const g = o.grow || 9, dur = o.dur || 440, from = o.from || 0.7;
    const a = play(el, [{ opacity: from, scale: '1 1', easing: 'cubic-bezier(.2, .8, .3, 1)' }, { opacity: from * 0.6, offset: 0.4 }, { opacity: 0, scale: `${(r.width + 2 * g) / r.width} ${(r.height + 2 * g) / r.height}` }],
      { duration: dur, delay: o.delay || 0, fill: 'backwards' });
    fxDone(el, a, dur + (o.delay || 0));
    STATS.rings++;
  }

  /* ------------------------------------------------------- key sound
     Off unless the operator turns it on (the speaker button in the header;
     remembered on this laptop). Made on the spot with Web Audio — no files,
     a few milliseconds of sound, never in the way of the tap. */
  const SOUND_KEY = 'cm-sound';
  let soundOn = !!store.get(SOUND_KEY, false), ac = null;
  function tone(f0, f1, dur, type, gain, at){
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, at); o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), at + dur);
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(gain, at + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(ac.destination); o.start(at); o.stop(at + dur + 0.02);
  }
  function sound(kind){
    if (!soundOn) return;
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      const t = ac.currentTime + 0.002;
      if (kind === 'six') { tone(1200, 1250, 0.05, 'sine', 0.05, t); tone(1600, 1650, 0.05, 'sine', 0.05, t + 0.05); tone(2150, 2200, 0.09, 'sine', 0.055, t + 0.1); }
      else if (kind === 'four') { tone(1400, 1450, 0.05, 'sine', 0.05, t); tone(1900, 1950, 0.08, 'sine', 0.05, t + 0.055); }
      else if (kind === 'wicket') tone(220, 90, 0.16, 'triangle', 0.09, t);
      else if (kind === 'undo') tone(1400, 900, 0.08, 'sine', 0.04, t);
      else if (kind === 'extra') tone(1150, 1050, 0.04, 'triangle', 0.04, t);
      else tone(1700, 1500, 0.035, 'sine', 0.045, t);
      STATS.sounds++;
    } catch (e) { /* no audio here */ }
  }
  function soundKind(btn){
    const b = btn.dataset.ball || '';
    if (b === '6') return 'six';
    if (b === '4') return 'four';
    if (b === 'W') return 'wicket';
    if (/^(Wd|Nb|B|LB|OT)$/.test(b)) return 'extra';
    if (btn.id === 'undo-btn') return 'undo';
    return 'run';
  }
  function setupSoundButton(){
    const row = $('conn-row');
    if (!row || $('cm-sound-btn')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'cm-sound-btn'; b.className = 'small cm-sound';
    const paint = () => {
      b.textContent = soundOn ? '🔊' : '🔇';
      b.setAttribute('aria-pressed', String(soundOn));
      b.title = soundOn ? 'Key sound on — click to turn it off' : 'Key sound off — click for a soft click on every scoring key (this laptop only; keep it off if this laptop\'s sound goes into the stream)';
      b.setAttribute('aria-label', b.title);
    };
    paint();
    b.addEventListener('click', () => { soundOn = !soundOn; store.set(SOUND_KEY, soundOn); paint(); if (soundOn) sound('run'); });
    row.insertBefore(b, row.firstChild);       // (the row grows to the left: nothing already in it moves)
  }

  /* --------------------------------------------- the keys: ring and dip */
  const KEYS = '.lc-key, #card-ball-outcome .balls-grid button, #card-ball-outcome .ev-btn';
  const EXTRA = '#undo-btn';
  function keyColour(btn){
    const cs = getComputedStyle(btn), ball = btn.dataset.ball || '';
    if (ball === 'W' || btn.matches('.kw, .b-wicket')) return '#ef4444';
    return cs.getPropertyValue('--k').trim() || cs.color;
  }
  function ringFrom(btn){
    const ball = btn.dataset.ball || '', big = ball === '4' || ball === '6', c = keyColour(btn);
    ring(btn, c, { grow: big ? 14 : 9, dur: big ? 640 : 440, from: big ? 0.9 : 0.7 });
    if (big) ring(btn, c, { grow: 26, dur: 640, from: 0.9, delay: 110 });
  }
  function dip(btn){ play(btn, [{ scale: 0.95 }, { scale: 1 }], { duration: 320, easing: SPRING }); }
  // after the panel's own handler (capture only to see the tap; the effect waits for the next frame)
  document.addEventListener('click', (e) => {
    const t = e.target, btn = t && t.closest && t.closest(KEYS + ', ' + EXTRA);
    if (!btn || btn.disabled) return;
    sound(soundKind(btn));
    if (quiet()) return;
    const fromKeyOrRemote = e.detail === 0;     // a real mouse / finger tap is pressed by CSS already
    requestAnimationFrame(() => { if (fromKeyOrRemote) dip(btn); if (btn.matches(KEYS)) ringFrom(btn); });
  }, true);
  // a scoring shortcut: show it on its key. Read before the panel acts on it
  // (it scores nothing while a question is open), shown once it has.
  const SHORTCUT = Object.assign({ w: '[data-ball="W"]', s: '#lc-swap-btn, #swap-strike', h: '#highlight-btn, #save-highlight-btn' }, CFG.shortcuts || {});
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target, tag = ((t && t.tagName) || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || (t && t.isContentEditable)) return;
    const k = (e.key || '').toLowerCase();
    const sel = /^[0-6]$/.test(k) ? `[data-ball="${k}"]` : SHORTCUT[k];
    if (!sel || (k === 'h' && e.repeat)) return;   // (a held key scores again — and shows again; H does not)
    // the panels score nothing behind an open question (Panel 3's H works over one)
    const asking = document.querySelector('.wicket-modal-overlay.show:not(#auto-card-modal-overlay), .tc-overlay.show');
    if (asking && !(k === 'h' && $('save-highlight-btn'))) return;
    const btn = [...document.querySelectorAll(sel)].find(b => b.offsetParent !== null && !b.disabled);
    if (!btn) return;
    if (k !== 'h' && k !== 's') sound(soundKind(btn));
    if (quiet()) return;
    requestAnimationFrame(() => { dip(btn); if (btn.matches(KEYS)) ringFrom(btn); });
  }, true);

  /* ------------------------------------------------ numbers that changed */
  const ODO = new Set(arr('odo')), POP = new Set(arr('pop'));
  function lineHeight(el){
    const cs = getComputedStyle(el), lh = parseFloat(cs.lineHeight);
    return lh > 0 ? lh : parseFloat(cs.fontSize) * 1.15;
  }
  // The odometer: the digits that changed roll (up when the number rose,
  // down when it fell), right to left; the element's text stays exactly what
  // the panel wrote (the old digit is drawn by CSS, it is not in the text),
  // and once the roll is done the element is plain text again.
  function odometer(el, from, to){
    const segT = to.split(/(\d+)/), segF = from.split(/(\d+)/);
    if (segT.length !== segF.length) return false;
    const H = lineHeight(el);
    if (!(H > 0)) return false;
    let html = '', rolled = 0;
    for (let i = 0; i < segT.length; i++) {
      const t = segT[i], f = segF[i];
      if (i % 2 === 0) { if (t !== f) return false; html += esc(t); continue; }   // (the separators must be the same)
      if (t === f) { html += esc(t); continue; }
      const up = Number(t) >= Number(f), len = Math.max(t.length, f.length), T = t.padStart(len, ' '), F = f.padStart(len, ' ');
      for (let j = 0; j < len; j++) {
        const a = F[j], b = T[j];
        if (a === b) { html += b === ' ' ? '' : esc(b); continue; }
        rolled++;
        html += `<span class="cm-odo ${up ? 'up' : 'dn'}" style="--cm-h:${H}px"><span class="cm-odo-c" data-o="${a === ' ' ? '' : esc(a)}"><span class="cm-odo-n">${b === ' ' ? '' : esc(b)}</span></span></span>`;
      }
    }
    if (!rolled) return false;
    el.innerHTML = html;                        // (its text is still exactly `to`)
    const cols = el.querySelectorAll('.cm-odo-c');
    let left = cols.length;
    cols.forEach((c, i) => {
      const up = c.parentNode.classList.contains('up');
      const a = play(c, up ? [{ translate: '0 0' }, { translate: `0 ${-H}px` }] : [{ translate: `0 ${-H}px` }, { translate: '0 0' }],
        { duration: 420, delay: (cols.length - 1 - i) * 40, easing: GLIDE, fill: 'both' });
      const done = () => { if (--left === 0 && el.textContent === to && el.querySelector('.cm-odo')) el.textContent = to; };
      if (a) { a.onfinish = done; a.oncancel = done; } else done();
    });
    STATS.odo++;
    return true;
  }
  function watch(el){
    let last = el.textContent, anim = null;
    new MutationObserver(() => {
      const now = el.textContent;
      if (now === last) return;
      const prev = last, a = firstNumber(prev), b = firstNumber(now);
      last = now;
      if (quiet()) return;
      if (anim) { anim.cancel(); anim = null; }  // (the latest one only, never a queue)
      const down = a != null && b != null && b < a;
      const rolled = ODO.has(el.id) && odometer(el, prev, now);
      if (POP.has(el.id) && a != null && b != null && b - a >= 4) {
        anim = play(el, [{ scale: 1 }, { scale: 1.09, offset: 0.45 }, { scale: 1 }], { duration: 460, easing: OUT });
      } else if (!rolled) {
        anim = play(el, [{ opacity: 0.35, translate: down ? '0 -3px' : '0 3px' }, { opacity: 1, translate: '0 0' }], { duration: 230, easing: OUT });
      }
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }

  /* ------------------------------------------- moments: wicket, 50, 100, 5 */
  const GOLD = '#f5c542';
  function burst(row, colour){
    if (!row || quiet()) return;
    ring(row, colour, { grow: 8, dur: 700, from: 0.95 });
    ring(row, colour, { grow: 20, dur: 800, from: 0.8, delay: 140 });
    ring(row, colour, { grow: 34, dur: 900, from: 0.6, delay: 280 });
    STATS.bursts++;
  }
  function glowText(el, colour, ms){
    if (!el || quiet()) return;
    play(el, [{ textShadow: '0 0 0 transparent' }, { textShadow: `0 0 26px ${colour}`, offset: 0.3 }, { textShadow: '0 0 0 transparent' }], { duration: ms || 1100, easing: 'ease-out' });
  }
  const rowOf = (el) => el.closest('.lc-player, .live-player-row') || el;
  function watchScore(el){
    const parse = (s) => { const m = /(\d+)\s*[-/]\s*(\d+)/.exec(s || ''); return m ? [Number(m[1]), Number(m[2])] : null; };
    let last = parse(el.textContent);
    new MutationObserver(() => {
      const now = parse(el.textContent);
      if (!now || (last && now[0] === last[0] && now[1] === last[1])) { last = now || last; return; }
      const fell = last && now[1] > last[1];
      last = now;
      if (fell) glowText(el, '#ef4444', 1000);
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }
  // a batter's 50 / 100 / 150 / 200 — per player (a strike change moves them between rows)
  const batRuns = new Map();
  function watchBatter(nameEl, figEl){
    const check = () => {
      const name = (nameEl.textContent || '').trim(), runs = firstNumber(figEl.textContent);
      if (!name || name === '—' || runs == null) return;
      const was = batRuns.get(name);
      batRuns.set(name, runs);
      if (was == null || runs <= was) return;
      const mark = [50, 100, 150, 200].find(m => was < m && runs >= m);
      if (mark) { burst(rowOf(figEl), GOLD); glowText(figEl, GOLD, 1400); }
    };
    new MutationObserver(check).observe(figEl, { childList: true, characterData: true, subtree: true });
    check();
  }
  // a bowler's five-for (the figures read W-R(O) in Panel 1, O-M-R-W in Panel 3)
  function watchBowler(nameEl, figEl, form){
    const seen = new Map();
    const wkts = (s) => { const n = (s || '').match(/\d+(?:\.\d+)?/g) || []; return form === 'omrw' ? (n.length >= 4 ? Number(n[3]) : null) : (n.length ? Number(n[0]) : null); };
    const check = () => {
      const name = (nameEl.textContent || '').trim(), w = wkts(figEl.textContent);
      if (!name || name === '—' || w == null) return;
      const was = seen.get(name);
      seen.set(name, w);
      if (was != null && was < 5 && w >= 5) { burst(rowOf(figEl), GOLD); glowText(figEl, GOLD, 1400); }
    };
    new MutationObserver(check).observe(figEl, { childList: true, characterData: true, subtree: true });
    check();
  }

  /* ------------------------------------------ the crease: strike changes
     The rows stay where they are (the top one is the striker's); when the
     two batters change ends, each one's name and figures slide from the
     other row into this one. */
  function watchSwap(A, B){
    const a = A.map($).filter(Boolean), b = B.map($).filter(Boolean);
    if (!a.length || a.length !== b.length) return;
    let na = a[0].textContent, nb = b[0].textContent;
    const mo = new MutationObserver(() => {
      const xa = a[0].textContent, xb = b[0].textContent;
      if (xa === na && xb === nb) return;
      const swapped = xa === nb && xb === na && xa !== xb && xa.trim() && xb.trim() && xa.trim() !== '—' && xb.trim() !== '—';
      na = xa; nb = xb;
      if (!swapped || quiet()) return;
      const ra = a.map(e => e.getBoundingClientRect()), rb = b.map(e => e.getBoundingClientRect());
      const slide = (el, from, to) => play(el, [{ translate: `${from.left - to.left}px ${from.top - to.top}px`, opacity: 0.85 }, { translate: '0 0', opacity: 1 }], { duration: 460, easing: GLIDE });
      a.forEach((el, i) => slide(el, rb[i], ra[i]));
      b.forEach((el, i) => slide(el, ra[i], rb[i]));
      // (Panel 1's own name-change fade on the two rows: the slide says it better)
      [a[0], b[0]].forEach(el => { const row = el.closest('.lc-player, .live-player-row'); if (row) row.getAnimations().forEach(x => { if (x.animationName === 'lcIn') x.cancel(); }); });
      STATS.swaps++;
    });
    [a[0], b[0]].forEach(el => mo.observe(el, { childList: true, characterData: true, subtree: true }));
  }

  /* ------------------------------------------------------------ the over
     The ball just bowled pops into "this over"; when the over is done its
     balls gather into the first one and go. (The panel draws the strip
     afresh on every render — the pop carries on on the new pip.) */
  function watchOver(box){
    const FRAMES = [{ opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1.16, offset: 0.6 }, { opacity: 1, scale: 1 }], TIMING = { duration: 360, easing: OUT };
    const PROPS = ['width', 'height', 'borderRadius', 'backgroundColor', 'backgroundImage', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'boxShadow'];
    let n = box.children.length, popAt = -1, popEl = null, snap = null, snapRaf = 0;
    const takeSnap = () => {
      snapRaf = 0;
      if (!box.children.length || box.offsetParent === null) return;
      snap = { at: box.getBoundingClientRect(), pips: [...box.children].map(p => { const cs = getComputedStyle(p), s = {}; PROPS.forEach(k => { s[k] = cs[k]; }); s.border = `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`; return { r: p.getBoundingClientRect(), s, t: p.textContent }; }) };
    };
    function gather(){
      if (!snap || !snap.pips.length || quiet()) return;
      const now = box.getBoundingClientRect(), dx = now.left - snap.at.left, dy = now.top - snap.at.top, first = snap.pips[0].r;
      const wrap = fxEl('cm-gather');
      let longest = 0;
      snap.pips.forEach((p, i) => {
        const d = document.createElement('div');
        Object.assign(d.style, p.s, { position: 'fixed', left: (p.r.left + dx) + 'px', top: (p.r.top + dy) + 'px', margin: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' });
        d.textContent = p.t;
        wrap.appendChild(d);
        const delay = (snap.pips.length - 1 - i) * 28, dur = 440;
        longest = Math.max(longest, delay + dur);
        play(d, [{ translate: '0 0', scale: 1, opacity: 1 }, { translate: `${first.left - p.r.left}px 0`, scale: 0.9, opacity: 1, offset: 0.55 }, { translate: `${first.left - p.r.left}px 0`, scale: 0.2, opacity: 0 }], { duration: dur, delay, easing: GLIDE, fill: 'both' });
      });
      fxDone(wrap, null, longest);
      STATS.gathers++;
    }
    new MutationObserver(() => {
      const m = box.children.length, last = box.lastElementChild;
      if (m === 0 && n > 0) gather();
      if (!quiet()) {
        if (m > n && last) { popAt = performance.now(); popEl = last; play(last, FRAMES, TIMING); }
        else if (m === n && last && popEl && last !== popEl && performance.now() - popAt < TIMING.duration) {
          const a = play(last, FRAMES, TIMING);
          if (a) a.currentTime = performance.now() - popAt;
          popEl = last;
        }
      }
      n = m;
      if (!snapRaf) snapRaf = requestAnimationFrame(takeSnap);   // (where they are, read with the frame — never mid-render)
    }).observe(box, { childList: true });
    snapRaf = requestAnimationFrame(takeSnap);
  }

  /* ------------------------------------------- buttons that wait on the server
     A button whose click starts a request (a fetch begun in the same
     moment) shows a spinner if the request takes a while, then ✓ or ✕. A
     second click on a save / send kind of button is held back while its
     first one is still waiting. Scoring keys, Undo, Highlights, chips and
     the quick-nav are never touched: a tap there always goes through. */
  const NO_BUSY = KEYS + ', [data-ball], #undo-btn, #highlight-btn, #save-highlight-btn, .pro-dd-trigger, #cm-sound-btn, #quick-nav button, [role=radio]';
  const SUBMIT = /\b(save|send|upload|import|publish|create|sync|submit|apply|download|export)\b/i;
  const busy = new Map();
  let clickBtn = null, clickT = 0, spotRaf = 0;
  function spot(el, btn){ const r = btn.getBoundingClientRect(); el.style.left = (r.right - 10) + 'px'; el.style.top = (r.top - 7) + 'px'; el.style.display = r.width && btn.offsetParent !== null ? '' : 'none'; }
  function follow(){
    spotRaf = 0;
    let any = false;
    busy.forEach((st, btn) => { if (st.spin) { spot(st.spin, btn); any = true; } });
    document.querySelectorAll('.cm-done').forEach(d => { if (d._btn) { spot(d, d._btn); any = true; } });
    if (any) spotRaf = requestAnimationFrame(follow);
  }
  const keepFollowing = () => { if (!spotRaf) spotRaf = requestAnimationFrame(follow); };
  function finish(btn, ok){
    const st = busy.get(btn); if (!st) return;
    st.ok = st.ok && ok;
    if (--st.n > 0) return;
    busy.delete(btn); clearTimeout(st.timer);
    btn.removeAttribute('aria-busy');
    if (st.spin) st.spin.remove();
    if (st.spin || !st.ok) {                    // (a quick success needs no tick)
      const d = document.createElement('div');
      d.className = 'cm-done ' + (st.ok ? 'ok' : 'bad'); d.textContent = st.ok ? '✓' : '✕'; d.setAttribute('aria-hidden', 'true'); d._btn = btn;
      document.body.appendChild(d); spot(d, btn); keepFollowing();
      const a = quiet() ? null : play(d, [{ scale: 0.3, opacity: 0 }, { scale: 1.12, opacity: 1, offset: 0.25 }, { scale: 1, opacity: 1, offset: 0.4 }, { scale: 1, opacity: 1, offset: 0.85 }, { scale: 0.8, opacity: 0 }], { duration: 1300, easing: OUT });
      const end = () => d.remove();
      if (a) { a.onfinish = end; a.oncancel = end; } else setTimeout(end, 1300);
    }
  }
  function track(btn, p){
    let st = busy.get(btn);
    if (!st) { st = { n: 0, ok: true, spin: null, timer: 0 }; busy.set(btn, st); }
    st.n++;
    btn.setAttribute('aria-busy', 'true');
    if (!st.timer && !st.spin) st.timer = setTimeout(() => {
      if (busy.get(btn) !== st) return;
      st.spin = document.createElement('div'); st.spin.className = 'cm-spin'; st.spin.setAttribute('aria-hidden', 'true');
      document.body.appendChild(st.spin); spot(st.spin, btn); keepFollowing(); STATS.busy++;
    }, 220);
    p.then((res) => {
      if (!res || !res.ok) return finish(btn, false);
      const type = (res.headers && res.headers.get('content-type')) || '', size = Number((res.headers && res.headers.get('content-length')) || 0);
      if (!/json/.test(type) || !size || size > 200000) return finish(btn, true);   // (big answers are not read twice)
      res.clone().json().then(j => finish(btn, !(j && j.success === false)), () => finish(btn, true));
    }, () => finish(btn, false));
  }
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('button');
    if (!btn || btn.matches(NO_BUSY)) return;
    if (busy.has(btn) && SUBMIT.test(btn.textContent || '')) {   // its first click is still on its way
      e.stopImmediatePropagation(); e.preventDefault(); STATS.blocked++;
      if (!quiet()) play(btn, [{ translate: '0 0' }, { translate: '-3px 0' }, { translate: '3px 0' }, { translate: '0 0' }], { duration: 220 });
      return;
    }
    clickBtn = btn; clearTimeout(clickT); clickT = setTimeout(() => { clickBtn = null; }, 0);
  }, true);
  if (typeof window.fetch === 'function') {
    const realFetch = window.fetch;
    const wrapped = function(){
      const p = realFetch.apply(window, arguments);
      const btn = clickBtn;
      if (btn && p && typeof p.then === 'function') { try { track(btn, p); } catch (e) { /* the request goes on regardless */ } }
      return p;
    };
    try { window.fetch = wrapped; } catch (e) { /* (a read-only fetch: no spinners) */ }
  }

  /* --------------------------------------------------------- cards fold
     A card with a heading folds to its heading when the heading is clicked
     (and unfolds again), remembered on this laptop. The live scoring cards
     never fold. A card that is jumped to (quick-nav, a focus jump) unfolds. */
  const KEEP_OPEN = new Set(arr('liveCards'));
  const FOLD_KEY = 'cm-folded:' + PAGE;
  const folded = new Set(store.get(FOLD_KEY, []));
  const saveFolded = () => store.set(FOLD_KEY, [...folded]);
  function foldedHeight(card, h2){ const cr = card.getBoundingClientRect(), hr = h2.getBoundingClientRect(), cs = getComputedStyle(card); return (hr.bottom - cr.top) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth); }
  function animateHeight(card, from, to, after){
    if (quiet()) { after(); return; }
    card.style.height = from + 'px'; card.style.overflow = 'hidden';
    void card.offsetHeight;
    card.style.transition = `height .34s ${GLIDE}`;
    card.style.height = to + 'px';
    let done = false;
    const end = () => { if (done) return; done = true; card.removeEventListener('transitionend', te); card.style.transition = ''; card.style.height = ''; card.style.overflow = ''; after(); };
    const te = (ev) => { if (ev.target === card && ev.propertyName === 'height') end(); };
    card.addEventListener('transitionend', te);
    setTimeout(end, 500);
  }
  function fold(card, instant){
    const h2 = card.querySelector(':scope > h2');
    if (!h2 || card.classList.contains('cm-folded')) return;
    folded.add(card.id); saveFolded();
    h2.setAttribute('aria-expanded', 'false');
    if (instant || quiet()) { card.classList.add('cm-folded'); return; }
    const from = card.offsetHeight, to = foldedHeight(card, h2);
    animateHeight(card, from, to, () => { card.classList.add('cm-folded'); });
  }
  function unfold(card){
    if (!card.classList.contains('cm-folded')) return;
    folded.delete(card.id); saveFolded();
    const h2 = card.querySelector(':scope > h2'); if (h2) h2.setAttribute('aria-expanded', 'true');
    const from = card.offsetHeight;
    card.classList.remove('cm-folded');
    animateHeight(card, from, card.offsetHeight, () => {});
  }
  function setupFolding(){
    for (const card of document.querySelectorAll('.card[id]')) {
      const h2 = card.querySelector(':scope > h2');
      if (!h2 || KEEP_OPEN.has(card.id)) continue;
      card.classList.add('cm-foldable');
      h2.setAttribute('aria-expanded', 'true');
      if (!h2.title) h2.title = 'Click to fold or unfold this card';
      h2.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, select, textarea, label')) return;
        if (card.classList.contains('cm-folded')) unfold(card); else fold(card);
      });
      if (folded.has(card.id)) fold(card, true);
      // a jump to it (the quick-nav, a "Change" on the live console) unfolds it
      new MutationObserver(() => { if (card.classList.contains('flash')) unfold(card); }).observe(card, { attributes: true, attributeFilter: ['class'] });
    }
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('#quick-nav [data-target]');
      const card = b && $(b.getAttribute('data-target'));
      if (card) unfold(card);
    }, true);
  }

  /* --------------------------------------- cards far off screen: not drawn
     content-visibility: auto, only on cards it cannot change: never the
     live scoring, recording or Stream Engine cards, never a card with a
     video / canvas, numbered lists (counters), something positioned against
     a box outside it, or anything sticking out of it. One card at a time,
     when the page is idle. */
  const NO_CV = new Set([...arr('liveCards'), ...arr('drawAlways')]);
  function setupCv(){
    const cards = [...document.querySelectorAll('.card[id]')].filter(c => !NO_CV.has(c.id) && !c.closest('.wicket-modal-overlay, .tc-overlay, .ww-overlay'));
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 30));
    const step = () => {
      const card = cards.shift(); if (!card) return;
      try {
        if (card.offsetParent !== null && !card.querySelector('video, canvas, iframe, object, embed')) {
          const cr = card.getBoundingClientRect();
          let ok = cr.height > 0;
          for (const el of card.querySelectorAll('*')) {
            const cs = getComputedStyle(el);
            if (cs.counterIncrement !== 'none' || cs.counterReset !== 'none' || cs.position === 'fixed') { ok = false; break; }
            if (cs.position === 'absolute' && el.offsetParent && el.offsetParent !== card && !card.contains(el.offsetParent)) { ok = false; break; }
            const r = el.getBoundingClientRect();
            if (r.width && (r.left < cr.left - 1 || r.right > cr.right + 1 || r.top < cr.top - 1 || r.bottom > cr.bottom + 1)) { ok = false; break; }
          }
          if (ok) { card.style.containIntrinsicSize = `auto ${Math.round(cr.height)}px`; card.classList.add('cm-cv'); }
        }
      } catch (e) { /* leave it drawn */ }
      idle(step);
    };
    idle(step);
  }

  /* -------------------------------------------- quick-nav: what is in view */
  function setupQuickNav(){
    const qn = $('quick-nav'); if (!qn) return;
    const items = [...qn.querySelectorAll('button[data-target]')].map(b => ({ b, t: $(b.getAttribute('data-target')) })).filter(x => x.t);
    if (!items.length) return;
    const ind = document.createElement('i'); ind.className = 'cm-qn-ind'; ind.setAttribute('aria-hidden', 'true');
    qn.appendChild(ind);
    let cur = null, picked = null, raf = 0, first = true;
    const move = (x) => {
      if (cur === x) return;
      if (cur) cur.b.classList.remove('cm-qn-on');
      cur = x;
      if (!x) { ind.style.opacity = '0'; return; }
      x.b.classList.add('cm-qn-on');
      const label = x.b.closest('.qn-group') && x.b.closest('.qn-group').querySelector('.qn-label');
      if (label) ind.style.setProperty('--cm-qn-c', getComputedStyle(label).color);
      if (first) { ind.style.transition = 'none'; first = false; requestAnimationFrame(() => requestAnimationFrame(() => { ind.style.transition = ''; })); }
      ind.style.opacity = '1';
      ind.style.transform = `translateX(${x.b.offsetLeft}px) scaleX(${x.b.offsetWidth / 100})`;
      // keep it on screen when the bar is wider than the window
      const l = x.b.offsetLeft, r = l + x.b.offsetWidth;
      if (l < qn.scrollLeft || r > qn.scrollLeft + qn.clientWidth) qn.scrollTo({ left: Math.max(0, l - 40), behavior: quiet() ? 'auto' : 'smooth' });
    };
    const spy = () => {
      raf = 0;
      const top = qn.getBoundingClientRect().bottom + 8;
      let best = null, bestD = Infinity;
      for (const x of items) {
        if (x.t.offsetParent === null) continue;
        const r = x.t.getBoundingClientRect();
        if (r.bottom <= top + 40 || r.top >= innerHeight - 60) continue;   // (not really in view)
        if (x === picked) { best = x; break; }
        const d = Math.abs(r.top - top);
        if (d < bestD) { bestD = d; best = x; }
      }
      if (picked && best !== picked) picked = null;
      move(best);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(spy); };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    qn.addEventListener('click', (e) => { const b = e.target.closest('button[data-target]'); const x = b && items.find(i => i.b === b); if (x) { picked = x; move(x); } });
    schedule();
  }

  /* --------------------------------------------- a toast replacing another */
  function watchToast(t){
    let lastText = t.textContent, shown = t.classList.contains('show');
    new MutationObserver(() => {
      const text = t.textContent, isShown = t.classList.contains('show');
      if (text !== lastText && shown && isShown && lastText && !quiet()) {
        const r = t.getBoundingClientRect(), cs = getComputedStyle(t);
        if (r.width) {
          const g = fxEl('cm-toast-ghost');
          ['backgroundColor', 'backgroundImage', 'color', 'borderTopColor', 'borderTopWidth', 'borderTopStyle', 'borderRadius', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'boxShadow', 'textAlign'].forEach(k => { g.style[k] = cs[k]; });
          Object.assign(g.style, { borderStyle: cs.borderTopStyle, borderWidth: cs.borderTopWidth, borderColor: cs.borderTopColor, position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', zIndex: cs.zIndex, margin: '0', pointerEvents: 'none', boxSizing: 'border-box' });
          g.textContent = lastText;
          const a = play(g, [{ translate: '0 0', opacity: 1 }, { translate: `0 ${-(r.height + 10)}px`, opacity: 0.75, offset: 0.35 }, { translate: `0 ${-(r.height + 18)}px`, opacity: 0 }], { duration: 900, easing: OUT, fill: 'both' });
          fxDone(g, a, 900);
          play(t, [{ scale: 0.96, opacity: 0.6 }, { scale: 1, opacity: 1 }], { duration: 240, easing: SPRING });
        }
      }
      lastText = text; shown = isShown;
    }).observe(t, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  /* ------------------------- segmented chips (only with cricket-polish.css) */
  function setupSegments(){
    if (getComputedStyle(document.documentElement).getPropertyValue('--cm-polish').trim() !== '1') return;
    for (const g of document.querySelectorAll(CFG.segments || '.bcg-seg[role=radiogroup], .bcg-chips[role=radiogroup]')) {
      if (g.querySelector(':scope > .cm-seg-pill')) continue;
      g.classList.add('cm-seg');
      const pill = document.createElement('i'); pill.className = 'cm-seg-pill'; pill.setAttribute('aria-hidden', 'true');
      g.appendChild(pill);
      let placed = false;
      const place = () => {
        const on = g.querySelector(':scope > [role=radio][aria-checked="true"]');
        if (!on || g.offsetParent === null || !on.offsetWidth) { pill.style.opacity = '0'; placed = false; return; }
        if (!placed || quiet()) { pill.style.transition = 'none'; requestAnimationFrame(() => requestAnimationFrame(() => { pill.style.transition = ''; })); }
        placed = true;
        pill.style.opacity = '1'; pill.style.width = on.offsetWidth + 'px'; pill.style.height = on.offsetHeight + 'px';
        pill.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
      };
      new MutationObserver(place).observe(g, { attributes: true, subtree: true, attributeFilter: ['aria-checked', 'hidden'] });
      if (window.ResizeObserver) new ResizeObserver(place).observe(g);
      place();
    }
  }

  function start(){
    setupSoundButton();
    arr('tick').forEach(id => { const el = $(id); if (el) watch(el); });
    arr('score').forEach(id => { const el = $(id); if (el) watchScore(el); });
    arr('batters').forEach(([n, f]) => { const a = $(n), b = $(f); if (a && b) watchBatter(a, b); });
    if (Array.isArray(CFG.bowler)) { const [n, f, form] = CFG.bowler; const a = $(n), b = $(f); if (a && b) watchBowler(a, b, form); }
    if (Array.isArray(CFG.swap) && CFG.swap.length === 2) watchSwap(CFG.swap[0], CFG.swap[1]);   // (after the number watchers: its slide wins)
    const over = $('over-preview'); if (over) watchOver(over);
    const t = $('toast'); if (t) watchToast(t);
    setupFolding();
    setupQuickNav();
    setupSegments();
    // the off-screen drawing check runs once the page has settled
    const later = () => setTimeout(setupCv, 1500);
    if (document.readyState === 'complete') later(); else window.addEventListener('load', later, { once: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
