/* 🔽 CRICKET PANEL DROPDOWNS — one smooth glass dropdown for every <select>
   in Cricket Panel and Cricket Panel 3 (each loads this file once, in its
   <head>, before its own scripts).

   The <select> itself stays where it is, as it is: the panel reads and sets
   its value and listens for its 'change', the tests drive it, the phone
   remote copies it, and the panel shows / hides / disables it as before.
   Two things are new:
     • its closed look — a glass field with a chevron, in both themes;
     • its open list — instead of the browser's own popup, a list in the
       panel's style that opens and closes smoothly next to the field, with
       a search box on longer lists, the chosen one ticked, an option's
       `data-sub` line and `data-badge` under / before its name, and the
       keyboard (↑ ↓ Home End Enter Esc Tab, typing to jump).
   The list is drawn from the select's options each time it opens and
   follows them while it is open, so a list that changes (a tournament made
   on another laptop arriving from the server) shows at once. A select with
   `multiple` or a `size`, or inside [data-native-select], keeps the
   browser's own list; on a touch screen the phone's own picker opens.

   The panel's searchable player lists (makeProDropdown) get the same look.

   API (window.CricketSelect):
     open(select), close(), isOpen(select)
     status(select, text | null, busy) — a line at the foot of the open list
     The select fires 'lqs-open' (bubbling) when its list opens. */
