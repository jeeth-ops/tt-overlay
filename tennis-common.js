/* 🎾 Shared by the tennis pages: Google sign-in (the same Firebase project
   as the homepage — a session signed in there is already signed in here),
   API calls carrying the verified ID token, the /tennis socket, the server
   clock, formatting, the clip player and small UI helpers.

   Signing in only ever proves WHO you are; what you may do is decided by
   the server on every request (see tennis-server.js). */
(function () {
  'use strict';
  var TN = window.TN = {};
  var listeners = {};
  TN.on = function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); };
  TN.emit = function (ev, x) { (listeners[ev] || []).forEach(function (fn) { try { fn(x); } catch (e) { console.error(e); } }); };

  var firebaseConfig = {
    apiKey: 'AIzaSyAYc_bEB9C4RhhLhPBEJsJRFRUppcR45yo',
    authDomain: 'auth.allsportslivestreams.com',
    projectId: 'scorvix-faf0e',
    storageBucket: 'scorvix-faf0e.firebasestorage.app',
    messagingSenderId: '725629580596',
    appId: '1:725629580596:web:7737847e7194650f276161'
  };
  var auth = null, readyResolve;
  TN.user = null;
  TN.authReady = new Promise(function (r) { readyResolve = r; });
  try {
    if (window.firebase) {
      if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
      auth = firebase.auth();
      auth.onAuthStateChanged(function (u) { TN.user = u || null; readyResolve(TN.user); TN.emit('auth', TN.user); });
    } else readyResolve(null);
  } catch (e) { console.warn('[tn] auth unavailable', e); readyResolve(null); }
  TN.signIn = function () {
    if (!auth) { location.href = '/'; return Promise.resolve(); }
    var provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    return auth.signInWithPopup(provider).catch(function () { return auth.signInWithRedirect(provider); });
  };
  TN.signOut = function () { return auth ? auth.signOut() : Promise.resolve(); };
  TN.token = function (force) {
    return TN.authReady.then(function () { return auth && auth.currentUser ? auth.currentUser.getIdToken(!!force) : null; }).catch(function () { return null; });
  };

  // JSON API with the ID token; one retry with a fresh token on 401.
  TN.api = function (method, url, body, opts) {
    opts = opts || {};
    var go = function (force) {
      return TN.token(force).then(function (tok) {
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

  // The /tennis namespace, signed in when possible.
  TN.connect = function () {
    return TN.token().then(function (tok) {
      // eslint-disable-next-line no-undef
      var s = io('/tennis', { auth: tok ? { idToken: tok } : {}, transports: ['websocket', 'polling'], reconnectionDelayMax: 4000 });
      // a refreshed token is handed to the server, so a long match never loses its identity
      if (auth) auth.onIdTokenChanged(function (u) { if (u) u.getIdToken().then(function (t) { s.emit('tn:auth', { idToken: t }); s.auth = { idToken: t }; }); });
      return s;
    });
  };
  TN.ack = function (socket, ev, payload, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve({ ok: false, timeout: true, error: 'No answer from the server' }); } }, ms || 10000);
      socket.emit(ev, payload, function (r) { if (done) return; done = true; clearTimeout(t); resolve(r || { ok: false }); });
    });
  };

  // Server clock: offset = server − local, measured over a few round trips.
  TN.clock = { offset: 0, rtt: null };
  TN.syncClock = function () {
    var best = null, i = 0;
    var one = function () {
      var t0 = Date.now();
      return fetch('/api/tennis/time', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
        var t1 = Date.now(), rtt = t1 - t0;
        if (!best || rtt < best.rtt) best = { rtt: rtt, offset: j.now - (t0 + rtt / 2) };
      }).catch(function () {});
    };
    var loop = function () { return one().then(function () { return ++i < 4 ? loop() : null; }); };
    return loop().then(function () { if (best) { TN.clock.offset = best.offset; TN.clock.rtt = best.rtt; } return TN.clock; });
  };
  TN.serverNow = function () { return Date.now() + TN.clock.offset; };

  /* ---------- helpers ---------- */
  TN.esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  TN.$ = function (s, r) { return (r || document).querySelector(s); };
  TN.$$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  TN.uid = function () {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  };
  TN.deviceId = function () {
    try {
      var d = localStorage.getItem('tn_device');
      if (!d) { d = 'dev-' + TN.uid().slice(0, 13); localStorage.setItem('tn_device', d); }
      return d;
    } catch (e) { return 'dev-' + TN.uid().slice(0, 13); }
  };
  TN.store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } }
  };
  TN.lum = function (hex) {
    var h = String(hex || '#000').replace('#', ''); if (h.length === 3) h = h.replace(/./g, '$&$&');
    var n = parseInt(h, 16) || 0; return (0.299 * (n >> 16) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255;
  };
  TN.onColor = function (hex) { return TN.lum(hex) > 0.62 ? '#111111' : '#ffffff'; };
  TN.teamColor = function (t, fb) { return (t && t.colors && t.colors.primary) || fb || '#0a84ff'; };
  TN.initials = function (name) {
    var w = String(name || '').trim().split(/\s+/).filter(Boolean);
    return (w.length > 1 ? w.map(function (x) { return x[0]; }).join('') : String(name || '?')).slice(0, 3).toUpperCase();
  };
  TN.logoHtml = function (team, cls) {
    var c = TN.teamColor(team);
    if (team && team.logo) return '<span class="logo ' + (cls || '') + '" style="background:#fff"><img src="' + TN.esc(team.logo) + '" alt="" loading="lazy"></span>';
    return '<span class="logo ' + (cls || '') + '" style="background:' + TN.esc(c) + ';color:' + TN.onColor(c) + '">' + TN.esc(TN.initials(team && (team.shortName || team.name))) + '</span>';
  };
  TN.fmtDate = function (ms, opts) {
    if (!ms) return '';
    try { return new Intl.DateTimeFormat(undefined, Object.assign({ weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }, opts || {})).format(new Date(ms)); }
    catch (e) { return new Date(ms).toLocaleString(); }
  };
  TN.ago = function (ms) {
    if (!ms) return '';
    var s = Math.round((Date.now() - ms) / 1000);
    if (s < 5) return 'just now'; if (s < 60) return s + ' s ago'; if (s < 3600) return Math.round(s / 60) + ' min ago';
    return Math.round(s / 3600) + ' h ago';
  };
  var toasts = null;
  TN.toast = function (msg, kind) {
    if (!toasts) { toasts = document.createElement('div'); toasts.className = 'toasts'; toasts.setAttribute('role', 'status'); document.body.appendChild(toasts); }
    var t = document.createElement('div');
    t.className = 'toast' + (kind === 'err' ? ' err' : '');
    t.textContent = msg;
    toasts.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 320); }, kind === 'err' ? 4200 : 2200);
  };
  // A sheet (modal). Returns { el, close }. Escape and the scrim close it.
  TN.sheet = function (html, opts) {
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
    TN.$$('[data-close]', scrim).forEach(function (b) { b.addEventListener('click', close); });
    return { el: scrim.firstChild, close: close };
  };
  TN.confirm = function (title, text, okLabel, danger) {
    return new Promise(function (resolve) {
      var s = TN.sheet('<h3>' + TN.esc(title) + '</h3><p class="muted" style="margin-top:8px">' + TN.esc(text) + '</p><div class="foot"><button class="btn" data-close>Cancel</button><button class="btn ' + (danger ? 'danger' : 'primary') + '" data-ok>' + TN.esc(okLabel || 'OK') + '</button></div>', { onClose: function () { resolve(false); } });
      s.el.querySelector('[data-ok]').addEventListener('click', function () { resolve(true); s.close(); });
    });
  };
  TN.prompt = function (title, text, placeholder, okLabel) {
    return new Promise(function (resolve) {
      var done = false;
      var s = TN.sheet('<h3>' + TN.esc(title) + '</h3><p class="muted small" style="margin:8px 0 12px">' + TN.esc(text) + '</p><input class="input" maxlength="200" placeholder="' + TN.esc(placeholder || '') + '" autofocus><div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>' + TN.esc(okLabel || 'Save') + '</button></div>', { onClose: function () { if (!done) resolve(null); } });
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
  TN.readLogo = function (file, max) {
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
  TN.readPhoto = function (file) {
    return readImage(file, function (img) {
      var limit = 390 * 1024, q = 0.88, size = 800;
      var out = draw(img, size, 'image/jpeg', q);
      while (bytesOf(out) > limit && q > 0.5) { q -= 0.08; out = draw(img, size, 'image/jpeg', q); }
      while (bytesOf(out) > limit && size > 300) { size = Math.round(size * 0.8); out = draw(img, size, 'image/jpeg', q); }
      if (bytesOf(out) > limit) throw new Error('That photo is too large to store');
      return out;
    });
  };
  TN.copy = function (text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    try { var a = document.createElement('textarea'); a.value = text; a.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(a); a.select(); var ok = document.execCommand('copy'); a.remove(); return Promise.resolve(ok); }
    catch (e) { return Promise.resolve(false); }
  };
  /* 🎬 THE CLIP PLAYER — the cricket scorecard's player, for tennis:
     the page dims and blurs, the player card rises in, a branded loader
     holds the 16:9 frame until the video can play (then it fades in —
     nothing jumps), a stall shows a small "Buffering…", a failure says so
     with Try again / Download. One <video>, reused for every open; closing
     pauses at once and drops the download after the card has gone. A list
     plays as a playlist: Previous / Next (and ← →) step through it.

     TN.playClips([{ sources: [url, fallbackUrl], title, sub, poster, download }], index) */
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
  TN.playClips = function (items, index) {
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
  TN.closeClips = cpClose;

  /* 🏟️ Line icons (the cricket portal's set). */
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
  TN.icon = function (name, cls) { return '<svg class="' + (cls || 'i') + '" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg>'; };


  /* =================================================================
     🎾 TENNIS PIECES — people, countries, surfaces, the court picture
     behind a cover, scores, and the match card.
     ================================================================= */
  TN.SURFACES = { hard: { label: 'Hard court', c: '#2563eb', line: '#ffffff', out: '#1e3a8a' }, clay: { label: 'Clay court', c: '#c2410c', line: '#fff7ed', out: '#9a3412' }, grass: { label: 'Grass court', c: '#15803d', line: '#f0fdf4', out: '#166534' }, synthetic: { label: 'Synthetic court', c: '#0f766e', line: '#f0fdfa', out: '#115e59' }, carpet: { label: 'Carpet', c: '#7c3aed', line: '#f5f3ff', out: '#5b21b6' }, other: { label: 'Court', c: '#475569', line: '#f8fafc', out: '#334155' } };
  TN.surface = function (k) { return TN.SURFACES[k] || TN.SURFACES.hard; };
  TN.CATEGORIES = { men: "Men's", women: "Women's", mixed: 'Mixed', open: 'Open', boys: 'Boys', girls: 'Girls', veterans: 'Veterans', custom: 'Custom' };
  TN.surname = function (n) { var w = String(n || '').trim().split(/\s+/); return w[w.length - 1] || ''; };
  TN.short = function (n) { var w = String(n || '').trim().split(/\s+/).filter(Boolean); return w.length > 1 ? w[0][0] + '. ' + w.slice(1).join(' ') : (w[0] || ''); };
  // a player's colour: their own, else one worked out from their id (stable, never random)
  var PALETTE = ['#0f766e', '#b45309', '#1d4ed8', '#be123c', '#7c3aed', '#15803d', '#c2410c', '#0369a1', '#a21caf', '#4d7c0f'];
  TN.colorOf = function (p, fb) {
    if (p && /^#[0-9a-f]{6}$/i.test(p.color || '')) return p.color;
    var id = String((p && (p.playerId || p.name)) || fb || ''), h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return PALETTE[Math.abs(h) % PALETTE.length];
  };
  TN.sideColor = function (side, fb) { if (!side) return fb || '#0f766e'; return side.color || TN.colorOf(side.players && side.players[0], fb); };
  // a portrait — only one that was uploaded; otherwise the player's initials on their colour
  TN.avatar = function (p, size, cls) {
    var c = TN.colorOf(p);
    var s = '--s:' + (size || 44) + 'px;--c:' + TN.esc(c);
    if (p && p.photo) return '<span class="av ' + (cls || '') + '" style="' + s + '"><img src="' + TN.esc(p.photo) + '" alt="" loading="lazy"></span>';
    return '<span class="av ' + (cls || '') + '" style="' + s + '">' + TN.esc(TN.initials(p && p.name)) + '</span>';
  };
  TN.ctry = function (code) { return code ? '<span class="ctry">' + TN.esc(String(code).slice(0, 3)) + '</span>' : ''; };
  TN.sideName = function (side, fb) { return side ? side.name : (fb || 'To be decided'); };
  TN.slotLabel = function (m, s) {
    var src = m.source && m.source[s];
    if (src && src.winnerOf) return 'Winner of ' + String(src.winnerOf).replace(/^.*KO:(\d+):(\d+)$/, 'R$1 · match $2');
    if (src && src.loserOf) return 'Loser of ' + String(src.loserOf).replace(/^.*KO:(\d+):(\d+)$/, 'R$1 · match $2');
    return 'To be decided';
  };
  // the set scores of a summary / result for one side: [{ g, tb, won, now }]
  TN.setCells = function (m, s) {
    var sum = m.summary, res = m.result || (sum && sum.result);
    var list = (res && res.scores) || (sum && sum.sets) || [];
    return list.map(function (x) {
      var mtb = !!x.mtb;
      var g = mtb && x.tb ? x.tb[s] : x[s];
      var won = x.winner === s;
      var now = !x.winner && (!x.status || x.status !== 'completed');
      return { g: g, tb: x.tb && !mtb && !won && x.winner ? x.tb[s] : null, won: won, now: now, mtb: mtb };
    }).filter(function (c, i, a) { return c.g > 0 || c.now || a.length === 1 || c.won || (list[i] && (list[i].A + list[i].B > 0 || list[i].winner)); });
  };
  TN.scoreLine = function (res, from) {
    if (!res || !res.scores) return '';
    var me = from || res.winner || 'A', op = me === 'A' ? 'B' : 'A';
    if (res.reason === 'walkover') return 'w/o';
    var parts = res.scores.map(function (x) {
      if (x.mtb && x.tb) return '[' + x.tb[me] + '-' + x.tb[op] + ']';
      if (!x.A && !x.B && !x.tb) return '';
      return x[me] + '-' + x[op] + (x.tb ? '(' + Math.min(x.tb.A, x.tb.B) + ')' : '');
    }).filter(Boolean);
    if (res.reason === 'retired') parts.push('ret.');
    if (res.reason === 'default') parts.push('def.');
    return parts.join(' ');
  };
  TN.statusBadge = function (m) {
    var s = m.status;
    if (s === 'live') return '<span class="badge live">Live</span>';
    if (s === 'paused') return '<span class="badge live">Paused</span>';
    if (s === 'suspended') return '<span class="badge">Suspended</span>';
    if (s === 'completed') { var r = m.result && m.result.reason; return '<span class="badge done">' + (r === 'retired' ? 'Retired' : r === 'walkover' ? 'Walkover' : r === 'default' ? 'Default' : 'Completed') + '</span>'; }
    if (s === 'abandoned') return '<span class="badge">Abandoned</span>';
    if (s === 'ready') return '<span class="badge optic">Ready</span>';
    return '<span class="badge">Upcoming</span>';
  };
  // The tennis court in perspective — the surface's own colour, its lines,
  // the net, the stands and a ball in flight — behind a cover.
  var artN = 0;
  TN.coverArt = function (surfaceKey, accent) {
    var id = 'tna' + (++artN), sf = TN.surface(surfaceKey), A = /^#[0-9a-f]{6}$/i.test(accent || '') ? accent : '#c8f031';
    // the court's corners, far baseline (y 300) to near baseline (y 668)
    var far = 300, near = 668, fx0 = 560, fx1 = 1040, nx0 = 250, nx1 = 1350;
    var xAt = function (t, side) { return side === 0 ? fx0 + (nx0 - fx0) * t : fx1 + (nx1 - fx1) * t; };
    var yAt = function (t) { return far + (near - far) * t; };
    var hl = function (t, inset) { var a = xAt(t, 0), b = xAt(t, 1), w = (b - a) * (inset || 0); return '<path d="M' + (a + w).toFixed(1) + ' ' + yAt(t).toFixed(1) + 'H' + (b - w).toFixed(1) + '"/>'; };
    var singles = 0.125, svcT = [0.235, 0.765];
    var sideLine = function (inset) { var a0 = xAt(0, 0), b0 = xAt(0, 1), a1 = xAt(1, 0), b1 = xAt(1, 1); var w0 = (b0 - a0) * inset, w1 = (b1 - a1) * inset; return '<path d="M' + (a0 + w0).toFixed(1) + ' ' + far + 'L' + (a1 + w1).toFixed(1) + ' ' + near + 'M' + (b0 - w0).toFixed(1) + ' ' + far + 'L' + (b1 - w1).toFixed(1) + ' ' + near + '"/>'; };
    var centre = '<path d="M' + ((xAt(svcT[0], 0) + xAt(svcT[0], 1)) / 2).toFixed(1) + ' ' + yAt(svcT[0]).toFixed(1) + 'L' + ((xAt(svcT[1], 0) + xAt(svcT[1], 1)) / 2).toFixed(1) + ' ' + yAt(svcT[1]).toFixed(1) + '"/>';
    var netY = yAt(0.5), nA = xAt(0.5, 0) - 40, nB = xAt(0.5, 1) + 40;
    var mesh = '';
    for (var x = nA; x <= nB; x += 14) mesh += 'M' + x.toFixed(1) + ' ' + (netY - 46).toFixed(1) + 'V' + netY.toFixed(1);
    return '<svg class="art" viewBox="0 0 1600 700" preserveAspectRatio="xMidYMid slice" aria-hidden="true">'
      + '<defs><linearGradient id="' + id + 's" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#06140f"/><stop offset=".6" stop-color="#081a13"/><stop offset="1" stop-color="#030806"/></linearGradient>'
      + '<radialGradient id="' + id + 'g" cx=".5" cy=".62" r=".55"><stop offset="0" stop-color="' + sf.c + '" stop-opacity=".55"/><stop offset="1" stop-color="' + sf.c + '" stop-opacity="0"/></radialGradient>'
      + '<radialGradient id="' + id + 'a" cx=".82" cy=".12" r=".45"><stop offset="0" stop-color="' + A + '" stop-opacity=".35"/><stop offset="1" stop-color="' + A + '" stop-opacity="0"/></radialGradient>'
      + '<linearGradient id="' + id + 'c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + sf.c + '"/><stop offset="1" stop-color="' + sf.out + '"/></linearGradient>'
      + '<linearGradient id="' + id + 'b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'
      + '<pattern id="' + id + 'p" width="16" height="12" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="2.3" fill="#cbd5e1" fill-opacity=".16"/><circle cx="12" cy="9" r="2.1" fill="' + A + '" fill-opacity=".12"/></pattern></defs>'
      + '<rect width="1600" height="700" fill="url(#' + id + 's)"/><rect width="1600" height="700" fill="url(#' + id + 'a)"/>'
      + '<rect x="0" y="120" width="1600" height="170" fill="url(#' + id + 'p)"/><rect x="0" y="282" width="1600" height="8" fill="#0b1712"/><rect x="0" y="282" width="1600" height="2" fill="' + A + '" fill-opacity=".55"/>'
      + '<g fill="url(#' + id + 'b)"><path d="M300 0h50l200 700H140z" opacity=".5"/><path d="M1250 0h50l170 700H1080z" opacity=".5"/></g>'
      + '<path d="M0 290H1600V700H0z" fill="' + sf.out + '"/>'
      + '<ellipse cx="800" cy="520" rx="640" ry="190" fill="url(#' + id + 'g)"/>'
      + '<path d="M' + (fx0 - 70) + ' ' + (far - 12) + 'H' + (fx1 + 70) + 'L' + (nx1 + 140) + ' 700H' + (nx0 - 140) + 'Z" fill="' + sf.out + '" fill-opacity=".55"/>'
      + '<path d="M' + fx0 + ' ' + far + 'H' + fx1 + 'L' + nx1 + ' ' + near + 'H' + nx0 + 'Z" fill="url(#' + id + 'c)"/>'
      + '<g stroke="' + sf.line + '" stroke-width="4" fill="none" stroke-opacity=".92" stroke-linejoin="round"><path d="M' + fx0 + ' ' + far + 'H' + fx1 + 'L' + nx1 + ' ' + near + 'H' + nx0 + 'Z"/>' + sideLine(singles) + hl(svcT[0], singles) + hl(svcT[1], singles) + centre + '</g>'
      + '<g><path d="M' + nA.toFixed(1) + ' ' + netY.toFixed(1) + 'V' + (netY - 52).toFixed(1) + 'M' + nB.toFixed(1) + ' ' + netY.toFixed(1) + 'V' + (netY - 52).toFixed(1) + '" stroke="#e2e8f0" stroke-width="6" stroke-linecap="round"/>'
      + '<path d="' + mesh + '" stroke="#fff" stroke-opacity=".2" stroke-width="1.2"/><rect x="' + nA.toFixed(1) + '" y="' + (netY - 50).toFixed(1) + '" width="' + (nB - nA).toFixed(1) + '" height="7" rx="2" fill="#fff"/></g>'
      + '<path d="M420 610Q760 150 1120 236" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="3" stroke-dasharray="2 12" stroke-linecap="round"/>'
      + '<g transform="translate(1138 236)"><circle r="17" fill="' + A + '"/><path d="M-12-11c8 6 8 16 0 23M12-11c-8 6-8 16 0 23" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="2.2" stroke-linecap="round"/></g>'
      + '</svg>';
  };
  // A match card: both sides with their sets (and the live game), the state, what to do next.
  TN.matchCard = function (m, opts) {
    opts = opts || {};
    var esc = TN.esc, sum = m.summary, res = m.result;
    var A = m.sides && m.sides.A, B = m.sides && m.sides.B;
    var ca = TN.sideColor(A, '#0f766e'), cb = TN.sideColor(B, '#b45309');
    var w = res && res.winner;
    var live = m.status === 'live' || m.status === 'paused', done = m.status === 'completed';
    var stage = m.stage ? [m.eventName, m.stage.group ? 'Group ' + m.stage.group : '', m.stage.round].filter(Boolean).join(' · ') : (m.eventName || '');
    var row = function (s) {
      var t = s === 'A' ? A : B;
      var serving = live && sum && sum.serving === s;
      var cells = m.status === 'scheduled' || m.status === 'ready' ? [] : TN.setCells(m, s);
      var sc = cells.map(function (c) { return '<i class="' + (c.won ? 'w' : '') + '">' + c.g + (c.tb != null ? '<sup>' + c.tb + '</sup>' : '') + '</i>'; }).join('');
      if (live && sum && sum.display) sc += '<b>' + esc(sum.display[s]) + '</b>';
      var names = t ? (t.players || []).map(function (p) { return (p.seed && m.format !== 'doubles' ? '<span class="seed">[' + p.seed + ']</span> ' : '') + esc(opts.full ? p.name : (m.format === 'doubles' ? TN.surname(p.name) : p.name)) + ' ' + TN.ctry(p.country); }).join(' / ') : '<span class="muted">' + esc(TN.slotLabel(m, s)) + '</span>';
      return '<div class="mc-side' + (w && w !== s ? ' lost' : '') + '"><span class="nm">' + (serving ? '<i class="mc-serve" title="Serving"></i>' : '') + '<span>' + names + '</span>' + (w === s ? ' <span class="badge done">Won</span>' : '') + '</span><span class="sc">' + sc + '</span></div>';
    };
    var when = m.scheduledAt ? TN.fmtDate(m.scheduledAt) : 'Time to be set';
    var place = [m.court ? 'Court ' + String(m.court).replace(/^court\s*/i, '') : '', m.venue].filter(Boolean).join(' · ');
    var foot;
    if (done && w) foot = '<b>' + esc(TN.sideName(m.sides[w]) + ' won ' + TN.scoreLine(res, w)) + '</b>';
    else if (live && sum) foot = '<b>' + esc(sum.status === 'paused' ? 'Paused' : sum.headline ? ({ match: 'Match point', set: 'Set point', break: 'Break point', game: 'Game point' })[sum.headline.kind] : (sum.call || 'In play')) + '</b>' + (place ? ' · ' + esc(place) : '');
    else if (m.status === 'abandoned') foot = '<b>Abandoned</b>';
    else foot = '<b>' + esc(when) + '</b>' + (place ? ' · ' + esc(place) : '');
    var href = opts.href === null ? null : opts.href || '/tennis/match/' + encodeURIComponent(m.matchId);
    return '<article class="mcard' + (live ? ' is-live' : '') + '" style="--ca:' + esc(ca) + ';--cb:' + esc(cb) + '" data-m="' + esc(m.matchId) + '">'
      + (href ? '<a class="mc-link" href="' + esc(href) + '" aria-label="' + esc(TN.sideName(A, TN.slotLabel(m, 'A')) + ' v ' + TN.sideName(B, TN.slotLabel(m, 'B'))) + '"></a>' : '')
      + '<div class="mc-head">' + (m.matchNo ? '<span>M' + m.matchNo + '</span>' : '') + '<span class="grow ellipsis">' + esc(stage || m.title || (m.format === 'doubles' ? 'Doubles' : 'Singles')) + '</span>' + TN.statusBadge(m) + '</div>'
      + '<div class="mc-body">' + row('A') + row('B') + '</div>'
      + '<div class="mc-foot"><div class="grow ellipsis">' + foot + '</div></div>'
      + (opts.actions ? '<div class="mc-acts">' + opts.actions + '</div>' : '')
      + '</article>';
  };
  // Dark by default — the All Sports Live broadcast look; light for whoever
  // picks it ('auto' from before follows the device).
  TN.theme = function () {
    var t = TN.store.get('tn_theme', 'dark');
    if (t === 'auto') t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    return t === 'light' ? 'light' : 'dark';
  };
  var paintThemeButtons = function () {
    var t = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    document.querySelectorAll('[data-theme-btn]').forEach(function (b) { b.innerHTML = TN.themeIcon(); b.title = t === 'dark' ? 'Light theme' : 'Dark theme'; });
  };
  TN.applyTheme = function () {
    document.documentElement.dataset.theme = TN.theme();
    paintThemeButtons();
  };
  TN.themeIcon = function () {
    return TN.theme() === 'dark'
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z"/></svg>';
  };
  TN.toggleTheme = function () { TN.store.set('tn_theme', TN.theme() === 'dark' ? 'light' : 'dark'); TN.applyTheme(); };
  // a theme button anywhere on the page: <button class="theme-btn" data-theme-btn>
  document.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-theme-btn]'); if (b) TN.toggleTheme(); });
  TN.applyTheme();
  // a page may fix its own theme (the studio is always dark): only the buttons are painted later
  document.addEventListener('DOMContentLoaded', paintThemeButtons);
})();
