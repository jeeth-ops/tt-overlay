/* ============================================================
   🎬 highlight-options.js — "how do you want your video?", asked before
   every highlights download that makes ONE edited video (the scorecard's
   player / team / match downloads and the tournament page's player
   downloads):
     • the shape — 16:9 (YouTube, landscape) or 9:16 (Reels / Shorts /
       status, the whole picture kept, nothing cropped);
     • the animated wagon wheel — on or off.
   HighlightOptions.ask({ title }) → Promise<{ format, wheel } | null>
   (null: the viewer closed it). The last choice is remembered on this
   device, so the next download is one tap. Styled from the page's own
   theme variables (--panel, --text, --accent…), with fallbacks.
   ============================================================ */
(function () {
  if (window.HighlightOptions) return;
  const KEY = 'scorvix-hl-options';
  const load = () => {
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
  };
  const save = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* private window: just not remembered */ } };

  const CSS = `
  #hlo-back{ position:fixed; inset:0; z-index:10050; display:flex; align-items:center; justify-content:center; padding:16px;
    background:rgba(5,8,15,.56); -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px);
    opacity:0; pointer-events:none; transition:opacity .2s ease; }
  #hlo-back.open{ opacity:1; pointer-events:auto; }
  #hlo{ width:min(460px,100%); max-height:calc(100dvh - 32px); overflow:auto; box-sizing:border-box;
    background:var(--panel,#121826); color:var(--text,#eef1f6); border:1px solid var(--border,#232c40);
    border-radius:var(--radius-lg,16px); box-shadow:var(--shadow,0 18px 50px rgba(0,0,0,.45)); padding:20px 20px 16px;
    font-family:var(--font-body,'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);
    transform:translateY(14px) scale(.98); transition:transform .26s cubic-bezier(.2,.8,.2,1); }
  #hlo-back.open #hlo{ transform:none; }
  #hlo .hlo-title{ font-family:var(--font-display,inherit); font-weight:800; font-size:18px; letter-spacing:-.01em; }
  #hlo .hlo-sub{ color:var(--text-dim,#8791a3); font-size:12.5px; margin-top:3px; }
  #hlo .hlo-label{ margin:18px 0 8px; font-size:11px; font-weight:800; letter-spacing:.09em; text-transform:uppercase; color:var(--text-dim,#8791a3); }
  #hlo .hlo-shapes{ display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  #hlo .hlo-shape{ all:unset; box-sizing:border-box; cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:6px; text-align:center;
    padding:14px 10px 12px; border-radius:var(--radius-md,12px); border:1.5px solid var(--border,#232c40); background:var(--panel-2,#171f30);
    transition:border-color .15s ease, background .15s ease, transform .15s ease; }
  #hlo .hlo-shape:hover{ transform:translateY(-1px); }
  #hlo .hlo-shape:focus-visible{ outline:2px solid var(--accent,#22c55e); outline-offset:2px; }
  #hlo .hlo-shape[aria-checked="true"]{ border-color:var(--accent,#22c55e); background:var(--accent-soft,rgba(34,197,94,.14)); }
  #hlo .hlo-shape b{ font-size:13.5px; font-weight:800; }
  #hlo .hlo-shape small{ font-size:11.5px; color:var(--text-dim,#8791a3); line-height:1.3; }
  /* a little picture of the layout: the clip, and where the wheel goes */
  #hlo .hlo-frame{ position:relative; box-sizing:border-box; border:2px solid currentColor; border-radius:5px; opacity:.85; margin-bottom:2px; }
  #hlo .hlo-frame.wide{ width:74px; height:42px; }
  #hlo .hlo-frame.tall{ width:30px; height:53px; }
  #hlo .hlo-frame i{ position:absolute; background:currentColor; opacity:.28; border-radius:2px; }
  #hlo .hlo-frame.wide i.pic{ inset:3px; }
  #hlo .hlo-frame.tall i.pic{ left:2px; right:2px; top:18px; height:12px; }
  #hlo .hlo-frame i.wheel{ border-radius:50%; background:#22c55e; opacity:0; transform:scale(.4); transition:opacity .2s ease, transform .25s cubic-bezier(.2,.9,.3,1.3); }
  #hlo .hlo-frame.wide i.wheel{ left:6px; top:6px; width:12px; height:12px; }
  #hlo .hlo-frame.tall i.wheel{ left:8px; bottom:4px; width:11px; height:11px; }
  #hlo.wheel-on .hlo-frame i.wheel{ opacity:1; transform:none; }
  #hlo .hlo-toggle{ display:flex; align-items:center; gap:12px; cursor:pointer; padding:12px; border-radius:var(--radius-md,12px);
    border:1.5px solid var(--border,#232c40); background:var(--panel-2,#171f30); }
  #hlo .hlo-toggle:focus-within{ outline:2px solid var(--accent,#22c55e); outline-offset:2px; }
  #hlo .hlo-ww{ flex:none; width:38px; height:38px; }
  #hlo .hlo-tt{ flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
  #hlo .hlo-tt b{ font-size:13.5px; font-weight:800; }
  #hlo .hlo-tt small{ font-size:11.5px; color:var(--text-dim,#8791a3); line-height:1.35; }
  #hlo .hlo-toggle input{ position:absolute; opacity:0; width:1px; height:1px; }
  #hlo .hlo-switch{ flex:none; position:relative; width:42px; height:24px; border-radius:99px; background:var(--border,#232c40); transition:background .18s ease; }
  #hlo .hlo-switch::after{ content:""; position:absolute; left:3px; top:3px; width:18px; height:18px; border-radius:50%; background:#fff;
    box-shadow:0 1px 3px rgba(0,0,0,.3); transition:transform .2s cubic-bezier(.2,.8,.2,1); }
  #hlo .hlo-toggle input:checked + .hlo-switch{ background:var(--accent,#22c55e); }
  #hlo .hlo-toggle input:checked + .hlo-switch::after{ transform:translateX(18px); }
  #hlo .hlo-actions{ display:flex; gap:10px; margin-top:18px; }
  #hlo .hlo-btn{ all:unset; box-sizing:border-box; cursor:pointer; flex:1; text-align:center; padding:12px 14px; border-radius:var(--radius-md,12px);
    font-weight:800; font-size:14px; transition:filter .15s ease, background .15s ease; }
  #hlo .hlo-btn:focus-visible{ outline:2px solid var(--accent,#22c55e); outline-offset:2px; }
  #hlo .hlo-btn.ghost{ border:1.5px solid var(--border,#232c40); color:var(--text,#eef1f6); }
  #hlo .hlo-btn.ghost:hover{ background:var(--panel-2,#171f30); }
  #hlo .hlo-btn.go{ flex:1.6; background:var(--accent,#22c55e); color:var(--accent-contrast,#06170c); }
  #hlo .hlo-btn.go:hover{ filter:brightness(1.07); }
  @media (max-width:560px){
    #hlo-back{ align-items:flex-end; padding:0; }
    #hlo{ width:100%; max-height:92dvh; border-radius:18px 18px 0 0; border-bottom:0; padding:18px 16px calc(14px + env(safe-area-inset-bottom)); transform:translateY(40px); }
  }
  @media (prefers-reduced-motion:reduce){ #hlo-back, #hlo, #hlo *{ transition:none !important; } }`;

  const WHEEL_ICON = '<svg class="hlo-ww" viewBox="-24 -24 48 48" aria-hidden="true"><circle r="23" fill="#17491a"/><circle r="21" fill="#2f8a29"/>' +
    '<circle r="11.5" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1" stroke-dasharray="2 1.6"/><circle r="21" fill="none" stroke="#fff" stroke-width="1.3"/>' +
    '<rect x="-1.6" y="-5.5" width="3.2" height="11" rx=".6" fill="#d8b57a"/><path d="M0 -4Q9 2 14.5 15" fill="none" stroke="#d39bff" stroke-width="2.2" stroke-linecap="round"/>' +
    '<circle cx="14.5" cy="15" r="3" fill="#9b4cf0" stroke="#fff" stroke-width="1"/><path d="M0 -4L-16 6" stroke="#6cb2ff" stroke-width="2" stroke-linecap="round"/></svg>';

  let back = null, dlg = null, state = null, done = null, lastFocus = null;
  function build() {
    if (back) return;
    const st = document.createElement('style');
    st.id = 'hlo-css';
    st.textContent = CSS;
    document.head.appendChild(st);
    back = document.createElement('div');
    back.id = 'hlo-back';
    back.innerHTML = `<div id="hlo" role="dialog" aria-modal="true" aria-labelledby="hlo-title" aria-describedby="hlo-sub">
      <div class="hlo-title" id="hlo-title">How do you want your video?</div>
      <div class="hlo-sub" id="hlo-sub"></div>
      <div class="hlo-label" id="hlo-shape-label">Shape</div>
      <div class="hlo-shapes" role="radiogroup" aria-labelledby="hlo-shape-label">
        <button type="button" class="hlo-shape" role="radio" data-format="16:9"><span class="hlo-frame wide" aria-hidden="true"><i class="pic"></i><i class="wheel"></i></span><b>16:9 · YouTube</b><small>Landscape — laptop, TV</small></button>
        <button type="button" class="hlo-shape" role="radio" data-format="9:16"><span class="hlo-frame tall" aria-hidden="true"><i class="pic"></i><i class="wheel"></i></span><b>9:16 · Reels</b><small>Instagram, Shorts, Status</small></button>
      </div>
      <div class="hlo-label">Extras</div>
      <label class="hlo-toggle">${WHEEL_ICON}<span class="hlo-tt"><b>Wagon wheel</b><small>Shows where each shot went, animated — never over the batter, the bowler or the ball</small></span>
        <input type="checkbox" role="switch" id="hlo-wheel"><span class="hlo-switch" aria-hidden="true"></span></label>
      <div class="hlo-actions"><button type="button" class="hlo-btn ghost" data-act="cancel">Cancel</button><button type="button" class="hlo-btn go" data-act="go">Make video</button></div>
    </div>`;
    document.body.appendChild(back);
    dlg = back.querySelector('#hlo');
    back.addEventListener('click', (e) => {
      if (e.target === back) return close(null);
      const shape = e.target.closest('.hlo-shape');
      if (shape) { state.format = shape.dataset.format; paint(); return; }
      const act = e.target.closest('[data-act]');
      if (act) close(act.dataset.act === 'go' ? { format: state.format, wheel: state.wheel } : null);
    });
    back.querySelector('#hlo-wheel').addEventListener('change', (e) => { state.wheel = e.target.checked; paint(); });
    back.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target.closest('.hlo-shape')) {
        e.preventDefault();
        state.format = state.format === '9:16' ? '16:9' : '9:16';
        paint();
        dlg.querySelector(`.hlo-shape[data-format="${state.format}"]`).focus();
        return;
      }
      if (e.key === 'Tab') { // keep focus inside the dialog
        const f = [...dlg.querySelectorAll('button, input')].filter(x => !x.disabled);
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    });
  }
  function paint() {
    dlg.querySelectorAll('.hlo-shape').forEach(b => {
      const on = b.dataset.format === state.format;
      b.setAttribute('aria-checked', on);
      b.tabIndex = on ? 0 : -1;
    });
    dlg.querySelector('#hlo-wheel').checked = state.wheel;
    dlg.classList.toggle('wheel-on', state.wheel);
  }
  function close(result) {
    if (!back || !done) return;
    if (result) save(result);
    back.classList.remove('open');
    const fn = done;
    done = null;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
    fn(result);
  }
  function ask(opts) {
    build();
    if (done) close(null); // a second ask replaces the first
    const last = load() || {};
    state = { format: last.format === '9:16' ? '9:16' : '16:9', wheel: last.wheel === true };
    dlg.querySelector('#hlo-sub').textContent = (opts && opts.title) || 'One video with titles and transitions, ready to post.';
    paint();
    lastFocus = document.activeElement;
    return new Promise((resolve) => {
      done = resolve;
      requestAnimationFrame(() => {
        back.classList.add('open');
        dlg.querySelector('[data-act="go"]').focus({ preventScroll: true });
      });
    });
  }
  window.HighlightOptions = { ask };
})();
