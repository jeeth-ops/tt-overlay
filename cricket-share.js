/* 🟢 WHATSAPP MATCH SHARE — a match announcement made from THIS panel's match.

   The button sits beside 📱 Phone Remote. It opens a workspace that builds,
   from what the panel already holds (Match Setup, Team Squads, the
   tournament), two things to send to WhatsApp:

     • a match card image (1080 × 1350 portrait, or 1080 × 1080 square) —
       tournament, both teams with their own logos and colours, date, time,
       venue, format, and two real QR codes (Match Centre, Live Scorecard)
     • a message carrying all three links, which are compulsory:
         Match link      the match's own permanent page on the website
                         (a tournament match: /score/tournament/<token>/match/<id>,
                          a single match:     /score/match/<id>)
         Scorecard link  its live scorecard (/cricket-scorecard?room=<Match ID>)
         Website         https://allsportslivestreams.com/

   The links are the panel's own (the same routes "Copy Public Match Link",
   "Copy Public Tournament Link" and the overlay links use): nothing here
   invents a route. Before anything can be shared they are checked with the
   website itself (does it know this match, is the scorecard room showing
   this match), and the message cannot go out without all three.

   Sharing:
     A. Share image + message — the phone's / computer's share sheet with the
        card as a file and the message as its text (pick WhatsApp)
     B. Open WhatsApp — the message prefilled; the card is downloaded, to be
        attached by hand (a WhatsApp link can carry text only — said so)
     C. Download — the card as a PNG
   The card in the preview IS the file: one canvas, drawn at full size. */
