/* 🎨 A tournament's own picture and colours — shared by the homepage cards
   (index.html) and the tournament page (score-tournament.html), so a
   tournament looks the same in both.

   Its colours: the two its thumbnail is made of (the server reads them off
   the picture when it is uploaded — thumb.palette), or, with no thumbnail,
   a pair picked from its token, so they never change. Its picture, when it
   has no thumbnail: a poster in those colours — its name, monogram and
   year over a floodlit ground of its sport (`bare`: no name, for a page
   whose heading already says it). The poster sizes everything in cqw, so
   it needs a `container-type: inline-size` frame around it. Its CSS comes
   with it, added to the page once. */

(function () {
    if (document.getElementById('tournament-art-css')) return;
    const css = `
        .tc-art {
            position: absolute; inset: 0; overflow: hidden; color: #fff;
            background:
                radial-gradient(80% 100% at 88% -6%, rgba(255, 255, 255, 0.26), rgba(255, 255, 255, 0) 58%),
                radial-gradient(90% 70% at 10% 112%, rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0) 70%),
                linear-gradient(140deg, rgb(var(--a)) 0%, rgb(var(--b)) 82%);
        }
        .tc-art::before, .tc-art::after {
            content: ''; position: absolute; top: -8%; width: 92%; height: 120%; pointer-events: none;
            background: conic-gradient(from 152deg at 50% 0%, rgba(255, 255, 255, 0) 0deg, rgba(220, 234, 255, 0.11) 10deg, rgba(235, 244, 255, 0.2) 19deg, rgba(220, 234, 255, 0.1) 28deg, rgba(255, 255, 255, 0) 40deg);
        }
        .tc-art::before { left: -34%; transform: rotate(-9deg); transform-origin: 50% 0; }
        .tc-art::after { right: -34%; transform: scaleX(-1) rotate(-9deg); transform-origin: 50% 0; }
        .tc-art-scene {
            position: absolute; inset: 0; width: 100%; height: 100%;
            -webkit-mask-image: linear-gradient(90deg, transparent 6%, rgba(0, 0, 0, 0.3) 34%, #000 60%);
            mask-image: linear-gradient(90deg, transparent 6%, rgba(0, 0, 0, 0.3) 34%, #000 60%);
        }
        .tc-art-mono {
            position: absolute; top: 7.5%; right: 5%; z-index: 1; display: grid; place-items: center;
            min-width: 15cqw; height: 15cqw; padding: 0 2.4cqw; border-radius: 4.4cqw;
            font-family: 'Inter', sans-serif; font-weight: 900; font-size: 5.2cqw; line-height: 1; letter-spacing: 0.03em; white-space: nowrap;
            background: linear-gradient(150deg, rgba(255, 255, 255, 0.3), rgba(255, 255, 255, 0.07));
            border: 1px solid rgba(255, 255, 255, 0.38);
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.4), 0 8px 20px -6px rgba(0, 0, 0, 0.45);
        }
        .tc-art-copy { position: absolute; left: 6.5%; right: 6.5%; bottom: 7.5%; z-index: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 2.2cqw; }
        .tc-art-copy::before { content: ''; position: absolute; z-index: -1; left: -14%; right: 8%; top: -34%; bottom: -30%; background: radial-gradient(closest-side, rgba(3, 7, 18, 0.42), rgba(3, 7, 18, 0)); pointer-events: none; }
        .tc-art-name {
            max-width: 100%; font-family: 'Space Grotesk', 'Inter', sans-serif; font-weight: 700; text-transform: uppercase;
            font-size: var(--tc-name, 8cqw); line-height: 1; letter-spacing: -0.01em; text-wrap: balance; overflow-wrap: anywhere;
            display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
            text-shadow: 0 2px 18px rgba(0, 0, 0, 0.5), 0 1px 2px rgba(0, 0, 0, 0.3);
        }
        .tc-art-tags { display: flex; align-items: center; gap: 1.8cqw; }
        .tc-art-sport, .tc-art-year { display: inline-flex; align-items: center; gap: 1.4cqw; font-size: max(8.5px, 3.3cqw); font-weight: 800; letter-spacing: 0.14em; line-height: 1; text-transform: uppercase; white-space: nowrap; }
        .tc-art-sport { opacity: 0.9; }
        .tc-art-sport svg { width: 1.3em; height: 1.3em; flex: none; }
        .tc-art-year { padding: 0.9cqw 1.9cqw; border-radius: 99px; letter-spacing: 0.08em; background: rgba(255, 255, 255, 0.18); border: 1px solid rgba(255, 255, 255, 0.26); }
        /* bare: the monogram large, as the tournament's emblem — no name */
        .tc-art--bare .tc-art-mono {
            top: 50%; right: auto; left: 8%; transform: translateY(-58%);
            min-width: 24cqw; height: 24cqw; padding: 0 3.6cqw; border-radius: 7cqw; font-size: 8.6cqw;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.4), 0 18px 40px -12px rgba(0, 0, 0, 0.55);
        }
        .tc-art--bare .tc-art-copy { left: 8%; bottom: 9%; }
        .tc-art--bare .tc-art-copy::before { display: none; }
    `;
    const style = document.createElement('style');
    style.id = 'tournament-art-css';
    style.textContent = css;
    document.head.appendChild(style);
})();

