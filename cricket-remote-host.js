/* ============================================================
   📱 PHONE REMOTE — the LAPTOP side (cricket-panel.html and
   cricket-panel3.html both load this file, after their own script).

   A phone paired with the QR code here sends COMMANDS; this panel carries
   each one out by pressing its OWN controls — the very buttons, modals and
   handlers the operator uses. Nothing is re-implemented:
     • 4 on the phone  →  this panel's [data-ball="4"] is clicked →
       recordBall() → the overlay update, the ball log, the outbox and the
       FOUR clip (triggerClip → this laptop's Clipper / Stream Engine, its
       recording, its timing, its file names, its upload) — exactly as a
       click here.
     • WICKET / Wide / No Ball / … open this panel's own popups; the phone
       shows a copy of the popup that is open here and answers it through
       the same controls, so every rule and check of the panel applies.
     • GRAPHICS / CLIPPER / MATCH: the panel's own cards (Broadcast Graphics,
       Stat Cards, Summary Graphics, Milestones, Recording, Bowler, …) are
       read off this page as they are — every button, switch and choice with
       its live state — and shown on the phone. A tap there presses the same
       control here. A control added to one of those cards later shows up on
       the phone by itself.
     • Clips: every clip request this panel sends to its local Clipper /
       Stream Engine is followed by its clip id until the laptop reports the
       file cut and saved — only then does the phone say "Clip Done!".
   Commands run one at a time, in order, and each has an id: a command the
   phone sends twice (a retry after a dropped answer) is done once.
   ============================================================ */