(function(){
  'use strict';
  if(window.__matchShare) return;

  /* ============================== constants ============================== */
  const WEBSITE = 'https://allsportslivestreams.com/';
  const CANON_HOST = 'allsportslivestreams.com';
  const YOUTUBE = 'https://www.youtube.com/@allsportslive';
  const INSTAGRAM = 'https://www.instagram.com/all.sports.live/';
  const PREF_KEY = 'asl-match-share-prefs';
  const SIZES = { portrait: [1080, 1350], square: [1080, 1080] };
  const DEFAULT_PREFS = { theme: 'dark', size: 'portrait', qr: 'split', brand: true, venue: true, format: true, social: false };
  const DISPLAY = '"Barlow Condensed", "Arial Narrow", "Roboto Condensed", Arial, sans-serif';
  const BODY = 'Inter, "Segoe UI", Roboto, Arial, sans-serif';
  const WA_ICON = '<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" d="M16.04 3C8.86 3 3.03 8.82 3.03 16c0 2.3.6 4.53 1.74 6.5L3 29l6.68-1.74A12.95 12.95 0 0 0 16.04 29C23.2 29 29 23.18 29 16S23.2 3 16.04 3Zm0 23.62c-1.98 0-3.9-.53-5.6-1.53l-.4-.24-3.96 1.03 1.06-3.86-.26-.4a10.6 10.6 0 0 1-1.63-5.62c0-5.86 4.78-10.63 10.66-10.63 5.86 0 10.62 4.77 10.62 10.63 0 5.86-4.77 10.62-10.5 10.62Zm5.84-7.96c-.32-.16-1.89-.93-2.18-1.04-.3-.1-.5-.16-.72.16-.21.32-.82 1.04-1 1.25-.19.21-.37.24-.69.08-.32-.16-1.35-.5-2.57-1.59-.95-.85-1.59-1.9-1.78-2.22-.18-.32-.02-.49.14-.65.14-.14.32-.37.48-.56.16-.18.21-.32.32-.53.1-.21.05-.4-.03-.56-.08-.16-.72-1.73-.98-2.37-.26-.62-.52-.53-.72-.54h-.61c-.21 0-.56.08-.85.4-.29.32-1.12 1.09-1.12 2.66 0 1.57 1.14 3.09 1.3 3.3.16.21 2.25 3.44 5.46 4.82.76.33 1.36.53 1.82.68.77.24 1.46.2 2.01.12.61-.09 1.89-.77 2.15-1.52.27-.74.27-1.38.19-1.52-.08-.13-.29-.21-.61-.37Z"/></svg>';

  /* =============================== helpers =============================== */
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const safe = (fn, d) => { try{ const v = fn(); return v === undefined ? d : v; }catch(e){ return d; } };
  const g = (name) => safe(() => (typeof window[name] === 'function' ? window[name] : null), null);   // a panel function, if it has it
  const say = (text, ms) => { const t = g('toast'); if(t) t(text, ms); };
  // a value as WhatsApp shows it: its * _ ~ ` formatting characters taken out
  const waPlain = (s) => clean(s).replace(/[*_~`]/g, '');
  const slug = (s) => clean(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'Team';
  function hexOk(c, d){ return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c || '').trim()) ? String(c).trim() : d; }
  function rgbOf(hex){
    let h = String(hex).replace('#', '');
    if(h.length === 3) h = h.split('').map(x => x + x).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgba = (hex, a) => { const [r, gg, b] = rgbOf(hex); return `rgba(${r},${gg},${b},${a})`; };
  function mix(hex, toHex, t){ const a = rgbOf(hex), b = rgbOf(toHex); const m = a.map((v, i) => Math.round(v + (b[i] - v) * t)); return '#' + m.map(v => v.toString(16).padStart(2, '0')).join(''); }
  const darken = (hex, t) => mix(hex, '#000000', t);
  const lighten = (hex, t) => mix(hex, '#ffffff', t);
  function luminance(hex){ const [r, gg, b] = rgbOf(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * gg + 0.0722 * b; }
  const inkOn = (hex) => luminance(hex) > 0.42 ? '#0b1226' : '#ffffff';
  function initialsOf(t){
    const s = clean(t.short);
    if(s) return s.slice(0, 4).toUpperCase();
    const w = clean(t.name).split(' ').filter(Boolean);
    return (w.length > 1 ? w.slice(0, 3).map(x => x[0]).join('') : (w[0] || '?').slice(0, 3)).toUpperCase();
  }
  function logoOk(u){
    const v = String(u || '').trim();
    return (/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/i.test(v) || /^https?:\/\//i.test(v) || /^\//.test(v)) ? v : '';
  }

  /* ================================ prefs ================================ */
  let prefs = Object.assign({}, DEFAULT_PREFS);
  try{ Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); }catch(e){}
  if(!SIZES[prefs.size]) prefs.size = 'portrait';
  if(!['dark', 'light', 'team'].includes(prefs.theme)) prefs.theme = 'dark';
  if(!['split', 'right'].includes(prefs.qr)) prefs.qr = 'split';
  const savePrefs = () => { try{ localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); }catch(e){} };

  /* ===================== the match, as the panel has it ===================== */
  function stateNow(){ return safe(() => state, null) || {}; }   // the panel's live `state` (a global binding)
  function tournamentEntry(name){
    const cache = safe(() => tournamentInfoCache, null);
    return (cache && name && cache[name.toLowerCase()]) || null;
  }
  function formatText(s){
    const f = String(s.format || '').trim();
    if(!f) return '';
    if(f === 'Test') return 'Test Match';
    if(f === 'Custom') return s.customOvers ? `${s.customOvers} Overs` : 'Custom';
    const rules = safe(() => FORMAT_RULES[f], null);
    const ov = rules && rules.oversPerInnings;
    return ov ? `${f} · ${ov} Overs` : f;
  }
  function dateText(iso){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace(/,(?=\s\d)/, ',');
  }
  function timeText(hhmm){
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    if(!m) return '';
    const h = Number(m[1]), mi = m[2];
    if(h > 23) return '';
    return `${h % 12 || 12}:${mi} ${h < 12 ? 'AM' : 'PM'}`;
  }
  // Everything the card and the message show — read fresh every time.
  function matchInfo(){
    const s = stateNow();
    const tour = clean(safe(() => currentMatchTournament(), '') || '');
    const entry = tournamentEntry(tour);
    const ti = (entry && entry.info) || {};
    const team = (k) => {
      const t = (k === 'A' ? s.teamA : s.teamB) || {};
      return { key: k, name: clean(t.name) || 'Team ' + k, short: clean(t.short), color: hexOk(t.color, k === 'A' ? '#1d4ed8' : '#b91c1c'), logo: logoOk(t.logoUrl) };
    };
    const stage = clean(safe(() => umStageLabel(s.matchStage), '') || '');
    const title = clean(s.matchTitle);
    const no = s.matchNo ? `Match ${s.matchNo}` : '';
    // "Semi Final · Match 12" — each part once (a title may already say it)
    const parts = [];
    [stage, no && !new RegExp(`\\bmatch\\s*${s.matchNo}\\b`, 'i').test(title) ? no : '', title].forEach(p => {
      if(p && !parts.some(q => q.toLowerCase() === p.toLowerCase())) parts.push(p);
    });
    const season = clean(ti.season);
    return {
      tournament: tour,
      tournamentFull: tour && season && !tour.toLowerCase().includes(season.toLowerCase()) ? `${tour} ${season}` : tour,
      tournamentLogo: logoOk(ti.logoUrl),
      tournamentColor: hexOk(ti.color, ''),
      round: parts.join(' · '),
      a: team('A'), b: team('B'),
      date: /^\d{4}-\d{2}-\d{2}$/.test(s.matchDate || '') ? s.matchDate : '',
      time: /^\d{1,2}:\d{2}$/.test(s.matchTime || '') ? s.matchTime : '',
      dateText: dateText(s.matchDate),
      timeText: timeText(s.matchTime),
      venue: clean(s.venue),
      format: formatText(s)
    };
  }

  /* ========================== the three links ========================== */
  const tokenCache = {};   // tournament (lower case) -> its public token
  const tokenTried = {};   // tournament -> when it last could not be had
  let tokenError = '';
  async function tournamentToken(tour, force){
    const key = tour.toLowerCase();
    const entry = tournamentEntry(tour);
    if(entry && entry.token) return entry.token;
    if(tokenCache[key]) return tokenCache[key];
    const uid = safe(() => currentOwnerUid(), '');
    if(!uid){ tokenError = 'login'; return ''; }
    if(!force && tokenTried[key] && Date.now() - tokenTried[key] < 20000) return '';
    tokenTried[key] = Date.now();
    try{
      // the same idempotent call as "Copy Public Tournament Link": always the same token
      const res = await fetch(withUid(`${leagueApiPath(tour)}/public-link`), { method: 'POST' });
      const data = await res.json().catch(() => null);
      if(data && data.success && data.token){ tokenCache[key] = data.token; tokenError = ''; return data.token; }
      tokenError = res.status === 403 ? 'denied' : 'server';
    }catch(e){ tokenError = 'offline'; }
    return '';
  }
  // The links of THIS match, from the panel's own ids and the site's own routes.
  async function computeLinks(force){
    const s = stateNow();
    const origin = location.origin;
    const room = clean(safe(() => currentMatchId(), '') || '');
    const tour = clean(safe(() => currentMatchTournament(), '') || '');
    // the match's permanent id — the one "Copy Public Match Link" uses (made once, kept by the match)
    const id = clean(s.tournamentMatchId || (g('ensureTournamentMatchId') ? ensureTournamentMatchId() : ''));
    let match = '', token = '';
    if(id){
      if(tour){
        token = await tournamentToken(tour, force);
        if(token) match = `${origin}/score/tournament/${encodeURIComponent(token)}/match/${encodeURIComponent(id)}`;
      } else match = `${origin}/score/match/${encodeURIComponent(id)}`;
    }
    const scorecard = room ? `${origin}/cricket-scorecard?room=${encodeURIComponent(room)}` : '';
    return { match, scorecard, website: WEBSITE, id, room, tour, token, origin };
  }

  // Each link checked with the website: is it there, and is it THIS match?
  const sameTeams = (x, info) => {
    const n = (v) => clean(v).toLowerCase();
    const a = n(x && (x.teamA && (x.teamA.name || x.teamA))), b = n(x && (x.teamB && (x.teamB.name || x.teamB)));
    return a && b && ((a === n(info.a.name) && b === n(info.b.name)) || (a === n(info.b.name) && b === n(info.a.name)));
  };
  const teamsOf = (x) => `${clean(x && x.teamA && (x.teamA.name || x.teamA)) || '?'} vs ${clean(x && x.teamB && (x.teamB.name || x.teamB)) || '?'}`;
  async function getJson(url){
    const res = await fetch(url, { cache: 'no-store' });
    let json = null; try{ json = await res.json(); }catch(e){}
    return { status: res.status, json };
  }
  async function validate(links, info){
    const out = { match: null, scorecard: null, website: null, origin: null };
    // 🌐 the website link
    let wsOk = false; try{ const u = new URL(links.website); wsOk = u.protocol === 'https:' && u.hostname === CANON_HOST; }catch(e){}
    out.website = wsOk ? { level: 'ok', text: 'Official AllSportsLive website' } : { level: 'bad', text: 'The website address is not valid' };
    // where the links point
    const host = location.hostname.replace(/^www\./, '');
    out.origin = host === CANON_HOST ? null : { level: 'warn', text: `These links point to ${location.origin} — open this panel on ${CANON_HOST} so viewers can open them.` };

    // 🔴 the match page
    if(!links.id) out.match = { level: 'bad', text: 'This match has no permanent id yet.', fix: 'Set up the match (Match Setup) first.' };
    else if(links.tour && !links.token){
      const why = { login: 'You are not signed in, so the tournament\'s public page cannot be made.', denied: 'Your account cannot make this tournament\'s public page.', offline: 'The website could not be reached to get the tournament\'s page.', server: 'The website did not return the tournament\'s page.' }[tokenError] || 'The tournament\'s public page is missing.';
      out.match = { level: 'bad', text: why, fix: tokenError === 'login' ? 'Sign in on the home page, then reopen this panel.' : 'Check the connection and press Re-check.' };
    } else {
      try{
        const api = links.tour
          ? `/api/public/tournament/${encodeURIComponent(links.token)}/match/${encodeURIComponent(links.id)}`
          : `/api/public/match/${encodeURIComponent(links.id)}`;
        const r = await getJson(api);
        const d = r.json || {};
        if(r.status === 200 && d.success && d.match){
          out.match = sameTeams(d.match, info)
            ? { level: 'ok', text: `On the website: ${teamsOf(d.match)}${d.match.upcoming === true ? ' (upcoming)' : ''}` }
            : { level: 'bad', stale: true, text: `The website still shows other teams under this link (${teamsOf(d.match)}).`, fix: 'Save this match (Match Type → Save This Match), then Re-check.' };
        } else if(r.status === 200 && d.success && d.match === null && d.roomId && (d.roomId === links.room)){
          out.match = { level: 'ok', text: 'Live on the website now — opens this match' };
        } else if(r.status === 200 && d.success && d.match === null){
          out.match = { level: 'warn', text: 'The website shows this match once it is live — press Connect, or save the match.', fix: 'Fine to share now: the same link opens the match from then on.' };
        } else if(r.status === 404){
          // the token came from the website itself, so a tournament that answers
          // "not found" to a viewer is a private one: nobody else can open it
          const t = links.tour ? await getJson(`/api/public/tournament/${encodeURIComponent(links.token)}`).catch(() => null) : null;
          out.match = t && t.status === 404
            ? { level: 'bad', text: 'This tournament is private — viewers cannot open its match page.', fix: 'Make it public (Admin → Tournaments → visibility), then Re-check.' }
            : { level: 'warn', text: 'Not on the website yet — it appears once the match is saved or live (press Connect).', fix: 'Fine to share now: the same link opens the match from then on.' };
        } else out.match = { level: 'warn', text: 'The website did not answer the check — the link is still this match\'s own.' };
      }catch(e){ out.match = { level: 'warn', text: 'Could not check with the website (no connection) — the link is still this match\'s own.' }; }
    }

    // 📊 the live scorecard
    if(!links.room) out.scorecard = { level: 'bad', text: 'No Match ID — the live scorecard needs it.', fix: 'Type the Match ID at the top of the panel and press Connect.' };
    else {
      // connected — and to THIS match's room (the panel's socket joins the room it was given on Connect)
      const connected = !!safe(() => socket && socket.connected && String(socket.io.opts.query.uid) === links.room, false);
      try{
        const r = await getJson(`/api/cricket/room-state/${encodeURIComponent(links.room)}`);
        const st = r.json && r.json.state;
        if(r.status === 200 && st){
          out.scorecard = sameTeams(st, info)
            ? { level: 'ok', text: `Room ${links.room} shows ${teamsOf(st)}${connected ? ' · live' : ''}` }
            : { level: 'bad', connect: !connected, stale: connected, text: `Room ${links.room} still shows another match (${teamsOf(st)}).`, fix: connected ? 'Updating it…' : 'Press Connect so the scorecard shows this match, then Re-check.' };
        } else if(r.status === 404 || r.status === 400){
          out.scorecard = connected
            ? { level: 'ok', text: `Room ${links.room} — this match, live once the first ball is scored` }
            : { level: 'warn', connect: true, text: `The scorecard shows this match once you press Connect.`, fix: 'Fine to share now: viewers see "match not started yet" until then.' };
        } else out.scorecard = { level: 'warn', text: 'The website did not answer the check.' };
      }catch(e){ out.scorecard = { level: 'warn', text: 'Could not check with the website (no connection).' }; }
    }
    return out;
  }

  /* ============================== the message ============================== */
  function buildMessage(info, links){
    const L = ['🏏 *ALLSPORTSLIVE | LIVE CRICKET*'];
    if(info.tournament && prefs.brand){
      L.push('', '🏆 *TOURNAMENT*', waPlain(info.tournamentFull));
      if(info.round) L.push(waPlain(info.round));
    } else if(info.round) L.push('', `🏆 *${waPlain(info.round).toUpperCase()}*`);
    L.push('', '⚔️ *MATCH*', `*${waPlain(info.a.name)}* 🆚 *${waPlain(info.b.name)}*`);
    const det = [];
    if(info.dateText) det.push(`📅 Date: ${info.dateText}`);
    if(info.timeText) det.push(`⏰ Time: ${info.timeText}`);
    if(info.venue && prefs.venue) det.push(`📍 Venue: ${waPlain(info.venue)}`);
    if(info.format && prefs.format) det.push(`🏏 Format: ${info.format}`);
    if(det.length) L.push('', ...det);
    L.push('', '🔴 *FOLLOW THE MATCH:*', links.match || '');
    L.push('', '📊 *LIVE SCORECARD:*', links.scorecard || '');
    L.push('', '🌐 *OFFICIAL WEBSITE:*', links.website);
    if(prefs.social) L.push('', `▶️ YouTube: ${YOUTUBE}`, `📸 Instagram: ${INSTAGRAM}`);
    L.push('', '📺 Watch Live Cricket with AllSportsLive!');
    return L.join('\n');
  }
  const LINK_BLOCK = {
    match: (u) => `🔴 *FOLLOW THE MATCH:*\n${u}`,
    scorecard: (u) => `📊 *LIVE SCORECARD:*\n${u}`,
    website: (u) => `🌐 *OFFICIAL WEBSITE:*\n${u}`
  };
  // the compulsory links missing from a message (each must be there exactly, as its own word)
  function missingLinks(text, links){
    const has = (u) => !!u && new RegExp(`(^|\\s)${u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`).test(text);
    return ['match', 'scorecard', 'website'].filter(k => !has(links[k]));
  }

  /* ============================ drawing helpers ============================ */
  function rr(ctx, x, y, w, h, r){
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  const F = (w, px, fam) => `${w} ${Math.round(px)}px ${fam || DISPLAY}`;
  function spacing(ctx, px){ if('letterSpacing' in ctx) ctx.letterSpacing = px + 'px'; }
  // the biggest size (down to min) at which one line fits
  function fit(ctx, text, weight, max, min, maxW, fam){
    let s = max;
    ctx.font = F(weight, s, fam);
    while(s > min && ctx.measureText(text).width > maxW){ s -= 2; ctx.font = F(weight, s, fam); }
    return s;
  }
  // up to n lines that fit maxW; the last one ends with … if the text is longer
  function lines(ctx, text, maxW, n){
    const words = clean(text).split(' ');
    const out = [];
    let cur = '';
    for(let i = 0; i < words.length; i++){
      const t = cur ? cur + ' ' + words[i] : words[i];
      if(ctx.measureText(t).width <= maxW || !cur){ cur = t; continue; }
      out.push(cur); cur = words[i];
      if(out.length === n){ cur = ''; break; }
    }
    if(cur) out.push(cur);
    if(out.length > n) out.length = n;
    const rest = words.join(' ');
    if(out.join(' ').length < rest.length){
      let last = out[n - 1] || '';
      while(last && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
      out[n - 1] = last.replace(/\s+$/, '') + '…';
    }
    return out.map(l => { let t = l; while(t.length > 1 && ctx.measureText(t).width > maxW) t = t.slice(0, -2) + '…'; return t; });
  }
  // text in a few lines at the largest size that keeps it to n lines
  function block(ctx, text, weight, max, min, maxW, n, fam){
    let s = max;
    for(; s >= min; s -= 2){
      ctx.font = F(weight, s, fam);
      const words = clean(text).split(' ');
      let ln = 1, cur = '';
      let ok = true;
      words.forEach(w => {
        const t = cur ? cur + ' ' + w : w;
        if(ctx.measureText(t).width <= maxW || !cur) cur = t; else { ln++; cur = w; }
        if(ctx.measureText(w).width > maxW) ok = false;
      });
      if(ln <= n && ok) break;
    }
    s = Math.max(s, min);
    ctx.font = F(weight, s, fam);
    return { size: s, lines: lines(ctx, text, maxW, n) };
  }

  // images: same-origin and data: as they are; another site's only if it allows it
  const imgCache = new Map();
  function loadImage(src){
    if(!src) return Promise.resolve(null);
    if(imgCache.has(src)) return imgCache.get(src);
    const p = new Promise((resolve) => {
      const img = new Image();
      let cross = false;
      try{ const u = new URL(src, location.href); cross = /^https?:$/.test(u.protocol) && u.origin !== location.origin; }catch(e){}
      if(cross) img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => resolve(img.naturalWidth ? img : null);
      img.onerror = () => resolve(cross ? { blocked: true, src } : null);
      img.src = src;
    });
    imgCache.set(src, p);
    p.then(v => { if(!v || v.blocked) imgCache.delete(src); });
    return p;
  }
  // a logo made of light colours (a white crest) sits on dark, everything else on white
  function lightLogo(img){
    try{
      const c = document.createElement('canvas'); c.width = 48; c.height = 48;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, 48, 48);
      const d = x.getImageData(0, 0, 48, 48).data;
      let sum = 0, n = 0;
      for(let i = 0; i < d.length; i += 4){ if(d[i + 3] > 140){ sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]); n++; } }
      return n > 60 && sum / n > 225;
    }catch(e){ return false; }
  }
  function contain(ctx, img, cx, cy, box){
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const k = Math.min(box / w, box / h);
    const dw = w * k, dh = h * k;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, Math.round(cx - dw / 2), Math.round(cy - dh / 2), Math.round(dw), Math.round(dh));
  }
  let fontsReady = null;
  function loadFonts(){
    if(fontsReady) return fontsReady;
    if(!document.querySelector('link[data-ms-fonts]')){
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.setAttribute('data-ms-fonts', '1');
      l.href = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,700;0,800;1,800&family=Inter:wght@500;600;700;800&display=swap';
      document.head.appendChild(l);
    }
    const want = ['800 60px "Barlow Condensed"', 'italic 800 60px "Barlow Condensed"', '700 40px "Barlow Condensed"', '600 30px "Barlow Condensed"', '600 24px Inter', '700 24px Inter', '800 24px Inter', '500 24px Inter'];
    fontsReady = Promise.race([
      Promise.all(want.map(f => document.fonts ? document.fonts.load(f).catch(() => null) : null)),
      new Promise(r => setTimeout(r, 3500))     // never wait for ever: the card draws with what is there
    ]);
    return fontsReady;
  }

  /* ================================ QR codes ================================ */
  // The real QR matrix of a link, from the same QR library the panel already
  // uses for its own codes (qrcodejs); drawn here as crisp squares.
  const qrCache = new Map();
  function qrMatrix(text){
    if(!text) return null;
    if(qrCache.has(text)) return qrCache.get(text);
    const Q = window.QRCode;
    if(!Q) return null;
    let model = null;
    for(const lvl of ['Q', 'M', 'L']){
      try{
        const host = document.createElement('div');
        const q = new Q(host, { text, width: 64, height: 64, correctLevel: Q.CorrectLevel ? Q.CorrectLevel[lvl] : undefined });
        if(q && q._oQRCode && q._oQRCode.getModuleCount() > 0){ model = q._oQRCode; break; }
      }catch(e){}
    }
    if(!model) return null;
    const n = model.getModuleCount();
    const cells = [];
    for(let r = 0; r < n; r++){ const row = []; for(let c = 0; c < n; c++) row.push(!!model.isDark(r, c)); cells.push(row); }
    const m = { n, cells };
    qrCache.set(text, m);
    return m;
  }
  // a QR on a white card: a whole number of pixels per module, quiet zone inside the card
  function drawQr(ctx, x, y, size, matrix){
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 10;
    rr(ctx, x, y, size, size, Math.round(size * 0.1)); ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.restore();
    if(!matrix){
      ctx.fillStyle = '#9aa3b5'; ctx.font = F(700, size * 0.09, BODY); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('QR unavailable', x + size / 2, y + size / 2);
      return;
    }
    const quiet = 3;
    const cell = Math.max(2, Math.floor(size / (matrix.n + quiet * 2)));
    const px = cell * matrix.n;
    const ox = Math.round(x + (size - px) / 2), oy = Math.round(y + (size - px) / 2);
    ctx.fillStyle = '#0a0f1c';
    for(let r = 0; r < matrix.n; r++){
      for(let c = 0; c < matrix.n; c++) if(matrix.cells[r][c]) ctx.fillRect(ox + c * cell, oy + r * cell, cell, cell);
    }
  }

  /* ============================== small icons ============================== */
  function icon(ctx, kind, cx, cy, s, color){
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = Math.max(2, s * 0.11); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const h = s / 2;
    if(kind === 'date'){
      rr(ctx, cx - h, cy - h * 0.8, s, s * 0.9, s * 0.16); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - h, cy - h * 0.25); ctx.lineTo(cx + h, cy - h * 0.25); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - h * 0.45, cy - h * 1.05); ctx.lineTo(cx - h * 0.45, cy - h * 0.6); ctx.moveTo(cx + h * 0.45, cy - h * 1.05); ctx.lineTo(cx + h * 0.45, cy - h * 0.6); ctx.stroke();
    } else if(kind === 'time'){
      ctx.beginPath(); ctx.arc(cx, cy, h, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy - h * 0.55); ctx.lineTo(cx, cy); ctx.lineTo(cx + h * 0.42, cy + h * 0.25); ctx.stroke();
    } else if(kind === 'venue'){
      ctx.beginPath(); ctx.moveTo(cx, cy + h);
      ctx.bezierCurveTo(cx - h * 1.05, cy - h * 0.1, cx - h * 0.8, cy - h * 1.05, cx, cy - h * 1.05);
      ctx.bezierCurveTo(cx + h * 0.8, cy - h * 1.05, cx + h * 1.05, cy - h * 0.1, cx, cy + h); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy - h * 0.38, h * 0.3, 0, Math.PI * 2); ctx.stroke();
    } else if(kind === 'format'){
      ctx.beginPath(); ctx.arc(cx, cy, h, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx - h * 1.25, cy, h * 0.95, -0.7, 0.7); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx + h * 1.25, cy, h * 0.95, Math.PI - 0.7, Math.PI + 0.7); ctx.stroke();
    } else if(kind === 'play'){
      ctx.beginPath(); ctx.moveTo(cx - h * 0.55, cy - h * 0.8); ctx.lineTo(cx + h * 0.85, cy); ctx.lineTo(cx - h * 0.55, cy + h * 0.8); ctx.closePath(); ctx.fill();
    } else if(kind === 'bars'){
      [[-0.7, 0.2], [-0.1, -0.35], [0.5, -0.8]].forEach(([dx, top]) => { rr(ctx, cx + dx * h, cy + top * h, h * 0.42, h * (1 - top), h * 0.1); ctx.fill(); });
    }
    ctx.restore();
  }

  /* ============================== the match card ============================== */
  function palette(info){
    if(prefs.theme === 'light') return { light: true, ink: '#0b1226', dim: '#4b5875', soft: '#6b7690', card: 'rgba(11,18,38,.045)', line: 'rgba(11,18,38,.10)', gold: '#b7791f', gold2: '#e0a73a', red: '#e11d48', red2: '#be123c', vsBg: '#0b1226', bg: ['#fbfcff', '#e9eef8'] };
    const base = { light: false, ink: '#ffffff', dim: '#b9c3da', soft: '#8f9ab3', card: 'rgba(255,255,255,.065)', line: 'rgba(255,255,255,.15)', gold: '#f6c453', gold2: '#ffe7a3', red: '#ef233c', red2: '#c1121f', vsBg: '#070b16', bg: ['#050914', '#0c1531'] };
    if(prefs.theme === 'team') return Object.assign(base, { team: true, card: 'rgba(0,0,0,.28)', line: 'rgba(255,255,255,.18)' });
    return base;
  }
  function background(ctx, W, H, info, P){
    const ca = info.a.color, cb = info.b.color;
    if(P.team){
      // the two teams' colours, meeting on a slant
      const ga = ctx.createLinearGradient(0, 0, W * 0.6, H); ga.addColorStop(0, darken(ca, 0.15)); ga.addColorStop(1, darken(ca, 0.62));
      ctx.fillStyle = ga; ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.beginPath(); ctx.moveTo(W * 0.62, 0); ctx.lineTo(W, 0); ctx.lineTo(W, H); ctx.lineTo(W * 0.38, H); ctx.closePath(); ctx.clip();
      const gb = ctx.createLinearGradient(W, 0, W * 0.4, H); gb.addColorStop(0, darken(cb, 0.15)); gb.addColorStop(1, darken(cb, 0.62));
      ctx.fillStyle = gb; ctx.fillRect(0, 0, W, H);
      ctx.restore();
      ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(W * 0.62, 0); ctx.lineTo(W * 0.38, H); ctx.stroke(); ctx.restore();
      const v = ctx.createLinearGradient(0, 0, 0, H); v.addColorStop(0, 'rgba(0,0,0,.35)'); v.addColorStop(0.45, 'rgba(0,0,0,.05)'); v.addColorStop(1, 'rgba(0,0,0,.6)');
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    } else {
      const bg = ctx.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, P.bg[0]); bg.addColorStop(1, P.bg[1]);
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      // each team's colour, glowing from its side
      const glow = (x, c) => { const r = ctx.createRadialGradient(x, H * 0.46, 0, x, H * 0.46, W * 0.72); r.addColorStop(0, rgba(c, P.light ? 0.22 : 0.55)); r.addColorStop(1, rgba(c, 0)); ctx.fillStyle = r; ctx.fillRect(0, 0, W, H); };
      glow(-W * 0.05, ca); glow(W * 1.05, cb);
    }
    // floodlight beams from the top centre
    ctx.save();
    ctx.globalCompositeOperation = P.light ? 'multiply' : 'screen';
    for(let i = -3; i <= 3; i++){
      const a = i * 0.16;
      const grad = ctx.createLinearGradient(W / 2, 0, W / 2 + Math.sin(a) * H, H);
      grad.addColorStop(0, P.light ? 'rgba(20,40,90,.05)' : 'rgba(255,255,255,.07)'); grad.addColorStop(0.7, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.moveTo(W / 2 - 6, -10); ctx.lineTo(W / 2 + 6, -10);
      ctx.lineTo(W / 2 + Math.sin(a) * H * 1.1 + 70, H); ctx.lineTo(W / 2 + Math.sin(a) * H * 1.1 - 70, H); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    // a fine ring behind the teams, like the stands of a ground
    ctx.save(); ctx.strokeStyle = P.light ? 'rgba(11,18,38,.06)' : 'rgba(255,255,255,.06)'; ctx.lineWidth = 2;
    [0.42, 0.52].forEach(k => { ctx.beginPath(); ctx.ellipse(W / 2, H * 0.47, W * k, W * k * 0.42, 0, 0, Math.PI * 2); ctx.stroke(); });
    ctx.restore();
    // grain-free vignette at the bottom, for the QR codes
    const vb = ctx.createLinearGradient(0, H * 0.62, 0, H); vb.addColorStop(0, 'rgba(0,0,0,0)'); vb.addColorStop(1, P.light ? 'rgba(11,18,38,.06)' : 'rgba(0,0,0,.45)');
    ctx.fillStyle = vb; ctx.fillRect(0, 0, W, H);
  }
  function medallion(ctx, cx, cy, r, team, img, P){
    ctx.save();
    ctx.shadowColor = rgba(team.color, P.light ? 0.45 : 0.9); ctx.shadowBlur = r * 0.45;
    const ring = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    ring.addColorStop(0, lighten(team.color, 0.35)); ring.addColorStop(0.5, team.color); ring.addColorStop(1, darken(team.color, 0.35));
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = ring; ctx.fill();
    ctx.restore();
    // a thin gold line around the ring
    ctx.save(); ctx.strokeStyle = rgba(P.gold, 0.85); ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(cx, cy, r + 7, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    const inner = r * 0.88;
    const usable = img && !img.blocked;
    const dark = usable && lightLogo(img);
    ctx.beginPath(); ctx.arc(cx, cy, inner, 0, Math.PI * 2);
    if(usable){
      const disc = ctx.createRadialGradient(cx, cy - inner * 0.4, inner * 0.1, cx, cy, inner);
      if(dark){ disc.addColorStop(0, '#1d2742'); disc.addColorStop(1, '#0a1020'); } else { disc.addColorStop(0, '#ffffff'); disc.addColorStop(1, '#eef1f7'); }
      ctx.fillStyle = disc; ctx.fill();
      // the team's own logo, whole, never cropped or recoloured
      contain(ctx, img, cx, cy, inner * 1.36);
    } else {
      const disc = ctx.createRadialGradient(cx, cy - inner * 0.5, inner * 0.1, cx, cy, inner);
      disc.addColorStop(0, lighten(team.color, 0.18)); disc.addColorStop(1, darken(team.color, 0.3));
      ctx.fillStyle = disc; ctx.fill();
      const txt = initialsOf(team);
      ctx.fillStyle = inkOn(team.color); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      fit(ctx, txt, 800, inner * 0.78, 30, inner * 1.5);
      ctx.fillText(txt, cx, cy + inner * 0.04);
    }
  }
  function vsBadge(ctx, cx, cy, r, P){
    ctx.save();
    ctx.shadowColor = rgba(P.gold, 0.7); ctx.shadowBlur = r * 0.6;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = P.vsBg; ctx.fill();
    ctx.restore();
    const ring = ctx.createLinearGradient(cx, cy - r, cx, cy + r); ring.addColorStop(0, P.gold2); ring.addColorStop(1, P.gold);
    ctx.strokeStyle = ring; ctx.lineWidth = Math.max(4, r * 0.07); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    const fill = ctx.createLinearGradient(cx, cy - r * 0.5, cx, cy + r * 0.5); fill.addColorStop(0, P.gold2); fill.addColorStop(1, P.gold);
    ctx.fillStyle = fill; ctx.font = `italic 800 ${Math.round(r * 1.05)}px ${DISPLAY}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('VS', cx - r * 0.02, cy + r * 0.06);
  }
  function pill(ctx, x, y, w, h, text, kind, P){
    ctx.save();
    rr(ctx, x, y, w, h, h / 2);
    if(kind === 'primary'){
      ctx.shadowColor = rgba(P.red, 0.55); ctx.shadowBlur = 28; ctx.shadowOffsetY = 8;
      const gr = ctx.createLinearGradient(x, y, x + w, y + h); gr.addColorStop(0, P.red); gr.addColorStop(1, P.red2);
      ctx.fillStyle = gr; ctx.fill();
    } else {
      ctx.fillStyle = P.light ? 'rgba(11,18,38,.05)' : 'rgba(255,255,255,.08)'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = P.light ? 'rgba(11,18,38,.55)' : 'rgba(255,255,255,.75)'; ctx.stroke();
    }
    ctx.restore();
    const ink = kind === 'primary' ? '#ffffff' : P.ink;
    ctx.fillStyle = ink; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    spacing(ctx, 1.5);
    const size = fit(ctx, text, 800, h * 0.46, 18, w - h * 1.3);
    const tw = ctx.measureText(text).width;
    const iconS = h * 0.36, gap = h * 0.2;
    const sx = x + (w - (iconS + gap + tw)) / 2;
    icon(ctx, kind === 'primary' ? 'play' : 'bars', sx + iconS / 2, y + h / 2, iconS, ink);
    ctx.font = F(800, size); ctx.fillText(text, sx + iconS + gap, y + h / 2 + 2);
    spacing(ctx, 0);
  }
  function chip(ctx, cx, y, text, P, h){
    ctx.font = F(700, h * 0.52); spacing(ctx, 3);
    const w = Math.min(ctx.measureText(text).width + h * 1.4, 940);
    rr(ctx, cx - w / 2, y, w, h, h / 2);
    ctx.fillStyle = P.light ? 'rgba(183,121,31,.1)' : 'rgba(246,196,83,.12)'; ctx.fill();
    ctx.strokeStyle = rgba(P.gold, 0.85); ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = P.light ? '#8a5a12' : P.gold2; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(lines(ctx, text, w - h, 1)[0], cx, y + h / 2 + 1);
    spacing(ctx, 0);
  }

  // Where everything goes, at scale k (1 = full size). Everything scales together,
  // so a long tournament name or two-line team names never push one thing onto
  // another: the largest k at which it all fits is used.
  function plan(ctx, W, H, info, k, sq, tLogoOk){
    const M = 64;
    const P = { M, k, sq };
    P.bs = sq ? 76 : 88; P.by = sq ? 38 : 46;
    P.hasTour = !!(info.tournament && prefs.brand);
    P.tl = P.hasTour && tLogoOk ? Math.round((sq ? 96 : 132) * k) : 0;
    P.head = (P.hasTour ? info.tournamentFull : (info.round || 'MATCH DAY')).toUpperCase();
    spacing(ctx, 1);
    P.hb = block(ctx, P.head, 800, Math.round((sq ? 62 : 74) * k), 30, W - M * 2 - 40, sq ? 1 : 2);
    spacing(ctx, 0);
    P.chipH = P.hasTour && info.round ? Math.round((sq ? 44 : 52) * Math.max(k, 0.85)) : 0;
    P.tourH = (P.tl ? P.tl + Math.round(18 * k) : 0) + P.hb.lines.length * P.hb.size * 0.98 + Math.round(14 * k) + 3 + (P.chipH ? Math.round(18 * k) + P.chipH : 0);
    P.r = Math.round((sq ? 124 : 160) * k);
    spacing(ctx, 1);
    P.names = [info.a, info.b].map(t => block(ctx, t.name.toUpperCase(), 800, Math.round((sq ? 44 : 52) * k), 24, sq ? 400 : 430, 2));
    spacing(ctx, 0);
    P.namesH = Math.max(...P.names.map(n => n.lines.length * n.size * 0.96));
    P.teamsH = P.r * 2 + Math.round((sq ? 20 : 28) * k) + P.namesH;
    P.items = [];
    if(info.dateText) P.items.push(['date', 'DATE', info.dateText]);
    if(info.timeText) P.items.push(['time', 'TIME', info.timeText]);
    if(info.format && prefs.format) P.items.push(['format', 'FORMAT', info.format]);
    P.venue = prefs.venue && info.venue ? info.venue : '';
    P.rowH = Math.round((sq ? 82 : 94) * Math.max(k, 0.8));
    P.rows = (P.items.length ? 1 : 0) + (P.venue ? 1 : 0);
    P.infoH = P.rows ? P.rows * P.rowH + (P.rows - 1) * 2 : 0;
    P.qs = Math.max(sq ? 200 : 232, Math.round((sq ? 220 : 262) * k));   // never small enough to be hard to scan
    P.labelH = sq ? 36 : 42;
    P.bottomH = P.labelH + P.qs + 12;
    P.footH = sq ? 46 : 56;
    P.top = P.by + P.bs + Math.round((sq ? 22 : 34) * k);
    const minGaps = Math.round((sq ? 18 : 26) * k) * 3;
    P.used = P.top + P.tourH + P.teamsH + P.infoH + P.bottomH + P.footH + minGaps;
    P.fits = P.used <= H;
    return P;
  }

  // Draws the whole card at full size. Returns notes (a logo that could not be used, …).
  async function drawCard(canvas, info, links){
    const [W, H] = SIZES[prefs.size];
    const sq = prefs.size === 'square';
    await loadFonts();
    const [logoA, logoB, tLogo, brand] = await Promise.all([loadImage(info.a.logo), loadImage(info.b.logo), prefs.brand ? loadImage(info.tournamentLogo) : null, loadImage('/logo.png')]);
    const notes = [];
    [[info.a, logoA], [info.b, logoB]].forEach(([t, im]) => { if(im && im.blocked) notes.push(`${t.name}'s logo is on another website that does not allow it to be drawn on the card — upload the logo file in Team Squads to show it. The card shows the team's initials meanwhile.`); });
    if(tLogo && tLogo.blocked) notes.push('The tournament logo is on another website that does not allow it on the card — upload it in the tournament\'s details to show it.');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const C = palette(info);
    background(ctx, W, H, info, C);
    const tLogoOk = !!(tLogo && !tLogo.blocked);
    let L = null;
    for(let k = 1; k >= 0.6; k -= 0.03){ L = plan(ctx, W, H, info, k, sq, tLogoOk); if(L.fits) break; }
    const M = L.M, k = L.k;
    // the space left over opens up the gaps a little, the rest centres it all
    const free = Math.max(0, H - L.used);
    const g0 = Math.round((sq ? 18 : 26) * k);
    const gTour = g0 + Math.min(free * 0.34, sq ? 40 : 70);
    const gTeams = g0 + Math.min(free * 0.22, sq ? 30 : 46);
    const gInfo = g0 + Math.min(free * 0.22, sq ? 30 : 46);
    const rest = Math.max(0, free - (gTour - g0) - (gTeams - g0) - (gInfo - g0));

    // ---- top: AllSportsLive ----
    const bs = L.bs, by = L.by;
    if(brand && !brand.blocked){ ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.3)'; ctx.shadowBlur = 16; rr(ctx, M, by, bs, bs, bs * 0.22); ctx.clip(); ctx.drawImage(brand, M, by, bs, bs); ctx.restore(); }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = C.ink;
    spacing(ctx, 3); ctx.font = F(800, sq ? 36 : 42); ctx.fillText('ALLSPORTSLIVE', M + bs + 22, by + bs * 0.52);
    spacing(ctx, 4); ctx.font = F(700, sq ? 18 : 21, BODY); ctx.fillStyle = C.dim; ctx.fillText('LIVE CRICKET', M + bs + 24, by + bs * 0.9);
    spacing(ctx, 0);
    if(info.format && prefs.format){
      const ft = info.format.split(' · ')[0].toUpperCase();
      ctx.font = F(800, sq ? 26 : 30); spacing(ctx, 2);
      const fw = ctx.measureText(ft).width + 44, fh = sq ? 48 : 54;
      rr(ctx, W - M - fw, by + (bs - fh) / 2, fw, fh, fh / 2);
      ctx.fillStyle = C.red; ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(ft, W - M - fw / 2, by + bs / 2 + 2);
      spacing(ctx, 0);
    }

    // ---- the tournament ----
    let y = L.top + Math.round(rest * 0.4);
    if(L.tl){
      const ls = L.tl;
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 24; rr(ctx, W / 2 - ls / 2, y, ls, ls, ls * 0.22); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.restore();
      contain(ctx, tLogo, W / 2, y + ls / 2, ls * 0.84);
      y += ls + Math.round(18 * k);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = C.ink; spacing(ctx, 1);
    L.hb.lines.forEach((l, i) => { ctx.font = F(800, L.hb.size); ctx.fillText(l, W / 2, y + L.hb.size * 0.82 + i * L.hb.size * 0.98); });
    spacing(ctx, 0);
    y += L.hb.lines.length * L.hb.size * 0.98 + Math.round(14 * k);
    // a gold rule under the name
    const rg = ctx.createLinearGradient(W / 2 - 220, 0, W / 2 + 220, 0); rg.addColorStop(0, rgba(C.gold, 0)); rg.addColorStop(0.5, C.gold); rg.addColorStop(1, rgba(C.gold, 0));
    ctx.fillStyle = rg; ctx.fillRect(W / 2 - 220, Math.round(y), 440, 3);
    y += 3;
    if(L.chipH){ y += Math.round(18 * k); chip(ctx, W / 2, y, info.round.toUpperCase(), C, L.chipH); y += L.chipH; }

    // ---- the teams ----
    const r = L.r;
    const cy = Math.round(y + gTour + r);
    const cxA = sq ? 250 : 262, cxB = W - cxA;
    const bar = ctx.createLinearGradient(cxA, 0, cxB, 0); bar.addColorStop(0, rgba(info.a.color, 0.9)); bar.addColorStop(0.5, rgba(C.gold, 0.9)); bar.addColorStop(1, rgba(info.b.color, 0.9));
    ctx.fillStyle = bar; ctx.fillRect(cxA, cy - 3, cxB - cxA, 6);
    medallion(ctx, cxA, cy, r, info.a, logoA, C);
    medallion(ctx, cxB, cy, r, info.b, logoB, C);
    vsBadge(ctx, W / 2, cy, Math.round((sq ? 60 : 76) * Math.max(k, 0.8)), C);
    const nameTop = cy + r + Math.round((sq ? 20 : 28) * k);
    [[L.names[0], cxA], [L.names[1], cxB]].forEach(([nb, cx]) => {
      ctx.fillStyle = C.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; spacing(ctx, 1);
      nb.lines.forEach((l, i) => { ctx.font = F(800, nb.size); ctx.fillText(l, cx, nameTop + nb.size * 0.85 + i * nb.size * 0.96); });
      spacing(ctx, 0);
    });
    y = nameTop + L.namesH;

    // ---- date · time · format, then the venue ----
    const panelY = Math.round(y + gTeams);
    if(L.rows){
      const rowH = L.rowH;
      ctx.save(); rr(ctx, M, panelY, W - M * 2, L.infoH, 28); ctx.fillStyle = C.card; ctx.fill(); ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
      const drawItem = (it, x, w, yy) => {
        const ic = Math.round((sq ? 30 : 34) * Math.max(k, 0.85));
        icon(ctx, it[0], x + 26 + ic / 2, yy + rowH / 2, ic, C.gold);
        const tx = x + 26 + ic + 18, tw = w - (26 + ic + 18) - 18;
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = C.soft; spacing(ctx, 2.5); ctx.font = F(700, sq ? 15 : 17, BODY); ctx.fillText(it[1], tx, yy + rowH * 0.42);
        spacing(ctx, 0.5); ctx.fillStyle = C.ink;
        const sz = fit(ctx, it[2], 700, Math.round((sq ? 30 : 34) * Math.max(k, 0.85)), 18, tw);
        ctx.font = F(700, sz); ctx.fillText(lines(ctx, it[2], tw, 1)[0], tx, yy + rowH * 0.8);
        spacing(ctx, 0);
      };
      let yy = panelY;
      if(L.items.length){
        const cw = (W - M * 2) / L.items.length;
        L.items.forEach((it, i) => {
          drawItem(it, M + i * cw, cw, yy);
          if(i){ ctx.fillStyle = C.line; ctx.fillRect(Math.round(M + i * cw), yy + 18, 2, rowH - 36); }
        });
        yy += rowH;
        if(L.venue){ ctx.fillStyle = C.line; ctx.fillRect(M + 24, yy, W - M * 2 - 48, 2); yy += 2; }
      }
      if(L.venue) drawItem(['venue', 'VENUE', L.venue], M, W - M * 2, yy);
    }
    y = panelY + L.infoH;

    // ---- watch · scorecard · the two QR codes ----
    const footH = L.footH;
    const qs = L.qs;
    const qy = Math.round(Math.max(y + gInfo + L.labelH, H - footH - 12 - qs - Math.round(rest * 0.35)));
    const qrA = qrMatrix(links.match), qrB = qrMatrix(links.scorecard);
    const label = (txt, cx, yy) => {
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = C.ink; spacing(ctx, 2); ctx.font = F(800, sq ? 24 : 28); ctx.fillText(txt, cx, yy);
      spacing(ctx, 0);
    };
    const ctaH = Math.round((sq ? 70 : 82) * Math.max(k, 0.85));
    const mid = qy + qs / 2;
    let bx, bw;
    if(prefs.qr === 'right'){
      // the buttons on the left, both codes together on the right
      const gap = 22;
      const qx2 = W - M - qs, qx1 = qx2 - gap - qs;
      drawQr(ctx, qx1, qy, qs, qrA); drawQr(ctx, qx2, qy, qs, qrB);
      label('MATCH CENTRE', qx1 + qs / 2, qy - 14); label('SCORECARD', qx2 + qs / 2, qy - 14);
      bx = M; bw = qx1 - M - 40;
    } else {
      // a code each side, the buttons between them
      const qx1 = M, qx2 = W - M - qs;
      drawQr(ctx, qx1, qy, qs, qrA); drawQr(ctx, qx2, qy, qs, qrB);
      label('MATCH CENTRE', qx1 + qs / 2, qy - 14); label('LIVE SCORECARD', qx2 + qs / 2, qy - 14);
      bx = qx1 + qs + 34; bw = qx2 - 34 - bx;
    }
    pill(ctx, bx, mid - ctaH - 10, bw, ctaH, 'WATCH MATCH', 'primary', C);
    pill(ctx, bx, mid + 10, bw, ctaH, 'VIEW SCORECARD', 'ghost', C);
    ctx.fillStyle = C.soft; ctx.font = F(600, sq ? 14 : 16, BODY); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(prefs.qr === 'right' ? 'Scan a code with your phone camera ▶' : '◀  Scan with your phone camera  ▶', bx + bw / 2, Math.min(mid + ctaH + (sq ? 40 : 48), qy + qs - 2));

    // ---- the website, small, at the foot ----
    const fy = H - footH;
    ctx.fillStyle = C.line; ctx.fillRect(M, fy, W - M * 2, 2);
    ctx.textBaseline = 'middle'; ctx.fillStyle = C.dim; ctx.font = F(700, sq ? 17 : 19, BODY); spacing(ctx, 1);
    if(prefs.social){
      ctx.textAlign = 'left'; ctx.fillText('allsportslivestreams.com', M, fy + footH / 2 + 1);
      ctx.textAlign = 'right'; ctx.fillText('YouTube @allsportslive  ·  Instagram @all.sports.live', W - M, fy + footH / 2 + 1);
    } else { ctx.textAlign = 'center'; ctx.fillText('www.allsportslivestreams.com', W / 2, fy + footH / 2 + 1); }
    spacing(ctx, 0);
    return { notes, qr: { match: !!qrA, scorecard: !!qrB }, scale: Math.round(k * 100) / 100, qrSize: qs };
  }

  /* ============================== workspace ============================== */
  const css = document.createElement('style');
  css.textContent = `
    #ms-share-btn{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;background:linear-gradient(135deg,#25d366,#128c4a);color:#fff;border:1px solid rgba(255,255,255,.18);font-weight:800;box-shadow:0 4px 14px -6px rgba(37,211,102,.7)}
    #ms-share-btn svg{width:17px;height:17px;flex:none}
    #ms-share-btn:hover{filter:brightness(1.07)}
    #ms-share-btn:active{transform:translateY(1px)}
    .msx{position:fixed;inset:0;z-index:9000;display:none;background:rgba(3,6,14,.72);padding:18px;overflow:auto}
    .msx.show{display:flex;align-items:flex-start;justify-content:center}
    .msx *{box-sizing:border-box}
    .msx-sheet{width:min(1320px,100%);height:calc(100vh - 36px);background:var(--panel,#121826);color:var(--text,#f2f4f8);border:1px solid var(--border,#232c42);border-radius:20px;box-shadow:0 30px 90px -20px rgba(0,0,0,.7);display:flex;flex-direction:column;overflow:hidden}
    .msx-head{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border,#232c42)}
    .msx-head .msx-ic{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,#25d366,#128c4a);color:#fff;flex:none}
    .msx-head .msx-ic svg{width:24px;height:24px}
    .msx-head h3{margin:0;font-size:19px;font-weight:850;letter-spacing:-.2px}
    .msx-head small{display:block;font-size:12.5px;color:var(--text-dim,#8892a6);font-weight:600;margin-top:2px}
    .msx-x{margin-left:auto;width:38px;height:38px;border-radius:11px;border:1px solid var(--border,#232c42);background:var(--panel-2,#182034);color:var(--text,#f2f4f8);font-size:20px;line-height:1;cursor:pointer}
    .msx-body{flex:1;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.08fr);gap:0;min-height:0}
    .msx-left{padding:18px 20px 24px;border-right:1px solid var(--border,#232c42);display:flex;flex-direction:column;gap:16px;min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain}
    .msx-right{padding:18px 20px 24px;display:flex;flex-direction:column;gap:12px;min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain;background:color-mix(in srgb,var(--panel-2,#182034) 55%,transparent)}
    .msx-sec{border:1px solid var(--border,#232c42);border-radius:16px;padding:14px 14px 12px;background:var(--panel,#121826)}
    .msx-sec h4{margin:0 0 10px;font-size:12px;font-weight:850;letter-spacing:.09em;text-transform:uppercase;color:var(--text-dim,#8892a6);display:flex;align-items:center;gap:8px}
    .msx-sec h4 .msx-n{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:7px;background:var(--accent,#ff7a00);color:#fff;font-size:11px;letter-spacing:0}
    .msx-teams{display:flex;align-items:center;gap:10px;margin-bottom:10px}
    .msx-team{flex:1;min-width:0;display:flex;align-items:center;gap:10px}
    .msx-team.b{flex-direction:row-reverse;text-align:right}
    .msx-logo{width:46px;height:46px;border-radius:50%;flex:none;display:grid;place-items:center;font-weight:900;font-size:14px;background-size:contain;background-position:center;background-repeat:no-repeat;border:3px solid var(--c,#334155);background-color:#fff}
    .msx-logo.none{background-color:var(--c,#334155);color:#fff}
    .msx-team b{display:block;font-size:15px;font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .msx-vs{font-weight:900;font-style:italic;color:var(--accent,#ff7a00);flex:none}
    .msx-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:13px;align-items:center}
    .msx-kv span{color:var(--text-dim,#8892a6);font-weight:650}
    .msx-kv b{font-weight:750;min-width:0;overflow:hidden;text-overflow:ellipsis}
    .msx-kv b.miss{color:var(--text-dim,#8892a6);font-weight:600;font-style:italic}
    .msx-kv input{width:100%;padding:7px 9px;border-radius:9px;border:1px solid var(--border,#232c42);background:var(--panel-2,#182034);color:var(--text,#f2f4f8);font:inherit;font-size:13px;color-scheme:dark}
    html[data-theme="light"] .msx-kv input{color-scheme:light}
    .msx-hint{font-size:12px;color:var(--text-dim,#8892a6);margin-top:8px;line-height:1.4}
    .msx-note{font-size:12.5px;line-height:1.4;padding:9px 11px;border-radius:11px;background:rgba(245,158,11,.12);color:#f5b544;border:1px solid rgba(245,158,11,.28);margin-top:8px}
    html[data-theme="light"] .msx-note{color:#92400e;background:#fff7e6}
    .msx-link{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:10px;align-items:start;padding:10px 0;border-top:1px solid var(--border,#232c42)}
    .msx-link:first-of-type{border-top:0;padding-top:2px}
    .msx-link .li{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;font-size:17px;background:var(--panel-2,#182034)}
    .msx-link .lt b{display:block;font-size:13.5px;font-weight:850}
    .msx-link .lt a{display:block;font-size:12.5px;color:#60a5fa;word-break:break-all;text-decoration:none;margin-top:2px}
    .msx-link .lt a:hover{text-decoration:underline}
    .msx-link .lt a.none{color:var(--text-dim,#8892a6);pointer-events:none}
    .msx-st{display:flex;gap:6px;align-items:flex-start;font-size:12px;font-weight:650;margin-top:5px;line-height:1.35}
    .msx-st i{font-style:normal;flex:none}
    .msx-st.ok{color:#22c55e} .msx-st.warn{color:#f59e0b} .msx-st.bad{color:#ef4444} .msx-st.wait{color:var(--text-dim,#8892a6)}
    .msx-st small{display:block;color:var(--text-dim,#8892a6);font-weight:600}
    .msx-mini{padding:6px 10px;border-radius:9px;border:1px solid var(--border,#232c42);background:var(--panel-2,#182034);color:var(--text,#f2f4f8);font-size:12px;font-weight:750;cursor:pointer;white-space:nowrap}
    .msx-mini:disabled{opacity:.45;cursor:default}
    .msx-msg{width:100%;min-height:290px;resize:vertical;padding:12px;border-radius:12px;border:1px solid var(--border,#232c42);background:var(--panel-2,#182034);color:var(--text,#f2f4f8);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    .msx-msg:focus{outline:2px solid #25d366;outline-offset:1px}
    .msx-req{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
    .msx-req span{font-size:11.5px;font-weight:800;padding:4px 9px;border-radius:999px;background:rgba(34,197,94,.13);color:#22c55e}
    .msx-req span.no{background:rgba(239,68,68,.14);color:#ef4444}
    .msx-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
    .msx-seg{display:flex;padding:3px;border-radius:12px;background:var(--panel-2,#182034);border:1px solid var(--border,#232c42);gap:3px}
    .msx-seg button{flex:1;padding:8px 10px;border-radius:9px;border:0;background:transparent;color:var(--text-dim,#8892a6);font-weight:800;font-size:12.5px;cursor:pointer;white-space:nowrap}
    .msx-seg button.on{background:var(--panel,#121826);color:var(--text,#f2f4f8);box-shadow:0 1px 4px rgba(0,0,0,.25),inset 0 0 0 1px var(--accent,#ff7a00)}
    .msx-grid{display:grid;grid-template-columns:110px 1fr;gap:9px 12px;align-items:center;font-size:13px}
    .msx-grid > span{color:var(--text-dim,#8892a6);font-weight:700}
    .msx-toggles{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
    .msx-tg{display:flex;align-items:center;gap:9px;padding:9px 10px;border-radius:11px;border:1px solid var(--border,#232c42);background:var(--panel-2,#182034);font-size:12.5px;font-weight:700;cursor:pointer;user-select:none}
    .msx-tg input{width:16px;height:16px;accent-color:#25d366;margin:0}
    .msx-prev-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .msx-prev-head .msx-seg{flex:1}
    .msx-stage{position:relative;border-radius:16px;overflow:hidden;background:repeating-conic-gradient(rgba(127,127,127,.12) 0% 25%,transparent 0% 50%) 50%/22px 22px;border:1px solid var(--border,#232c42);display:flex;justify-content:center;padding:14px}
    .msx-stage canvas{display:block;width:auto;height:auto;max-width:100%;max-height:calc(100vh - 290px);border-radius:10px;box-shadow:0 18px 50px -14px rgba(0,0,0,.6)}
    .msx-stage{cursor:zoom-in}
    .msx-stage.zoom{cursor:zoom-out}
    .msx-stage.zoom canvas{max-height:none;width:100%;max-width:1080px}
    .msx-busy{position:absolute;top:12px;right:12px;font-size:11.5px;font-weight:800;padding:5px 10px;border-radius:999px;background:rgba(0,0,0,.6);color:#fff;opacity:0;transition:opacity .2s}
    .msx-busy.on{opacity:1}
    .msx-qrs{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .msx-qr{display:flex;gap:10px;align-items:center;padding:10px;border-radius:14px;border:1px solid var(--border,#232c42);background:var(--panel,#121826);min-width:0}
    .msx-qr canvas{width:84px;height:84px;flex:none;border-radius:8px;background:#fff}
    .msx-qr b{display:block;font-size:13px;font-weight:850}
    .msx-qr small{display:block;font-size:11.5px;color:var(--text-dim,#8892a6);word-break:break-all;margin-top:2px}
    .msx-foot{flex:none;display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:14px 20px;border-top:1px solid var(--border,#232c42);background:var(--panel,#121826);border-radius:0 0 20px 20px}
    .msx-act{display:inline-flex;align-items:center;gap:8px;padding:12px 16px;border-radius:13px;border:1px solid var(--border,#232c42);background:var(--panel-2,#182034);color:var(--text,#f2f4f8);font-weight:850;font-size:14px;cursor:pointer;white-space:nowrap}
    .msx-act svg{width:18px;height:18px}
    .msx-act.wa{background:linear-gradient(135deg,#25d366,#128c4a);border-color:transparent;color:#fff;box-shadow:0 8px 20px -10px rgba(37,211,102,.9)}
    .msx-act:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
    .msx-foot .msx-why{flex:1 1 220px;font-size:12.5px;color:var(--text-dim,#8892a6);font-weight:600;line-height:1.35}
    .msx-foot .msx-why.bad{color:#ef4444}
    .msx-done{margin:0 20px 14px;padding:11px 13px;border-radius:12px;background:rgba(37,211,102,.12);border:1px solid rgba(37,211,102,.35);font-size:13px;line-height:1.45;display:none}
    .msx-done.show{display:block}
    @media (max-width:980px){
      .msx{padding:0}
      .msx-sheet{border-radius:0;height:auto;min-height:100vh;overflow:visible}
      .msx-body{grid-template-columns:1fr}
      .msx-left,.msx-right{overflow:visible}
      .msx-left{border-right:0;order:2}
      .msx-right{order:1;border-bottom:1px solid var(--border,#232c42)}
      .msx-right{padding:12px 10px 16px}
      .msx-stage{padding:6px;border-radius:12px}
      .msx-stage canvas{max-height:none;width:100%}
      .msx-foot{position:sticky;bottom:0;border-radius:0;z-index:2;box-shadow:0 -10px 30px -12px rgba(0,0,0,.5)}
      .msx-act{flex:1 1 calc(50% - 10px);justify-content:center}
      .msx-foot .msx-why{flex-basis:100%;order:-1}
    }
    @media (max-width:520px){ .msx-seg .px{display:none} .msx-prev-head .msx-seg{flex:1 1 100%} .msx-qrs{grid-template-columns:1fr} .msx-toggles{grid-template-columns:1fr} .msx-grid{grid-template-columns:1fr} }
  `;
  document.head.appendChild(css);

  const ov = document.createElement('div');
  ov.className = 'msx'; ov.id = 'msx';
  ov.innerHTML = `
    <div class="msx-sheet" role="dialog" aria-modal="true" aria-labelledby="msx-title">
      <div class="msx-head">
        <span class="msx-ic">${WA_ICON}</span>
        <div><h3 id="msx-title">WhatsApp Match Share</h3><small>A match card and a message with the match, scorecard and website links — made from this match</small></div>
        <button type="button" class="msx-x" id="msx-x" aria-label="Close">×</button>
      </div>
      <div class="msx-body">
        <div class="msx-left">
          <section class="msx-sec" id="msx-match"><h4><span class="msx-n">1</span>Match</h4><div id="msx-match-in"></div></section>
          <section class="msx-sec"><h4><span class="msx-n">2</span>Links — all three go out with every message</h4><div id="msx-links"></div>
            <div class="msx-row"><button type="button" class="msx-mini" id="msx-recheck">↻ Re-check links</button></div></section>
          <section class="msx-sec"><h4><span class="msx-n">3</span>WhatsApp message</h4>
            <textarea class="msx-msg" id="msx-msg" spellcheck="false" aria-label="WhatsApp message"></textarea>
            <div class="msx-req" id="msx-req"></div>
            <div class="msx-row"><button type="button" class="msx-mini" id="msx-restore" hidden>⤺ Put the links back</button><button type="button" class="msx-mini" id="msx-reset">Rebuild message from the match</button></div>
            <div class="msx-hint" id="msx-msg-hint">Edit freely — the three links must stay. *Bold* and _italic_ work in WhatsApp.</div></section>
          <section class="msx-sec"><h4><span class="msx-n">4</span>Design</h4>
            <div class="msx-grid">
              <span>Style</span><div class="msx-seg" data-pref="theme"><button type="button" data-v="dark">Premium dark</button><button type="button" data-v="light">Premium light</button><button type="button" data-v="team">Team colours</button></div>
              <span>QR codes</span><div class="msx-seg" data-pref="qr"><button type="button" data-v="split">One each side</button><button type="button" data-v="right">Both on the right</button></div>
            </div>
            <div class="msx-toggles">
              <label class="msx-tg"><input type="checkbox" data-pref-tg="brand">Tournament branding</label>
              <label class="msx-tg"><input type="checkbox" data-pref-tg="venue">Venue</label>
              <label class="msx-tg"><input type="checkbox" data-pref-tg="format">Match format</label>
              <label class="msx-tg"><input type="checkbox" data-pref-tg="social">YouTube &amp; Instagram</label>
            </div>
            <div class="msx-hint">Your choices are remembered for the next match.</div></section>
        </div>
        <div class="msx-right">
          <div class="msx-prev-head"><div class="msx-seg" data-pref="size"><button type="button" data-v="portrait">Portrait 4:5<span class="px"> · 1080×1350</span></button><button type="button" data-v="square">Square 1:1<span class="px"> · 1080×1080</span></button></div>
            <button type="button" class="msx-mini" id="msx-regen" title="Draw the card again from the match">↻ Regenerate</button></div>
          <div class="msx-stage" id="msx-stage" title="Click to see the card at full size"><canvas id="msx-card" width="1080" height="1350" aria-label="Match card preview"></canvas><span class="msx-busy" id="msx-busy">Updating…</span></div>
          <div id="msx-card-notes"></div>
          <div class="msx-qrs">
            <div class="msx-qr"><canvas id="msx-qr-a" width="168" height="168"></canvas><div><b>Match Centre QR</b><small id="msx-qr-a-u">—</small></div></div>
            <div class="msx-qr"><canvas id="msx-qr-b" width="168" height="168"></canvas><div><b>Live Scorecard QR</b><small id="msx-qr-b-u">—</small></div></div>
          </div>
        </div>
      </div>
      <div class="msx-done" id="msx-done"></div>
      <div class="msx-foot">
        <span class="msx-why" id="msx-why">Checking the links…</span>
        <button type="button" class="msx-act wa" id="msx-share">${WA_ICON}Share image + message</button>
        <button type="button" class="msx-act" id="msx-wa">${WA_ICON}Open WhatsApp</button>
        <button type="button" class="msx-act" id="msx-copy">Copy message</button>
        <button type="button" class="msx-act" id="msx-dl">Download card</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  // the button, beside 📱 Phone Remote
  const btn = document.createElement('button');
  btn.id = 'ms-share-btn'; btn.className = 'small'; btn.type = 'button';
  btn.title = 'Make a match card and a WhatsApp message with the match, scorecard and website links';
  btn.innerHTML = `${WA_ICON}<span>WhatsApp Match Share</span>`;
  function placeButton(){
    const anchor = $('cr-remote-btn') || $('connect-btn');
    if(anchor && anchor.parentNode){ if(anchor.nextElementSibling !== btn) anchor.insertAdjacentElement('afterend', btn); return true; }
    if(!btn.isConnected) document.body.appendChild(btn);
    return false;
  }
  placeButton();
  // Phone Remote's own button may arrive a moment later: sit beside it once it does
  if(!$('cr-remote-btn')){ let n = 0; const t = setInterval(() => { if($('cr-remote-btn') || ++n > 40){ placeButton(); clearInterval(t); } }, 250); }

  /* ============================== live state ============================== */
  let open = false;
  let info = null, links = null, checks = null;
  let msgAuto = '';      // the message as last built from the match
  let msgEdited = false; // the operator has typed in it
  let file = null, fileUrl = '', blob = null;
  let renderSeq = 0, lastSig = '', lastLinkSig = '', checkSeq = 0, pollTimer = null, checkTimer = null;

  function filename(){
    return `${slug(info.a.name)}-vs-${slug(info.b.name)}-AllSportsLive-Match-Card${prefs.size === 'square' ? '-Square' : ''}.png`;
  }
  function setStatus(el, c){
    if(!c){ el.className = 'msx-st wait'; el.innerHTML = '<i>…</i><span>Checking with the website…</span>'; return; }
    el.className = 'msx-st ' + c.level;
    el.innerHTML = `<i>${{ ok: '✓', warn: '⚠', wait: '…' }[c.level] || '✕'}</i><span>${esc(c.text)}${c.fix ? `<small>${esc(c.fix)}</small>` : ''}</span>`
      + (c.connect ? '<button type="button" class="msx-mini" data-connect-now style="margin-left:auto;align-self:center">Connect this match</button>' : '');
  }
  function renderMatchSection(){
    const t = (x, cls) => `<div class="msx-team ${cls}"><span class="msx-logo${x.logo ? '' : ' none'}" style="--c:${esc(x.color)};${x.logo ? `background-image:url('${esc(x.logo)}')` : ''}">${x.logo ? '' : esc(initialsOf(x))}</span><div style="min-width:0"><b>${esc(x.name)}</b></div></div>`;
    const v = (txt, miss) => txt ? `<b>${esc(txt)}</b>` : `<b class="miss">${esc(miss)}</b>`;
    const s = stateNow();
    $('msx-match-in').innerHTML = `<div class="msx-teams">${t(info.a, 'a')}<span class="msx-vs">VS</span>${t(info.b, 'b')}</div>
      <div class="msx-kv">
        <span>Tournament</span>${v(info.tournamentFull, 'Single match')}
        <span>Round</span>${v(info.round, 'Not set — optional')}
        <span>Date</span><input type="date" id="msx-date" value="${esc(s.matchDate || '')}">
        <span>Start time</span><input type="time" id="msx-time" value="${esc(info.time)}">
        <span>Venue</span>${v(info.venue, 'Not set — add it in Match Setup')}
        <span>Format</span>${v(info.format, '—')}
      </div>
      <div class="msx-hint">Teams, logos, venue and format come from Match Setup and Team Squads — change them there and the card follows. Date and start time are this match's own (the date is the same one as in Match Setup).</div>`;
  }
  function renderLinks(){
    const row = (k, icon, title, url) => `<div class="msx-link"><span class="li">${icon}</span><div class="lt"><b>${title}</b><a ${url ? `href="${esc(url)}" target="_blank" rel="noopener"` : 'class="none"'}>${esc(url || 'Not available yet')}</a><div class="msx-st" id="msx-st-${k}"></div></div><button type="button" class="msx-mini" data-copy-link="${k}"${url ? '' : ' disabled'}>Copy</button></div>`;
    $('msx-links').innerHTML = row('match', '🔴', 'Match link — the match\'s own page', links.match)
      + row('scorecard', '📊', 'Scorecard link — the live scorecard', links.scorecard)
      + row('website', '🌐', 'AllSportsLive website', links.website)
      + (checks && checks.origin ? `<div class="msx-note">⚠ ${esc(checks.origin.text)}</div>` : '');
    ['match', 'scorecard', 'website'].forEach(k => setStatus($('msx-st-' + k), checks && checks[k]));
  }
  function renderQrPreviews(){
    [['a', links.match], ['b', links.scorecard]].forEach(([k, u]) => {
      const c = $('msx-qr-' + k), ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      const m = qrMatrix(u);
      if(m){ const cell = Math.floor(c.width / (m.n + 4)); const off = Math.round((c.width - cell * m.n) / 2); ctx.fillStyle = '#0a0f1c'; for(let r = 0; r < m.n; r++) for(let cc = 0; cc < m.n; cc++) if(m.cells[r][cc]) ctx.fillRect(off + cc * cell, off + r * cell, cell, cell); }
      else { ctx.fillStyle = '#9aa3b5'; ctx.font = '700 16px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(u ? 'QR unavailable' : 'No link', c.width / 2, c.height / 2); }
      $(`msx-qr-${k}-u`).textContent = u || 'No link yet';
    });
  }
  function renderPrefs(){
    ov.querySelectorAll('.msx-seg[data-pref]').forEach(seg => seg.querySelectorAll('button').forEach(b => { const on = b.dataset.v === prefs[seg.dataset.pref]; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }));
    ov.querySelectorAll('[data-pref-tg]').forEach(i => { i.checked = !!prefs[i.dataset.prefTg]; });
  }

  // the message box: kept in step with the match unless the operator has written in it
  function refreshMessage(prevLinks){
    const box = $('msx-msg');
    const fresh = buildMessage(info, links);
    if(!msgEdited){ if(box.value !== fresh) box.value = fresh; }
    else if(prevLinks){
      // the operator's words stay; a link that changed is changed in them too
      let v = box.value;
      ['match', 'scorecard'].forEach(k => { const a = prevLinks[k], b = links[k]; if(a && b && a !== b) v = v.split(a).join(b); });
      if(v !== box.value) box.value = v;
    }
    msgAuto = fresh;
    checkMessage();
  }
  function checkMessage(){
    const miss = missingLinks($('msx-msg').value, links);
    const name = { match: 'Match link', scorecard: 'Scorecard link', website: 'Website link' };
    $('msx-req').innerHTML = ['match', 'scorecard', 'website'].map(k => `<span class="${miss.includes(k) ? 'no' : ''}">${miss.includes(k) ? '✕' : '✓'} ${name[k]}</span>`).join('');
    $('msx-restore').hidden = !miss.length || miss.every(k => !links[k]);
    updateActions();
    return miss;
  }
  // can it be shared now — and if not, why
  function blockers(){
    const out = [];
    if(!links) return ['Getting the links…'];
    if(!links.match) out.push(checks && checks.match && checks.match.level === 'bad' ? checks.match.text : 'The match link is missing.');
    if(!links.scorecard) out.push('The scorecard link is missing — type the Match ID and press Connect.');
    if(!checks) out.push('Checking the links with the website…');   // nothing goes out before they are checked
    if(checks){ ['match', 'scorecard', 'website'].forEach(k => { const c = checks[k]; if(c && c.level === 'bad' && !out.includes(c.text)) out.push(c.text); if(c && c.level === 'wait') out.push('Bringing the website up to date with this match — one moment…'); }); }
    const miss = missingLinks($('msx-msg').value, links).filter(k => links[k]);
    if(miss.length) out.push('The message is missing a compulsory link — press "Put the links back".');
    if(!file) out.push('The card is still being drawn…');
    else if(!cardInfo.qr.match || !cardInfo.qr.scorecard) out.push('The QR codes could not be made — the QR library did not load. Check the connection and reopen.');
    return out;
  }
  let cardInfo = { notes: [], qr: { match: false, scorecard: false } };
  function canShareFiles(){
    try{ return !!(file && navigator.canShare && navigator.canShare({ files: [file] })); }catch(e){ return false; }
  }
  function updateActions(){
    const b = blockers();
    const ok = !b.length;
    $('msx-share').disabled = !ok || !canShareFiles();
    $('msx-wa').disabled = !ok;
    $('msx-copy').disabled = !ok;
    $('msx-dl').disabled = !file;
    const why = $('msx-why');
    if(!ok){ why.className = 'msx-why bad'; why.textContent = b[0]; }
    else if(!canShareFiles()){ why.className = 'msx-why'; why.textContent = 'This browser cannot hand an image to WhatsApp directly — use Open WhatsApp: the message opens and the card is downloaded to attach.'; }
    else { why.className = 'msx-why'; why.textContent = 'Ready — the card and the message, with all three links.'; }
  }

  async function renderCard(force){
    const seq = ++renderSeq;
    $('msx-busy').classList.add('on');
    const canvas = $('msx-card');
    // drawn off screen, then shown at once — the preview never shows a half-drawn card
    const off = document.createElement('canvas');
    const res = await drawCard(off, info, links).catch(e => { console.warn('match card', e); return null; });
    if(seq !== renderSeq) return;
    if(!res){ $('msx-busy').classList.remove('on'); return; }
    canvas.width = off.width; canvas.height = off.height;
    canvas.getContext('2d').drawImage(off, 0, 0);
    cardInfo = res;
    $('msx-card-notes').innerHTML = res.notes.map(n => `<div class="msx-note">⚠ ${esc(n)}</div>`).join('');
    // the PNG made now, so a share happens straight from the tap
    const b = await new Promise(r => { try{ off.toBlob(r, 'image/png'); }catch(e){ r(null); } });
    if(seq !== renderSeq) return;
    blob = b;
    if(fileUrl){ URL.revokeObjectURL(fileUrl); fileUrl = ''; }
    file = b ? new File([b], filename(), { type: 'image/png' }) : null;
    if(b) fileUrl = URL.createObjectURL(b);
    $('msx-busy').classList.remove('on');
    updateActions();
  }

  async function refresh(force){
    if(!open) return;
    const prevLinks = links;
    info = matchInfo();
    links = await computeLinks(force);
    if(!open) return;
    const linkSig = JSON.stringify([links.match, links.scorecard, info.a.name, info.b.name]);
    const sig = JSON.stringify([info, links.match, links.scorecard, prefs]);
    if(!force && sig === lastSig) return;
    lastSig = sig;
    if(document.activeElement && document.activeElement.closest && !document.activeElement.closest('#msx-match')) renderMatchSection();
    else if(!$('msx-date')) renderMatchSection();
    renderLinks();
    renderQrPreviews();
    refreshMessage(prevLinks);
    renderCard(force);
    if(force || linkSig !== lastLinkSig){ lastLinkSig = linkSig; healed = 0; scheduleCheck(force ? 0 : 500); }
  }
  function scheduleCheck(ms){
    clearTimeout(checkTimer);
    checkTimer = setTimeout(async () => {
      const seq = ++checkSeq;
      checks = null; renderLinks(); updateActions();
      const res = await validate(links, info);
      if(seq !== checkSeq || !open) return;
      const stale = ['match', 'scorecard'].filter(k => res[k] && res[k].stale);
      if(stale.length && healed < 2){
        // the panel's own save of this match (what it does after every edit) —
        // the website then shows these teams; checked again a moment later
        healed++;
        if(res.match && res.match.stale){ safe(() => autoSyncMatchSnapshot()); res.match = { level: 'wait', text: 'Updating the website with this match\'s current teams…' }; }
        if(res.scorecard && res.scorecard.stale){ safe(() => pushState(true)); res.scorecard = { level: 'wait', text: 'Updating the live scorecard with this match…' }; }
        checks = res; renderLinks(); updateActions();
        scheduleCheck(3500);
        return;
      }
      checks = res; renderLinks(); updateActions();
    }, ms);
  }
  let healed = 0;

  function openWorkspace(){
    open = true; msgEdited = false; lastSig = ''; lastLinkSig = '';
    $('msx-done').classList.remove('show');
    ov.classList.add('show');
    document.documentElement.style.overflow = 'hidden';
    renderPrefs();
    refresh(true);
    clearInterval(pollTimer);
    pollTimer = setInterval(() => refresh(false), 900);   // the panel changed something: the card follows
  }
  function closeWorkspace(){
    open = false;
    ov.classList.remove('show');
    document.documentElement.style.overflow = '';
    clearInterval(pollTimer); clearTimeout(checkTimer);
  }

  /* ================================ actions ================================ */
  function download(){
    if(!fileUrl) return;
    const a = document.createElement('a');
    a.href = fileUrl; a.download = filename();
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function copyText(text){
    try{ await navigator.clipboard.writeText(text); return true; }catch(e){}
    try{
      const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select(); const ok = document.execCommand('copy'); t.remove(); return ok;
    }catch(e){ return false; }
  }
  function done(html){ const d = $('msx-done'); d.innerHTML = html; d.classList.add('show'); }
  const finalMessage = () => $('msx-msg').value.trim();

  btn.addEventListener('click', openWorkspace);
  $('msx-x').addEventListener('click', closeWorkspace);
  ov.addEventListener('click', (e) => { if(e.target === ov) closeWorkspace(); });
  document.addEventListener('keydown', (e) => { if(open && e.key === 'Escape') closeWorkspace(); });

  // A. the share sheet: the card as a file + the message (pick WhatsApp there)
  $('msx-share').addEventListener('click', async () => {
    if(blockers().length || !canShareFiles()) return;
    try{
      await navigator.share({ files: [file], text: finalMessage(), title: `${info.a.name} vs ${info.b.name}` });
      done('✅ Shared. If WhatsApp was picked, the card went with the message as its caption.');
    }catch(e){
      if(e && e.name === 'AbortError') return;   // closed the share sheet
      done(`⚠️ The share sheet did not take the image (${esc(e && e.message || 'not supported')}). Use <b>Open WhatsApp</b> — the card is downloaded to attach.`);
    }
  });
  // B. WhatsApp with the message, the card downloaded to attach by hand
  $('msx-wa').addEventListener('click', () => {
    if(blockers().length) return;
    const url = 'https://wa.me/?text=' + encodeURIComponent(finalMessage());
    const w = window.open(url, '_blank');   // straight from the tap, so no pop-up blocker stops it
    if(w){ try{ w.opener = null; }catch(e){} }
    download();
    done(`✅ WhatsApp ${w === null ? 'could not open here (pop-up blocked) — copy the message instead' : 'is open'} with the message and all three links. <b>The match card was downloaded</b> as <b>${esc(filename())}</b> — attach it in WhatsApp (📎 → Gallery / Photos) before sending. A WhatsApp link can carry text only, so the image is never added by itself.`);
  });
  $('msx-copy').addEventListener('click', async () => {
    if(blockers().length) return;
    const ok = await copyText(finalMessage());
    done(ok ? '📋 Message copied, with all three links — paste it in WhatsApp.' : '⚠️ Could not copy — select the message and copy it.');
  });
  $('msx-dl').addEventListener('click', () => { if(!file) return; download(); done(`⬇️ Downloaded <b>${esc(filename())}</b> (${SIZES[prefs.size].join(' × ')} PNG).`); });
  $('msx-stage').addEventListener('click', () => $('msx-stage').classList.toggle('zoom'));
  // the match section is not redrawn under a field being edited; once the field is left, it catches up
  $('msx-match').addEventListener('focusout', () => setTimeout(() => { if(open && info && !$('msx-match').contains(document.activeElement)) renderMatchSection(); }, 0));
  $('msx-recheck').addEventListener('click', () => { lastLinkSig = ''; refresh(true); });
  $('msx-regen').addEventListener('click', () => { imgCache.clear(); qrCache.clear(); fontsReady = null; refresh(true); });
  $('msx-reset').addEventListener('click', () => { msgEdited = false; $('msx-msg').value = buildMessage(info, links); checkMessage(); });
  $('msx-restore').addEventListener('click', () => {
    const box = $('msx-msg');
    const miss = missingLinks(box.value, links).filter(k => links[k]);
    box.value = box.value.replace(/\s+$/, '') + '\n\n' + miss.map(k => LINK_BLOCK[k](links[k])).join('\n\n');
    checkMessage();
  });
  $('msx-msg').addEventListener('input', () => { msgEdited = $('msx-msg').value !== msgAuto; checkMessage(); });
  ov.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy-link]');
    if(c && links){ const u = links[c.dataset.copyLink]; if(u && await copyText(u)){ c.textContent = 'Copied'; setTimeout(() => { c.textContent = 'Copy'; }, 1200); } return; }
    if(e.target.closest('[data-connect-now]')){
      const cb = $('connect-btn');
      if(cb){ cb.click(); e.target.closest('[data-connect-now]').disabled = true; setTimeout(() => refresh(true), 2600); }
      return;
    }
    const sb = e.target.closest('.msx-seg[data-pref] button');
    if(sb){ const key = sb.closest('.msx-seg').dataset.pref; if(prefs[key] !== sb.dataset.v){ prefs[key] = sb.dataset.v; savePrefs(); renderPrefs(); refresh(true); } }
  });
  ov.addEventListener('change', (e) => {
    const tg = e.target.closest('[data-pref-tg]');
    if(tg){ prefs[tg.dataset.prefTg] = !!tg.checked; savePrefs(); refresh(true); return; }
    const s = stateNow();
    // the date is Match Setup's own date; the time is kept with the match — entered once, here
    if(e.target.id === 'msx-date'){
      s.matchDate = /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) ? e.target.value : '';
      safe(() => renderMatchSetup());
      safe(() => { saveLocal(); pushState(true); });
      refresh(true);
    }
    if(e.target.id === 'msx-time'){
      s.matchTime = /^\d{1,2}:\d{2}$/.test(e.target.value) ? e.target.value : '';
      safe(() => { saveLocal(); pushState(true); });
      refresh(true);
    }
  });

  // for tests / support
  window.__matchShare = {
    open: openWorkspace, close: closeWorkspace, refresh: () => refresh(true),
    get info(){ return info; }, get links(){ return links; }, get checks(){ return checks; }, get prefs(){ return Object.assign({}, prefs); },
    get file(){ return file; }, blockers, missingLinks: (t) => missingLinks(t, links), buildMessage: () => buildMessage(info, links),
    qrMatrix, filename: () => filename()
  };
})();