// the sports' own icons (the homepage tabs draw the same ones)
const TOURNAMENT_SPORT_ICONS = {
    cricket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="1.8" width="6" height="14" rx="2" transform="rotate(45 12 8.8)" fill="currentColor" fill-opacity=".22"/><path d="M6.6 14.2L3 17.8" stroke-width="2.8"/><circle cx="18.2" cy="18.2" r="2.6" fill="currentColor" stroke="none"/></svg>',
    football: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5l4.2 3-1.6 5h-5.2l-1.6-5z"/><path d="M12 3v4.5M20.6 9.5l-4.4 1M17.4 19.3l-2.8-3.8M6.6 19.3l2.8-3.8M3.4 9.5l4.4 1"/></svg>',
    tabletennis: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="9" r="6.8" fill="currentColor" fill-opacity=".22"/><rect x="9" y="15.6" width="3" height="6" rx="1.4" fill="currentColor"/><circle cx="19.6" cy="17.4" r="2" fill="currentColor" stroke="none"/></svg>'
};
const TOURNAMENT_ART_SPORT_LABELS = { cricket: 'Cricket', football: 'Football', tabletennis: 'Table Tennis' };
function tournamentArtEscape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The colours picked from a token: "r, g, b" pairs, [bright, deep].
const TOURNAMENT_ART_COLOURS = [['37, 99, 235', '9, 22, 64'], ['225, 29, 72', '62, 8, 28'], ['13, 148, 136', '4, 42, 40'], ['124, 58, 237', '30, 10, 70'],
    ['234, 88, 12', '62, 20, 6'], ['2, 132, 199', '6, 32, 58'], ['77, 140, 20', '18, 40, 8'], ['192, 38, 211', '50, 8, 58']];
