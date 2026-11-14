/* 🦶 The All Sports Live footer — one modern footer for every public page
   (scorecards, match and tournament pages of every sport).

   A page puts <footer class="asl-foot" data-asl-footer></footer> where it
   wants it (straight in the HTML, or inside markup it renders later) and
   loads this script once: every empty [data-asl-footer] is filled, also
   ones that appear after a re-render. The look follows the page's theme:
   dark by default, light under :root[data-theme="light"] — the switch every
   AllSportsLive page already uses. Its CSS comes with it, added once. */
(function () {
  if (window.ASLFooter) return;

  var css = [
    'footer.asl-foot{display:block;position:relative;max-width:1080px;margin:40px auto 18px;padding:0 16px;text-align:left;font:inherit;color:var(--af-ink);',
    '  --af-ink:#e8eef6;--af-mute:rgba(232,238,246,.62);--af-faint:rgba(232,238,246,.42);--af-card:linear-gradient(160deg,rgba(255,255,255,.07),rgba(255,255,255,.025));--af-line:rgba(255,255,255,.09);--af-chip:rgba(255,255,255,.06);--af-chip-h:rgba(255,255,255,.12);--af-shadow:0 24px 60px -30px rgba(0,0,0,.75);--af-a:#22c55e;--af-b:#f59e0b}',
    ':root[data-theme="light"] footer.asl-foot{--af-ink:#0f172a;--af-mute:rgba(15,23,42,.62);--af-faint:rgba(15,23,42,.45);--af-card:linear-gradient(160deg,rgba(255,255,255,.92),rgba(255,255,255,.7));--af-line:rgba(15,23,42,.09);--af-chip:rgba(15,23,42,.05);--af-chip-h:rgba(15,23,42,.1);--af-shadow:0 20px 50px -28px rgba(15,23,42,.35);--af-a:#16a34a;--af-b:#d97706}',
    'footer.asl-foot *{box-sizing:border-box}',
    'footer.asl-foot .af-card{position:relative;overflow:hidden;border-radius:22px;padding:22px 24px 16px;background:var(--af-card);border:1px solid var(--af-line);box-shadow:var(--af-shadow)}',
    // a thin moving light along the top edge: transform only, and still under reduced motion
    'footer.asl-foot .af-card:before{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,transparent,var(--af-a),var(--af-b),transparent);opacity:.9}',
    'footer.asl-foot .af-card:after{content:"";position:absolute;left:-40%;top:0;width:40%;height:2px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.9),transparent);animation:afSweep 6s ease-in-out infinite}',
    '@keyframes afSweep{0%{transform:translateX(0)}60%,100%{transform:translateX(350%)}}',
    '@media (prefers-reduced-motion:reduce){footer.asl-foot .af-card:after{animation:none;display:none}}',
    'footer.asl-foot .af-top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between}',
    'footer.asl-foot .af-brand{display:flex;align-items:center;min-width:0;margin:0 18px 14px 0;text-decoration:none;color:inherit}',
    'footer.asl-foot .af-brand img{width:42px;height:42px;border-radius:12px;object-fit:cover;flex:none;margin-right:12px;box-shadow:0 6px 18px -8px rgba(0,0,0,.6)}',
    'footer.asl-foot .af-brand b{display:block;font-size:16px;font-weight:800;letter-spacing:-.01em;line-height:1.2}',
    'footer.asl-foot .af-brand b span{background:linear-gradient(90deg,var(--af-a),var(--af-b));-webkit-background-clip:text;background-clip:text;color:transparent}',
    'footer.asl-foot .af-brand small{display:block;font-size:12.5px;color:var(--af-mute);margin-top:2px;line-height:1.35}',
    'footer.asl-foot .af-social{display:flex;margin:0 0 14px}',
    'footer.asl-foot .af-ic{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;margin-left:8px;color:var(--af-ink);background:var(--af-chip);border:1px solid var(--af-line);transition:transform .25s cubic-bezier(.34,1.56,.64,1),background .2s}',
    'footer.asl-foot .af-ic:first-child{margin-left:0}',
    'footer.asl-foot .af-ic:hover{transform:translateY(-2px);background:var(--af-chip-h)}',
    'footer.asl-foot .af-ic svg{width:18px;height:18px}',
    'footer.asl-foot .af-ic.yt:hover{color:#ef4444} footer.asl-foot .af-ic.ig:hover{color:#e1306c}',
    'footer.asl-foot .af-sports{display:flex;flex-wrap:wrap;padding:14px 0 4px;border-top:1px solid var(--af-line)}',
    'footer.asl-foot .af-sports a{display:inline-flex;align-items:center;height:30px;padding:0 12px;margin:0 8px 8px 0;border-radius:99px;font-size:12.5px;font-weight:700;text-decoration:none;color:var(--af-mute);background:var(--af-chip);border:1px solid var(--af-line);transition:color .2s,background .2s,transform .25s cubic-bezier(.34,1.56,.64,1)}',
    'footer.asl-foot .af-sports a:hover{color:var(--af-ink);background:var(--af-chip-h);transform:translateY(-1px)}',
    'footer.asl-foot .af-sports a i{font-style:normal;margin-right:6px}',
    'footer.asl-foot .af-bottom{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;padding-top:10px;font-size:12px;color:var(--af-faint)}',
    'footer.asl-foot .af-bottom > span{margin:2px 0}',
    'footer.asl-foot .af-live{display:inline-flex;align-items:center;font-weight:700;color:var(--af-mute)}',
    'footer.asl-foot .af-live:before{content:"";width:7px;height:7px;border-radius:50%;margin-right:7px;background:var(--af-a);box-shadow:0 0 0 3px rgba(34,197,94,.18)}',
    'footer.asl-foot a.af-home{color:var(--af-a);font-weight:700;text-decoration:none}',
    '@media (max-width:560px){footer.asl-foot{margin-top:28px}footer.asl-foot .af-card{padding:18px 16px 14px;border-radius:18px}footer.asl-foot .af-social{width:100%}footer.asl-foot .af-bottom{display:block}footer.asl-foot .af-bottom > span{display:block}footer.asl-foot .af-bottom > span.af-live{display:flex;margin-top:6px}}',
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
    return '<div class="af-card">'
      + '<div class="af-top">'
      + '<a class="af-brand" href="/" aria-label="All Sports Live — home"><img src="/logo.png" alt="" width="42" height="42" loading="lazy" decoding="async">'
      + '<span><b>All Sports <span>Live</span></b><small>Live scoring, TV-style broadcast graphics &amp; instant highlights</small></span></a>'
      + '<nav class="af-social" aria-label="All Sports Live online">'
      + '<a class="af-ic" href="/" title="Home" aria-label="Home">' + ICONS.home + '</a>'
      + '<a class="af-ic yt" href="https://www.youtube.com/@allsportslive" target="_blank" rel="noopener noreferrer" title="YouTube" aria-label="YouTube">' + ICONS.yt + '</a>'
      + '<a class="af-ic ig" href="https://www.instagram.com/all.sports.live" target="_blank" rel="noopener noreferrer" title="Instagram" aria-label="Instagram">' + ICONS.ig + '</a>'
      + '</nav></div>'
      + '<nav class="af-sports" aria-label="Sports">' + SPORTS.map(function (s) { return '<a href="' + s[2] + '"><i aria-hidden="true">' + s[0] + '</i>' + s[1] + '</a>'; }).join('') + '</nav>'
      + '<div class="af-bottom"><span>© ' + new Date().getFullYear() + ' All Sports Live. All rights reserved.</span>'
      + '<span class="af-live">Powered by&nbsp;<a class="af-home" href="/">All Sports Live</a></span></div>'
      + '</div>';
  }

  function addCss() {
    if (document.getElementById('asl-footer-css')) return;
    var st = document.createElement('style');
    st.id = 'asl-footer-css';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }
  function mount(root) {
    addCss();
    var list = (root || document).querySelectorAll('[data-asl-footer]');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-filled') === '1') continue;
      list[i].innerHTML = html();
      list[i].setAttribute('data-filled', '1');
      if (!list[i].getAttribute('role')) list[i].setAttribute('role', 'contentinfo');
    }
  }
  window.ASLFooter = { mount: mount };

  function start() {
    mount();
    // pages that draw their footer later (after loading the match) get it too
    if (window.MutationObserver && document.body) {
      var pending = false;
      new MutationObserver(function () {
        if (pending) return;
        pending = true;
        (window.requestAnimationFrame || setTimeout)(function () { pending = false; if (document.querySelector('[data-asl-footer]:not([data-filled="1"])')) mount(); });
      }).observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
