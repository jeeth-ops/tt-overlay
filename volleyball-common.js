/* 🏐 Shared by the volleyball pages: Google sign-in (the same Firebase
   project as the homepage — a session signed in there is already signed
   in here), API calls carrying the verified ID token, the /volleyball
   socket, the server clock, formatting and small UI helpers.

   Signing in only ever proves WHO you are; what you may do is decided by
   the server on every request (see volleyball-server.js). */
(function () {
  'use strict';
  var VB = window.VB = {};
  var listeners = {};
  VB.on = function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); };
  VB.emit = function (ev, x) { (listeners[ev] || []).forEach(function (fn) { try { fn(x); } catch (e) { console.error(e); } }); };

  var firebaseConfig = {
    apiKey: 'AIzaSyAYc_bEB9C4RhhLhPBEJsJRFRUppcR45yo',
    authDomain: 'auth.allsportslivestreams.com',
    projectId: 'scorvix-faf0e',
    storageBucket: 'scorvix-faf0e.firebasestorage.app',
    messagingSenderId: '725629580596',
    appId: '1:725629580596:web:7737847e7194650f276161'
  };
  var auth = null, readyResolve;
  VB.user = null;
  VB.authReady = new Promise(function (r) { readyResolve = r; });
  try {
    if (window.firebase) {
      if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
      auth = firebase.auth();
      auth.onAuthStateChanged(function (u) { VB.user = u || null; readyResolve(VB.user); VB.emit('auth', VB.user); });
    } else readyResolve(null);
  } catch (e) { console.warn('[vb] auth unavailable', e); readyResolve(null); }
  VB.signIn = function () {
    if (!auth) { location.href = '/'; return Promise.resolve(); }
    var provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    return auth.signInWithPopup(provider).catch(function () { return auth.signInWithRedirect(provider); });
  };
  VB.signOut = function () { return auth ? auth.signOut() : Promise.resolve(); };
  VB.token = function (force) {
    return VB.authReady.then(function () { return auth && auth.currentUser ? auth.currentUser.getIdToken(!!force) : null; }).catch(function () { return null; });
  };

  // JSON API with the ID token; one retry with a fresh token on 401.
  VB.api = function (method, url, body, opts) {
    opts = opts || {};
    var go = function (force) {
      return VB.token(force).then(function (tok) {
        var h = Object.assign({}, opts.headers || {});
        if (tok) h.Authorization = 'Bearer ' + tok;
        if (body !== undefined) h['Content-Type'] = 'application/json';
        return fetch(url, { method: method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store' })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok && j.success !== false, status: r.status, json: j }; }); });
      });
    };
    return go(false).then(function (r) { return r.status === 401 && !opts.noRetry ? go(true) : r; })
      .catch(function (e) { return { ok: false, status: 0, json: { error: 'No connection — ' + (e && e.message || 'network error') } }; });
  };

  // The /volleyball namespace, signed in when possible.
  VB.connect = function () {
    return VB.token().then(function (tok) {
      // eslint-disable-next-line no-undef
      var s = io('/volleyball', { auth: tok ? { idToken: tok } : {}, transports: ['websocket', 'polling'], reconnectionDelayMax: 4000 });
      // a refreshed token is handed to the server, so a long match never loses its identity
      if (auth) auth.onIdTokenChanged(function (u) { if (u) u.getIdToken().then(function (t) { s.emit('vb:auth', { idToken: t }); s.auth = { idToken: t }; }); });
      return s;
    });
  };
  VB.ack = function (socket, ev, payload, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve({ ok: false, timeout: true, error: 'No answer from the server' }); } }, ms || 10000);
      socket.emit(ev, payload, function (r) { if (done) return; done = true; clearTimeout(t); resolve(r || { ok: false }); });
    });
  };

  // Server clock: offset = server − local, measured over a few round trips.
  VB.clock = { offset: 0, rtt: null };
  VB.syncClock = function () {
    var best = null, i = 0;
    var one = function () {
      var t0 = Date.now();
      return fetch('/api/volleyball/time', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
        var t1 = Date.now(), rtt = t1 - t0;
        if (!best || rtt < best.rtt) best = { rtt: rtt, offset: j.now - (t0 + rtt / 2) };
      }).catch(function () {});
    };
    var loop = function () { return one().then(function () { return ++i < 4 ? loop() : null; }); };
    return loop().then(function () { if (best) { VB.clock.offset = best.offset; VB.clock.rtt = best.rtt; } return VB.clock; });
  };
  VB.serverNow = function () { return Date.now() + VB.clock.offset; };

  /* ---------- helpers ---------- */
  VB.esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  VB.$ = function (s, r) { return (r || document).querySelector(s); };
  VB.$$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  VB.uid = function () {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  };
  VB.deviceId = function () {
    try {
      var d = localStorage.getItem('vb_device');
      if (!d) { d = 'dev-' + VB.uid().slice(0, 13); localStorage.setItem('vb_device', d); }
      return d;
    } catch (e) { return 'dev-' + VB.uid().slice(0, 13); }
  };
  VB.store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } }
  };
  VB.lum = function (hex) {
    var h = String(hex || '#000').replace('#', ''); if (h.length === 3) h = h.replace(/./g, '$&$&');
    var n = parseInt(h, 16) || 0; return (0.299 * (n >> 16) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255;
  };
  VB.onColor = function (hex) { return VB.lum(hex) > 0.62 ? '#111111' : '#ffffff'; };
  VB.teamColor = function (t, fb) { return (t && t.colors && t.colors.primary) || fb || '#0a84ff'; };
  VB.initials = function (name) {
    var w = String(name || '').trim().split(/\s+/).filter(Boolean);
    return (w.length > 1 ? w.map(function (x) { return x[0]; }).join('') : String(name || '?')).slice(0, 3).toUpperCase();
  };
  VB.logoHtml = function (team, cls) {
    var c = VB.teamColor(team);
    if (team && team.logo) return '<span class="logo ' + (cls || '') + '" style="background:#fff"><img src="' + VB.esc(team.logo) + '" alt="" loading="lazy"></span>';
    return '<span class="logo ' + (cls || '') + '" style="background:' + VB.esc(c) + ';color:' + VB.onColor(c) + '">' + VB.esc(VB.initials(team && (team.shortName || team.name))) + '</span>';
  };
  VB.fmtDate = function (ms, opts) {
    if (!ms) return '';
    try { return new Intl.DateTimeFormat(undefined, Object.assign({ weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }, opts || {})).format(new Date(ms)); }
    catch (e) { return new Date(ms).toLocaleString(); }
  };
  VB.ago = function (ms) {
    if (!ms) return '';
    var s = Math.round((Date.now() - ms) / 1000);
    if (s < 5) return 'just now'; if (s < 60) return s + ' s ago'; if (s < 3600) return Math.round(s / 60) + ' min ago';
    return Math.round(s / 3600) + ' h ago';
  };
  var toasts = null;
  VB.toast = function (msg, kind) {
    if (!toasts) { toasts = document.createElement('div'); toasts.className = 'toasts'; toasts.setAttribute('role', 'status'); document.body.appendChild(toasts); }
    var t = document.createElement('div');
    t.className = 'toast' + (kind === 'err' ? ' err' : '');
    t.textContent = msg;
    toasts.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 320); }, kind === 'err' ? 4200 : 2200);
  };
  // A sheet (modal). Returns { el, close }. Escape and the scrim close it.
  VB.sheet = function (html, opts) {
    opts = opts || {};
    var scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = '<div class="sheet ' + (opts.wide ? 'wide' : '') + '" role="dialog" aria-modal="true">' + html + '</div>';
    document.body.appendChild(scrim);
    var prev = document.activeElement;
    requestAnimationFrame(function () { scrim.classList.add('show'); var f = scrim.querySelector('[autofocus], input, select, button'); if (f) f.focus(); });
    var close = function () {
      scrim.classList.remove('show');
      document.removeEventListener('keydown', onKey, true);
      setTimeout(function () { scrim.remove(); }, 260);
      if (prev && prev.focus) try { prev.focus(); } catch (e) { /* gone */ }
      if (opts.onClose) opts.onClose();
    };
    var onKey = function (e) { if (e.key === 'Escape') { e.preventDefault(); close(); } e.stopPropagation(); };
    document.addEventListener('keydown', onKey, true);
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim && !opts.sticky) close(); });
    VB.$$('[data-close]', scrim).forEach(function (b) { b.addEventListener('click', close); });
    return { el: scrim.firstChild, close: close };
  };
  VB.confirm = function (title, text, okLabel, danger) {
    return new Promise(function (resolve) {
      var s = VB.sheet('<h3>' + VB.esc(title) + '</h3><p class="muted" style="margin-top:8px">' + VB.esc(text) + '</p><div class="foot"><button class="btn" data-close>Cancel</button><button class="btn ' + (danger ? 'danger' : 'primary') + '" data-ok>' + VB.esc(okLabel || 'OK') + '</button></div>', { onClose: function () { resolve(false); } });
      s.el.querySelector('[data-ok]').addEventListener('click', function () { resolve(true); s.close(); });
    });
  };
  VB.prompt = function (title, text, placeholder, okLabel) {
    return new Promise(function (resolve) {
      var done = false;
      var s = VB.sheet('<h3>' + VB.esc(title) + '</h3><p class="muted small" style="margin:8px 0 12px">' + VB.esc(text) + '</p><input class="input" maxlength="200" placeholder="' + VB.esc(placeholder || '') + '" autofocus><div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>' + VB.esc(okLabel || 'Save') + '</button></div>', { onClose: function () { if (!done) resolve(null); } });
      var inp = s.el.querySelector('input');
      var ok = function () { var v = inp.value.trim(); if (!v) { inp.focus(); return; } done = true; resolve(v); s.close(); };
      s.el.querySelector('[data-ok]').addEventListener('click', ok);
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok(); });
    });
  };
  // A picture, resized in the browser and sent as a data URL the server
  // accepts. Logos: up to 512 px (sharp on the broadcast graphics' large
  // plates) as PNG, keeping transparency — as WebP (still transparent) or
  // smaller if that PNG would be too big to store.
  function readImage(file, done) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) return reject(new Error('Use a PNG, JPEG or WebP picture'));
      if (file.size > 12 * 1024 * 1024) return reject(new Error('That picture is over 12 MB'));
      var fr = new FileReader();
      fr.onload = function () {
        var img = new Image();
        img.onload = function () { try { resolve(done(img)); } catch (e) { reject(e); } };
        img.onerror = function () { reject(new Error('That file is not a picture we can read')); };
        img.src = fr.result;
      };
      fr.onerror = function () { reject(new Error('Could not read the file')); };
      fr.readAsDataURL(file);
    });
  }
  function draw(img, max, type, quality) {
    var k = Math.min(1, max / Math.max(img.width, img.height));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
    var g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL(type, quality);
  }
  var bytesOf = function (dataUrl) { return Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4); };
  VB.readLogo = function (file, max) {
    return readImage(file, function (img) {
      var limit = 580 * 1024, size = max || 512;
      var out = draw(img, size, 'image/png');
      if (bytesOf(out) > limit) { var w = draw(img, size, 'image/webp', 0.92); if (/^data:image\/webp/.test(w)) out = w; }
      while (bytesOf(out) > limit && size > 128) { size = Math.round(size * 0.75); out = draw(img, size, 'image/png'); }
      if (bytesOf(out) > limit) throw new Error('That logo is too detailed to store — try a simpler or smaller file');
      return out;
    });
  };
  // A player's portrait for the starting six and the player card: JPEG,
  // up to 800 px, under the server's 400 KB.
  VB.readPhoto = function (file) {
    return readImage(file, function (img) {
      var limit = 390 * 1024, q = 0.88, size = 800;
      var out = draw(img, size, 'image/jpeg', q);
      while (bytesOf(out) > limit && q > 0.5) { q -= 0.08; out = draw(img, size, 'image/jpeg', q); }
      while (bytesOf(out) > limit && size > 300) { size = Math.round(size * 0.8); out = draw(img, size, 'image/jpeg', q); }
      if (bytesOf(out) > limit) throw new Error('That photo is too large to store');
      return out;
    });
  };
  VB.ROLES = { S: 'Setter', OH: 'Outside hitter', OPP: 'Opposite', MB: 'Middle blocker', L: 'Libero', DS: 'Defensive specialist', U: 'Universal' };
  VB.POS = ['I', 'II', 'III', 'IV', 'V', 'VI'];
  VB.copy = function (text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    try { var a = document.createElement('textarea'); a.value = text; a.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(a); a.select(); var ok = document.execCommand('copy'); a.remove(); return Promise.resolve(ok); }
    catch (e) { return Promise.resolve(false); }
  };
  /* 🎬 THE CLIP PLAYER — the cricket scorecard's player, for volleyball:
     the page dims and blurs, the player card rises in, a branded loader
     holds the 16:9 frame until the video can play (then it fades in —
     nothing jumps), a stall shows a small "Buffering…", a failure says so
     with Try again / Download. One <video>, reused for every open; closing
     pauses at once and drops the download after the card has gone. A list
     plays as a playlist: Previous / Next (and ← →) step through it.

     VB.playClips([{ sources: [url, fallbackUrl], title, sub, poster, download }], index) */
  var cp = null;
  function cpBuild() {
    var root = document.createElement('div');
    root.className = 'vcp';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Clip player');
    root.innerHTML = '<div class="vcp-card"><div class="vcp-head"><div class="vcp-t"><b class="vcp-title"></b><span class="vcp-sub"></span></div>'
      + '<button class="vcp-x" type="button" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>'
      + '<div class="vcp-stage"><video controls playsinline webkit-playsinline preload="metadata"></video>'
      + '<div class="vcp-loader" role="status" aria-live="polite"><div class="vcp-brand" role="img" aria-label="AllSportsLive"></div><div class="vcp-lt">Loading your clip…</div><div class="vcp-bar" aria-hidden="true"></div><div class="vcp-ls"></div></div>'
      + '<div class="vcp-error" role="alert"><b>This clip didn’t load</b><span class="vcp-es"></span><div class="vcp-acts"><button class="vcp-btn vcp-retry" type="button">↻ Try again</button><a class="vcp-btn ghost vcp-edl" download>Download instead</a></div></div></div>'
      + '<div class="vcp-foot"><button class="vcp-nb vcp-prev" type="button" aria-label="Previous clip"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></button><span class="vcp-pos"></span>'
      + '<button class="vcp-nb vcp-next" type="button" aria-label="Next clip"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></button><span class="grow"></span>'
      + '<a class="vcp-dl" download><svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14"/></svg>Download</a></div></div>';
    document.body.appendChild(root);
    var q = function (s) { return root.querySelector(s); };
    cp = { root: root, video: q('video'), stage: q('.vcp-stage'), items: [], i: 0, src: 0, token: 0, slow: null, buf: null, cleanup: null, back: null };
    var v = cp.video;
    var ready = function () { cpState('ready'); clearTimeout(cp.slow); };
    v.addEventListener('loadeddata', ready);   // fires even when autoplay is blocked
    v.addEventListener('canplay', ready);
    v.addEventListener('error', function () {
      if (!v.getAttribute('src') || !cp.root.classList.contains('open')) return;
      var it = cp.items[cp.i];
      if (cp.src < it.sources.length - 1) { cp.src++; cpLoad(); return; }   // direct link → the website's own route
      clearTimeout(cp.slow);
      q('.vcp-es').textContent = navigator.onLine === false ? 'You seem to be offline. Reconnect and try again.' : 'The clip could not be loaded right now. Try again, or download it.';
      cpState('error');
    });
    v.addEventListener('waiting', function () {
      clearTimeout(cp.buf);
      cp.buf = setTimeout(function () { if (cp.stage.classList.contains('is-ready') && !v.paused) { q('.vcp-lt').textContent = 'Buffering…'; cp.stage.classList.add('is-buffering'); } }, 700);   // brief hiccups never flash an overlay
    });
    var unbuffer = function () { clearTimeout(cp.buf); cp.stage.classList.remove('is-buffering'); };
    ['playing', 'pause', 'seeked'].forEach(function (e) { v.addEventListener(e, unbuffer); });
    q('.vcp-x').addEventListener('click', cpClose);
    root.addEventListener('mousedown', function (e) { if (e.target === root) cpClose(); });
    q('.vcp-retry').addEventListener('click', function () { cp.src = 0; v.removeAttribute('src'); v.load(); cpLoad(); });
    q('.vcp-prev').addEventListener('click', function () { cpGo(-1); });
    q('.vcp-next').addEventListener('click', function () { cpGo(1); });
    // above any sheet underneath (whose own Escape would close it instead)
    window.addEventListener('keydown', function (e) {
      if (!cp.root.classList.contains('open')) return;
      if (e.key === 'Escape') cpClose();
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target !== v) cpGo(e.key === 'ArrowLeft' ? -1 : 1);
      else return;
      e.preventDefault(); e.stopImmediatePropagation();
    }, true);
  }
  function cpState(s) {   // 'loading' | 'ready' | 'error'
    cp.stage.classList.toggle('is-ready', s === 'ready');
    cp.stage.classList.toggle('is-error', s === 'error');
    if (s !== 'ready') cp.stage.classList.remove('is-buffering');
  }
  function cpLoad() {
    var v = cp.video, it = cp.items[cp.i], my = ++cp.token;
    cpState('loading');
    cp.root.querySelector('.vcp-lt').textContent = 'Loading your clip…';
    cp.root.querySelector('.vcp-ls').textContent = '';
    clearTimeout(cp.slow);
    cp.slow = setTimeout(function () { if (my === cp.token) cp.root.querySelector('.vcp-ls').textContent = 'Slow connection — still loading…'; }, 6000);
    v.preload = 'auto';
    if (v.getAttribute('src') !== it.sources[cp.src] || v.error) { v.src = it.sources[cp.src]; v.load(); }
    else if (v.readyState >= 2) cpState('ready');
    var p = v.play();
    if (p && p.catch) p.catch(function () { /* autoplay blocked — the controls still work */ });
  }
  function cpShow() {
    var it = cp.items[cp.i], q = function (s) { return cp.root.querySelector(s); }, n = cp.items.length;
    q('.vcp-title').textContent = it.title || 'Clip';
    q('.vcp-sub').textContent = it.sub || '';
    q('.vcp-pos').textContent = n > 1 ? (cp.i + 1) + ' / ' + n : '';
    q('.vcp-prev').hidden = q('.vcp-next').hidden = n < 2;
    q('.vcp-prev').disabled = cp.i === 0;
    q('.vcp-next').disabled = cp.i === n - 1;
    [q('.vcp-dl'), q('.vcp-edl')].forEach(function (a) { if (it.download) { a.href = it.download; a.hidden = false; } else { a.removeAttribute('href'); a.hidden = true; } });
    if (it.poster) { cp.video.poster = it.poster; q('.vcp-loader').style.setProperty('--vcp-poster', 'url("' + String(it.poster).replace(/"/g, '%22') + '")'); }
    else { cp.video.removeAttribute('poster'); q('.vcp-loader').style.removeProperty('--vcp-poster'); }
    cp.src = 0;
    cpLoad();
  }
  function cpGo(d) {
    var j = cp.i + d;
    if (j < 0 || j >= cp.items.length || j === cp.i) return;
    cp.i = j;
    cp.video.pause();
    cpShow();
  }
  function cpClose() {
    if (!cp || !cp.root.classList.contains('open')) return;
    cp.token++;
    clearTimeout(cp.slow); clearTimeout(cp.buf);
    cp.video.pause();   // sound stops at once; the frame stays while the card leaves
    cp.root.classList.remove('open');
    document.documentElement.classList.remove('vcp-on');
    if (cp.back && document.contains(cp.back)) try { cp.back.focus({ preventScroll: true }); } catch (e) { /* gone */ }
    cp.back = null;
    clearTimeout(cp.cleanup);
    cp.cleanup = setTimeout(function () {   // after the exit: abort the download, back to the loading state
      if (cp.root.classList.contains('open')) return;
      cp.video.removeAttribute('src'); cp.video.removeAttribute('poster'); cp.video.load();
      cpState('loading');
    }, 320);
  }
  VB.playClips = function (items, index) {
    items = (items || []).filter(function (x) { return x && x.sources && x.sources.filter(Boolean).length; })
      .map(function (x) { return Object.assign({}, x, { sources: x.sources.filter(Boolean) }); });
    if (!items.length) return;
    if (!cp) cpBuild();
    clearTimeout(cp.cleanup);
    if (!cp.root.classList.contains('open')) cp.back = document.activeElement;
    cp.items = items;
    cp.i = Math.max(0, Math.min(items.length - 1, index || 0));
    cpShow();
    cp.root.classList.add('open');
    document.documentElement.classList.add('vcp-on');
    cp.root.querySelector('.vcp-x').focus({ preventScroll: true });
  };
  VB.closeClips = cpClose;

  /* 🏟️ The cricket portal's pieces, for volleyball: line icons, the arena
     picture behind a cover, and the match card. */
  var ICONS = {
    matches: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    table: '<path d="M4 6h16M4 12h16M4 18h16"/><path d="M9 4v16"/>',
    leaders: '<path d="M6 20V11M12 20V4M18 20v-6"/>',
    bracket: '<path d="M4 5h5v6H4M4 13h5v6H4M9 8h4v8H9M13 12h7"/>',
    teams: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.6-3.6 3-5.6 6-5.6s5.4 2 6 5.6M16 4.6a3.2 3.2 0 0 1 0 6.4M18 14.6c1.8.7 2.9 2.5 3.2 5.4"/>',
    summary: '<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
    card: '<rect x="5" y="4" width="14" height="17" rx="2.5"/><path d="M9 4V2.8h6V4M8.5 10h7M8.5 14h7M8.5 18h4"/>',
    points: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    clips: '<rect x="3" y="5.5" width="13" height="13" rx="2.5"/><path d="m16 10 5-3v10l-5-3z"/>',
    lineups: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 12h17"/><circle cx="8" cy="8" r=".8"/><circle cx="16" cy="8" r=".8"/><circle cx="12" cy="16" r=".8"/>',
    insights: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
    mvp: '<path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-2.9-5.4 2.9 1.1-6-4.5-4.2 6.1-.8z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    h2h: '<path d="M4 7h11l-3-3M20 17H9l3 3"/>',
    play: '<path d="M7 4.5v15l13-7.5z"/>',
    pin: '<path d="M12 21s-6.5-6.1-6.5-11.2A6.5 6.5 0 0 1 12 3.3a6.5 6.5 0 0 1 6.5 6.5C18.5 14.9 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.3"/>',
    cal: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5a3 3 0 0 0 3.5 4M16 6h3.5a3 3 0 0 1-3.5 4M12 13v4M8.5 20.5h7M9.5 17h5v3.5h-5z"/>',
    user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5c.8-4 3.8-6.2 7.5-6.2s6.7 2.2 7.5 6.2"/>',
    ball: '<circle cx="12" cy="12" r="9"/><path d="M12 3c-1.8 3.2-1.8 7.4 0 9M12 12c3.6 0 7-1.8 8.6-4.6M12 12c-1.8 3.2-5.2 5.4-8.8 5.2"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>'
  };
  VB.icon = function (name, cls) { return '<svg class="' + (cls || 'i') + '" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg>'; };

  // The arena behind a cover: night sky, light rigs, the crowd, an orange
  // court in perspective with its lines, the net and a ball in flight. The
  // two colours tint the light (a tournament's, or the two teams').
  var artN = 0;
  VB.coverArt = function (a, b) {
    var id = 'vba' + (++artN), A = /^#[0-9a-f]{3,8}$/i.test(a || '') ? a : '#2563eb', B = /^#[0-9a-f]{3,8}$/i.test(b || '') ? b : '#22c55e';
    var L = function (y) { return 520 + (330 - 520) * (y - 420) / 270; }, R = function (y) { return 1080 + (1270 - 1080) * (y - 420) / 270; };
    var line = function (y) { return '<path d="M' + L(y).toFixed(1) + ' ' + y + 'H' + R(y).toFixed(1) + '"/>'; };
    var mesh = '';
    for (var x = 432; x <= 1168; x += 16) mesh += 'M' + x + ' 392V440';
    return '<svg class="art" viewBox="0 0 1600 700" preserveAspectRatio="xMidYMid slice" aria-hidden="true">'
      + '<defs><linearGradient id="' + id + 's" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1633"/><stop offset=".55" stop-color="#081022"/><stop offset="1" stop-color="#04070e"/></linearGradient>'
      + '<radialGradient id="' + id + 'a" cx=".18" cy=".2" r=".6"><stop offset="0" stop-color="' + A + '" stop-opacity=".55"/><stop offset="1" stop-color="' + A + '" stop-opacity="0"/></radialGradient>'
      + '<radialGradient id="' + id + 'b" cx=".85" cy=".15" r=".55"><stop offset="0" stop-color="' + B + '" stop-opacity=".45"/><stop offset="1" stop-color="' + B + '" stop-opacity="0"/></radialGradient>'
      + '<linearGradient id="' + id + 'beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'
      + '<linearGradient id="' + id + 'c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f97316"/><stop offset="1" stop-color="#c2410c"/></linearGradient>'
      + '<linearGradient id="' + id + 'f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#172554"/></linearGradient>'
      + '<pattern id="' + id + 'p" width="14" height="12" patternUnits="userSpaceOnUse"><circle cx="3" cy="4" r="2.4" fill="#cbd5e1" fill-opacity=".22"/><circle cx="10" cy="9" r="2.2" fill="#94a3b8" fill-opacity=".16"/></pattern>'
      + '<pattern id="' + id + 'q" width="22" height="16" patternUnits="userSpaceOnUse"><circle cx="6" cy="5" r="2" fill="' + A + '" fill-opacity=".35"/><circle cx="17" cy="11" r="2" fill="' + B + '" fill-opacity=".3"/></pattern>'
      + '<linearGradient id="' + id + 'm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".35" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity=".5"/></linearGradient>'
      + '<mask id="' + id + 'k"><rect x="0" y="150" width="1600" height="270" fill="url(#' + id + 'm)"/></mask>'
      + '<radialGradient id="' + id + 'g" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fb923c" stop-opacity=".45"/><stop offset="1" stop-color="#fb923c" stop-opacity="0"/></radialGradient></defs>'
      + '<rect width="1600" height="700" fill="url(#' + id + 's)"/><rect width="1600" height="700" fill="url(#' + id + 'a)"/><rect width="1600" height="700" fill="url(#' + id + 'b)"/>'
      // the stands: tiers of the crowd, fading up into the dark
      + '<g mask="url(#' + id + 'k)"><rect x="0" y="150" width="1600" height="270" fill="url(#' + id + 'p)"/><rect x="0" y="150" width="1600" height="270" fill="url(#' + id + 'q)"/></g>'
      + '<path d="M0 300H1600M0 360H1600" stroke="#fff" stroke-opacity=".05" stroke-width="3"/>'
      + '<rect x="0" y="404" width="1600" height="16" fill="#0f172a"/><rect x="0" y="404" width="1600" height="3" fill="' + A + '" fill-opacity=".6"/>'
      // light rigs and their beams
      + '<g fill="url(#' + id + 'beam)"><path d="M260 0h60l260 700H120z" opacity=".55"/><path d="M1280 0h60l140 700H1020z" opacity=".55"/><path d="M770 0h60l170 700H600z" opacity=".35"/></g>'
      + '<g fill="#fff"><rect x="250" y="14" width="80" height="10" rx="4" opacity=".85"/><rect x="1270" y="14" width="80" height="10" rx="4" opacity=".85"/><rect x="760" y="10" width="80" height="10" rx="4" opacity=".7"/></g>'
      // the floor, the free zone and the court (right of centre: the title sits on the stands)
      + '<rect x="0" y="420" width="1600" height="280" fill="#0b1226"/><g transform="translate(190 0)">'
      + '<path d="M470 400H1130L1420 700H180Z" fill="url(#' + id + 'f)"/>'
      + '<ellipse cx="800" cy="560" rx="520" ry="150" fill="url(#' + id + 'g)"/>'
      + '<path d="M520 420H1080L1270 690H330Z" fill="url(#' + id + 'c)"/>'
      + '<g stroke="#fff" stroke-width="5" fill="none" stroke-linejoin="round" opacity=".92"><path d="M520 420H1080L1270 690H330Z"/>' + line(520) + '</g>'
      + '<g stroke="#fff" stroke-width="3.5" fill="none" opacity=".8">' + line(490) + line(565) + '</g>'
      // the net
      + '<g><path d="M420 520V372M1180 520V372" stroke="#e2e8f0" stroke-width="7" stroke-linecap="round"/>'
      + '<rect x="420" y="390" width="760" height="52" fill="#020617" fill-opacity=".35"/>'
      + '<path d="' + mesh + 'M420 404H1180M420 418H1180M420 432H1180" stroke="#fff" stroke-opacity=".22" stroke-width="1.2"/>'
      + '<rect x="420" y="384" width="760" height="8" rx="2" fill="#fff"/><rect x="420" y="440" width="760" height="4" fill="#fff" fill-opacity=".8"/>'
      + '<path d="M449.6 330V444M1150.4 330V444" stroke="#fff" stroke-width="4" stroke-dasharray="10 10"/><path d="M449.6 340V444M1150.4 340V444" stroke="#ef4444" stroke-width="4" stroke-dasharray="10 10" stroke-dashoffset="10"/></g>'
      // a ball in flight
      + '<path d="M470 640Q760 120 1040 236" fill="none" stroke="#fff" stroke-opacity=".38" stroke-width="3" stroke-dasharray="2 12" stroke-linecap="round"/>'
      + '<g transform="translate(1062 240)"><circle r="30" fill="#fde68a"/><circle r="30" fill="none" stroke="#1d4ed8" stroke-opacity=".55" stroke-width="2"/><path d="M-5-29c-8 14-8 32 1 44M1 15c14 2 24-6 28-18M1 15c-12 8-24 9-29 5M-20-21c12 4 24 2 30-8M-28 4c10 4 22 0 29-11" fill="none" stroke="#1d4ed8" stroke-opacity=".7" stroke-width="2.4" stroke-linecap="round"/></g>'
      + '</g></svg>';
  };

  // A match card (the cricket portal's): the two colours in the header, both
  // teams with their sets (and the live set's points), every set's score,
  // and what to do next. opts: { href (null: no link), slotLabel(m, side), actions (html), showVenue, cls }
  VB.matchCard = function (m, opts) {
    opts = opts || {};
    var esc = VB.esc, A = m.teamA, B = m.teamB, sum = m.summary, res = m.result;
    var ca = VB.teamColor(A, '#3b82f6'), cb = VB.teamColor(B, '#f59e0b');
    var w = res && res.winner;
    var live = m.status === 'live', done = m.status === 'completed';
    var sets = res ? res.sets : sum ? sum.setsWon : null;
    var brk = live && sum && sum.status === 'set_break';
    var st = live ? (brk ? '<span class="mc-st brk">SET BREAK</span>' : '<span class="mc-st live">LIVE</span>')
      : done ? '<span class="mc-st done">FULL TIME</span>'
      : m.status === 'abandoned' ? '<span class="mc-st brk">ABANDONED</span>'
      : m.locked ? '<span class="mc-st lock">LOCKED</span>' : '<span class="mc-st">UPCOMING</span>';
    var stage = m.stage ? [m.stage.group ? 'Group ' + m.stage.group : '', m.stage.round].filter(Boolean).join(' · ') : '';
    var label = function (s) { return opts.slotLabel ? opts.slotLabel(m, s) : 'To be decided'; };
    var row = function (s) {
      var t = s === 'A' ? A : B, c = s === 'A' ? ca : cb;
      var serving = live && sum && sum.status === 'in_set' && sum.serving === s;
      var sc = '';
      if (sets && m.status !== 'scheduled') {
        var pt = live && sum && sum.status === 'in_set' ? '<span class="pt" title="Set ' + sum.set + '">' + sum.points[s] + '</span>' : '';
        sc = '<span class="sc">' + pt + '<b>' + sets[s] + '</b></span>';
      }
      return '<div class="mc-team' + (w && w !== s ? ' lost' : '') + '" style="--tc:' + esc(c) + '">' + (t ? VB.logoHtml(t, 'sm') : '<span class="logo sm">?</span>')
        + '<span class="nm">' + (t ? '<b>' + esc(t.name) + (w === s ? '<span class="won">WON</span>' : '') + (serving ? ' <span class="mc-serve" title="Serving">' + VB.icon('ball') + '</span>' : '') + '</b><small>' + esc(t.shortName || t.city || '') + '</small>'
          : '<b class="tbd">' + esc(label(s)) + '</b><small>To be decided</small>') + '</span>' + sc + '</div>';
    };
    var setList = (res && res.setScores) || (sum && sum.sets) || [];
    var setsHtml = setList.length ? '<div class="mc-sets">' + setList.map(function (x) {
      var now = x.status && x.status !== 'completed';
      return '<span class="' + (now ? 'now' : '') + '">S' + x.set + ' ' + x.A + '–' + x.B + '</span>';
    }).join('') + '</div>' : '';
    var when = m.scheduledAt ? VB.fmtDate(m.scheduledAt) : 'Time to be set';
    var place = opts.showVenue === false ? '' : m.venue || '';
    var foot;
    if (done && w) {
      var wt = w === 'A' ? A : B;
      foot = '<b class="win">' + esc((wt ? wt.name : 'Team ' + w) + ' won ' + Math.max(sets.A, sets.B) + '–' + Math.min(sets.A, sets.B)) + (res.forfeit ? ' (forfeit)' : '') + '</b><small>' + esc([m.completedAt ? VB.fmtDate(m.completedAt) : when, place].filter(Boolean).join(' · ')) + '</small>';
    } else if (live && sum) {
      var srv = sum.serving ? (sum.serving === 'A' ? A : B) : null;
      foot = '<b>' + esc(brk ? 'Break before set ' + (sum.nextSet || sum.set + 1) : 'Set ' + sum.set + ' · ' + sum.points.A + '–' + sum.points.B) + '</b><small>' + esc(sum.matchPoint ? 'Match point ' + ((sum.matchPoint === 'A' ? A : B) || {}).name : sum.setPoint ? 'Set point ' + ((sum.setPoint === 'A' ? A : B) || {}).name : srv ? srv.name + ' serving' : place || 'In play') + '</small>';
    } else if (m.status === 'abandoned') {
      foot = '<b>Abandoned</b><small>' + esc(when) + '</small>';
    } else {
      foot = '<b>' + esc(when) + '</b><small>' + esc(place || (m.locked ? m.lockReason || 'Locked' : 'Best of ' + ((m.rules && m.rules.bestOf) || 5))) + '</small>';
    }
    var cta = live ? '<span class="mc-cta live">' + VB.icon('play') + 'Watch live</span>' : done ? '<span class="mc-cta">Scorecard' + VB.icon('arrow') + '</span>' : '<span class="mc-cta">Match centre' + VB.icon('arrow') + '</span>';
    var href = opts.href === null ? null : opts.href || '/volleyball/match/' + encodeURIComponent(m.matchId);
    return '<article class="mcard' + (live ? ' is-live' : '') + (opts.cls ? ' ' + opts.cls : '') + '" style="--ta:' + esc(ca) + ';--tb:' + esc(cb) + '" data-m="' + esc(m.matchId) + '">'
      + (href ? '<a class="mc-link" href="' + esc(href) + '" aria-label="' + esc((A ? A.name : label('A')) + ' v ' + (B ? B.name : label('B'))) + '"></a>' : '')
      + '<div class="mc-head">' + (m.matchNo ? '<span class="tag">M' + m.matchNo + '</span>' : '') + '<span class="grow">' + esc(stage || m.title || 'Match') + '</span>' + st + '</div>'
      + '<div class="mc-body">' + row('A') + row('B') + setsHtml + '</div>'
      + '<div class="mc-foot"><div class="grow">' + foot + '</div>' + (href ? cta : '') + '</div>'
      + (opts.actions ? '<div class="mc-acts">' + opts.actions + '</div>' : '')
      + '</article>';
  };

  // Dark by default — the All Sports Live broadcast look; light for whoever
  // picks it ('auto' from before follows the device).
  VB.theme = function () {
    var t = VB.store.get('vb_theme', 'dark');
    if (t === 'auto') t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    return t === 'light' ? 'light' : 'dark';
  };
  var paintThemeButtons = function () {
    var t = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    document.querySelectorAll('[data-theme-btn]').forEach(function (b) { b.innerHTML = VB.themeIcon(); b.title = t === 'dark' ? 'Light theme' : 'Dark theme'; });
  };
  VB.applyTheme = function () {
    document.documentElement.dataset.theme = VB.theme();
    paintThemeButtons();
  };
  VB.themeIcon = function () {
    return VB.theme() === 'dark'
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z"/></svg>';
  };
  VB.toggleTheme = function () { VB.store.set('vb_theme', VB.theme() === 'dark' ? 'light' : 'dark'); VB.applyTheme(); };
  // a theme button anywhere on the page: <button class="theme-btn" data-theme-btn>
  document.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-theme-btn]'); if (b) VB.toggleTheme(); });
  VB.applyTheme();
  // a page may fix its own theme (the studio is always dark): only the buttons are painted later
  document.addEventListener('DOMContentLoaded', paintThemeButtons);
})();
