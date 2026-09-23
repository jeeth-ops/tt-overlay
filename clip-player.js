/* =====================================================================
   🎬 AllSportsLive clip player — shared by the tournament / match score
   pages (same experience as cricket-scorecard.html's player).

   Include with <script src="/clip-player.js"></script> at the end of the
   page. It builds its own modal (#video-modal-backdrop) and defines:
     openVideoModal(clipId, title, playbackUrl?, posterUrl?)
     closeVideoModal()
   Old clips without a direct CDN URL play through /api/clips/:id/watch.

   Flow: tap → card rises in → branded loading screen (only while the
   video is really preparing) → video fades in → close reverses the
   motion; the source is released after the exit animation (no flash,
   the download stops). Failed loads fall back to /watch, then show a
   Try again / Download state.
   ===================================================================== */
(function () {
  if (window.__aslClipPlayer) return;
  window.__aslClipPlayer = true;

  const CSS = `
  #video-modal-backdrop{
    position:fixed; inset:0; z-index:1000; display:flex; align-items:center; justify-content:center;
    padding:max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
    background:rgba(5,8,14,.72); -webkit-backdrop-filter:blur(8px) saturate(120%); backdrop-filter:blur(8px) saturate(120%);
    opacity:0; pointer-events:none; visibility:hidden; overscroll-behavior:contain;
    transition:opacity .24s ease, visibility 0s linear .26s;
  }
  #video-modal-backdrop.open{ opacity:1; pointer-events:auto; visibility:visible; transition:opacity .24s ease, visibility 0s; }
  #video-modal{
    width:min(880px, 100%); max-height:100%; display:flex; flex-direction:column;
    background:#0b0e14; border-radius:18px; overflow:hidden;
    box-shadow:0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06);
    transform:translateY(18px) scale(.94); opacity:.4;
    transition:transform .32s cubic-bezier(.2,.9,.25,1), opacity .24s ease; will-change:transform, opacity;
  }
  #video-modal-backdrop.open #video-modal{ transform:none; opacity:1; }
  #video-modal-head{ display:flex; align-items:center; gap:10px; padding:12px 14px 12px 16px; background:#0b0e14; }
  #video-modal-head .vm-title{ flex:1; min-width:0; color:#fff; font:800 13.5px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; letter-spacing:.2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #video-modal-close{ width:36px; height:36px; flex:none; border-radius:99px; background:rgba(255,255,255,.1); color:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; border:none; padding:0; transition:background .15s ease, transform .12s ease; }
  #video-modal-close:hover{ background:rgba(255,255,255,.18); }
  #video-modal-close:active{ transform:scale(.92); }
  #video-modal-close:focus-visible{ outline:2px solid #22c55e; outline-offset:2px; }
  #video-modal-body{ display:flex; flex-direction:column; min-height:0; }
  .vm-stage{ position:relative; width:100%; aspect-ratio:16/9; max-height:calc(100dvh - 150px); background:#000; overflow:hidden; }
  .vm-stage video{ position:absolute; inset:0; width:100%; height:100%; object-fit:contain; background:#000; display:block; max-height:none;
    opacity:0; transform:scale(1.015); transition:opacity .32s ease, transform .4s cubic-bezier(.2,.9,.25,1); }
  .vm-stage.is-ready video{ opacity:1; transform:none; }
  .vm-loader, .vm-error{
    position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px;
    text-align:center; color:#fff; padding:20px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
    background:radial-gradient(120% 90% at 50% 40%, #16202f 0%, #070a10 70%);
    transition:opacity .3s ease, visibility 0s linear .3s;
  }
  .vm-loader::before{ content:''; position:absolute; inset:-20px; background:var(--vm-poster, none) center/cover no-repeat; filter:blur(18px) brightness(.35) saturate(1.1); opacity:.9; }
  .vm-loader > *, .vm-error > *{ position:relative; }
  .vm-stage.is-ready .vm-loader, .vm-stage:not(.is-error) .vm-error{ opacity:0; visibility:hidden; pointer-events:none; }
  .vm-stage.is-ready.is-buffering .vm-loader{ opacity:1; visibility:visible; transition:opacity .2s ease; background:rgba(0,0,0,.35); }
  .vm-stage.is-ready.is-buffering .vm-loader::before, .vm-stage.is-ready.is-buffering .vm-brand{ display:none; }
  .vm-brand{ width:84px; height:84px; border-radius:22px; background:#fff url('/logo.png') center/cover no-repeat;
    box-shadow:0 12px 30px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.12); animation:vmBreathe 1.8s ease-in-out infinite; }
  .vm-load-text{ font-size:14px; font-weight:700; letter-spacing:.2px; }
  .vm-load-sub{ font-size:12px; color:rgba(255,255,255,.62); min-height:15px; }
  .vm-bar{ width:140px; height:3px; border-radius:99px; background:rgba(255,255,255,.14); overflow:hidden; }
  .vm-bar::after{ content:''; display:block; width:40%; height:100%; border-radius:inherit; background:linear-gradient(90deg, transparent, #22c55e, transparent); animation:vmSlide 1.1s ease-in-out infinite; }
  @keyframes vmSlide{ from{ transform:translateX(-110%); } to{ transform:translateX(260%); } }
  @keyframes vmBreathe{ 0%,100%{ transform:scale(1); } 50%{ transform:scale(1.04); } }
  .vm-error .vm-err-title{ font-size:15px; font-weight:800; }
  .vm-error .vm-err-sub{ font-size:12.5px; color:rgba(255,255,255,.66); max-width:340px; line-height:1.45; }
  .vm-error .vm-err-actions{ display:flex; gap:8px; flex-wrap:wrap; justify-content:center; }
  .vm-btn{ display:inline-flex; align-items:center; gap:6px; padding:10px 16px; border-radius:99px; font-size:13px; font-weight:800; border:none; cursor:pointer; color:#07130c; background:#22c55e; text-decoration:none; }
  .vm-btn.ghost{ background:rgba(255,255,255,.1); color:#fff; }
  .vm-foot{ display:flex; align-items:center; justify-content:flex-end; gap:10px; padding:10px 14px; background:#0b0e14; }
  .vm-foot .vm-dl-link{ color:#fff; font:700 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; display:inline-flex; align-items:center; gap:6px; padding:9px 12px; border-radius:99px; background:rgba(255,255,255,.08); text-decoration:none; }
  .vm-foot .vm-dl-link:hover{ background:rgba(255,255,255,.14); }
  .vm-foot .vm-dl-link svg{ width:14px; height:14px; }
  @media (max-width:640px){
    #video-modal-backdrop{ padding:0; align-items:stretch; background:#000; -webkit-backdrop-filter:none; backdrop-filter:none; }
    #video-modal{ width:100%; height:100%; border-radius:0; background:#000; transform:translateY(28px); }
    #video-modal-head{ padding-top:max(12px, env(safe-area-inset-top)); }
    #video-modal-body{ flex:1; }
    .vm-stage{ flex:1; aspect-ratio:auto; max-height:none; }
    .vm-foot{ padding-bottom:max(12px, env(safe-area-inset-bottom)); }
    #video-modal-close{ width:40px; height:40px; }
  }
  @media (prefers-reduced-motion: reduce){
    #video-modal, .vm-stage video, .vm-loader, .vm-error{ transition:none; }
    .vm-brand, .vm-bar::after{ animation:none; }
  }`;
  const DL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>';
  const HTML = `
  <div id="video-modal" role="dialog" aria-modal="true" aria-label="Clip player">
    <div id="video-modal-head">
      <span class="vm-title" id="video-modal-title">Clip</span>
      <button type="button" id="video-modal-close" aria-label="Close">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div id="video-modal-body">
      <div class="vm-stage" id="vm-stage">
        <video id="vm-video" controls playsinline webkit-playsinline preload="metadata"></video>
        <div class="vm-loader" id="vm-loader" role="status" aria-live="polite">
          <div class="vm-brand" role="img" aria-label="AllSportsLive"></div>
          <div class="vm-load-text" id="vm-load-text">Loading your clip…</div>
          <div class="vm-bar" aria-hidden="true"></div>
          <div class="vm-load-sub" id="vm-load-sub"></div>
        </div>
        <div class="vm-error" id="vm-error" role="alert">
          <div class="vm-err-title">This clip didn't load</div>
          <div class="vm-err-sub" id="vm-err-sub">Check your connection and try again.</div>
          <div class="vm-err-actions">
            <button type="button" class="vm-btn" id="vm-retry">↻ Try again</button>
            <a class="vm-btn ghost" id="vm-err-dl">Download instead</a>
          </div>
        </div>
      </div>
      <div class="vm-foot"><a class="vm-dl-link" id="vm-dl-link">${DL_ICON} Download</a></div>
    </div>
  </div>`;

  // Build (replacing any older markup the page had for the same modal).
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const old = document.getElementById('video-modal-backdrop');
  if (old) old.remove();
  const backdrop = document.createElement('div');
  backdrop.id = 'video-modal-backdrop';
  backdrop.innerHTML = HTML;
  document.body.appendChild(backdrop);

  const el = (id) => document.getElementById(id);
  const v = el('vm-video');
  const apiBase = () => (typeof window.clipApiBase === 'function' ? window.clipApiBase() : '');
  let token = 0, current = null, returnFocus = null;
  let cleanupTimer = null, slowTimer = null, bufferTimer = null;

  function setState(s) {
    const st = el('vm-stage');
    st.classList.toggle('is-ready', s === 'ready');
    st.classList.toggle('is-error', s === 'error');
    if (s !== 'ready') st.classList.remove('is-buffering');
  }
  function onReady(t) { if (t !== token) return; clearTimeout(slowTimer); setState('ready'); }
  function load(t) {
    const src = current.sources[current.idx];
    setState('loading');
    el('vm-load-text').textContent = 'Loading your clip…';
    el('vm-load-sub').textContent = '';
    clearTimeout(slowTimer);
    slowTimer = setTimeout(() => { if (t === token) el('vm-load-sub').textContent = 'Slow connection — still loading…'; }, 6000);
    v.preload = 'auto';
    if (v.getAttribute('src') !== src || v.error) { v.src = src; v.load(); }
    else if (v.readyState >= 2) onReady(t);
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  }
  function onError(t) {
    if (t !== token || !current) return;
    if (current.idx < current.sources.length - 1) { current.idx++; load(t); return; }
    clearTimeout(slowTimer);
    el('vm-err-sub').textContent = navigator.onLine === false ? 'You seem to be offline. Reconnect and try again.' : 'The clip could not be loaded right now. Try again, or download it.';
    setState('error');
  }
  v.addEventListener('loadeddata', () => onReady(token));
  v.addEventListener('canplay', () => onReady(token));
  v.addEventListener('error', () => { if (v.getAttribute('src')) onError(token); });
  v.addEventListener('waiting', () => {
    clearTimeout(bufferTimer);
    bufferTimer = setTimeout(() => {
      const st = el('vm-stage');
      if (st.classList.contains('is-ready') && !v.paused) { el('vm-load-text').textContent = 'Buffering…'; st.classList.add('is-buffering'); }
    }, 700);
  });
  const unbuffer = () => { clearTimeout(bufferTimer); el('vm-stage').classList.remove('is-buffering'); };
  ['playing', 'pause', 'seeked'].forEach((ev) => v.addEventListener(ev, unbuffer));
  el('vm-retry').addEventListener('click', () => { if (!current) return; current.idx = 0; v.removeAttribute('src'); v.load(); load(token); });

  function openVideoModal(clipId, title, playbackUrl, posterUrl) {
    clearTimeout(cleanupTimer);
    const t = ++token;
    if (!backdrop.classList.contains('open')) returnFocus = document.activeElement;
    el('video-modal-title').textContent = title || 'Clip';
    const watch = `${apiBase()}/api/clips/${encodeURIComponent(clipId)}/watch`;
    const dl = `${apiBase()}/api/clips/${encodeURIComponent(clipId)}/download`;
    el('vm-dl-link').href = dl;
    el('vm-err-dl').href = dl;
    if (posterUrl) { v.poster = posterUrl; el('vm-loader').style.setProperty('--vm-poster', `url("${String(posterUrl).replace(/"/g, '%22')}")`); }
    else { v.removeAttribute('poster'); el('vm-loader').style.removeProperty('--vm-poster'); }
    current = { clipId, sources: playbackUrl && playbackUrl !== watch ? [playbackUrl, watch] : [watch], idx: 0 };
    backdrop.classList.add('open');
    load(t);
  }
  function closeVideoModal() {
    if (!backdrop.classList.contains('open')) return;
    token++;
    clearTimeout(slowTimer); clearTimeout(bufferTimer);
    v.pause();
    backdrop.classList.remove('open');
    if (returnFocus && document.contains(returnFocus)) { try { returnFocus.focus({ preventScroll: true }); } catch (e) {} }
    returnFocus = null;
    clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(() => {
      if (backdrop.classList.contains('open')) return;
      v.removeAttribute('src'); v.removeAttribute('poster'); v.load();
      current = null;
      setState('loading');
    }, 320);
  }
  el('video-modal-close').addEventListener('click', closeVideoModal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeVideoModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && backdrop.classList.contains('open')) { e.preventDefault(); closeVideoModal(); } });

  // ⚡ First-open speed: connect to the clip CDN early; start loading a clip's
  // header on press / deliberate hover (metadata only — a scroll-tap never
  // downloads the whole clip).
  const connected = new Set();
  function preconnect(url) {
    try {
      const origin = new URL(url, location.href).origin;
      if (origin === location.origin || connected.has(origin)) return;
      connected.add(origin);
      ['preconnect', 'dns-prefetch'].forEach((rel) => { const l = document.createElement('link'); l.rel = rel; l.href = origin; if (rel === 'preconnect') l.crossOrigin = ''; document.head.appendChild(l); });
    } catch (e) {}
  }
  function prime(e) {
    const t = e.target.closest && e.target.closest('[data-clip-id]');
    if (!t || t.disabled || backdrop.classList.contains('open')) return;
    const src = t.dataset.playbackUrl || `${apiBase()}/api/clips/${encodeURIComponent(t.dataset.clipId)}/watch`;
    if (v.getAttribute('src') === src) return;
    clearTimeout(cleanupTimer);
    v.preload = 'metadata';
    v.src = src; v.load();
  }
  document.addEventListener('pointerdown', prime, { passive: true });
  let hoverTimer = null;
  document.addEventListener('mouseover', (e) => {
    clearTimeout(hoverTimer);
    if (!(e.target.closest && e.target.closest('[data-clip-id]'))) return;
    hoverTimer = setTimeout(() => prime(e), 180);
  }, { passive: true });
  const obs = new MutationObserver(() => {
    const x = document.querySelector('[data-playback-url]:not([data-playback-url=""])');
    if (x) { preconnect(x.dataset.playbackUrl); obs.disconnect(); }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  window.openVideoModal = openVideoModal;
  window.closeVideoModal = closeVideoModal;
})();
