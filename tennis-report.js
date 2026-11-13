/* ================================================================
   📑 TENNIS SCORECARD PDF — made when a match is complete.

   Built only from what was saved: the match record (players, format,
   court, officials), the replayed event ledger (sets, games, every point)
   and the statistics derived from it. Nothing is estimated: a figure the
   operator never recorded prints as "–" (with a note saying so), never as
   a zero. Long tables run onto further pages with their headings
   repeated; text that would not fit is cut with "…".

   The PDF writer is the site's dependency-free one (volleyball-pdf.js),
   used as it is — nothing in it is volleyball's but the file name.
   ================================================================ */
'use strict';
const { PdfDoc, A4, hexColor } = require('./volleyball-pdf.js');
const E = require('./tennis-engine.js');

const M = 36;
const W = A4.w - 2 * M;
const BOTTOM = A4.h - 46;
const INK = '#0f172a', MUTED = '#64748b', LINE = '#e2e8f0', SOFT = '#f1f5f9', DEEP = '#0b2a1f', OPTIC = '#c8f031';
const SURFACE = { hard: ['Hard court', '#2563eb'], clay: ['Clay court', '#c2410c'], grass: ['Grass court', '#15803d'], synthetic: ['Synthetic court', '#0f766e'], carpet: ['Carpet', '#7c3aed'], other: ['Court', '#475569'] };

function lum(hex) { const [r, g, b] = hexColor(hex); return 0.299 * r + 0.587 * g + 0.114 * b; }
function fmtDate(ms, tz) {
  if (!ms) return '';
  try { return new Intl.DateTimeFormat('en-IN', { timeZone: tz || 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)); }
  catch (e) { return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }
}
function fmtDuration(ms) { if (!ms || ms < 0) return '–'; const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; }
const dash = '–';
const v = (x) => (x == null ? dash : String(x));
const frac = (a, b, p) => (a == null || b == null ? dash : `${a}/${b}${p != null ? ` (${Math.round(p)}%)` : ''}`);
const pctOnly = (p) => (p == null ? dash : `${Math.round(p)}%`);