function tournamentPalette(seed) {
    let h = 0;
    for (const ch of String(seed || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return TOURNAMENT_ART_COLOURS[h % TOURNAMENT_ART_COLOURS.length];
}
// A tournament's colours, "r, g, b" [bright, deep]: its thumbnail's own
// (thumb.palette, '#rrggbb' — the deep one darkened from the first when the
// picture has one colour only), else the pair its token picks.
function tournamentColours(t) {
    const hex = ((t && t.thumb && t.thumb.palette) || []).filter(c => /^#[0-9a-f]{6}$/i.test(c));
    if (!hex.length) return tournamentPalette((t && (t.token || t.name)) || '');
    const rgb = (c, k) => [1, 3, 5].map(i => Math.round(parseInt(c.slice(i, i + 2), 16) * k)).join(', ');
    return [rgb(hex[0], 1), hex[1] ? rgb(hex[1], 1) : rgb(hex[0], 0.32)];
}

const TOURNAMENT_ART_SCENES = {
    // a ground seen from behind the bowler: the stands, the boundary,
    // the 30-yard circle, the pitch, the far stumps and a lofted shot
    cricket: '<svg class="tc-art-scene" viewBox="0 0 160 90" preserveAspectRatio="xMaxYMax slice" fill="none" stroke="#fff" aria-hidden="true"><ellipse cx="134" cy="104" rx="100" ry="54" stroke-opacity=".12" stroke-width="1.2"/><ellipse cx="134" cy="101" rx="76" ry="40" fill="#fff" fill-opacity=".05" stroke-opacity=".2"/><ellipse cx="134" cy="99" rx="42" ry="19" stroke-opacity=".26" stroke-dasharray="2.2 2.6"/><path d="M129.2 63.5h9.6l3.4 26.5h-16.4z" fill="#e8d3a2" fill-opacity=".24" stroke-opacity=".4"/><path d="M128.8 66.6h10.4M126.2 86.6h15.6" stroke-opacity=".55" stroke-width=".8"/><path d="M132.7 60.4v4.4M134 60.4v4.4M135.3 60.4v4.4" stroke-opacity=".9" stroke-width=".9" stroke-linecap="round"/><path d="M135 82C133 58 126 38 116.6 29.4" stroke-opacity=".34" stroke-dasharray="1 2.4" stroke-linecap="round"/><circle cx="115.8" cy="28.6" r="2.3" fill="#fff" stroke="none"/></svg>',
    // a pitch from the side: halfway line, centre circle, a box, the ball
    football: '<svg class="tc-art-scene" viewBox="0 0 160 90" preserveAspectRatio="xMaxYMax slice" fill="none" stroke="#fff" aria-hidden="true"><path d="M96 61 92 90M112 61 111 90M144 61 147 90" stroke-opacity=".06" stroke-width="8"/><path d="M70 61h96l24 29H44z" fill="#fff" fill-opacity=".05" stroke-opacity=".26"/><path d="M128 61v29" stroke-opacity=".26"/><ellipse cx="128" cy="74" rx="15" ry="5.4" stroke-opacity=".26"/><circle cx="128" cy="74" r=".8" fill="#fff" fill-opacity=".7" stroke="none"/><path d="M66.4 65h16l-4.4 19.6H57.3" stroke-opacity=".22"/><circle cx="146" cy="71" r="3.4" fill="#fff" fill-opacity=".95" stroke="none"/><path d="M146 69.25l1.45 1.05-.55 1.7h-1.8l-.55-1.7z" fill="#0b1220" fill-opacity=".55" stroke="none"/></svg>',
    // a table from one end: the net across it, a ball over it, a bat
    tabletennis: '<svg class="tc-art-scene" viewBox="0 0 160 90" preserveAspectRatio="xMaxYMax slice" fill="none" stroke="#fff" aria-hidden="true"><path d="M92 58h52l12 24H80z" fill="#3b82f6" fill-opacity=".24" stroke-opacity=".42"/><path d="M118 58v24" stroke-opacity=".34" stroke-width=".8"/><path d="M80 82v6M156 82v6M90 82v5M146 82v5" stroke-opacity=".24"/><path d="M86 65.4h64v3.4H86z" fill="#fff" fill-opacity=".1" stroke-opacity=".5"/><path d="M104 60Q118 34 132 47" stroke-opacity=".32" stroke-dasharray="1 2.2" stroke-linecap="round"/><circle cx="132.6" cy="47.8" r="2.1" fill="#fff" stroke="none"/><g transform="rotate(32 150 70)"><ellipse cx="150" cy="66" rx="7.6" ry="8.6" fill="#ef4444" fill-opacity=".72" stroke="none"/><rect x="148.3" y="73.8" width="3.4" height="9" rx="1.5" fill="#fff" fill-opacity=".5" stroke="none"/></g></svg>'
};
// The monogram: a short name the operator set, else the initials of the
// first four words — not of numbers, years or formats ("20th D Y Patil T20
// Cup 2026" → DYPC).
function tournamentInitials(t) {
    const short = String((t.info && t.info.shortName) || '').trim();
    if (short) return short.slice(0, 8).toUpperCase();
    const words = String(t.name || '').split(/[^\p{L}\p{N}]+/u)
        .filter(w => /^\p{L}/u.test(w) && !/^(the|of|and|by|a|an|for|in)$/i.test(w) && !/^t\d+$/i.test(w));
    return words.slice(0, 4).map(w => Array.from(w)[0]).join('').toUpperCase() || '🏆';
}
// The poster's title and year: "MIG TOURNAMENT 2026" → MIG TOURNAMENT and
// 2026; "MCA President Cup 2026 - 27" → 2026–27; else the season the
// operator set, when it is a year.
function tournamentArtTitle(t) {
    const name = String(t.name || '').replace(/\s+/g, ' ').trim();
    const range = (y, to) => to ? `${y}–${to.slice(-2)}` : y;
    const m = /^(.*?)[\s,(–—-]*\b((?:19|20)\d{2})(?:\s*[-–—/]\s*(\d{2}|(?:19|20)\d{2}))?\)?$/.exec(name);
    if (m && m[1].trim()) return { title: m[1].trim(), year: range(m[2], m[3]) };
    const s = /^((?:19|20)\d{2})(?:\s*[-–—/]\s*(\d{2}|(?:19|20)\d{2}))?$/.exec(String((t.info && t.info.season) || '').trim());
    return { title: name, year: s ? range(s[1], s[2]) : '' };
}
// t: { token, name, sport, info }. opts.bare: the emblem without the name.
function tournamentArt(t, opts) {
    const bare = !!(opts && opts.bare);
    const art = document.createElement('div');
    const sport = TOURNAMENT_ART_SPORT_LABELS[t.sport] ? t.sport : 'cricket';
    const [a, b] = tournamentPalette(t.token || t.name);
    const { title, year } = tournamentArtTitle(t);
    const n = Array.from(title).length;
    art.className = `tc-art tc-art--${sport}${bare ? ' tc-art--bare' : ''}`;
    art.setAttribute('aria-hidden', 'true');
    art.style.setProperty('--a', a);
    art.style.setProperty('--b', b);
    // the longer the name, the smaller it is set (two lines at most)
    art.style.setProperty('--tc-name', `${n <= 10 ? 10 : n <= 16 ? 8.6 : n <= 24 ? 7.4 : n <= 34 ? 6.3 : 5.4}cqw`);
    art.innerHTML = TOURNAMENT_ART_SCENES[sport]
        + `<span class="tc-art-mono">${tournamentArtEscape(tournamentInitials(t))}</span>`
        + `<span class="tc-art-copy">${bare ? '' : `<span class="tc-art-name">${tournamentArtEscape(title)}</span>`}`
        + `<span class="tc-art-tags"><span class="tc-art-sport">${TOURNAMENT_SPORT_ICONS[sport]}${tournamentArtEscape(TOURNAMENT_ART_SPORT_LABELS[sport])}</span>`
        + `${year ? `<span class="tc-art-year">${tournamentArtEscape(year)}</span>` : ''}</span></span>`;
    return art;
}
