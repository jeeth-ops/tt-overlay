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

  VB.applyTheme = function () {
    var t = VB.store.get('vb_theme', 'auto');
    if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
  };
  VB.applyTheme();
})();
