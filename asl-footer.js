/* 🦶 The All Sports Live footer — one slim bar for every public page
   (scorecards, match and tournament pages of every sport, the dashboards).

   A page puts <footer class="asl-foot" data-asl-footer></footer> as a child
   of <body>, after its content, and loads this script once: the footer is
   drawn edge to edge (left to right), flush with the very bottom of the
   page — on a short page, at the bottom of the screen. The look follows the
   page's own theme: dark by default, light under :root[data-theme="light"]
   (the switch every AllSportsLive page uses). Its CSS comes with it. */
(function () {
  if (window.ASLFooter) return;

  var css = [
    'footer.asl-foot{display:block;position:relative;width:100%;max-width:none;margin:28px 0 0;padding:0;text-align:left;font:500 12.5px/1.3 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--af-ink);',
    '  background:var(--af-bg);border-top:1px solid var(--af-line);',
    '  --af-ink:#e8eef6;--af-mute:rgba(232,238,246,.6);--af-faint:rgba(232,238,246,.42);--af-bg:rgba(10,14,20,.86);--af-line:rgba(255,255,255,.08);--af-chip:rgba(255,255,255,.06);--af-chip-h:rgba(255,255,255,.13);--af-a:#22c55e;--af-b:#f59e0b}',
    ':root[data-theme="light"] footer.asl-foot{--af-ink:#0f172a;--af-mute:rgba(15,23,42,.6);--af-faint:rgba(15,23,42,.45);--af-bg:rgba(255,255,255,.9);--af-line:rgba(15,23,42,.08);--af-chip:rgba(15,23,42,.05);--af-chip-h:rgba(15,23,42,.1);--af-a:#16a34a;--af-b:#d97706}',
    'footer.asl-foot *{box-sizing:border-box}',
    // a thin brand line along the top edge, with a light moving along it (transform only; off with reduced motion)
    'footer.asl-foot:before{content:"";position:absolute;left:0;right:0;top:-1px;height:2px;background:linear-gradient(90deg,transparent,var(--af-a) 20%,var(--af-b) 80%,transparent)}',
    'footer.asl-foot .af-sweep{position:absolute;left:0;top:-1px;width:30%;height:2px;overflow:hidden;pointer-events:none;background:linear-gradient(90deg,transparent,rgba(255,255,255,.85),transparent);animation:afSweep 7s ease-in-out infinite;transform:translateX(-100%)}',
    '@keyframes afSweep{0%{transform:translateX(-100%)}55%,100%{transform:translateX(340%)}}',
    '@media (prefers-reduced-motion:reduce){footer.asl-foot .af-sweep{display:none}}',
    'footer.asl-foot .af-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;padding:10px 24px}',
    'footer.asl-foot .af-brand{display:flex;align-items:center;margin:3px 16px 3px 0;text-decoration:none;color:inherit;white-space:nowrap}',
    'footer.asl-foot .af-brand img{width:24px;height:24px;border-radius:7px;object-fit:cover;flex:none;margin-right:8px}',
    'footer.asl-foot .af-brand b{font-size:13px;font-weight:800;letter-spacing:-.01em}',
    'footer.asl-foot .af-brand b span{background:linear-gradient(90deg,var(--af-a),var(--af-b));-webkit-background-clip:text;background-clip:text;color:transparent}',
    'footer.asl-foot .af-brand em{font-style:normal;color:var(--af-faint);margin-left:8px;font-size:12px}',
    'footer.asl-foot .af-sports{display:flex;flex-wrap:wrap;align-items:center;margin:3px 0}',
    'footer.asl-foot .af-sports a{display:inline-flex;align-items:center;height:24px;padding:0 9px;margin:2px 4px 2px 0;border-radius:99px;font-size:12px;font-weight:700;text-decoration:none;color:var(--af-mute);transition:color .2s,background .2s}',
    'footer.asl-foot .af-sports a:hover{color:var(--af-ink);background:var(--af-chip-h)}',
    'footer.asl-foot .af-sports a i{font-style:normal;margin-right:5px;font-size:12px}',
    'footer.asl-foot .af-end{display:flex;align-items:center;margin:3px 0 3px 12px;color:var(--af-faint);white-space:nowrap}',
    'footer.asl-foot .af-ic{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;margin-left:4px;color:var(--af-mute);background:var(--af-chip);transition:color .2s,background .2s,transform .25s cubic-bezier(.34,1.56,.64,1)}',
    'footer.asl-foot .af-ic:hover{color:var(--af-ink);background:var(--af-chip-h);transform:translateY(-1px)}',
    'footer.asl-foot .af-ic svg{width:14px;height:14px}',
    'footer.asl-foot .af-ic.yt:hover{color:#ef4444} footer.asl-foot .af-ic.ig:hover{color:#e1306c}',
    'footer.asl-foot .af-copy{margin-right:10px}',
    'footer.asl-foot .af-copy:before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:7px;vertical-align:1px;background:var(--af-a);box-shadow:0 0 0 3px rgba(34,197,94,.16)}',
    // phones: two short rows — brand + icons, then the sports and the year
    '@media (max-width:760px){footer.asl-foot .af-row{padding:8px 14px}footer.asl-foot .af-brand em{display:none}footer.asl-foot .af-sports{order:3;width:100%;flex-wrap:nowrap;overflow-x:auto;margin:2px 0 0;scrollbar-width:none;-webkit-overflow-scrolling:touch}footer.asl-foot .af-sports::-webkit-scrollbar{display:none}footer.asl-foot .af-sports a{flex:none;padding:0 8px;font-size:11.5px;background:var(--af-chip)}footer.asl-foot .af-brand{margin:0 10px 0 0}footer.asl-foot .af-end{margin:0 0 0 auto}footer.asl-foot .af-end{margin-left:auto}footer.asl-foot .af-copy{font-size:11px}}',
    '@media (max-width:400px){footer.asl-foot .af-copy{display:none}}',
    '@media print{footer.asl-foot{display:none}}'
  ].join('\n');

  var ICONS = {
    yt: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31.6 31.6 0 0 0 0 12a31.6 31.6 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31.6 31.6 0 0 0 24 12a31.6 31.6 0 0 0-.5-5.8zM9.6 15.5v-7L15.8 12z"/></svg>',
    ig: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>'
  };
  var SPORTS = [['🏏', 'Cricket', '/'], ['🏐', 'Volleyball', '/?sport=volleyball#tournaments'], ['🎾', 'Tennis', '/?sport=tennis#tournaments'],
    ['🏓', 'Table Tennis', '/?sport=table-tennis#tournaments'], ['⚽', 'Football', '/?sport=football#tournaments']];

  function html() {
    return '<i class="af-sweep" aria-hidden="true"></i><div class="af-row">'
      + '<a class="af-brand" href="/" aria-label="All Sports Live — home"><img src="/logo.png" alt="" width="24" height="24" loading="lazy" decoding="async"><b>All Sports <span>Live</span></b><em>Live scoring &amp; broadcast graphics</em></a>'
      + '<nav class="af-sports" aria-label="Sports">' + SPORTS.map(function (s) { return '<a href="' + s[2] + '"><i aria-hidden="true">' + s[0] + '</i>' + s[1] + '</a>'; }).join('') + '</nav>'
      + '<div class="af-end"><span class="af-copy">© ' + new Date().getFullYear() + ' All Sports Live</span>'
      + '<a class="af-ic" href="/" title="Home" aria-label="Home">' + ICONS.home + '</a>'
      + '<a class="af-ic yt" href="https://www.youtube.com/@allsportslive" target="_blank" rel="noopener noreferrer" title="YouTube" aria-label="YouTube">' + ICONS.yt + '</a>'
      + '<a class="af-ic ig" href="https://www.instagram.com/all.sports.live" target="_blank" rel="noopener noreferrer" title="Instagram" aria-label="Instagram">' + ICONS.ig + '</a>'
      + '</div></div>';
  }

  function addCss() {
    if (document.getElementById('asl-footer-css')) return;
    var st = document.createElement('style');
    st.id = 'asl-footer-css';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  // Flush with the bottom: the page's own bottom padding moves above the
  // footer, and on a short page the footer drops to the bottom of the screen.
  var feet = [];
  function stick() {
    feet.forEach(function (f) {
      if (!f.isConnected) return;
      var body = document.body;
      if (f.parentNode === body && body.lastElementChild) {
        var pad = parseFloat(getComputedStyle(body).paddingBottom) || 0;
        if (pad) { f.dataset.pad = String(pad + (parseFloat(f.dataset.pad) || 0)); body.style.paddingBottom = '0px'; }
      }
      f.style.marginTop = '';
      var base = parseFloat(getComputedStyle(f).marginTop) + (parseFloat(f.dataset.pad) || 0);
      f.style.marginTop = base + 'px';
      var room = window.innerHeight - (f.getBoundingClientRect().bottom + window.scrollY);
      if (room > 0) f.style.marginTop = (base + room) + 'px';
    });
  }
  var stickQueued = false;
  function queueStick() { if (stickQueued) return; stickQueued = true; (window.requestAnimationFrame || setTimeout)(function () { stickQueued = false; stick(); }); }

  function mount(root) {
    addCss();
    var list = (root || document).querySelectorAll('[data-asl-footer]');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-filled') === '1') continue;
      list[i].innerHTML = html();
      list[i].setAttribute('data-filled', '1');
      if (!list[i].getAttribute('role')) list[i].setAttribute('role', 'contentinfo');
      feet.push(list[i]);
    }
    queueStick();
  }
  window.ASLFooter = { mount: mount };

  function start() {
    mount();
    window.addEventListener('resize', queueStick);
    window.addEventListener('load', queueStick);
    // the page draws its content later (after loading the match): keep the footer at the bottom
    if (window.MutationObserver && document.body) {
      new MutationObserver(function () {
        if (document.querySelector('[data-asl-footer]:not([data-filled="1"])')) mount(); else queueStick();
      }).observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