function build(input) {
  const { match, tournament, ledger, stats, photos, logo, version, generatedAt } = input;
  const tz = (tournament && tournament.timezone) || 'Asia/Kolkata';
  const st = ledger.state, ns = ledger.setup;
  const sides = { A: match.sides.A, B: match.sides.B };
  const col = { A: (sides.A && (sides.A.color || (sides.A.players[0] && sides.A.players[0].color))) || '#0f766e', B: (sides.B && (sides.B.color || (sides.B.players[0] && sides.B.players[0].color))) || '#b45309' };
  if (col.A === col.B) col.B = '#b45309';
  const doc = new PdfDoc({ ffmpegPath: input.ffmpegPath, info: { Title: `${sides.A.name} vs ${sides.B.name} — Tennis scorecard`, Subject: tournament ? tournament.name : 'Tennis', Author: 'AllSportsLive', Creator: 'AllSportsLive tennis' } });
  const img = { T: logo ? doc.loadImage(logo, { maxSide: 256 }) : null };
  Object.keys(photos || {}).forEach((id) => { if (photos[id]) img[id] = doc.loadImage(photos[id], { maxSide: 320 }); });
  const res = st.result || match.result || {};
  const winner = res.winner || null;
  let y = 0;

  function header(compact) {
    const h = compact ? 40 : 74;
    doc.rect(0, 0, A4.w, h, { fill: DEEP });
    doc.rect(0, h, A4.w, 3, { fill: OPTIC });
    doc.text('ALLSPORTSLIVE', M, compact ? 24 : 32, { size: compact ? 10 : 12, bold: true, color: '#ffffff', charSpace: 1.5 });
    doc.text('TENNIS  ·  MATCH SCORECARD', M, compact ? 34 : 50, { size: compact ? 7 : 8.5, color: OPTIC, charSpace: 1 });
    const right = A4.w - M;
    let tx = right;
    if (img.T && !compact) { doc.image(img.T, right - 46, 13, 46, 46); tx = right - 54; }
    doc.text(tournament ? tournament.name : '', M + 190, compact ? 26 : 38, { size: compact ? 9 : 12, bold: true, color: '#ffffff', align: 'right', width: tx - (M + 190), maxWidth: tx - (M + 190) });
    if (!compact) {
      const line = [match.eventName, match.stage && match.stage.round, match.court ? 'Court ' + String(match.court).replace(/^court\s*/i, '') : ''].filter(Boolean).join('  ·  ');
      if (line) doc.text(line, M + 190, 54, { size: 8.5, color: '#cbd5e1', align: 'right', width: tx - (M + 190), maxWidth: tx - (M + 190) });
    }
    y = h + 20;
  }
  function footer(pageNo) {
    doc.line(M, A4.h - 34, A4.w - M, A4.h - 34, { color: LINE });
    doc.text(`Generated ${fmtDate(generatedAt, tz)} · scorecard v${version} · from ${ledger.events.length} recorded events · allsportslive`, M, A4.h - 22, { size: 7, color: MUTED, maxWidth: W - 60 });
    doc.text('Page ' + pageNo, A4.w - M - 60, A4.h - 22, { size: 7, color: MUTED, align: 'right', width: 60 });
  }
  let page = 0;
  function newPage(compact) { doc.addPage(); page++; header(compact); footer(page); }
  function need(h) { if (y + h > BOTTOM) newPage(true); }
  function section(title) { need(40); doc.text(title.toUpperCase(), M, y, { size: 9, bold: true, color: DEEP, charSpace: 1.2 }); doc.rect(M, y + 5, 30, 2, { fill: OPTIC }); y += 18; }

  newPage(false);

  /* ---- the two sides ---- */
  const boxW = (W - 60) / 2, boxH = 108;
  ['A', 'B'].forEach((s, i) => {
    const x = M + i * (boxW + 60), side = sides[s];
    const won = winner === s;
    doc.rect(x, y, boxW, boxH, { fill: SOFT, radius: 10 });
    doc.rect(x, y, 5, boxH, { fill: col[s], radius: 2 });
    const players = side.players || [];
    // portraits: only those uploaded — never a stand-in picture
    let px = x + 16;
    players.forEach((p) => {
      const im = img[p.playerId];
      if (im) { doc.rect(px - 1, y + 13, 50, 50, { fill: '#ffffff', radius: 8 }); doc.image(im, px, y + 14, 48, 48); px += 56; }
    });
    const nx = px === x + 16 ? x + 16 : px + 4;
    const nameW = x + boxW - 12 - nx;
    doc.text(side.name, nx, y + 30, { size: players.length > 1 ? 12 : 15, bold: true, color: INK, maxWidth: nameW });
    const sub = players.map((p) => [p.seed ? `[${p.seed}]` : '', p.country, p.club].filter(Boolean).join(' ')).filter(Boolean).join(' · ');
    if (players.length > 1) doc.text(players.map((p) => p.name).join(' / '), nx, y + 46, { size: 8.5, color: MUTED, maxWidth: nameW });
    if (sub) doc.text(sub, nx, y + (players.length > 1 ? 60 : 48), { size: 8.5, color: MUTED, maxWidth: nameW });
    if (won) { doc.rect(x + 16, y + boxH - 30, 74, 18, { fill: DEEP, radius: 9 }); doc.text('WINNER', x + 16, y + boxH - 17.5, { size: 8, bold: true, color: OPTIC, align: 'center', width: 74, charSpace: 1.4 }); }
    doc.text(String(st.setsWon[s]), x + boxW - 48, y + boxH - 16, { size: 30, bold: true, color: won ? DEEP : MUTED, align: 'right', width: 36 });
  });
  doc.text('vs', M + boxW, y + boxH / 2 + 6, { size: 14, bold: true, color: MUTED, align: 'center', width: 60 });
  y += boxH + 18;

  /* ---- the result ---- */
  const line = E.scoreLine(res, winner || 'A');
  const reason = res.reason === 'retired' ? `${sides[res.by].name} retired${res.note ? ' (' + res.note + ')' : ''}` : res.reason === 'walkover' ? `Walkover — ${sides[res.by].name} did not play` : res.reason === 'default' ? `${sides[res.by].name} defaulted${res.note ? ' (' + res.note + ')' : ''}` : res.reason === 'abandoned' ? 'Match abandoned' + (res.note ? ' — ' + res.note : '') : '';
  doc.rect(M, y, W, 46, { fill: DEEP, radius: 10 });
  doc.text(winner ? `${sides[winner].name} won` : 'No result', M + 16, y + 19, { size: 10, bold: true, color: OPTIC, maxWidth: W / 2 });
  doc.text(line || dash, M + 16, y + 37, { size: 15, bold: true, color: '#ffffff', maxWidth: W - 32 });
  if (reason) doc.text(reason, M + W / 2, y + 19, { size: 8.5, color: '#cbd5e1', align: 'right', width: W / 2 - 16, maxWidth: W / 2 - 16 });
  y += 62;

  /* ---- match information ---- */
  const surf = SURFACE[match.surface] || SURFACE.other;
  const info = [
    ['Date', fmtDate(st.startedAt || match.scheduledAt, tz) || dash],
    ['Venue', [match.venue, match.court ? 'Court ' + String(match.court).replace(/^court\s*/i, '') : ''].filter(Boolean).join(' · ') || dash],
    ['Surface', surf[0]],
    ['Format', (match.format === 'doubles' ? 'Doubles' : 'Singles') + ' · ' + (match.rules && match.rules.label ? match.rules.label : E.normalizeRules(match.rules).label)],
    ['Duration', stats.duration ? fmtDuration(stats.duration.playingMs) + (stats.duration.totalMs - stats.duration.playingMs > 60000 ? ` (with stoppages ${fmtDuration(stats.duration.totalMs)})` : '') : dash],
    ['Umpire', (match.officials && match.officials.umpire) || dash]
  ];
  const colW = W / 2;
  info.forEach((r, i) => {
    const x = M + (i % 2) * colW, yy = y + Math.floor(i / 2) * 26;
    doc.text(r[0].toUpperCase(), x, yy, { size: 7, bold: true, color: MUTED, charSpace: 1 });
    doc.text(r[1], x, yy + 12, { size: 9.5, color: INK, maxWidth: colW - 12 });
  });
  doc.rect(M + colW, y + 18, 8, 8, { fill: surf[1], radius: 2 });
  y += Math.ceil(info.length / 2) * 26 + 10;

  /* ---- set by set ---- */
  section('Set by set');
  const sets = st.sets.filter((s) => s.winner || s.games.A + s.games.B > 0 || (s.tb && s.tb.A + s.tb.B > 0));
  const nameColW = 190, cell = Math.min(54, (W - nameColW - 60) / Math.max(1, sets.length));
  doc.rect(M, y - 10, W, 18, { fill: SOFT, radius: 4 });
  doc.text('PLAYER', M + 10, y + 2, { size: 7.5, bold: true, color: MUTED, charSpace: 1 });
  sets.forEach((s, i) => doc.text(s.rule.type === 'mtb' ? 'MTB' : 'SET ' + s.n, M + nameColW + i * cell, y + 2, { size: 7.5, bold: true, color: MUTED, align: 'center', width: cell }));
  doc.text('SETS', M + W - 60, y + 2, { size: 7.5, bold: true, color: MUTED, align: 'center', width: 60 });
  y += 14;
  ['A', 'B'].forEach((s) => {
    y += 22;
    doc.rect(M + 4, y - 11, 4, 14, { fill: col[s], radius: 2 });
    doc.text(sides[s].name, M + 14, y, { size: 10, bold: winner === s, color: INK, maxWidth: nameColW - 20 });
    sets.forEach((x, i) => {
      const won = x.winner === s;
      const g = x.rule.type === 'mtb' && x.tb ? x.tb[s] : x.games[s];
      doc.text(String(g), M + nameColW + i * cell, y, { size: 12, bold: won, color: won ? INK : MUTED, align: 'center', width: cell - (x.tb && x.rule.type !== 'mtb' && !won ? 12 : 0) });
      if (x.tb && x.rule.type !== 'mtb' && !won) doc.text(String(x.tb[s]), M + nameColW + i * cell + cell / 2 + 6, y - 5, { size: 7, color: MUTED });
    });
    doc.text(String(st.setsWon[s]), M + W - 60, y, { size: 13, bold: true, color: winner === s ? DEEP : MUTED, align: 'center', width: 60 });
    doc.line(M, y + 8, M + W, y + 8, { color: LINE });
  });
  y += 24;

  /* ---- statistics ---- */
  section(match.format === 'doubles' ? 'Team statistics' : 'Match statistics');
  const A = stats.sides.A, B = stats.sides.B;
  const rows = [
    ['Aces', v(A.serve.aces), v(B.serve.aces)],
    ['Double faults', v(A.serve.doubleFaults), v(B.serve.doubleFaults)],
    ...((A.serve.footFaults || B.serve.footFaults) ? [['Foot faults', v(A.serve.footFaults), v(B.serve.footFaults)]] : []),
    ['1st serve in', frac(A.serve.firstIn, A.serve.firstServes, A.serve.firstPct), frac(B.serve.firstIn, B.serve.firstServes, B.serve.firstPct)],
    ['1st serve points won', frac(A.serve.firstWon, A.serve.firstIn, A.serve.firstWonPct), frac(B.serve.firstWon, B.serve.firstIn, B.serve.firstWonPct)],
    ['2nd serve points won', frac(A.serve.secondWon, A.serve.secondPoints, A.serve.secondWonPct), frac(B.serve.secondWon, B.serve.secondPoints, B.serve.secondWonPct)],
    ['Service points won', frac(A.serve.won, A.serve.points, A.serve.wonPct), frac(B.serve.won, B.serve.points, B.serve.wonPct)],
    ['Break points saved', frac(A.serve.bpSaved, A.serve.bpFaced, A.serve.bpSavedPct), frac(B.serve.bpSaved, B.serve.bpFaced, B.serve.bpSavedPct)],
    ['Service games won', frac(A.serve.gamesWon, A.serve.games, A.serve.gamesWonPct), frac(B.serve.gamesWon, B.serve.games, B.serve.gamesWonPct)],
    ['Return points won', frac(A.ret.won, A.ret.points, A.ret.wonPct), frac(B.ret.won, B.ret.points, B.ret.wonPct)],
    ['Break points converted', frac(A.ret.bpConverted, A.ret.bpChances, A.ret.bpConvertedPct), frac(B.ret.bpConverted, B.ret.bpChances, B.ret.bpConvertedPct)],
    ['Winners', v(A.winners), v(B.winners)],
    ['Unforced errors', v(A.unforcedErrors), v(B.unforcedErrors)],
    ['Net points won', A.net ? frac(A.net.won, A.net.points, A.net.wonPct) : dash, B.net ? frac(B.net.won, B.net.points, B.net.wonPct) : dash],
    ['Tie-breaks won', A.tiebreaks.played ? `${A.tiebreaks.won}/${A.tiebreaks.played}` : dash, B.tiebreaks.played ? `${B.tiebreaks.won}/${B.tiebreaks.played}` : dash],
    ['Most points in a row', v(A.streak.points), v(B.streak.points)],
    ['Total points won', frac(A.pointsWon, A.pointsPlayed, A.pointsWonPct), frac(B.pointsWon, B.pointsPlayed, B.pointsWonPct)],
    ['Fastest serve', A.serve.fastestKmh ? A.serve.fastestKmh + ' km/h' : dash, B.serve.fastestKmh ? B.serve.fastestKmh + ' km/h' : dash]
  ];
  const sw = (W - 200) / 2;
  doc.rect(M, y - 10, W, 18, { fill: SOFT, radius: 4 });
  doc.text(sides.A.name.toUpperCase(), M + 10, y + 2, { size: 7.5, bold: true, color: col.A, maxWidth: sw - 10 });
  doc.text(sides.B.name.toUpperCase(), M + W - sw, y + 2, { size: 7.5, bold: true, color: col.B, align: 'right', width: sw - 10, maxWidth: sw - 10 });
  y += 10;
  rows.forEach((r) => {
    need(18);
    y += 17;
    doc.text(r[1], M + 10, y, { size: 10, bold: true, color: INK, maxWidth: sw - 10 });
    doc.text(r[0], M + sw, y, { size: 9, color: MUTED, align: 'center', width: 200 });
    doc.text(r[2], M + W - sw, y, { size: 10, bold: true, color: INK, align: 'right', width: sw - 10, maxWidth: sw - 10 });
    doc.line(M, y + 6, M + W, y + 6, { color: LINE, width: 0.4 });
  });
  y += 16;
  const notes = [];
  if (!stats.available.serve) notes.push('first / second serve figures were not tracked');
  if (!stats.available.outcomes) notes.push('winners and errors were not recorded');
  else if (stats.coverage.classified < stats.coverage.points) notes.push(`winners / errors from ${stats.coverage.classified} of ${stats.coverage.points} classified points`);
  if (!stats.available.net) notes.push('net points were not recorded');
  doc.paragraph('– = not recorded' + (notes.length ? ' (' + notes.join('; ') + ')' : '') + '. Every figure is counted from the points as recorded and corrected.', M, y, W, { size: 7.5, color: MUTED });
  y += 18;

  // doubles: per player
  if (match.format === 'doubles') {
    section('Players');
    const ps = [].concat(sides.A.players, sides.B.players);
    const cw = W / 6;
    const heads = ['Player', 'Aces', 'Double faults', 'Service games', 'Winners', 'Unforced errors'];
    heads.forEach((h, i) => doc.text(h.toUpperCase(), M + (i === 0 ? 0 : cw * (i + 0.5)), y, { size: 7, bold: true, color: MUTED, width: i === 0 ? cw * 1.5 : cw * 0.9, align: i === 0 ? 'left' : 'center' }));
    y += 6;
    ps.forEach((p) => {
      const x = stats.players[p.playerId];
      if (!x) return;
      need(16); y += 15;
      doc.text(p.name, M, y, { size: 9, bold: true, color: INK, maxWidth: cw * 1.5 - 6 });
      [v(x.serve.aces), v(x.serve.doubleFaults), x.serve.games ? `${x.serve.gamesWon}/${x.serve.games}` : dash, v(x.winners), v(x.unforcedErrors)].forEach((t, i) => doc.text(t, M + cw * (i + 1.5), y, { size: 9, color: INK, width: cw * 0.9, align: 'center' }));
    });
    y += 18;
  }

  /* ---- game by game ---- */
  section('Game by game');
  const games = stats.games;
  const bySet = {};
  games.forEach((g) => { (bySet[g.set] = bySet[g.set] || []).push(g); });
  Object.keys(bySet).forEach((sn) => {
    const list = bySet[sn];
    need(30);
    const set = st.sets.find((s) => String(s.n) === String(sn));
    doc.text((set && set.rule.type === 'mtb' ? 'Match tie-break' : 'Set ' + sn) + (set && set.winner ? ` — ${sides[set.winner].name} ${set.rule.type === 'mtb' && set.tb ? set.tb[set.winner] + '-' + set.tb[set.winner === 'A' ? 'B' : 'A'] : set.games[set.winner] + '-' + set.games[set.winner === 'A' ? 'B' : 'A']}` : ''), M, y, { size: 9, bold: true, color: INK });
    y += 6;
    list.forEach((g) => {
      need(14);
      y += 13;
      const server = ns.byId[g.server] ? ns.byId[g.server].player.name : '';
      const tag = g.tiebreak ? (g.mtb ? 'MTB' : 'TB') : 'G' + g.n;
      doc.text(tag, M, y, { size: 8, bold: true, color: MUTED });
      doc.text(g.tiebreak ? 'Tie-break' : server + ' serving', M + 30, y, { size: 8, color: INK, maxWidth: 150 });
      const seq = g.points.map((p) => (p.w === g.serverSide ? '•' : '◦')).join('');
      doc.text(g.points.length + ' pts', M + 186, y, { size: 7.5, color: MUTED });
      doc.text(seq.replace(/◦/g, 'o'), M + 222, y, { size: 7, color: MUTED, maxWidth: 190 });
      const res2 = g.winner ? (g.tiebreak ? `${sides[g.winner].name} wins it` : (g.break ? 'BREAK — ' : 'Hold — ') + sides[g.winner].name) : 'unfinished';
      doc.text(res2, M + 418, y, { size: 8, bold: !!g.break, color: g.break ? '#b91c1c' : INK, maxWidth: 100 });
      if (g.games) doc.text(`${g.games.A}-${g.games.B}`, M + W - 26, y, { size: 8.5, bold: true, color: INK, align: 'right', width: 26 });
    });
    y += 12;
  });
  doc.text('• point won by the server   o point won by the receiver', M, y, { size: 7, color: MUTED });
  y += 16;

  /* ---- point by point ---- */
  section('Point by point');
  const lines = ledger.timeline.filter((e) => !e.voided && !e.invalid && !E.META[e.type]).map((e) => {
    const c = E.commentary(ns, e);
    if (!c) return null;
    const snap = e.before || {};
    return { tag: snap.set ? `S${snap.set}${e.type === 'POINT' ? ' G' + snap.game : ''}` : '', text: c.text, tone: c.tone };
  }).filter(Boolean);
  const colGap = 16, cw2 = (W - colGap) / 2;
  let colIdx = 0, colTop = y, colY = y;
  lines.forEach((l) => {
    if (colY + 11 > BOTTOM) {
      if (colIdx === 0) { colIdx = 1; colY = colTop; }
      else { newPage(true); colIdx = 0; colTop = y; colY = y; }
    }
    const x = M + colIdx * (cw2 + colGap);
    const strong = l.tone === 'match' || l.tone === 'set' || l.tone === 'break';
    doc.text(l.tag, x, colY, { size: 6.5, color: MUTED });
    doc.text(l.text, x + 34, colY, { size: 7, bold: strong, color: l.tone === 'break' ? '#b91c1c' : INK, maxWidth: cw2 - 36 });
    colY += 10;
  });
  return doc.output();
}

module.exports = { build };
