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

  /* ---------------- a copy of the open popup, for the phone ----------------
     Read straight off the panel's own DOM: headings, text, buttons (with
     their on / disabled state), dropdowns, inputs, check boxes, the wagon
     wheel. A control is named by its id, or its position inside the popup;
     the phone hands that name back, and it is checked against the control's
     text before anything is pressed. */
  function shown(el){
    if(el.hidden) return false;
    if(el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) return false;
    const cs = window.getComputedStyle ? getComputedStyle(el) : null;
    return !(cs && (cs.display === 'none' || cs.visibility === 'hidden'));
  }
  function textOf(el){
    let out = '';
    (function walk(n){
      for(const c of n.childNodes){
        if(c.nodeType === 3) out += ' ' + c.nodeValue;
        else if(c.nodeType === 1 && !/^(SVG|svg|KBD|STYLE|SCRIPT|SELECT|OPTION|TEMPLATE)$/.test(c.tagName) && shown(c)) walk(c);
      }
    })(el);
    return norm(out);
  }
  function refOf(el, root){
    if(el.id) return '#' + el.id;
    const path = [];
    for(let n = el; n && n !== root; n = n.parentElement) path.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
    return 'p:' + path.join('.');
  }
  function resolveRef(root, ref){
    if(typeof ref !== 'string') return null;
    if(ref[0] === '#'){ const el = document.getElementById(ref.slice(1)); return el && root.contains(el) ? el : null; }
    if(!ref.startsWith('p:')) return null;
    let n = root;
    for(const i of ref.slice(2).split('.')){ n = n && n.children[Number(i)]; }
    return n || null;
  }
  const isBtn = (el) => el.tagName === 'BUTTON' || /^(button|radio|tab|option)$/.test(el.getAttribute('role') || '') || el.classList.contains('wm-pill');
  const isOn = (el) => ['on', 'active', 'selected', 'sel', 'picked'].some(c => el.classList.contains(c)) || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true';
  function sigOf(el){
    if(el.tagName === 'SELECT') return 'select';
    if(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return 'input:' + (el.type || 'text');
    if(el.tagName === 'svg' || el.tagName === 'SVG') return 'svg';
    return 'btn:' + textOf(el).slice(0, 60);
  }
  function toneOf(el){
    const c = ' ' + (el.className && el.className.baseVal == null ? el.className : '') + ' ';
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
    return first && first.value === '' ? norm(first.textContent) : '— choose —';
  }
  function serialize(ov){
    const root = ov.el, items = [];
    let tooBig = false;
    const push = (it) => { if(items.length >= 220){ tooBig = true; return; } items.push(it); };
    (function walk(el){
      for(const c of el.children){
        if(tooBig) return;
        if(c.tagName === 'SELECT' && c._proDD){
          if(c._proDD.wrap && !shown(c._proDD.wrap)) continue;
          if(!shown(c.parentElement)) continue;
          push({ k: 's', ref: refOf(c, root), sig: 'select', value: c.value, ph: placeholderOf(c), opts: selectItems(c) });
          continue;
        }
        if(c.classList && c.classList.contains('pro-dd')) continue;      // shown above, as its select
        if(/^(SCRIPT|STYLE|TEMPLATE)$/.test(c.tagName) || !shown(c)) continue;
        if(c.id === 'ww-svg'){
          push({ k: 'ww', ref: '#ww-svg', zones: wwZones(), boundary: c.classList.contains('boundary'), picked: !!(typeof ww !== 'undefined' && ww && ww.picked) });
          continue;
        }
        if(c.tagName === 'svg' || c.tagName === 'SVG') continue;
        if(isBtn(c)){
          const label = textOf(c);
          if(label) push({ k: 'b', ref: refOf(c, root), sig: sigOf(c), text: label, on: isOn(c), dis: !!c.disabled || c.getAttribute('aria-disabled') === 'true', tone: toneOf(c) });
          continue;
        }
        if(c.tagName === 'SELECT'){
          push({ k: 's', ref: refOf(c, root), sig: 'select', value: c.value, ph: placeholderOf(c), opts: selectItems(c) });
          continue;
        }
        if(c.tagName === 'INPUT' || c.tagName === 'TEXTAREA'){
          const type = (c.type || 'text').toLowerCase();
          if(type === 'password' || type === 'hidden' || type === 'file') continue;
          if(type === 'checkbox' || type === 'radio'){
            const lab = c.closest('label');
            push({ k: 'c', ref: refOf(c, root), sig: sigOf(c), on: !!c.checked, text: lab ? textOf(lab) : norm(c.getAttribute('aria-label') || ''), radio: type === 'radio', dis: !!c.disabled });
          } else {
            push({ k: 'i', ref: refOf(c, root), sig: sigOf(c), value: String(c.value || '').slice(0, 200), ph: c.placeholder || '', num: type === 'number' });
          }
          continue;
        }
        if(c.tagName === 'LABEL' && c.querySelector('input[type=checkbox], input[type=radio]')){
          const inp = c.querySelector('input[type=checkbox], input[type=radio]');
          push({ k: 'c', ref: refOf(inp, root), sig: sigOf(inp), on: !!inp.checked, text: textOf(c), radio: inp.type === 'radio', dis: !!inp.disabled });
          continue;
        }
        if(/^H[1-4]$/.test(c.tagName)){ const t = textOf(c); if(t) push({ k: 'h', text: t }); continue; }
        const interactive = c.querySelector('button, input, select, textarea, [role=button], [role=radio], [role=tab], .wm-pill, #ww-svg, h1, h2, h3, h4');
        if(!interactive){
          const t = textOf(c);
          if(t){
            const cls = String(c.className || '');
            push({ k: 't', text: t.slice(0, 400), tone: /err|warn|bad/.test(cls) ? 'warn' : /preview|summary|note|hint|sub|ctx/.test(cls) ? 'note' : '' });
          }
          continue;
        }
        walk(c);
      }
    })(root);
    if(tooBig) return { id: ov.id, title: ov.title, tooBig: true };
    return { id: ov.id, title: ov.title, items };
  }
  // The wagon wheel's regions as the laptop draws them (right/left-hander).
  function wwZones(){
    return safe(() => {
      if(typeof WW_ZONES === 'undefined' || typeof wwRange !== 'function' || typeof ww === 'undefined' || !ww) return [];
      return WW_ZONES.map(z => { const [a0, a1] = wwRange(z, ww.hand); return { id: z.id, a0, a1, inner: z.inner, deep: z.deep }; });
    }, []);
  }

  /* ---------------- the summary the phone shows ---------------- */
  function teamOf(t){ return { name: (t && t.name) || '', short: (t && t.short) || '', color: (t && t.color) || '' }; }
  function batterOf(p){ return p && p.name ? { name: p.name, runs: p.runs || 0, balls: p.balls || 0, fours: p.fours || 0, sixes: p.sixes || 0 } : null; }
  function summary(){
    const s = state || {};
    const bk = s.battingTeam === 'B' ? 'B' : 'A';
    const score = s.score || {};
    const b = s.bowler || {};
    const log = s.ballLog || [];
    const last = log[log.length - 1];
    const ov = openOverlay();
    const mirrored = ov && MIRROR.has(ov.id) ? ov : null;
    const crr = safe(() => calcCRR(), null), rrr = safe(() => calcRRR(), null);
    return {
      v: 1, panel: PANEL, matchId: mid(),
      online: !!(typeof socket !== 'undefined' && socket && socket.connected),
      bat: teamOf(bk === 'A' ? s.teamA : s.teamB), bowl: teamOf(bk === 'A' ? s.teamB : s.teamA),
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
      last: last ? { id: last.deliveryId || null, over: last.over || '', n: log.length } : { id: null, over: '', n: 0 },
      hl: { asks: document.querySelectorAll('#hl-prompts .hl-prompt').length, pending: safe(() => pendingHighlights.length, 0) },
      modal: mirrored ? serialize(mirrored) : null,
      busy: ov && !mirrored ? ov.title : null,
      rev: rev()
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
  function pressBall(v){
    if(!BALL_KINDS.includes(v)) return fail('bad-request', 'Unknown ball.');
    const block = blockingOverlay();
    if(block) return fail('modal-open', MIRROR.has(block.id) ? `Finish “${block.title}” first.` : `“${block.title}” is open on the laptop — close it there first.`);
    // A new delivery: the wagon wheel of the last one is skipped, as Esc does.
    const wheel = $('ww-overlay');
    if(wheel && wheel.classList.contains('show')){ const skip = $('ww-skip'); if(skip) skip.click(); }
    const btn = document.querySelector(`[data-ball="${v}"]`);
    if(btn && btn.disabled) return fail('disabled', 'Scoring is closed on the laptop (innings or match over).');
    return press(btn);
  }
  async function pressUndo(cmd){
    const block = blockingOverlay();
    if(block) return fail('modal-open', `Finish “${block.title}” first.`);
    // Undo removes the LAST ball: only when it is the ball the phone was looking at.
    const log = state.ballLog || [];
    const last = log[log.length - 1];
    const lastId = last ? (last.deliveryId || null) : null;
    if(cmd.last !== undefined && (cmd.last.id !== lastId || cmd.last.n !== log.length))
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
    if(value && !Array.prototype.some.call(sel.options, o => o.value === value)){
      const items = selectItems(sel);
      const it = items.find(x => x.v === value);
      if(!it) return fail('stale', 'That name is not in the list any more — choose again.');
      const opt = document.createElement('option');
      opt.value = it.v; opt.textContent = it.l;
      sel.appendChild(opt);
    }
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    if(sel._proDD && typeof sel._proDD.refreshLabel === 'function') safe(() => sel._proDD.refreshLabel());
    return { ok: true };
  }
  function uiAction(cmd){
    const ov = openOverlay();
    if(!ov || !MIRROR.has(ov.id)) return fail('stale', 'That window is already closed on the laptop.');
    const el = resolveRef(ov.el, cmd.ref);
    if(!el || !ov.el.contains(el)) return fail('stale', 'The screen changed — try again.');
    for(let n = el; n && n !== ov.el; n = n.parentElement){ if(!(n.tagName === 'SELECT' && n._proDD) && !shown(n)) return fail('stale', 'The screen changed — try again.'); }
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
        el.value = String(cmd.value == null ? '' : cmd.value).slice(0, 200);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      }
    }
    return fail('bad-request', 'Unknown action.');
  }
  function wwPick(cmd){
    const x = Number(cmd.x), y = Number(cmd.y);
    if(!isFinite(x) || !isFinite(y) || Math.abs(x) > 130 || Math.abs(y) > 130) return fail('bad-request', 'Bad position.');
    if(typeof wwPickAt !== 'function') return fail('missing', 'No wagon wheel on this panel.');
    const wheel = $('ww-overlay');
    if(!wheel || !wheel.classList.contains('show')) return fail('stale', 'The wagon wheel is already closed.');
    return wwPickAt(x, y) ? { ok: true } : fail('stale', 'Tap inside the field.');
  }
  async function run(cmd){
    if(!mid()) return fail('no-match', 'No match is connected on the laptop.');
    const n0 = (state.ballLog || []).length;
    const toasts = [];
    capturing = toasts;
    let r;
    try{
      switch(cmd && cmd.t){
        case 'ball': r = pressBall(String(cmd.v)); break;
        case 'undo': r = await pressUndo(cmd); break;
        case 'swap': {
          const block = blockingOverlay();
          r = block ? fail('modal-open', `Finish “${block.title}” first.`) : press($('swap-strike'));
          break;
        }
        case 'highlight': r = press($('save-highlight-btn') || $('highlight-btn')); break;
        case 'hl': r = (typeof answerOldestHighlightPrompt === 'function' && answerOldestHighlightPrompt(!!cmd.yes)) ? { ok: true } : fail('stale', 'No highlight question is open.'); break;
        case 'ui': r = uiAction(cmd); break;
        case 'ww': r = wwPick(cmd); break;
        default: r = fail('bad-request', 'Unknown command.');
      }
      // let what the press schedules (the wagon wheel, the next popup) open
      await sleep(40);
    } finally { capturing = null; }
    r.recorded = (state.ballLog || []).length > n0;
    r.toasts = toasts.slice(0, 4);
    if(!r.ok && !r.message && toasts.length) r.message = toasts[0];
    return r;
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
    if(done.has(msg.cmdId)) return reply(Object.assign({}, done.get(msg.cmdId), { duplicate: true, state: summary() }));
    if(inflight.has(msg.cmdId)){ inflight.get(msg.cmdId).then(r => reply(Object.assign({}, r, { duplicate: true, state: summary() }))); return; }
    const p = chain.then(() => run(msg.cmd || {})).catch(e => fail('host-error', 'Laptop error: ' + ((e && e.message) || e)));
    chain = p.then(() => {}, () => {});
    inflight.set(msg.cmdId, p);
    p.then(res => {
      inflight.delete(msg.cmdId);
      remember(msg.cmdId, res);
      lastAction = { text: describe(msg.cmd), ok: res.ok, at: Date.now(), who: (msg.from && msg.from.label) || 'Phone' };
      renderChip(true);
      const st = summary();
      lastSent = JSON.stringify(st);
      reply(Object.assign({}, res, { state: st }));
      if(rs && rs.connected) rs.emit('remoteHost:state', st);
    });
  }
  function describe(cmd){
    if(!cmd) return '';
    if(cmd.t === 'ball') return { W: 'WICKET', Wd: 'Wide', Nb: 'No Ball', B: 'Bye', LB: 'Leg Bye', OT: 'Overthrow' }[cmd.v] || String(cmd.v);
    return { undo: 'Undo', swap: 'Swap strike', highlight: 'Highlight', hl: 'Highlight answer', ui: 'Popup', ww: 'Wagon wheel' }[cmd.t] || '';
  }

  /* ---------------- the connection ---------------- */
  let registeredFor = null, registeredLock = null, regError = null, lastReg = 0, phones = [], lastSent = '';
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
      lastSent = ''; publish();   // a phone that just joined gets the match at once
      renderChip(); renderModal();
      if(grew){
        safe(() => origToast && origToast.call(window, `📱 ${phones[phones.length - 1].label || 'Phone'} connected as a scoring remote`, 3500));
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
      if(res && res.ok){ registeredFor = m; registeredLock = lockToken; regError = null; phones = res.phones || []; lastSent = ''; publish(); }
      else { registeredFor = null; regError = (res && res.error) || 'error'; }
      renderChip(); renderModal();
    });
  }
  function publish(){
    if(!rs || !rs.connected || !registeredFor || !phones.length) return;   // nobody to show it to
    const st = summary();
    const json = JSON.stringify(st);
    if(json === lastSent) return;
    lastSent = json;
    rs.emit('remoteHost:state', st);
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
  setInterval(tick, 300);

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
  btn.title = 'Score from a phone — the phone presses this panel\'s buttons; overlay and clips run from this laptop';
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
      <div class="wm-sub">Scan with the phone. It opens this match as a scoring remote: every press on the phone presses this panel's button — the overlay and the clips run from this laptop, exactly as always.</div>
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
  window.__crRemote = { summary, run, hostRec, get registeredFor(){ return registeredFor; }, get phones(){ return phones; } };
})();