(function(){
  'use strict';
  if(window.__crRemoteHost) return;
  if(typeof io !== 'function' || typeof state === 'undefined' || typeof currentMatchId !== 'function') return;
  window.__crRemoteHost = true;

  const PANEL = document.getElementById('save-highlight-btn') ? 'panel3' : 'panel';
  // The popups the phone may see and answer — scoring only. Setup screens,
  // the match-lock code, Drive folders, Edit Scorecard etc. stay on the laptop.
  const MIRROR = new Set(['wd-overlay', 'wicket-modal-overlay', 'caught-modal-overlay', 'stumped-modal-overlay', 'runout-modal-overlay',
    'retired-modal-overlay', 'extras-modal-overlay', 'overthrow-modal-overlay', 'newbat-modal-overlay', 'newover-modal-overlay',
    'midover-bowler-overlay', 'ww-overlay', 'penalty-modal-overlay', 'auto-card-modal-overlay', 'correct-batsman-modal-overlay',
    'ba-overlay', 'ip-overlay']);
  // Open, but never in the way of the next delivery (it answers itself).
  const NONBLOCKING = new Set(['auto-card-modal-overlay']);
  const BALL_KINDS = ['0', '1', '2', '3', '4', '5', '6', 'W', 'Wd', 'Nb', 'B', 'LB', 'OT'];
  // WICKET straight into one dismissal of the panel's own Wicket Details.
  const BALL_PICKS = ['Run Out'];
  const QUICK = { penalty: 'lc-penalty-btn', retired: 'lc-retired-btn', impact: 'lc-impact-btn' };
  const DONE_KEEP = 300;

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const norm = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safe = (fn, dflt) => { try{ const v = fn(); return v === undefined ? dflt : v; }catch(e){ return dflt; } };
  const mid = () => safe(() => currentMatchId(), '') || '';
  const rev = () => Number(state && state.localRev) || 0;
  function randId(n){
    const a = new Uint8Array(n);
    (window.crypto || {}).getRandomValues ? window.crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = Math.floor(Math.random() * 256); });
    return Array.from(a, b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'[b & 63]).join('');
  }
  const store = {
    get(k){ try{ return JSON.parse(localStorage.getItem(k) || 'null'); }catch(e){ return null; } },
    set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
  };
  // This laptop's identity for one match: phones pair with it. The epoch is
  // bumped by "Disconnect phones", which ends every earlier pairing.
  function hostRec(matchId){
    const k = 'cricketRemoteHost:' + matchId;
    let r = store.get(k);
    if(!r || typeof r.id !== 'string' || !Number.isSafeInteger(r.epoch)){ r = { id: randId(18), epoch: 1 }; store.set(k, r); }
    return r;
  }

  /* ---------------- toasts: what the panel tells the operator, the phone hears too ---------------- */
  let capturing = null;
  let rs = null;
  const origToast = window.toast;
  if(typeof origToast === 'function'){
    window.toast = function(msg){
      const text = norm(msg);
      if(capturing) capturing.push(text);
      if(text && rs && rs.connected && registeredFor) rs.emit('remoteHost:toast', { text });
      return origToast.apply(this, arguments);
    };
  }

  /* ---------------- which popup is open ---------------- */
  function overlayTitle(el){
    const h = el.querySelector('h1, h2, h3, h4');
    return norm(h ? textOf(h) : (el.getAttribute('aria-label') || '')) || 'a window';
  }
  function openOverlay(){
    const list = Array.prototype.filter.call(document.querySelectorAll('[id$="overlay"].show'), el => el.id !== 'cr-remote-overlay');
    const el = list[list.length - 1];
    return el ? { el, id: el.id, title: overlayTitle(el) } : null;
  }
  // A popup that stops the next delivery until it is answered.
  function blockingOverlay(){
    const list = Array.prototype.filter.call(document.querySelectorAll('[id$="overlay"].show'),
      el => el.id !== 'cr-remote-overlay' && el.id !== 'ww-overlay' && !NONBLOCKING.has(el.id));
    const el = list[list.length - 1];
    return el ? { el, id: el.id, title: overlayTitle(el) } : null;
  }

  /* ---------------- reading the panel's own controls ----------------
     Straight off this page's DOM: headings, text, status rows, buttons (with
     their on / disabled state), on-off switches, choice groups, dropdowns,
     inputs, the wagon wheel. A control is named by its id, or its position
     inside its card; the phone hands that name back, and it is checked
     against the control's text before anything is pressed. */
  function shown(el){
    if(el.hidden) return false;
    if(el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) return false;
    const cs = window.getComputedStyle ? getComputedStyle(el) : null;
    return !(cs && (cs.display === 'none' || cs.visibility === 'hidden'));
  }
  function shownUpTo(el, root){
    for(let n = el; n; n = n.parentElement){
      if(!(n.tagName === 'SELECT' && n._proDD) && !shown(n)) return false;
      if(n === root) return true;
    }
    return true;
  }
  function textOf(el){
    let out = '';
    (function walk(n){
      for(const c of n.childNodes){
        if(c.nodeType === 3) out += ' ' + c.nodeValue;
        else if(c.nodeType === 1 && !/^(SVG|svg|KBD|STYLE|SCRIPT|SELECT|OPTION|TEMPLATE|DATALIST)$/.test(c.tagName) && shown(c)) walk(c);
      }
    })(el);
    return norm(out);
  }
  function refIn(el, root){
    if(el.id) return '#' + el.id;
    const path = [];
    for(let n = el; n && n !== root; n = n.parentElement) path.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
    return 'p:' + path.join('.');
  }
  function resolveIn(root, ref){
    if(typeof ref !== 'string' || !root) return null;
    if(ref[0] === '#'){ const el = document.getElementById(ref.slice(1)); return el && (el === root || root.contains(el)) ? el : null; }
    if(!ref.startsWith('p:')) return null;
    let n = root;
    if(ref.length > 2) for(const i of ref.slice(2).split('.')){ n = n && n.children[Number(i)]; }
    return n || null;
  }
  const isBtn = (el) => el.tagName === 'BUTTON' || /^(button|radio|tab|option)$/.test(el.getAttribute('role') || '') || el.classList.contains('wm-pill');
  const isOn = (el) => ['on', 'active', 'selected', 'sel', 'picked'].some(c => el.classList.contains(c)) || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true';
  const INTERACTIVE = 'button, input, select, textarea, [role=button], [role=radio], [role=tab], .wm-pill, #ww-svg';
  function sigOf(el){
    if(el.tagName === 'SELECT') return 'select';
    if(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return 'input:' + (el.type || 'text');
    if(el.tagName === 'svg' || el.tagName === 'SVG') return 'svg';
    return 'btn:' + textOf(el).slice(0, 60);
  }
  function toneOf(el){
    const c = ' ' + (el.className && el.className.baseVal == null ? el.className : '') + ' ';
    if(/ (bcg-stop) /.test(c) || /border-color:var\(--red\)/.test(el.getAttribute('style') || '')) return 'stop';
    if(/ (primary|wd-confirm) /.test(c)) return 'primary';
    if(/ (b-wicket) /.test(c)) return 'wicket';
    if(/ (b-extra) /.test(c)) return 'extra';
    if(/ (ghost|wm-cancel|ww-off) /.test(c)) return 'ghost';
    return '';
  }
  function selectItems(sel){
    if(sel._proDD && typeof sel._proDD.items === 'function'){
      const items = safe(() => sel._proDD.items(), []) || [];
      if(items.length) return items.map(it => ({ v: String(it.id), l: norm(it.label) + (it.sub ? ' · ' + norm(it.sub) : '') }));
    }
    return Array.prototype.filter.call(sel.options, o => o.value !== '' && !o.disabled).map(o => ({ v: o.value, l: norm(o.textContent) }));
  }
  function placeholderOf(sel){
    const first = sel.options[0];
    return first && first.value === '' ? norm(first.textContent) : '';
  }
  // A card's title without its "— note" tail.
  function cardTitle(card){
    const h = card && card.querySelector(':scope > h2, :scope > div > h2');
    if(!h) return '';
    const c = h.cloneNode(true);
    c.querySelectorAll('.note, span[id]').forEach(n => n.remove());
    return norm(c.textContent);
  }
  // Reads one or more roots (cards, rows or single buttons) into items.
  // A ref is "<root index>|<ref inside that root>".
  function serialize(roots, exclude){
    const items = [];
    let tooBig = false;
    const push = (it) => { if(items.length >= 260){ tooBig = true; return; } items.push(it); };
    const ex = exclude || new Set();
    roots.forEach((root, ri) => {
      if(!root) return;
      const R = (el) => ri + '|' + refIn(el, root);
      function visit(c){
        if(tooBig || ex.has(c)) return;
        if(c.tagName === 'SELECT' && c._proDD){
          if(c._proDD.wrap && !shown(c._proDD.wrap)) return;
          push({ k: 's', ref: R(c), sig: 'select', value: c.value, ph: placeholderOf(c) || '— choose —', opts: selectItems(c), dis: !!c.disabled });
          return;
        }
        if(c.classList && c.classList.contains('pro-dd')) return;      // shown above, as its select
        if(/^(SCRIPT|STYLE|TEMPLATE|DATALIST|A)$/.test(c.tagName) || !shown(c)) return;
        if(c.id === 'ww-svg'){
          push({ k: 'ww', ref: R(c), zones: wwZones(), boundary: c.classList.contains('boundary') });
          return;
        }
        if(c.tagName === 'svg' || c.tagName === 'SVG') return;
        if(c.tagName === 'H2' && c.parentElement && (c.parentElement === root && root.classList.contains('card') || c.parentElement.parentElement === root && root.classList.contains('card'))) return;   // the card title is the section's name
        if(c.getAttribute('role') === 'radiogroup'){
          const opts = Array.prototype.filter.call(c.querySelectorAll('[role=radio]'), b => shown(b)).map(b => ({ ref: R(b), sig: sigOf(b), text: textOf(b), on: isOn(b), dis: !!b.disabled || b.getAttribute('aria-disabled') === 'true' }));
          const lbId = c.getAttribute('aria-labelledby');
          const label = norm(c.getAttribute('aria-label') || (lbId && $(lbId) ? textOf($(lbId)) : ''));
          // its label already went out as text just before: once is enough
          const prev = items[items.length - 1];
          if(label && prev && prev.k === 't' && prev.text.toLowerCase() === label.toLowerCase()) items.pop();
          if(opts.length) push({ k: 'seg', label, opts });
          for(const x of c.children) if(x.getAttribute('role') !== 'radio') visit(x);
          return;
        }
        if(isBtn(c)){
          const label = textOf(c);
          if(!label) return;
          const b = c.querySelector('b'), sm = c.querySelector('small'), ico = c.querySelector('.bcg-ico');
          const it = { k: 'b', ref: R(c), sig: sigOf(c), text: label, on: isOn(c), dis: !!c.disabled || c.getAttribute('aria-disabled') === 'true', tone: toneOf(c) };
          if(b){ it.title = textOf(b); it.sub = sm ? textOf(sm) : ''; it.ico = ico ? textOf(ico) : ''; it.tile = true; }
          push(it);
          return;
        }
        if(c.tagName === 'SELECT'){
          push({ k: 's', ref: R(c), sig: 'select', value: c.value, ph: placeholderOf(c), opts: selectItems(c), dis: !!c.disabled });
          return;
        }
        if(c.tagName === 'INPUT' || c.tagName === 'TEXTAREA'){
          const type = (c.type || 'text').toLowerCase();
          if(type === 'password' || type === 'hidden' || type === 'file' || type === 'color') return;
          if(type === 'checkbox' || type === 'radio'){
            const lab = c.closest('label');
            push({ k: 'tg', ref: R(c), sig: sigOf(c), on: !!c.checked, text: lab ? textOf(lab) : norm(c.getAttribute('aria-label') || ''), radio: type === 'radio', dis: !!c.disabled });
          } else {
            push({ k: 'i', ref: R(c), sig: sigOf(c), value: String(c.value || '').slice(0, 200), ph: c.placeholder || '', num: type === 'number', dis: !!c.disabled });
          }
          return;
        }
        // one switch + its words (a .toggle-row, a <label> with text): one item
        const controls = c.querySelectorAll('input, button, select, textarea');
        if(controls.length === 1 && controls[0].type === 'checkbox' && shown(controls[0].closest('label') || controls[0])){
          const inp = controls[0];
          push({ k: 'tg', ref: R(inp), sig: sigOf(inp), on: !!inp.checked, text: textOf(c), dis: !!inp.disabled });
          return;
        }
        if(/^H[1-4]$/.test(c.tagName)){ const t = textOf(c); if(t) push({ k: 'h', text: t }); return; }
        const interactive = c.querySelector(INTERACTIVE + ', h1, h2, h3, h4');
        if(!interactive){
          const cs = window.getComputedStyle ? getComputedStyle(c) : null;
          const kids = Array.prototype.filter.call(c.children, x => shown(x));
          // a label / value grid (Recording ● Active, Buffer ● 12 s, …)
          if(cs && cs.display === 'grid' && kids.length >= 2 && kids.length % 2 === 0 && kids.every(x => !x.children.length || x.querySelector('b, small'))){
            const rows = [];
            for(let i = 0; i < kids.length; i += 2) rows.push([textOf(kids[i]), textOf(kids[i + 1])]);
            push({ k: 'kv', rows });
            return;
          }
          const t = textOf(c);
          if(t){
            const cls = String(c.className || '');
            const small = /font-size:\s*1[01](\.\d+)?px/.test(c.getAttribute('style') || '') && /opacity/.test(c.getAttribute('style') || '');
            const it = { k: 't', text: t.slice(0, 600), tone: c.getAttribute('role') === 'status' ? (c.classList.contains('on') ? 'air' : 'status') : /shortcut-hint|hint/.test(cls) || small || t.length > 160 ? 'hint' : /err|warn|bad/.test(cls) ? 'warn' : /preview|summary|note|sub|ctx|status|result/.test(cls) ? 'note' : '' };
            const dot = c.querySelector('.dot') || (c.classList.contains('dot') ? c : null);
            if(dot) it.dot = dot.classList.contains('on');
            push(it);
          }
          return;
        }
        for(const x of c.children) visit(x);
      }
      visit(root);
    });
    return { items, tooBig };
  }
  // The wagon wheel's regions as the laptop draws them (right/left-hander).
  function wwZones(){
    return safe(() => {
      if(typeof WW_ZONES === 'undefined' || typeof wwRange !== 'function' || typeof ww === 'undefined' || !ww) return [];
      return WW_ZONES.map(z => { const [a0, a1] = wwRange(z, ww.hand); return { id: z.id, a0, a1, inner: z.inner, deep: z.deep }; });
    }, []);
  }
  function serializeOverlay(ov){
    const s = serialize([ov.el]);
    return s.tooBig ? { id: ov.id, title: ov.title, tooBig: true } : { id: ov.id, title: ov.title, items: s.items };
  }

  /* ---------------- the panel's cards the phone gets ----------------
     Each is the panel's own card (or rows / buttons of it), read as it is.
     tab: gfx = GRAPHICS, clip = CLIPPER, match = MATCH. */
  const up = (el, n) => { let x = el; for(let i = 0; x && i < (n || 1); i++) x = x.parentElement; return x; };
  const SECTIONS = [
    { id: 'scorebug', tab: 'gfx', icon: '📺', title: 'Score Bug', roots: () => [up($('visible-toggle'), 2)] },
    { id: 'bcg', tab: 'gfx', icon: '🎬', roots: () => [$('card-broadcast-graphics')] },
    { id: 'playercards', tab: 'gfx', icon: '🧑', title: 'Player & Bowler Cards', roots: () => [$('card-live-players')] },
    { id: 'statcards', tab: 'gfx', icon: '🃏', roots: () => [$('card-stat-cards')] },
    { id: 'summary', tab: 'gfx', icon: '📊', roots: () => [$('card-summary-graphics')] },
    { id: 'milestones', tab: 'gfx', icon: '⚡', roots: () => [$('card-milestone-trigger')] },
    { id: 'tournament', tab: 'gfx', icon: '🏆', title: 'Tournament Graphics',
      // the history / points views only — never the Matches list (Resume / Delete stay on the laptop)
      roots: () => [up($('view-player-history-btn')), $('view-points-table-btn'),
        safe(() => (['player', 'team', 'points'].includes(historyPanelView) ? $('league-matches-list') : null), null)] },
    { id: 'recording', tab: 'clip', icon: '🎥', roots: () => [$('card-recording')],
      exclude: () => [up($('connect-drive-btn')), up($('drive-folder-link'), 2), $('rec-data-root-input'), $('rec-data-root-browse-btn'),
        $('rec-data-root-save-btn'), $('ce-clip-jobs-list'), $('clip-jobs-list'), $('rec-resolution-select') && $('rec-resolution-select').closest('label')] },
    { id: 'clipper', tab: 'clip', icon: '✂️', roots: () => (PANEL === 'panel' ? [$('card-clipper-helper')] : []),
      exclude: () => [$('clipper-first'), $('clip-jobs-list'), $('clipper-open-btn')] },
    { id: 'crease', tab: 'match', icon: '👥', roots: () => [$('card-players')] },
    { id: 'bowler', tab: 'match', icon: '🎯', roots: () => [$('card-bowler')] },
    { id: 'newbat', tab: 'match', icon: '🆕', roots: () => [$('card-new-batsman')] },
    { id: 'events', tab: 'match', icon: '🩹', title: 'Match Events', roots: () => [$('lc-retired-btn'), $('lc-penalty-btn'), $('lc-impact-btn'), $('freehit-banner'), $('so-bar')] },
    { id: 'innings', tab: 'match', icon: '🔁', title: 'Innings', roots: () => ['next-innings-btn', 'declare-btn', 'stumps-btn', 'resume-day-btn', 'draw-btn'].map($) }
  ];
  const SEC = Object.fromEntries(SECTIONS.map(s => [s.id, s]));
  function secRoots(sec){ return (safe(() => sec.roots(), []) || []).map(r => r || null); }
  function secExclude(sec){ return new Set((safe(() => (sec.exclude ? sec.exclude() : []), []) || []).filter(Boolean)); }
  function readSection(sec){
    const roots = secRoots(sec);
    if(!roots.some(r => r && shown(r))) return null;
    const s = serialize(roots, secExclude(sec));
    if(!s.items.length) return null;
    const first = roots.find(r => r && r.classList && r.classList.contains('card'));
    // (the card's own leading emoji gives way to the section icon)
    const title = (sec.title || cardTitle(first) || sec.id).replace(/^[^\p{L}\p{N}]+/u, '') || sec.id;
    return { id: sec.id, tab: sec.tab, icon: sec.icon, title, items: s.items, tooBig: s.tooBig || undefined };
  }
  // A control of a section, as a ready-made command for the phone.
  function secAct(secId, el, op, value){
    const sec = SEC[secId];
    if(!sec || !el) return null;
    const roots = secRoots(sec);
    const i = roots.findIndex(r => r && (r === el || r.contains(el)));
    if(i < 0) return null;
    const a = { t: 'ui', sec: secId, ref: i + '|' + refIn(el, roots[i]), sig: sigOf(el), op: op || 'click' };
    if(value !== undefined) a.value = value;
    return a;
  }

  /* ---------------- what is on air right now ----------------
     From what the panel itself holds: the Broadcast Graphics state (kept by
     the server, rendered on this card), the switches that put cards on the
     overlay, the active player card, the tournament cards. Each comes with
     the panel's own control that takes it off. */
  function onAirList(){
    const L = [];
    const vis = $('visible-toggle');
    if(vis && vis.checked) L.push({ id: 'scorebug', label: 'Scorecard (score bug)', act: secAct('scorebug', vis, 'set', false) });
    document.querySelectorAll('#card-broadcast-graphics .bcg-btn.on').forEach(b => {
      let off = b;
      const visible = (el) => el && shownUpTo(el, $('card-broadcast-graphics'));
      if(b.id === 'bcg-toss-btn' && visible($('bcg-toss-hide'))) off = $('bcg-toss-hide');
      if((b.id === 'bcg-bat-btn' || b.id === 'bcg-bowl-btn') && visible($('bcg-card-hide'))) off = $('bcg-card-hide');
      if(b.id === 'bcg-xi-btn' && visible($('bcg-xi-stop'))) off = $('bcg-xi-stop');
      if(b.id === 'bcg-intro-btn' && visible($('bcg-intro-stop'))) off = $('bcg-intro-stop');
      L.push({ id: b.id, label: textOf(b.querySelector('b') || b), act: secAct('bcg', off, 'click') });
    });
    const toggles = [['player-stat-toggle', 'Player stat card', 'player'], ['bowler-stat-toggle', 'Bowler stat card', 'bowler'], ['team-stat-toggle', 'Team stats card', 'team']];
    toggles.forEach(([id, label]) => { const t = $(id); if(t && t.checked) L.push({ id, label, act: secAct('statcards', t, 'set', false) }); });
    const kind = state.activeCardKind, hideBtn = $('hide-current-card-btn');
    const shadowed = toggles.some(([id, , k]) => k === kind && $(id) && $(id).checked);
    if(kind && hideBtn && !hideBtn.disabled && !shadowed) L.push({ id: 'activecard', label: norm(state.activeCardLabel) || 'Player card', act: secAct('playercards', hideBtn, 'click') });
    if(state.showPointsTableCard) L.push({ id: 'points', label: 'Points table', act: { t: 'gfxoff', id: 'points' } });
    if(state.showPlayerHistoryCard) L.push({ id: 'playerhistory', label: 'Player history' + (state.playerHistoryOverlayName ? ' · ' + state.playerHistoryOverlayName : ''), act: { t: 'gfxoff', id: 'playerhistory' } });
    if(state.showTeamHistoryCard) L.push({ id: 'teamhistory', label: 'Team history' + (state.teamHistoryOverlayName ? ' · ' + state.teamHistoryOverlayName : ''), act: { t: 'gfxoff', id: 'teamhistory' } });
    return L;
  }
  // Every graphic this panel sends to the overlay, from either device —
  // the phone's "sent ✓" line for graphics the overlay times out by itself.
  const GFX_EVENTS = {
    cricketInningsSummary: 'Innings Summary — on air', cricketHideInningsSummary: 'Innings Summary — off air',
    cricketMatchSummary: 'Match Summary — on air', cricketHideMatchSummary: 'Match Summary — off air',
    cricketPlayerStat: 'Player stat card — on air', cricketHidePlayerStat: 'Player stat card — off air',
    cricketBowlerStat: 'Bowler stat card — on air', cricketHideBowlerStat: 'Bowler stat card — off air',
    cricketTeamStat: 'Team stats — on air', cricketHideTeamStat: 'Team stats — off air',
    cricketPlayerHistory: 'Player history — on air', cricketHidePlayerHistory: 'Player history — off air',
    cricketTeamHistory: 'Team history — on air', cricketHideTeamHistory: 'Team history — off air',
    cricketPointsTable: 'Points table — on air', cricketHidePointsTable: 'Points table — off air',
    cricketOverSummary: 'Over summary', cricketEvent: 'Animation', cricketGraphic: 'Broadcast graphic'
  };
  const gfxLog = [];
  const SP = io.Socket && io.Socket.prototype;
  if(SP && typeof SP.emit === 'function' && !SP.__crWrapped){
    const emit0 = SP.emit;
    SP.__crWrapped = true;
    SP.emit = function(ev, data){
      try{
        if(this !== rs && GFX_EVENTS[ev]){
          let label = GFX_EVENTS[ev];
          if(ev === 'cricketEvent'){ const e = (data && data.event) || data || {}; label = '⚡ ' + (norm(e.text || e.kind) || 'Animation'); }
          if(ev === 'cricketGraphic'){ const d = data || {}; label = '🎬 ' + norm([d.action || d.cmd || d.type, d.mode || d.kind].filter(Boolean).join(' ')) || label; }
          const lastSame = gfxLog.find(x => x.label === label);
          if(!lastSame || Date.now() - lastSame.at > 8000){
            gfxLog.unshift({ label, at: Date.now(), from: capturing ? 'phone' : 'laptop' });
            gfxLog.length = Math.min(gfxLog.length, 10);
          }
        }
      }catch(e){}
      return emit0.apply(this, arguments);
    };
  }

  /* ---------------- clips: from request to "saved on the laptop" ----------------
     Every POST this panel makes to its local Clipper (localhost:5005) or
     Stream Engine (127.0.0.1:5006) /clip is noted with its clip id; the
     job is then followed through the same engine's own job record. The
     phone's "Clip Done!" comes only from that record saying the file is
     cut and saved. */
  const clipJobs = new Map();   // clipId -> job
  const nativeFetch = window.fetch;
  const isClipEngine = (u) => (u.hostname === '127.0.0.1' && u.port === '5006') || (u.hostname === 'localhost' && u.port === '5005');
  const PROCESSING = ['WAITING', 'WAITING_FOR_POSTROLL', 'QUEUED', 'CUTTING', 'CUT_RETRY', 'PENDING', 'STARTED'];
  const FAILED = ['CUT_FAILED', 'FAILED_PERMANENT', 'FAILED'];
  const UPLOADED = ['COMPLETE', 'SYNC_COMPLETE'];
  function stageOf(job){
    const st = String(job.syncStatus || job.status || '').toUpperCase();
    if(UPLOADED.includes(st)) return 'uploaded';
    if(FAILED.includes(st)) return job.localSaved || job.localPath || job.localFilePath ? 'saved' : 'failed';
    if(PROCESSING.includes(st)) return 'processing';
    if(job.localSaved || st) return 'saved';   // LOCAL_SAVED, LOCAL_ONLY, FORWARDING, SENDING, SENT, OFFLINE_PENDING, …
    return 'processing';
  }
  function ballLabel(meta){
    if(!meta) return '';
    const over = meta.over != null && meta.ballInOver != null ? `${meta.over}.${meta.ballInOver}` : '';
    return [over, meta.striker].filter(Boolean).join(' · ');
  }
  function noteClipRequest(body){
    const clipId = String(body.clipId || '');
    if(!clipId) return null;
    let job = clipJobs.get(clipId);
    if(!job){
      job = { clipId, eventType: String(body.eventType || 'CLIP').toUpperCase(), label: ballLabel(body.ballMeta), t0: Number(body.timestamp) || Date.now(),
        origin: capturing ? 'phone' : 'laptop', stage: 'requested', status: '', error: '', at: Date.now() };
      clipJobs.set(clipId, job);
      while(clipJobs.size > 40) clipJobs.delete(clipJobs.keys().next().value);
    }
    return job;
  }
  function setStage(job, stage, error){
    if(job.stage === stage && (error || '') === job.error) return;
    if(job.stage === 'uploaded' || (job.stage === 'saved' && stage === 'processing')) return;
    job.stage = stage; job.error = error || ''; job.changedAt = Date.now();
    if(stage === 'saved' && !job.doneAt) job.doneAt = Date.now();
  }
  if(typeof nativeFetch === 'function'){
    window.fetch = function(input, init){
      let job = null;
      try{
        const url = new URL(typeof input === 'string' ? input : (input && input.url) || '', location.href);
        if(init && /^post$/i.test(init.method || '') && isClipEngine(url) && url.pathname === '/clip'){
          job = noteClipRequest(JSON.parse(init.body || '{}'));
        }
      }catch(e){}
      const p = nativeFetch.apply(this, arguments);
      if(job){
        Promise.resolve(p).then(r => (r && typeof r.clone === 'function' ? r.clone() : r).json()).then(res => {
          if(res && res.success === false && !res.duplicate) setStage(job, 'failed', res.error || 'The clipper did not accept the clip');
          else if(job.stage === 'requested' || job.stage === 'waiting') setStage(job, 'processing');
          pollClipsSoon();
        }).catch(() => {
          // Panel 1 keeps the request in its clip outbox and re-sends it; Panel 3 cannot start it.
          setStage(job, PANEL === 'panel' ? 'waiting' : 'failed', PANEL === 'panel' ? 'Clipper Helper not reachable — kept, will be sent when it is back' : 'Local Stream Engine not reachable — clip could not be started');
        });
      }
      return p;
    };
  }
  let clipPollTimer = null, clipPolling = false;
  function pollClipsSoon(){ clearTimeout(clipPollTimer); clipPollTimer = setTimeout(pollClips, 600); }
  async function pollClips(){
    if(clipPolling) return;
    const live = [...clipJobs.values()].filter(j => ['requested', 'processing', 'waiting'].includes(j.stage) || (j.stage === 'saved' && Date.now() - (j.doneAt || 0) < 180000));
    if(!live.length) return;
    clipPolling = true;
    try{
      if(PANEL === 'panel3'){
        for(const j of live){
          let job = safe(() => { const u = clipUiJobs.get(j.clipId); return u && u.job; }, null);
          if(!job){
            const r = await nativeFetch.call(window, `${STREAM_ENGINE_URL}/clip-jobs/${encodeURIComponent(j.clipId)}`).then(x => x.json()).catch(() => null);
            job = r && r.success && r.job;
          }
          if(job){ j.status = job.status || ''; setStage(j, stageOf(job), stageOf(job) === 'failed' ? (job.error || 'Clip failed') : ''); }
        }
      } else {
        const m = String(mid()).replace(/[^a-zA-Z0-9_-]/g, '');
        const r = await nativeFetch.call(window, `${CLIPPER_HELPER_URL}/clip-jobs?limit=25${m ? `&matchId=${encodeURIComponent(m)}` : ''}`).then(x => x.json()).catch(() => null);
        const byId = new Map(((r && r.jobs) || []).map(x => [x.clipId, x]));
        for(const j of live){
          const job = byId.get(j.clipId);
          if(job){ j.status = job.syncStatus || job.status || ''; setStage(j, stageOf(job), stageOf(job) === 'failed' ? (job.error || 'Clip failed') : ''); }
        }
      }
      // a request that never became a job on the laptop
      live.forEach(j => { if(j.stage === 'requested' && Date.now() - j.at > 20000) setStage(j, 'failed', 'The clipper never started this clip'); });
    } finally { clipPolling = false; }
    clipPollTimer = setTimeout(pollClips, 1200);
  }
  function dotOn(id){ const d = $(id); return !!(d && d.classList.contains('on')); }
  function clipperStatus(){
    if(PANEL === 'panel3'){
      return {
        engine: { name: 'Stream Engine', on: dotOn('ce-engine-dot'), text: norm($('ce-engine-status') && $('ce-engine-status').textContent) },
        // the panel writes "● RECORDING" (capitals) while it records, "● Not recording" when it does not
        rec: { on: dotOn('rec-dot') || /\bRECORDING\b/.test(norm($('rec-status') && $('rec-status').textContent)), text: norm($('rec-status') && $('rec-status').textContent) },
        path: norm($('rec-data-root-status') && $('rec-data-root-status').textContent),
        rows: [['Buffer', 'ce-buffer'], ['Clip worker', 'ce-worker'], ['Cloudflare', 'ce-cloudflare'], ['Recording file', 'rec-duration']].map(([l, id]) => [l, norm($(id) && $(id).textContent)]).filter(r => r[1] && r[1] !== '—')
      };
    }
    return {
      engine: { name: 'Clipper Helper', on: dotOn('clipper-status-dot'), text: norm($('clipper-status-text') && $('clipper-status-text').textContent) },
      rec: { on: dotOn('rec-dot'), text: norm($('rec-status') && $('rec-status').textContent) },
      path: '', rows: []
    };
  }
  function clipsPart(){
    const jobs = [...clipJobs.values()].sort((a, b) => b.at - a.at).slice(0, 15)
      .map(j => ({ clipId: j.clipId, eventType: j.eventType, label: j.label, t0: j.t0, origin: j.origin, stage: j.stage, status: j.status, error: j.error, at: j.at, doneAt: j.doneAt || null }));
    return { jobs, status: clipperStatus(), canHighlight: !!($('save-highlight-btn') || $('highlight-btn')) };
  }

  /* ---------------- the match, as the phone shows it ---------------- */
  function teamOf(t){
    const logo = t && typeof t.logoUrl === 'string' && (/^https?:\/\//.test(t.logoUrl) || (/^data:image\//.test(t.logoUrl) && t.logoUrl.length < 90000)) ? t.logoUrl : '';
    return { name: (t && t.name) || '', short: (t && t.short) || '', color: (t && t.color) || '', logo };
  }
  function batterOf(p){ return p && p.name ? { name: p.name, runs: p.runs || 0, balls: p.balls || 0, fours: p.fours || 0, sixes: p.sixes || 0 } : null; }
  function summary(){
    const s = state || {};
    const bk = s.battingTeam === 'B' ? 'B' : 'A';
    const score = s.score || {};
    const b = s.bowler || {};
    const log = s.ballLog || [];
    const last = log[log.length - 1];
    const ov = openOverlay();
    const crr = safe(() => calcCRR(), null), rrr = safe(() => calcRRR(), null);
    return {
      v: 2, panel: PANEL, matchId: mid(),
      online: !!(typeof socket !== 'undefined' && socket && socket.connected),
      bat: teamOf(bk === 'A' ? s.teamA : s.teamB), bowl: teamOf(bk === 'A' ? s.teamB : s.teamA), battingKey: bk,
      runs: score.runs || 0, wkts: score.wickets || 0,
      overs: safe(() => fmtOvers(score.overs || 0, score.balls || 0), `${score.overs || 0}.${score.balls || 0}`),
      maxOvers: s.oversPerInnings || null, innings: s.inningsNumber || 1,
      target: s.target || null,
      crr: typeof crr === 'number' && isFinite(crr) ? crr.toFixed(2) : null,
      rrr: typeof rrr === 'number' && isFinite(rrr) ? rrr.toFixed(2) : null,
      ballsLeft: safe(() => calcBallsLeft(), null),
      striker: batterOf(s.striker), nonStriker: batterOf(s.nonStriker),
      bowler: b.name ? { name: b.name, figs: `${b.overs || 0}.${b.balls || 0}-${b.maidens || 0}-${b.runs || 0}-${b.wickets || 0}` } : null,
      thisOver: (s.thisOver || []).slice(-14).map(x => String(x)),
      freeHit: !!s.freeHit,
      inningsOver: !!safe(() => isInningsOver(), false),
      off: BALL_KINDS.filter(k => { const el = document.querySelector(`[data-ball="${k}"]`); return !el || el.disabled; }),
      quick: Object.keys(QUICK).filter(k => { const el = $(QUICK[k]); return el && !el.disabled && shown(el); }),
      last: last ? { id: last.deliveryId || null, over: last.over || '', n: log.length } : { id: null, over: '', n: 0 },
      hl: { asks: document.querySelectorAll('#hl-prompts .hl-prompt').length, pending: safe(() => pendingHighlights.length, 0) },
      busy: ov && !MIRROR.has(ov.id) ? ov.title : null,
      rev: rev()
    };
  }
  function matchPart(){
    const s = state || {};
    const bk = s.battingTeam === 'B' ? 'B' : 'A', wk = bk === 'A' ? 'B' : 'A';
    const inn = s.inningsNumber || 1;
    const bat = ((s.battingCard && s.battingCard[bk]) || []).filter(r => (r.inningsNo || inn) === inn).map(r => ({ name: r.name, runs: r.runs || 0, balls: r.balls || 0, fours: r.fours || 0, sixes: r.sixes || 0, how: r.out ? norm(r.howOut) : '' }));
    [s.striker, s.nonStriker].forEach((p, i) => {
      if(p && p.name && !bat.some(r => r.name === p.name)) bat.push({ name: p.name, runs: p.runs || 0, balls: p.balls || 0, fours: p.fours || 0, sixes: p.sixes || 0, how: '' });
      const row = p && bat.find(r => r.name === p.name && !r.how);
      if(row){ Object.assign(row, { runs: p.runs || 0, balls: p.balls || 0, fours: p.fours || 0, sixes: p.sixes || 0, crease: i === 0 ? 'striker' : 'non-striker' }); }
    });
    const bowl = ((s.bowlingCard && s.bowlingCard[wk]) || []).filter(r => (r.inningsNo || inn) === inn).map(r => ({ name: r.name, o: `${r.overs || 0}.${r.balls || 0}`, m: r.maidens || 0, r: r.runs || 0, w: r.wickets || 0 }));
    const b = s.bowler || {};
    if(b.name){
      const row = bowl.find(r => r.name === b.name);
      const live = { name: b.name, o: `${b.overs || 0}.${b.balls || 0}`, m: b.maidens || 0, r: b.runs || 0, w: b.wickets || 0, now: true };
      if(row) Object.assign(row, live); else bowl.push(live);
    }
    const tossWinner = s.toss && (s.toss.winner === 'A' ? s.teamA : s.toss.winner === 'B' ? s.teamB : null);
    return {
      matchId: mid(), title: norm(s.matchTitle) || (s.matchNo ? `Match ${s.matchNo}` : ''), stage: s.matchStage || '',
      tournament: norm(s.matchLeague || s.leagueName || ''), venue: norm(s.venue), format: s.format || '', overs: s.oversPerInnings || null,
      date: s.matchDate || '', innings: inn, battingKey: bk, target: s.target || null,
      teamA: teamOf(s.teamA), teamB: teamOf(s.teamB),
      toss: tossWinner ? `${tossWinner.name || tossWinner.short} won the toss · chose to ${s.toss.decision === 'BOWL' ? 'bowl' : 'bat'}` : '',
      archive: (s.inningsArchive || []).map(a => ({ no: a.no, team: a.team, score: `${a.runs}/${a.wickets}`, overs: a.overs })),
      batting: bat, bowling: bowl,
      extras: s.extras && s.extras[bk] ? s.extras[bk] : null,
      partnership: { runs: s.partnershipRuns || 0, balls: s.partnershipBalls || 0 }
    };
  }

  /* ---------------- carrying out a command ---------------- */
  const fail = (error, message) => ({ ok: false, error, message });
  function press(el){
    if(!el) return fail('missing', 'That control is not on the laptop panel.');
    if(el.disabled) return fail('disabled', 'That button is switched off on the laptop right now.');
    el.click();
    return { ok: true };
  }
  function pressBall(v, pick){
    if(!BALL_KINDS.includes(v)) return fail('bad-request', 'Unknown ball.');
    if(pick != null && (v !== 'W' || !BALL_PICKS.includes(pick))) return fail('bad-request', 'Unknown dismissal.');
    const block = blockingOverlay();
    if(block) return fail('modal-open', MIRROR.has(block.id) ? `Finish “${block.title}” first.` : `“${block.title}” is open on the laptop — close it there first.`);
    // A new delivery: the wagon wheel of the last one is skipped, as Esc does.
    const wheel = $('ww-overlay');
    if(wheel && wheel.classList.contains('show')){ const skip = $('ww-skip'); if(skip) skip.click(); }
    const btn = document.querySelector(`[data-ball="${v}"]`);
    if(btn && btn.disabled) return fail('disabled', 'Scoring is closed on the laptop (innings or match over).');
    const r = press(btn);
    if(r.ok && pick){
      const chip = Array.prototype.find.call(document.querySelectorAll('#wd-types [data-wd-type]'), b => b.dataset.wdType === pick);
      if(chip && !chip.disabled) chip.click();
    }
    return r;
  }
  async function pressUndo(cmd){
    const block = blockingOverlay();
    if(block) return fail('modal-open', `Finish “${block.title}” first.`);
    // Undo removes the LAST ball: only when it is the ball the phone was looking at.
    const log = state.ballLog || [];
    const last = log[log.length - 1];
    const lastId = last ? (last.deliveryId || null) : null;
    if(cmd.last !== undefined && (!cmd.last || cmd.last.id !== lastId || cmd.last.n !== log.length))
      return fail('changed', 'The score just changed — check it, then press Undo again.');
    const r0 = rev();
    const seen = capturing ? capturing.length : 0;
    const r = press($('undo-btn'));
    if(!r.ok) return r;
    for(let i = 0; i < 60 && rev() === r0 && !(capturing && capturing.length > seen); i++) await sleep(50);
    return rev() !== r0 ? { ok: true } : fail('not-undone', (capturing && capturing[seen]) || 'Nothing was undone.');
  }
  function setSelect(sel, value){
    value = String(value == null ? '' : value);
    if(sel.disabled) return fail('disabled', 'That choice is locked on the laptop right now.');
    if(value && !Array.prototype.some.call(sel.options, o => o.value === value)){
      const it = selectItems(sel).find(x => x.v === value);
      if(!it) return fail('stale', 'That choice is not in the list any more — choose again.');
      const opt = document.createElement('option');
      opt.value = it.v; opt.textContent = it.l;
      sel.appendChild(opt);
    }
    sel.value = value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    if(sel._proDD && typeof sel._proDD.refreshLabel === 'function') safe(() => sel._proDD.refreshLabel());
    return { ok: true };
  }
  function applyOp(el, cmd){
    if(cmd.sig && sigOf(el) !== cmd.sig) return fail('stale', 'The screen changed — try again.');
    if(cmd.op === 'click') return press(el);
    if(cmd.op === 'set'){
      if(el.tagName === 'SELECT') return setSelect(el, cmd.value);
      if(el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')){
        if(el.disabled) return fail('disabled', 'That option is switched off.');
        if(el.checked !== !!cmd.value) el.click();
        return { ok: true };
      }
      if(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'){
        if(el.disabled || el.readOnly) return fail('disabled', 'That field is locked on the laptop.');
        el.value = String(cmd.value == null ? '' : cmd.value).slice(0, 200);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      }
    }
    return fail('bad-request', 'Unknown action.');
  }
  function modalAction(cmd){
    const ov = openOverlay();
    if(!ov || !MIRROR.has(ov.id)) return fail('stale', 'That window is already closed on the laptop.');
    const ref = String(cmd.ref || '').replace(/^0\|/, '');
    const el = resolveIn(ov.el, ref);
    if(!el || !shownUpTo(el, ov.el)) return fail('stale', 'The screen changed — try again.');
    return applyOp(el, cmd);
  }
  function sectionAction(cmd){
    const sec = SEC[cmd.sec];
    if(!sec) return fail('bad-request', 'Unknown section.');
    if(sec.tab === 'match'){
      const block = blockingOverlay();
      if(block) return fail('modal-open', `Finish “${block.title}” first.`);
    }
    const [i, ...rest] = String(cmd.ref || '').split('|');
    const roots = secRoots(sec);
    const root = roots[Number(i)];
    const el = root && resolveIn(root, rest.join('|'));
    if(!el || !shownUpTo(el, root)) return fail('stale', 'The screen changed — try again.');
    const ex = secExclude(sec);
    for(let n = el; n && n !== root.parentElement; n = n.parentElement) if(ex.has(n)) return fail('bad-request', 'That control stays on the laptop.');
    return applyOp(el, cmd);
  }
  async function waitFor(fn, ms){ for(let t = 0; t < (ms || 2000); t += 50){ const v = safe(fn, null); if(v) return v; await sleep(50); } return null; }
  // Taking a tournament card off air needs its view open on the panel first.
  async function gfxOff(id){
    const spec = {
      points: { flag: 'showPointsTableCard', view: 'points', toggle: 'points-table-overlay-toggle', open: () => {} },
      playerhistory: { flag: 'showPlayerHistoryCard', view: 'player', toggle: 'player-history-overlay-toggle', open: () => renderPlayerHistoryResults(state.playerHistoryOverlayName, currentLeagueMatchesLive()) },
      teamhistory: { flag: 'showTeamHistoryCard', view: 'team', toggle: 'team-history-overlay-toggle', open: () => renderTeamHistoryResults(state.teamHistoryOverlayName, currentLeagueMatchesLive()) }
    }[id];
    if(!spec) return fail('bad-request', 'Unknown graphic.');
    if(!state[spec.flag]) return { ok: true, already: true };
    if(!$(spec.toggle)){
      safe(() => { if(historyPanelView !== spec.view || $('league-matches-list').style.display === 'none') setHistoryPanelView(spec.view); });
      await sleep(80);
      if(!$(spec.toggle)) safe(spec.open);
    }
    const t = await waitFor(() => $(spec.toggle), 2500);
    if(!t) return fail('missing', 'Could not open that card on the laptop — take it off there.');
    t.click();
    await waitFor(() => !state[spec.flag], 2500);
    return state[spec.flag] ? fail('not-done', 'The laptop did not take it off air.') : { ok: true };
  }
  async function run(cmd){
    if(!mid()) return fail('no-match', 'No match is connected on the laptop.');
    const n0 = (state.ballLog || []).length;
    const toasts = [];
    capturing = toasts;
    // A laptop confirm() never blocks a phone press: the phone asks the
    // question itself and sends the press again with confirmed:true.
    const c0 = window.confirm, a0 = window.alert, p0 = window.prompt;
    let asked = null;
    window.confirm = (msg) => { if(cmd && cmd.confirmed) return true; if(asked == null) asked = norm(msg); return false; };
    window.alert = (msg) => { const t = norm(msg); if(t){ toasts.push(t); safe(() => origToast && origToast.call(window, t, 5000)); } };
    window.prompt = (msg) => { if(asked == null) asked = norm(msg); return null; };
    let r;
    try{
      switch(cmd && cmd.t){
        case 'ball': r = pressBall(String(cmd.v), cmd.pick == null ? null : String(cmd.pick)); break;
        case 'undo': r = await pressUndo(cmd); break;
        case 'swap': {
          const block = blockingOverlay();
          r = block ? fail('modal-open', `Finish “${block.title}” first.`) : press($('swap-strike'));
          break;
        }
        case 'quick': {
          const block = blockingOverlay();
          r = !QUICK[cmd.id] ? fail('bad-request', 'Unknown action.') : block ? fail('modal-open', `Finish “${block.title}” first.`) : press($(QUICK[cmd.id]));
          break;
        }
        case 'highlight': r = press($('save-highlight-btn') || $('highlight-btn')); break;
        case 'hl': r = (typeof answerOldestHighlightPrompt === 'function' && answerOldestHighlightPrompt(!!cmd.yes)) ? { ok: true } : fail('stale', 'No highlight question is open.'); break;
        case 'ui': r = cmd.sec ? sectionAction(cmd) : modalAction(cmd); break;
        case 'gfxoff': r = await gfxOff(String(cmd.id)); break;
        case 'ww': r = wwPick(cmd); break;
        default: r = fail('bad-request', 'Unknown command.');
      }
      // let what the press schedules (the wagon wheel, the next popup) open
      await sleep(40);
    } finally {
      capturing = null;
      window.confirm = c0; window.alert = a0; window.prompt = p0;
    }
    if(asked != null && !(cmd && cmd.confirmed)) r = { ok: false, error: 'confirm', message: asked };
    r.recorded = (state.ballLog || []).length > n0;
    r.toasts = toasts.slice(0, 4);
    if(!r.ok && !r.message && toasts.length) r.message = toasts[0];
    return r;
  }
  function wwPick(cmd){
    const x = Number(cmd.x), y = Number(cmd.y);
    if(!isFinite(x) || !isFinite(y) || Math.abs(x) > 130 || Math.abs(y) > 130) return fail('bad-request', 'Bad position.');
    if(typeof wwPickAt !== 'function') return fail('missing', 'No wagon wheel on this panel.');
    const wheel = $('ww-overlay');
    if(!wheel || !wheel.classList.contains('show')) return fail('stale', 'The wagon wheel is already closed.');
    return wwPickAt(x, y) ? { ok: true } : fail('stale', 'Tap inside the field.');
  }

  // One at a time, in the order they came; a repeated id answers from memory.
  const doneKey = () => 'cricketRemoteDone:' + mid();
  let done = new Map(), doneFor = null;
  function loadDone(){
    if(doneFor === mid()) return;
    doneFor = mid();
    done = new Map((store.get(doneKey()) || []).filter(x => Array.isArray(x) && x.length === 2));
  }
  function remember(id, res){
    done.set(id, res);
    while(done.size > DONE_KEEP) done.delete(done.keys().next().value);
    store.set(doneKey(), [...done.entries()].map(([k, v]) => [k, { ok: v.ok, error: v.error, message: v.message, recorded: v.recorded }]));
  }
  const inflight = new Map();
  let chain = Promise.resolve();
  let lastAction = null;
  function onCmd(msg, ack){
    const reply = typeof ack === 'function' ? ack : () => {};
    if(!msg || typeof msg.cmdId !== 'string') return reply(fail('bad-request'));
    loadDone();
    if(done.has(msg.cmdId)) return reply(Object.assign({}, done.get(msg.cmdId), { duplicate: true, parts: freshParts() }));
    if(inflight.has(msg.cmdId)){ inflight.get(msg.cmdId).then(r => reply(Object.assign({}, r, { duplicate: true, parts: freshParts() }))); return; }
    const p = chain.then(() => run(msg.cmd || {})).catch(e => fail('host-error', 'Laptop error: ' + ((e && e.message) || e)));
    chain = p.then(() => {}, () => {});
    inflight.set(msg.cmdId, p);
    p.then(res => {
      inflight.delete(msg.cmdId);
      remember(msg.cmdId, res);
      lastAction = { text: describe(msg.cmd), ok: res.ok, at: Date.now(), who: (msg.from && msg.from.label) || 'Phone' };
      renderChip(true);
      markDirty();
      reply(Object.assign({}, res, { parts: freshParts() }));
    });
  }
  function describe(cmd){
    if(!cmd) return '';
    if(cmd.t === 'ball') return cmd.pick || { W: 'WICKET', Wd: 'Wide', Nb: 'No Ball', B: 'Bye', LB: 'Leg Bye', OT: 'Overthrow' }[cmd.v] || String(cmd.v);
    return { undo: 'Undo', swap: 'Swap strike', quick: cmd.id, highlight: 'Highlight', hl: 'Highlight answer', ui: cmd.sec ? 'Panel: ' + cmd.sec : 'Popup', gfxoff: 'Off air', ww: 'Wagon wheel' }[cmd.t] || '';
  }

  /* ---------------- publishing to the phones, in parts ----------------
     score · modal · onair · clips · match · gfxlog · sections · sec:<id>.
     A part goes out only when it changed; a card is re-read when something
     on the page moved (or every 2 s, for values set without a DOM change). */
  const sent = new Map();   // part -> json
  const secDirty = new Set(SECTIONS.map(s => s.id));
  const secReadAt = new Map(), secPresent = new Map();
  const observed = new WeakSet();
  function markDirty(){ SECTIONS.forEach(s => secDirty.add(s.id)); }
  // the laptop operator touching anything may change any card
  ['click', 'change', 'input'].forEach(ev => document.addEventListener(ev, markDirty, true));
  // each card is watched on its own: a card is re-read only when it moved
  function armObservers(){
    if(typeof MutationObserver !== 'function') return;
    SECTIONS.forEach(sec => secRoots(sec).forEach(r => {
      if(!r || observed.has(r)) return;
      observed.add(r);
      new MutationObserver(() => secDirty.add(sec.id)).observe(r, { subtree: true, childList: true, attributes: true, characterData: true });
    }));
  }
  function parts(full){
    armObservers();
    const out = { score: summary(), onair: onAirList(), clips: clipsPart(), gfxlog: gfxLog.slice(0, 8), match: matchPart() };
    const ov = openOverlay();
    out.modal = ov && MIRROR.has(ov.id) ? serializeOverlay(ov) : null;
    const now = Date.now();
    const list = [];
    SECTIONS.forEach(sec => {
      const k = 'sec:' + sec.id;
      // (values a panel sets without touching the DOM — a switch's .checked — are caught every 2 s)
      if(full || secDirty.has(sec.id) || now - (secReadAt.get(sec.id) || 0) > 2000){
        out[k] = readSection(sec);
        secPresent.set(sec.id, !!out[k]);
        secReadAt.set(sec.id, now);
        secDirty.delete(sec.id);
      }
      if(secPresent.get(sec.id)) list.push({ id: sec.id, tab: sec.tab });
    });
    out.sections = list;
    return out;
  }
  function freshParts(){
    const p = parts(true), changed = {};
    Object.keys(p).forEach(k => { const j = JSON.stringify(p[k]); if(sent.get(k) !== j){ sent.set(k, j); changed[k] = p[k]; } });
    // the reply carries them; the other phones get them the usual way
    Object.keys(changed).forEach(k => { if(rs && rs.connected) rs.emit('remoteHost:part', { k, v: changed[k] }); });
    return changed;
  }
  function publish(){
    if(!rs || !rs.connected || !registeredFor || !phones.length) return;   // nobody to show it to
    const p = parts(false);
    Object.keys(p).forEach(k => {
      const j = JSON.stringify(p[k]);
      if(sent.get(k) === j) return;
      sent.set(k, j);
      rs.emit('remoteHost:part', { k, v: p[k] });
    });
  }

  /* ---------------- the connection ---------------- */
  let registeredFor = null, registeredLock = null, regError = null, lastReg = 0, phones = [];
  function lockTokenFor(m){ return safe(() => (typeof mlToken === 'function' ? mlToken(m) : null), null) || null; }
  function ensureSocket(){
    if(rs) return rs;
    let s = null;
    try{ s = io('/cricket-remote'); }catch(e){ s = null; }
    if(!s || typeof s.on !== 'function' || typeof s.emit !== 'function') return null;
    rs = s;
    rs.on('connect', () => { registeredFor = null; register(); });
    rs.on('disconnect', () => { registeredFor = null; renderChip(); renderModal(); });
    rs.on('remote:cmd', onCmd);
    rs.on('remoteHost:phones', (list) => {
      const grew = Array.isArray(list) && list.length > phones.length;
      phones = Array.isArray(list) ? list : [];
      if(grew){ sent.clear(); markDirty(); }   // a phone that just joined gets everything at once
      publish();
      renderChip(); renderModal();
      if(grew){
        safe(() => origToast && origToast.call(window, `📱 ${phones[phones.length - 1].label || 'Phone'} connected as a remote`, 3500));
        if(modalOpen()) newQr();   // that code is used up — the next phone gets a fresh one
      }
    });
    return rs;
  }
  function register(){
    const m = mid();
    if(!m || !rs || !rs.connected) return;
    const rec = hostRec(m), lockToken = lockTokenFor(m);
    lastReg = Date.now();
    rs.emit('remoteHost:register', { matchId: m, hostId: rec.id, epoch: rec.epoch, lockToken, panel: PANEL }, (res) => {
      if(mid() !== m) return;
      if(res && res.ok){ registeredFor = m; registeredLock = lockToken; regError = null; phones = res.phones || []; sent.clear(); markDirty(); publish(); }
      else { registeredFor = null; regError = (res && res.error) || 'error'; }
      renderChip(); renderModal();
    });
  }
  // Nothing connects until the operator opens the Phone Remote window, or
  // this browser already paired a phone for this match (a reload mid-match
  // brings its phones back by itself).
  let wanted = false;
  function tick(){
    const m = mid();
    if(!m) return;
    if(!wanted && !store.get('cricketRemoteHost:' + m)) return;
    if(!ensureSocket()) return;
    if(rs.connected){
      const stale = registeredFor !== m || registeredLock !== lockTokenFor(m);
      if(stale && Date.now() - lastReg > (regError ? 4000 : 800)) register();
      else if(registeredFor === m) publish();
    }
  }
  setInterval(tick, 350);

  /* ---------------- the laptop's own controls: 📱 button + pairing window ---------------- */
  const css = document.createElement('style');
  css.textContent = `
    #cr-remote-btn{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
    #cr-remote-btn .cr-n{display:none;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#16a34a;color:#fff;font-size:11px;font-weight:800;align-items:center;justify-content:center}
    #cr-remote-btn.has .cr-n{display:inline-flex}
    #cr-remote-btn.flash{box-shadow:0 0 0 3px rgba(34,197,94,.55);transition:box-shadow .2s}
    #cr-remote-btn.flash-bad{box-shadow:0 0 0 3px rgba(239,68,68,.6)}
    .cr-modal{max-width:440px}
    .cr-qr{display:flex;justify-content:center;align-items:center;min-height:228px;background:#fff;border-radius:14px;padding:12px;margin:12px auto 8px;width:236px}
    .cr-qr img,.cr-qr canvas{display:block}
    .cr-link{display:flex;gap:6px;margin:8px 0}
    .cr-link input{flex:1;font-size:12px}
    .cr-exp{font-size:12px;opacity:.75;text-align:center}
    .cr-status{font-size:13px;margin:10px 0;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.06)}
    .cr-status.bad{background:rgba(239,68,68,.15);color:#fca5a5}
    .cr-phones{margin:6px 0 10px;padding:0;list-style:none;font-size:13px}
    .cr-phones li{padding:6px 0;border-bottom:1px solid rgba(255,255,255,.08)}
    .cr-how{font-size:12.5px;opacity:.85;line-height:1.45;margin:6px 0 0}
    .cr-row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:12px}
  `;
  document.head.appendChild(css);

  const btn = document.createElement('button');
  btn.id = 'cr-remote-btn';
  btn.className = 'small';
  btn.type = 'button';
  btn.title = 'Control this match from a phone — scoring, graphics and clips; everything still runs on this laptop';
  btn.innerHTML = '📱 Phone Remote <span class="cr-n">0</span>';
  const anchor = $('connect-btn');
  if(anchor && anchor.parentNode) anchor.insertAdjacentElement('afterend', btn);
  else document.body.appendChild(btn);

  const ovl = document.createElement('div');
  ovl.className = 'wicket-modal-overlay';
  ovl.id = 'cr-remote-overlay';
  ovl.innerHTML = `
    <div class="wicket-modal cr-modal" role="dialog" aria-labelledby="cr-title">
      <h3 id="cr-title">📱 Phone Remote</h3>
      <div class="wm-sub">Scan with the phone. It opens this match as a wireless control panel — scoring, broadcast graphics and clips. Every tap on the phone presses this panel's own control: the overlay, the graphics and the clips run from this laptop, exactly as always.</div>
      <div class="cr-status" id="cr-status"></div>
      <div class="cr-qr" id="cr-qr"></div>
      <div class="cr-exp" id="cr-exp"></div>
      <div class="cr-link"><input type="text" id="cr-link" readonly><button type="button" class="small ghost" id="cr-copy">Copy</button></div>
      <div class="wm-sub" style="margin-top:10px"><b>Connected phones</b></div>
      <ul class="cr-phones" id="cr-phones"></ul>
      <p class="cr-how">One QR code pairs one phone and works for 10 minutes. A paired phone reconnects by itself for 24 hours. The phone never records video — clips are cut here, from this laptop's recording.</p>
      <div class="cr-row">
        <button type="button" class="ghost" id="cr-revoke">Disconnect all phones</button>
        <button type="button" class="ghost" id="cr-new">New QR code</button>
        <button type="button" class="primary" id="cr-close">Done</button>
      </div>
    </div>`;
  document.body.appendChild(ovl);

  let qr = null;   // { token, expiresAt, url }
  let expTimer = null;
  const modalOpen = () => ovl.classList.contains('show');
  function renderChip(flash){
    btn.classList.toggle('has', phones.length > 0);
    btn.querySelector('.cr-n').textContent = String(phones.length);
    if(flash && lastAction){
      const cls = lastAction.ok ? 'flash' : 'flash-bad';
      btn.classList.add(cls);
      btn.title = `${lastAction.who}: ${lastAction.text} ${lastAction.ok ? '✓' : '✗'}`;
      setTimeout(() => btn.classList.remove(cls), 450);
    }
  }
  function statusText(){
    if(!mid()) return ['Connect a match on this panel first (Match ID → Connect).', true];
    if(!rs || !rs.connected) return ['Connecting to the server…', true];
    if(regError === 'match-locked') return ['This match is locked with a code and this laptop does not hold it — enter the match code here first.', true];
    if(regError) return ['Could not start the phone remote (' + regError + ') — retrying…', true];
    if(registeredFor !== mid()) return ['Starting…', false];
    return [phones.length ? `✅ Ready — ${phones.length} phone${phones.length === 1 ? '' : 's'} connected to match ${mid()}` : `✅ Ready — scan the code to connect a phone to match ${mid()}`, false];
  }
  function renderModal(){
    if(!modalOpen()) return;
    const [t, bad] = statusText();
    const st = $('cr-status');
    st.textContent = t;
    st.classList.toggle('bad', !!bad);
    $('cr-phones').innerHTML = phones.length
      ? phones.map(p => `<li>📱 ${esc(p.label || 'Phone')} <span style="opacity:.6">· since ${esc(new Date(p.at).toLocaleTimeString())}</span></li>`).join('')
      : '<li style="opacity:.6">No phone connected yet</li>';
    if(!qr && registeredFor === mid()) newQr();
  }
  function drawQr(){
    const box = $('cr-qr');
    box.innerHTML = '';
    if(!qr){ box.textContent = ''; $('cr-link').value = ''; $('cr-exp').textContent = ''; return; }
    $('cr-link').value = qr.url;
    if(window.QRCode){
      try{ new QRCode(box, { text: qr.url, width: 212, height: 212, correctLevel: QRCode.CorrectLevel ? QRCode.CorrectLevel.M : undefined }); }
      catch(e){ box.innerHTML = '<span style="color:#0f172a;font-weight:700;text-align:center">Open the link below on the phone</span>'; }
    } else box.innerHTML = '<span style="color:#0f172a;font-weight:700;text-align:center">QR could not be drawn — open the link below on the phone</span>';
    renderExp();
  }
  function renderExp(){
    if(!qr){ $('cr-exp').textContent = ''; return; }
    const left = Math.max(0, qr.expiresAt - Date.now());
    if(!left){ qr = null; drawQr(); if(modalOpen()) newQr(); return; }
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    $('cr-exp').textContent = `Code works for ${m}:${String(s).padStart(2, '0')} more · one phone per code`;
  }
  function newQr(){
    if(!rs || !rs.connected || registeredFor !== mid()) return;
    rs.emit('remoteHost:pair', {}, (res) => {
      if(!res || !res.ok){ qr = null; drawQr(); regError = (res && res.error) || 'error'; renderModal(); return; }
      qr = { token: res.token, expiresAt: res.expiresAt, url: `${location.origin}/cricket-remote?pair=${encodeURIComponent(res.token)}` };
      drawQr();
    });
  }
  function openModal(){
    wanted = true;
    tick();
    ovl.classList.add('show');
    qr = null; drawQr();
    renderModal();
    clearInterval(expTimer);
    expTimer = setInterval(() => { if(!modalOpen()){ clearInterval(expTimer); return; } renderExp(); renderModal(); }, 1000);
  }
  function closeModal(){ ovl.classList.remove('show'); clearInterval(expTimer); qr = null; }
  btn.addEventListener('click', openModal);
  $('cr-close').addEventListener('click', closeModal);
  ovl.addEventListener('click', (e) => { if(e.target === ovl) closeModal(); });
  $('cr-new').addEventListener('click', () => { qr = null; drawQr(); newQr(); });
  $('cr-copy').addEventListener('click', () => {
    const v = $('cr-link').value;
    if(!v) return;
    try{ navigator.clipboard.writeText(v); origToast && origToast.call(window, '📋 Link copied'); }catch(e){}
  });
  $('cr-revoke').addEventListener('click', () => {
    const m = mid();
    if(!m || !rs || !rs.connected) return;
    if(!confirm('Disconnect every phone from this match? They will need to scan a new QR code.')) return;
    rs.emit('remoteHost:revokeAll', {}, () => {
      const rec = hostRec(m);
      rec.epoch += 1;
      store.set('cricketRemoteHost:' + m, rec);
      phones = [];
      registeredFor = null; qr = null; drawQr();
      register();
      setTimeout(() => { if(modalOpen()) newQr(); }, 400);
    });
  });
  window.addEventListener('keydown', (e) => {
    if(!modalOpen()) return;
    if(e.key === 'Escape'){ e.preventDefault(); closeModal(); }
    e.stopImmediatePropagation();   // no scoring shortcuts behind the window
  }, true);

  // For tests / support: what the phone would see right now.
  window.__crRemote = { summary, parts: () => parts(true), onAirList, readSection: (id) => readSection(SEC[id]), clipJobs, run, hostRec,
    sectionRoots: (id) => secRoots(SEC[id]), sectionExclude: (id) => [...secExclude(SEC[id])], sections: SECTIONS.map(x => ({ id: x.id, tab: x.tab })),
    get registeredFor(){ return registeredFor; }, get phones(){ return phones; } };
})();