(function () {
  if (window.CricketSelect) return;

  var CHEV = function (c, up) {
    return 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" fill="none" stroke="' + c +
      '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + (up ? 'M3 7.5 6 4.5l3 3' : 'M3 4.5 6 7.5l3-3') + '"/></svg>') + '")';
  };
  var SEL = 'select:not([multiple]):not([size])';
  var css = [
    /* ---- the closed field: a chevron instead of the browser's arrow ---- */
    'html ' + SEL + '{-webkit-appearance:none !important;appearance:none !important;background-image:' + CHEV('#9aa6bd') + ' !important;background-repeat:no-repeat !important;background-position:right 11px center !important;background-size:12px 12px !important;padding-right:32px !important;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}',
    'html[data-theme="light"] ' + SEL + '{background-image:' + CHEV('#64748b') + ' !important}',
    'html ' + SEL + ':disabled{cursor:not-allowed}',
    'html ' + SEL + '.lqs-open{background-image:' + CHEV('#ff9a3c', true) + ' !important;border-color:rgba(255,122,0,.75) !important;box-shadow:0 0 0 3px rgba(255,122,0,.22) !important}',
    'html[data-theme="light"] ' + SEL + '.lqs-open{background-image:' + CHEV('#e86a00', true) + ' !important}',

    /* ---- the open list ---- */
    '.lqs-pop{position:fixed;z-index:100000;left:0;top:0;display:flex;flex-direction:column;min-width:200px;box-sizing:border-box;border-radius:16px;overflow:hidden;',
    '  font:500 13px/1.3 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--lqs-ink);text-align:left;',
    '  background:var(--lqs-bg);border:1px solid var(--lqs-line);box-shadow:inset 0 1px 0 var(--lqs-hi),0 26px 60px -20px rgba(0,0,0,.75),0 6px 18px -10px rgba(0,0,0,.5);',
    '  -webkit-backdrop-filter:blur(22px) saturate(170%);backdrop-filter:blur(22px) saturate(170%);',
    '  opacity:0;transform:translateY(-6px) scale(.97);transform-origin:50% 0;transition:opacity .16s ease,transform .24s cubic-bezier(.2,.9,.25,1);',
    '  --lqs-ink:#e8eef6;--lqs-dim:rgba(232,238,246,.56);--lqs-bg:linear-gradient(180deg,rgba(30,39,62,.94),rgba(13,18,32,.96));--lqs-line:rgba(255,255,255,.1);--lqs-hi:rgba(255,255,255,.08);',
    '  --lqs-row-h:rgba(255,255,255,.075);--lqs-row-on:rgba(255,122,0,.16);--lqs-field:rgba(0,0,0,.3);--lqs-acc:#ff9a3c;--lqs-act:#ffb15c}',
    '.lqs-pop[data-dir="up"]{transform-origin:50% 100%;transform:translateY(6px) scale(.97)}',
    '.lqs-pop.in{opacity:1;transform:none}',
    '.lqs-pop.out{opacity:0;transform:scale(.985);transition-duration:.12s,.12s;pointer-events:none}',
    'html[data-theme="light"] .lqs-pop{--lqs-ink:#0f172a;--lqs-dim:rgba(15,23,42,.55);--lqs-bg:linear-gradient(180deg,rgba(255,255,255,.97),rgba(246,248,252,.97));--lqs-line:rgba(15,23,42,.1);--lqs-hi:rgba(255,255,255,.9);',
    '  --lqs-row-h:rgba(15,23,42,.055);--lqs-row-on:rgba(232,106,0,.1);--lqs-field:rgba(15,23,42,.05);--lqs-acc:#e86a00;--lqs-act:#c2410c;box-shadow:inset 0 1px 0 var(--lqs-hi),0 26px 60px -22px rgba(15,23,42,.38),0 4px 14px -8px rgba(15,23,42,.2)}',
    '.lqs-pop *{box-sizing:border-box}',
    '.lqs-search{flex:none;display:flex;align-items:center;margin:8px 8px 2px;padding:0 10px;height:36px;border-radius:11px;background:var(--lqs-field);border:1px solid var(--lqs-line)}',
    '.lqs-search:focus-within{border-color:rgba(255,122,0,.6);box-shadow:0 0 0 3px rgba(255,122,0,.18)}',
    '.lqs-search svg{flex:none;width:14px;height:14px;margin-right:8px;color:var(--lqs-dim)}',
    '.lqs-search input{flex:1;min-width:0;height:100%;margin:0;padding:0;border:0 !important;outline:0;background:transparent !important;box-shadow:none !important;color:inherit;font:inherit;font-size:13px}',
    '.lqs-search input::placeholder{color:var(--lqs-dim)}',
    '.lqs-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:6px;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--lqs-line) transparent}',
    '.lqs-opt{display:flex;align-items:center;min-height:36px;padding:7px 10px;border-radius:10px;cursor:pointer;user-select:none;transition:background-color .12s ease}',
    '.lqs-opt + .lqs-opt{margin-top:1px}',
    '.lqs-opt.act{background:var(--lqs-row-h)}',
    '.lqs-opt[aria-selected="true"]{background:var(--lqs-row-on);font-weight:700}',
    '.lqs-opt[aria-selected="true"].act{background:color-mix(in srgb,var(--lqs-row-on) 100%,var(--lqs-row-h))}',
    '.lqs-opt[aria-disabled="true"]{opacity:.38;cursor:not-allowed}',
    '.lqs-opt.ph{color:var(--lqs-dim)}',
    '.lqs-opt.action{color:var(--lqs-act);font-weight:700}',
    '.lqs-badge{flex:none;width:28px;height:28px;margin-right:10px;border-radius:9px;display:grid;place-items:center;font-size:10.5px;font-weight:800;letter-spacing:.02em;color:#fff;',
    '  background:linear-gradient(145deg,var(--lqs-b1,#6366f1),var(--lqs-b2,#4338ca));box-shadow:inset 0 1px 0 rgba(255,255,255,.3)}',
    '.lqs-txt{flex:1;min-width:0;display:flex;flex-direction:column}',
    '.lqs-txt b{font-weight:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.lqs-txt small{font-size:11px;font-weight:500;color:var(--lqs-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}',
    '.lqs-tick{flex:none;width:16px;height:16px;margin-left:10px;color:var(--lqs-acc);opacity:0;transform:scale(.6);transition:opacity .15s,transform .2s cubic-bezier(.34,1.56,.64,1)}',
    '.lqs-opt[aria-selected="true"] .lqs-tick{opacity:1;transform:none}',
    '.lqs-group{padding:9px 10px 4px;font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--lqs-dim)}',
    '.lqs-sep{height:1px;margin:5px 8px;background:var(--lqs-line)}',
    '.lqs-empty{padding:16px 12px;text-align:center;font-size:12.5px;color:var(--lqs-dim)}',
    '.lqs-status{flex:none;display:flex;align-items:center;gap:7px;padding:8px 12px;border-top:1px solid var(--lqs-line);font-size:11.5px;color:var(--lqs-dim)}',
    '.lqs-status[hidden]{display:none}',
    '.lqs-spin{flex:none;width:12px;height:12px;border-radius:50%;border:2px solid var(--lqs-line);border-top-color:var(--lqs-acc);animation:lqsSpin .7s linear infinite}',
    '@keyframes lqsSpin{to{transform:rotate(360deg)}}',

    /* ---- the panel's searchable player lists, in the same look ---- */
    'html body .pro-dd-trigger::after{content:"";width:12px;height:12px;background:' + CHEV('#9aa6bd') + ' center/12px no-repeat;font-size:0}',
    'html[data-theme="light"] body .pro-dd-trigger::after{background-image:' + CHEV('#64748b') + '}',
    'html body .pro-dd-panel{border-radius:16px;padding:0 0 4px;color:#e8eef6;background:linear-gradient(180deg,rgba(30,39,62,.95),rgba(13,18,32,.97));border:1px solid rgba(255,255,255,.1);',
    '  box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 26px 60px -20px rgba(0,0,0,.75);-webkit-backdrop-filter:blur(22px) saturate(170%);backdrop-filter:blur(22px) saturate(170%)}',  /* (it opens with the motion layer's own drop) */
    'html body .pro-dd-search{width:auto;margin:8px 8px 4px;height:36px;padding:0 12px;border-radius:11px;border:1px solid rgba(255,255,255,.1) !important;background:rgba(0,0,0,.3) !important;color:inherit}',
    'html body .pro-dd-search:focus{border-color:rgba(255,122,0,.6) !important;box-shadow:0 0 0 3px rgba(255,122,0,.18)}',
    'html body .pro-dd-list{padding:2px 6px}',
    'html body .pro-dd-item{border:0 !important;border-radius:10px;padding:8px 10px;transition:background-color .12s ease}',
    'html body .pro-dd-item:hover{background:rgba(255,255,255,.075)}',
    'html[data-theme="light"] body .pro-dd-panel{color:#0f172a;background:linear-gradient(180deg,rgba(255,255,255,.97),rgba(246,248,252,.97));border-color:rgba(15,23,42,.1);box-shadow:inset 0 1px 0 #fff,0 26px 60px -22px rgba(15,23,42,.38)}',
    'html[data-theme="light"] body .pro-dd-search{border-color:rgba(15,23,42,.1) !important;background:rgba(15,23,42,.05) !important}',
    'html[data-theme="light"] body .pro-dd-item:hover{background:rgba(15,23,42,.055)}',

    '@media (prefers-reduced-motion:reduce){.lqs-pop,.lqs-pop.out,.lqs-tick,.lqs-opt{transition:none !important}.lqs-pop{transform:none !important}.lqs-spin{animation-duration:2s}}'
  ].join('\n');

  function addCss() {
    if (document.getElementById('lqs-css')) return;
    var st = document.createElement('style');
    st.id = 'lqs-css';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }
  addCss();

  var ICON_SEARCH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="7" cy="7" r="4.6"/><path d="m10.4 10.4 3.1 3.1"/></svg>';
  var ICON_TICK = '<svg class="lqs-tick" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.4 3 3 6-6.6"/></svg>';
  var reduced = function () { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  function eligible(sel) {
    return !!(sel && sel.tagName === 'SELECT' && !sel.multiple && !(sel.size > 1) && !sel.disabled && !sel._proDD && !sel.closest('[data-native-select]'));
  }

  var cur = null;          // the open list: { sel, pop, list, search, status, rows, active, q, mo }
  var lastPointer = 'mouse';
  var seq = 0;

  function itemsOf(sel) {
    var out = [];
    var add = function (o, gDisabled) {
      if (o.hidden || o.style.display === 'none') return;
      out.push({
        o: o, value: o.value, label: (o.label || o.textContent || '').trim(),
        sub: o.getAttribute('data-sub') || '', badge: o.getAttribute('data-badge') || '', badgeColor: o.getAttribute('data-badge-color') || '',
        disabled: o.disabled || gDisabled, ph: o.value === '', action: /^__/.test(o.value)
      });
    };
    for (var i = 0; i < sel.children.length; i++) {
      var el = sel.children[i];
      if (el.tagName === 'OPTGROUP') {
        out.push({ group: el.label || '' });
        for (var j = 0; j < el.children.length; j++) if (el.children[j].tagName === 'OPTION') add(el.children[j], el.disabled);
      } else if (el.tagName === 'OPTION') add(el, false);
    }
    return out;
  }

  function render() {
    if (!cur) return;
    var sel = cur.sel, q = cur.q.trim().toLowerCase();
    var items = itemsOf(sel), plain = [], actions = [];
    items.forEach(function (it) {
      if (it.group != null) { plain.push(it); return; }
      if (q && (it.ph || it.action || (it.label + ' ' + it.sub).toLowerCase().indexOf(q) < 0)) return;
      (it.action ? actions : plain).push(it);
    });
    // a group with nothing left under it is not shown
    plain = plain.filter(function (it, i) { return it.group == null || (plain[i + 1] && plain[i + 1].group == null); });
    var html = '', rows = [];
    var row = function (it) {
      var idx = rows.length; rows.push(it);
      var selected = it.o.selected && !(it.ph && sel.selectedIndex < 0);
      var badge = it.badge ? '<span class="lqs-badge"' + (it.badgeColor ? ' style="--lqs-b1:' + esc(it.badgeColor) + ';--lqs-b2:color-mix(in srgb,' + esc(it.badgeColor) + ' 70%,#000)"' : '') + '>' + esc(it.badge) + '</span>' : '';
      return '<div class="lqs-opt' + (it.ph ? ' ph' : '') + (it.action ? ' action' : '') + '" role="option" id="lqs-o' + cur.id + '-' + idx + '" data-i="' + idx + '" aria-selected="' + selected + '"' + (it.disabled ? ' aria-disabled="true"' : '') + '>'
        + badge + '<span class="lqs-txt"><b>' + esc(it.label || '—') + '</b>' + (it.sub ? '<small>' + esc(it.sub) + '</small>' : '') + '</span>' + ICON_TICK + '</div>';
    };
    plain.forEach(function (it) { html += it.group != null ? '<div class="lqs-group" role="presentation">' + esc(it.group) + '</div>' : row(it); });
    if (actions.length) { if (rows.length) html += '<div class="lqs-sep" role="separator"></div>'; actions.forEach(function (it) { html += row(it); }); }
    if (!rows.length) html = '<div class="lqs-empty">' + (q ? 'Nothing matches “' + esc(cur.q.trim()) + '”' : 'Nothing to choose yet') + '</div>';
    var keep = cur.list.scrollTop;
    cur.list.innerHTML = html;
    cur.list.scrollTop = keep;
    cur.rows = rows;
    // the active row: the same option as before if it is still there, else the chosen one, else the first
    var prev = cur.activeOpt, a = -1;
    rows.forEach(function (it, i) { if (a < 0 && prev && it.o === prev) a = i; });
    if (a < 0 && q) a = firstEnabled(0, 1);
    if (a < 0) rows.forEach(function (it, i) { if (a < 0 && it.o.selected && !it.disabled) a = i; });
    setActive(a < 0 ? firstEnabled(0, 1) : a, !cur.drawn);
    cur.drawn = true;
  }
  function firstEnabled(from, step) {
    if (!cur) return -1;
    for (var i = from; i >= 0 && i < cur.rows.length; i += step) if (!cur.rows[i].disabled) return i;
    return -1;
  }
  function setActive(i, scroll) {
    if (!cur) return;
    var old = cur.list.querySelector('.lqs-opt.act');
    if (old) old.classList.remove('act');
    cur.active = i;
    cur.activeOpt = i >= 0 && cur.rows[i] ? cur.rows[i].o : null;
    var el = i >= 0 ? cur.list.querySelector('[data-i="' + i + '"]') : null;
    if (el) {
      el.classList.add('act');
      if (scroll) el.scrollIntoView({ block: 'nearest' });
      (cur.search || cur.sel).setAttribute('aria-activedescendant', el.id);
    }
  }

  function place() {
    if (!cur) return;
    var sel = cur.sel, pop = cur.pop, r = sel.getBoundingClientRect();
    if (!sel.isConnected || (r.width === 0 && r.height === 0) || sel.disabled) { close(true); return; }
    if (r.bottom < 0 || r.top > innerHeight) { close(); return; }
    var vw = document.documentElement.clientWidth || innerWidth, vh = innerHeight, gap = 6, pad = 8;
    var w = Math.min(Math.max(r.width, 220), vw - pad * 2);
    var left = Math.max(pad, Math.min(r.left, vw - w - pad));
    pop.style.width = w + 'px';
    pop.style.maxHeight = 'none';
    var natural = Math.min(pop.scrollHeight, 380);
    var below = vh - r.bottom - gap - pad, above = r.top - gap - pad;
    var dir = (below >= natural || below >= above) ? 'down' : 'up';
    var maxH = Math.max(120, Math.min(380, dir === 'down' ? below : above));
    pop.style.maxHeight = maxH + 'px';
    var h = Math.min(natural, maxH);
    pop.style.left = left + 'px';
    pop.style.top = (dir === 'down' ? r.bottom + gap : Math.max(pad, r.top - gap - h)) + 'px';
    pop.setAttribute('data-dir', dir);
  }

  function open(sel) {
    if (!eligible(sel)) return;
    if (cur && cur.sel === sel) { close(); return; }
    close(true);
    // the field in view first (a keyboard can open one scrolled away); one not on screen opens nothing
    var r0 = sel.getBoundingClientRect();
    if (r0.width === 0 && r0.height === 0) return;
    if (r0.top < 0 || r0.bottom > innerHeight) { try { sel.scrollIntoView({ block: 'nearest', behavior: 'instant' }); } catch (e) {} }
    var many = sel.options.length > 7;
    var pop = document.createElement('div');
    pop.className = 'lqs-pop';
    pop.setAttribute('role', 'listbox');
    var id = ++seq;
    pop.id = 'lqs-pop-' + id;
    var label = sel.getAttribute('aria-label') || (sel.labels && sel.labels[0] && sel.labels[0].textContent.trim()) || '';
    if (label) pop.setAttribute('aria-label', label);
    pop.innerHTML = (many ? '<div class="lqs-search">' + ICON_SEARCH + '<input type="text" autocomplete="off" spellcheck="false" placeholder="Search…" aria-label="Search the list" aria-controls="' + pop.id + '"></div>' : '')
      + '<div class="lqs-list"></div><div class="lqs-status" hidden></div>';
    document.body.appendChild(pop);
    cur = { sel: sel, pop: pop, id: id, list: pop.querySelector('.lqs-list'), search: pop.querySelector('.lqs-search input'), status: pop.querySelector('.lqs-status'),
      rows: [], active: -1, activeOpt: null, q: '', typed: '', typedAt: 0, drawn: false };
    sel.classList.add('lqs-open');
    sel.setAttribute('aria-expanded', 'true');
    sel.setAttribute('aria-controls', pop.id);
    render();
    place();
    if (!cur || cur.pop !== pop) return;   // the field went away while the list was being drawn
    if (reduced()) pop.classList.add('in'); else requestAnimationFrame(function () { requestAnimationFrame(function () { if (cur && cur.pop === pop) pop.classList.add('in'); }); });
    // the options may change while the list is open: follow them
    cur.mo = new MutationObserver(function () { render(); place(); });
    cur.mo.observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'label', 'hidden', 'data-sub', 'data-badge', 'style'] });
    if (cur.search) {
      cur.search.addEventListener('input', function () { if (!cur) return; cur.q = cur.search.value; cur.activeOpt = null; render(); place(); });
      setTimeout(function () { if (cur && cur.pop === pop) cur.search.focus({ preventScroll: true }); }, 0);
    } else sel.focus({ preventScroll: true });
    pop.addEventListener('mousedown', function (e) { if (e.target !== (cur && cur.search)) e.preventDefault(); });
    pop.addEventListener('mousemove', function (e) {
      var el = e.target.closest && e.target.closest('.lqs-opt');
      if (el && cur && +el.getAttribute('data-i') !== cur.active && el.getAttribute('aria-disabled') !== 'true') setActive(+el.getAttribute('data-i'), false);
    });
    pop.addEventListener('click', function (e) {
      var el = e.target.closest && e.target.closest('.lqs-opt');
      if (el && cur) choose(+el.getAttribute('data-i'));
    });
    sel.dispatchEvent(new CustomEvent('lqs-open', { bubbles: true }));
  }

  function close(instant) {
    if (!cur) return;
    var c = cur; cur = null;
    if (c.mo) c.mo.disconnect();
    c.sel.classList.remove('lqs-open');
    c.sel.setAttribute('aria-expanded', 'false');
    c.sel.removeAttribute('aria-activedescendant');
    var pop = c.pop;
    if (instant || reduced()) { pop.remove(); return; }
    pop.classList.remove('in');
    pop.classList.add('out');
    setTimeout(function () { pop.remove(); }, 170);
  }

  function choose(i) {
    if (!cur) return;
    var it = cur.rows[i];
    if (!it || it.disabled) return;
    var sel = cur.sel, before = sel.selectedIndex;
    close();
    try { sel.focus({ preventScroll: true }); } catch (e) {}
    it.o.selected = true;
    if (sel.selectedIndex !== before) {
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function move(step) {
    if (!cur || !cur.rows.length) return;
    var i = cur.active;
    for (var n = 0; n < cur.rows.length; n++) {
      i = i < 0 ? (step > 0 ? 0 : cur.rows.length - 1) : i + step;
      if (i < 0) i = cur.rows.length - 1;
      if (i >= cur.rows.length) i = 0;
      if (!cur.rows[i].disabled) { setActive(i, true); return; }
    }
  }

  // ---- the pointer: the field opens our list instead of the browser's ----
  window.addEventListener('pointerdown', function (e) { lastPointer = e.pointerType || 'mouse'; }, true);
  window.addEventListener('mousedown', function (e) {
    var t = e.target;
    if (cur && !cur.pop.contains(t) && t !== cur.sel) close();
    if (e.button !== 0 || lastPointer === 'touch') return;
    var sel = t && t.closest ? t.closest('select') : null;
    if (!sel || !eligible(sel)) return;
    e.preventDefault();
    try { sel.focus({ preventScroll: true }); } catch (err) {}
    open(sel);
  }, true);

  // ---- the keyboard ----
  window.addEventListener('keydown', function (e) {
    var t = e.target;
    if (!cur) {
      // a closed select with the focus: Space / Enter / Alt+↓ / F4 open the list
      if (t && t.tagName === 'SELECT' && eligible(t) && !e.ctrlKey && !e.metaKey &&
        (e.key === ' ' || e.key === 'Enter' || e.key === 'F4' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')))) {
        e.preventDefault(); e.stopImmediatePropagation(); open(t);
      }
      return;
    }
    var k = e.key, handled = true;
    if (k === 'ArrowDown') move(1);
    else if (k === 'ArrowUp') move(-1);
    else if (k === 'Home' && !cur.search) setActive(firstEnabled(0, 1), true);
    else if (k === 'End' && !cur.search) setActive(firstEnabled(cur.rows.length - 1, -1), true);
    else if (k === 'PageDown') { for (var a = 0; a < 6; a++) move(1); }
    else if (k === 'PageUp') { for (var b = 0; b < 6; b++) move(-1); }
    else if (k === 'Enter' || (k === ' ' && !cur.search)) { if (cur.active >= 0) choose(cur.active); else close(); }
    else if (k === 'Escape') { var s = cur.sel; close(); try { s.focus({ preventScroll: true }); } catch (err) {} }
    else if (k === 'Tab') { close(); handled = false; }
    else if (!cur.search && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // typing jumps to the first option that starts with what was typed
      var now = Date.now();
      cur.typed = (now - cur.typedAt < 700 ? cur.typed : '') + k.toLowerCase();
      cur.typedAt = now;
      for (var i = 0; i < cur.rows.length; i++) if (!cur.rows[i].disabled && cur.rows[i].label.toLowerCase().indexOf(cur.typed) === 0) { setActive(i, true); break; }
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  // ---- follow the page ----
  window.addEventListener('resize', function () { if (cur) place(); }, true);
  window.addEventListener('scroll', function (e) { if (cur && !cur.pop.contains(e.target)) place(); }, true);
  document.addEventListener('visibilitychange', function () { if (document.hidden) close(true); });
  window.addEventListener('blur', function () { close(true); });

  window.CricketSelect = {
    open: open,
    close: function () { close(); },
    isOpen: function (sel) { return !!(cur && (!sel || cur.sel === sel)); },
    status: function (sel, text, busy) {
      if (!cur || cur.sel !== sel) return;
      if (text == null || text === '') { cur.status.hidden = true; cur.status.innerHTML = ''; }
      else { cur.status.hidden = false; cur.status.innerHTML = (busy ? '<span class="lqs-spin" aria-hidden="true"></span>' : '') + '<span>' + esc(text) + '</span>'; }
      place();
    }
  };
})();
