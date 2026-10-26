/* ================================================================
   📑 VOLLEYBALL MATCH REPORT — the PDF made when a match is complete.

   Built only from what was saved: the match record (teams, squads, rules,
   toss), the replayed event ledger (sets, line-ups, substitutions,
   time-outs, every point) and the statistics derived from it. Nothing is
   estimated: a figure the operator never recorded is simply not there.
   Long tables run onto further pages with their headings repeated; every
   column is measured, and text that would not fit is cut with "…".
   ================================================================ */
'use strict';
const { PdfDoc, A4, hexColor } = require('./volleyball-pdf.js');
const E = require('./volleyball-engine.js');

const M = 36;                       // page margin
const W = A4.w - 2 * M;             // content width
const BOTTOM = A4.h - 46;           // last usable y before the footer
const INK = '#0f172a', MUTED = '#64748b', LINE = '#e2e8f0', SOFT = '#f1f5f9', NAVY = '#0b1736';

function lum(hex) { const [r, g, b] = hexColor(hex); return 0.299 * r + 0.587 * g + 0.114 * b; }
function onColor(hex) { return lum(hex) > 0.62 ? '#111827' : '#ffffff'; }
function teamColor(t, fallback) { return (t && t.colors && t.colors.primary) || fallback; }
function fmtDate(ms, tz) {
  if (!ms) return '';
  try { return new Intl.DateTimeFormat('en-IN', { timeZone: tz || 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)); }
  catch (e) { return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }
}
function fmtMinutes(ms) { if (!ms || ms < 0) return '–'; if (ms < 60000) return '< 1 min'; const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; }
function pct(v) { return v == null ? '–' : Math.round(v * 100) + '%'; }
function n2(v) { return Math.round(v * 100) % 100 ? (Math.round(v * 10) / 10).toString() : String(Math.round(v)); }

function build(input) {
  const { match, tournament, ledger, stats, logos, version, generatedAt } = input;
  const tz = (tournament && tournament.timezone) || 'Asia/Kolkata';
  const state = ledger.state;
  const ns = ledger.setup;
  const teams = { A: match.teamA, B: match.teamB };
  const colA = teamColor(teams.A, '#1d4ed8'), colB = teamColor(teams.B, '#ea580c');
  const col = { A: colA, B: colB };
  const doc = new PdfDoc({ ffmpegPath: input.ffmpegPath, info: { Title: `${teams.A.name} vs ${teams.B.name} — Match report`, Subject: tournament ? tournament.name : 'Volleyball', Author: 'AllSportsLive' } });
  const img = {
    A: logos && logos.A ? doc.loadImage(logos.A, { maxSide: 256 }) : null,
    B: logos && logos.B ? doc.loadImage(logos.B, { maxSide: 256 }) : null,
    T: logos && logos.tournament ? doc.loadImage(logos.tournament, { maxSide: 256 }) : null
  };
  let y = 0;

  function header(compact) {
    doc.rect(0, 0, A4.w, compact ? 40 : 70, { fill: NAVY });
    doc.rect(0, compact ? 40 : 70, A4.w / 2, 3, { fill: colA });
    doc.rect(A4.w / 2, compact ? 40 : 70, A4.w / 2, 3, { fill: colB });
    doc.text('ALLSPORTSLIVE', M, compact ? 24 : 32, { size: compact ? 10 : 12, bold: true, color: '#ffffff', charSpace: 1.5 });
    doc.text('VOLLEYBALL  ·  MATCH REPORT', M, compact ? 34 : 50, { size: compact ? 7 : 8.5, color: '#93c5fd', charSpace: 1 });
    const tname = tournament ? tournament.name : '';
    const right = A4.w - M;
    let tx = right;
    if (img.T && !compact) { doc.image(img.T, right - 44, 13, 44, 44); tx = right - 52; }
    doc.text(tname, M + 170, compact ? 26 : 38, { size: compact ? 9 : 12, bold: true, color: '#ffffff', align: 'right', width: tx - (M + 170), maxWidth: tx - (M + 170) });
    if (!compact && (match.stage && (match.stage.round || match.stage.group))) {
      const st = [match.stage.group ? 'Group ' + match.stage.group : '', match.stage.round || ''].filter(Boolean).join(' · ');
      doc.text(st, M + 170, 54, { size: 8.5, color: '#cbd5e1', align: 'right', width: tx - (M + 170), maxWidth: tx - (M + 170) });
    }
    y = compact ? 58 : 92;
  }
  function newPage() { doc.addPage(); header(true); }
  function ensure(h) { if (y + h > BOTTOM) newPage(); }
  function sectionTitle(t) {
    ensure(34);
    doc.text(t.toUpperCase(), M, y + 12, { size: 8.5, bold: true, color: MUTED, charSpace: 1.2 });
    doc.line(M, y + 17, M + W, y + 17, { color: LINE, width: 0.8 });
    y += 26;
  }
  function badge(side, x, yy, size) {
    const c = col[side];
    if (img[side]) {
      doc.rect(x, yy, size, size, { fill: '#ffffff', stroke: LINE, radius: 10 });
      doc.image(img[side], x + 6, yy + 6, size - 12, size - 12);
    } else {
      doc.circle(x + size / 2, yy + size / 2, size / 2, { fill: c });
      const ini = (teams[side].shortName || teams[side].name || side).slice(0, 3).toUpperCase();
      doc.text(ini, x, yy + size / 2 + size * 0.12, { size: size * 0.3, bold: true, color: onColor(c), align: 'center', width: size });
    }
  }

  /* ------------------------------ page 1: the result */
  doc.addPage();
  header(false);
  const result = state.result || null;
  const sets = state.setsWon;
  const heroH = 150;
  doc.rect(M, y, W, heroH, { fill: '#ffffff', stroke: LINE, radius: 12 });
  doc.rect(M, y, 6, heroH, { fill: colA, radius: 3 });
  doc.rect(M + W - 6, y, 6, heroH, { fill: colB, radius: 3 });
  const bsz = 70, colW = (W - 160) / 2;
  badge('A', M + colW / 2 - bsz / 2 + 6, y + 18, bsz);
  badge('B', M + W - colW / 2 - bsz / 2 - 6, y + 18, bsz);
  doc.text(teams.A.name, M + 10, y + 112, { size: 13, bold: true, color: INK, align: 'center', width: colW, maxWidth: colW - 8 });
  doc.text(teams.B.name, M + W - colW - 10, y + 112, { size: 13, bold: true, color: INK, align: 'center', width: colW, maxWidth: colW - 8 });
  const winner = state.winner;
  const statusLine = state.status === 'abandoned' ? 'ABANDONED' : state.forfeit ? 'FORFEIT' : state.status === 'completed' ? 'FINAL' : 'IN PROGRESS';
  doc.text(`${sets.A}  –  ${sets.B}`, M + colW, y + 72, { size: 40, bold: true, color: INK, align: 'center', width: 160 });
  doc.text(statusLine, M + colW, y + 92, { size: 9, bold: true, color: MUTED, align: 'center', width: 160, charSpace: 2 });
  if (winner) {
    const wl = `${teams[winner].name} won ${Math.max(sets.A, sets.B)}-${Math.min(sets.A, sets.B)}${state.forfeit ? ' (forfeit)' : ''}`;
    doc.text(wl, M + colW - 30, y + 132, { size: 9.5, bold: true, color: col[winner] === '#ffffff' ? INK : col[winner], align: 'center', width: 220, maxWidth: 220 });
  }
  doc.text(teams.A.shortName || '', M + 10, y + 128, { size: 8, color: MUTED, align: 'center', width: colW });
  doc.text(teams.B.shortName || '', M + W - colW - 10, y + 128, { size: 8, color: MUTED, align: 'center', width: colW });
  y += heroH + 10;
  // set chips
  const played = state.sets.filter((s) => s.status === 'completed');
  if (played.length) {
    const chipW = Math.min(92, (W - (played.length - 1) * 8) / played.length);
    let cx = M + (W - (chipW * played.length + 8 * (played.length - 1))) / 2;
    played.forEach((s) => {
      const wc = col[s.winner];
      doc.rect(cx, y, chipW, 30, { fill: SOFT, radius: 8 });
      doc.rect(cx, y + 27, chipW, 3, { fill: wc });
      doc.text(`SET ${s.number}${s.deciding ? ' · DECIDER' : ''}`, cx, y + 11, { size: 6.5, bold: true, color: MUTED, align: 'center', width: chipW, charSpace: 0.6 });
      doc.text(`${s.points.A} – ${s.points.B}`, cx, y + 23, { size: 11, bold: true, color: INK, align: 'center', width: chipW });
      cx += chipW + 8;
    });
    y += 42;
  }

  // match details
  sectionTitle('Match details');
  const rules = state.rules;
  const fmt = `Best of ${rules.bestOf} · sets to ${rules.setPoints}${rules.bestOf >= 3 ? `, deciding set to ${rules.decidingSetPoints}` : ''} · win by ${rules.winBy}${rules.pointCap ? ` · cap ${rules.pointCap}` : ''}`;
  const toss = state.tosses[1];
  const tossText = (tt) => !tt ? 'Not recorded'
    : `${teams[tt.winner].name} won the toss and chose ${tt.choice === 'court' ? 'the side of the court' : 'to ' + tt.choice}${tt.choice === 'serve' ? '' : `; ${teams[tt.firstServe].name} served first`}`;
  const setDur = played.reduce((a, s) => a + (s.endedAt && s.startedAt ? s.endedAt - s.startedAt : 0), 0);
  const details = [
    ['Tournament', tournament ? tournament.name : '–'],
    ['Stage', [match.stage && match.stage.group ? 'Group ' + match.stage.group : '', match.stage && match.stage.round, match.matchNo ? 'Match ' + match.matchNo : ''].filter(Boolean).join(' · ') || '–'],
    ['Date', fmtDate(match.startedAt || match.scheduledAt, tz) || '–'],
    ['Venue', match.venue || (tournament && tournament.venue) || '–'],
    ['Format', fmt + (rules.official ? ' (FIVB)' : ' (competition rules)')],
    ['Toss', tossText(toss)],
    ...(state.tosses[rules.bestOf] && rules.bestOf > 1 ? [['Deciding-set toss', tossText(state.tosses[rules.bestOf])]] : []),
    ['Playing time', fmtMinutes(setDur)],
    ['Result', winner ? `${teams[winner].name} ${Math.max(sets.A, sets.B)}-${Math.min(sets.A, sets.B)}` : (state.status === 'abandoned' ? 'Abandoned' + (state.abandoned && state.abandoned.reason ? ' — ' + state.abandoned.reason : '') : 'No result')]
  ];
  details.forEach(([k, v]) => {
    ensure(15);
    doc.text(k, M, y + 9, { size: 8.5, bold: true, color: MUTED });
    y = doc.paragraph(v, M + 110, y + 9, W - 110, { size: 9, color: INK, lineHeight: 12 }) - 9 + 4;
  });
  y += 6;

  // set by set
  sectionTitle('Set by set');
  const setCols = [['Set', 44], [teams.A.shortName || 'A', 54], [teams.B.shortName || 'B', 54], ['Winner', 150], ['Duration', 70], ['Time-outs', 66], ['Subs', 85]];
  table(setCols, played.map((s) => [
    String(s.number) + (s.deciding ? ' (D)' : ''), String(s.points.A), String(s.points.B),
    s.winner ? teams[s.winner].name : '–', s.forfeit ? 'forfeit' : fmtMinutes(s.endedAt && s.startedAt ? s.endedAt - s.startedAt : 0),
    `${s.timeouts.A.length} / ${s.timeouts.B.length}`, `${s.subCount.A} / ${s.subCount.B}`
  ]), { alignNum: [1, 2, 5, 6] });

  // team comparison — kept on one page
  ensure(26 + 14 * 17 + 24);
  sectionTitle('Team statistics');
  const tA = stats.teams.A, tB = stats.teams.B;
  const rows = [
    ['Points won', tA.points, tB.points],
    ['Attack kills', tA.attack.kills, tB.attack.kills],
    ['Block points', tA.blockPoints, tB.blockPoints],
    ['Service aces', tA.serve.aces, tB.serve.aces],
    ['Points from opponent errors', tA.byCategory.opponentError, tB.byCategory.opponentError],
    ['Penalty points', tA.byCategory.penalty, tB.byCategory.penalty],
    ['Service errors', tA.serve.errors, tB.serve.errors],
    ['Attack efficiency (named attackers)', tA.attack.efficiency, tB.attack.efficiency, 'pct'],
    ['Side-out points', tA.sideOutPoints, tB.sideOutPoints],
    ['Break points (on serve)', tA.breakPoints, tB.breakPoints],
    ['Longest run', tA.longestRun, tB.longestRun],
    ['Time-outs', tA.timeouts, tB.timeouts],
    ['Substitutions', tA.substitutions, tB.substitutions],
    ['Libero replacements', tA.liberoReplacements, tB.liberoReplacements]
  ];
  rows.forEach(([label, a, b, kind]) => {
    ensure(17);
    const va = kind === 'pct' ? pct(a) : n2(a || 0), vb = kind === 'pct' ? pct(b) : n2(b || 0);
    const na = kind === 'pct' ? Math.max(0, a || 0) : (a || 0), nb = kind === 'pct' ? Math.max(0, b || 0) : (b || 0);
    const tot = na + nb || 1, barW = 150;
    doc.text(label, M + W / 2 - 90, y + 10, { size: 8.5, color: INK, align: 'center', width: 180, maxWidth: 176 });
    doc.rect(M + 40, y + 4, barW, 7, { fill: SOFT, radius: 3 });
    doc.rect(M + 40 + barW * (1 - na / tot), y + 4, barW * na / tot, 7, { fill: colA, radius: 3 });
    doc.rect(M + W - 40 - barW, y + 4, barW, 7, { fill: SOFT, radius: 3 });
    doc.rect(M + W - 40 - barW, y + 4, barW * nb / tot, 7, { fill: colB, radius: 3 });
    doc.text(va, M, y + 11, { size: 9, bold: true, color: INK, align: 'right', width: 34 });
    doc.text(vb, M + W - 34, y + 11, { size: 9, bold: true, color: INK, width: 34 });
    y += 17;
  });
  y += 4;
  doc.text('Bars compare the two teams. Statistics come from the recorded event log; a point is credited to a player only when the scorer recorded who made it.', M, y + 8, { size: 7, color: MUTED, maxWidth: W });
  y += 16;

  /* ------------------------------ players */
  ['A', 'B'].forEach((side) => {
    ensure(120);
    sectionTitle(`${teams[side].name} — players`);
    const cols = [['#', 22], ['Player', 128], ['Role', 30], ['Sets', 28], ['Pts', 30], ['K', 24], ['AE', 24], ['Att', 26], ['Eff', 30], ['Ace', 26], ['SE', 24], ['BS', 22], ['BA', 22], ['Ast', 24], ['Dig', 24], ['RE', 25]];
    const list = Object.values(stats.players).filter((p) => p.team === side)
      .sort((a, b) => (b.setsPlayed > 0) - (a.setsPlayed > 0) || b.points - a.points || (Number(a.number) || 99) - (Number(b.number) || 99));
    table(cols, list.map((p) => [
      p.number || '', p.name + (p.captain ? ' (C)' : '') + (p.libero ? ' (L)' : ''), p.role || '', String(p.setsPlayed),
      n2(p.points), String(p.attack.kills), String(p.attack.errors), String(p.attack.attempts), pct(p.attack.efficiency),
      String(p.serve.aces), String(p.serve.errors), String(p.block.solo), String(p.block.assists), String(p.assists), String(p.digs), String(p.reception.errors)
    ]), { accent: col[side], alignNum: [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], dim: list.map((p) => p.setsPlayed === 0) });
    y += 2;
  });
  ensure(30);
  doc.paragraph('Pts = kills + aces + block points (a solo block is 1, each player in an n-player block gets 1/n). K kills · AE attack errors (incl. blocked) · Att attack attempts · Eff (kills − errors) ÷ attempts · SE service errors · BS solo blocks · BA block assists · Ast assists · Dig digs · RE reception errors · (C) captain · (L) libero. Greyed: in the squad, did not play.', M, y + 6, W, { size: 7, color: MUTED, lineHeight: 9.5 });
  y += 30;

  /* ------------------------------ line-ups, substitutions, key moments */
  sectionTitle('Line-ups and substitutions');
  const nm = (side, id) => { const p = ns.teams[side].byId[id]; return p ? `#${p.number} ${p.name}` : String(id || '?'); };
  state.sets.forEach((s) => {
    if (!s.lineup) return;
    ensure(64);
    doc.text(`Set ${s.number}${s.deciding ? ' (deciding set)' : ''} — ${s.points.A}-${s.points.B}${s.firstServe ? ` · ${teams[s.firstServe].name} served first` : ''}${s.sideSwitchAt ? ` · courts changed at ${s.sideSwitchAt.A}-${s.sideSwitchAt.B}` : ''}`, M, y + 10, { size: 9, bold: true, color: INK, maxWidth: W });
    y += 15;
    ['A', 'B'].forEach((side) => {
      const six = s.lineup[side].map((id, i) => `${E.POSITION_NAMES[i]} ${nm(side, id)}`).join('   ');
      ensure(13);
      doc.rect(M, y + 2, 4, 9, { fill: col[side] });
      doc.text(six, M + 10, y + 10, { size: 7.8, color: INK, maxWidth: W - 10 });
      y += 12;
      s.subs[side].forEach((sub) => {
        const txt = sub.pairs.map((p) => `${nm(side, p.in)} in for ${nm(side, p.out)}`).join(', ');
        ensure(11);
        doc.text(`${sub.exceptional ? 'Exceptional sub' : 'Sub'} at ${sub.score.A}-${sub.score.B}: ${txt}`, M + 18, y + 9, { size: 7.4, color: MUTED, maxWidth: W - 18 });
        y += 10;
      });
      const to = s.timeouts[side].map((x) => `${x.score.A}-${x.score.B}`).join(', ');
      if (to || s.liberoReplacements[side]) {
        ensure(11);
        doc.text(`${to ? 'Time-outs at ' + to : ''}${to && s.liberoReplacements[side] ? ' · ' : ''}${s.liberoReplacements[side] ? s.liberoReplacements[side] + ' libero replacement(s)' : ''}`, M + 18, y + 9, { size: 7.4, color: MUTED, maxWidth: W - 18 });
        y += 10;
      }
    });
    y += 6;
  });
  const libs = ['A', 'B'].map((side) => ns.teams[side].liberos.map((id) => nm(side, id)).join(', ')).map((v, i) => v ? `${teams[i ? 'B' : 'A'].name}: ${v}` : '').filter(Boolean);
  if (libs.length) { ensure(14); doc.text('Liberos — ' + libs.join('   ·   '), M, y + 9, { size: 8, color: INK, maxWidth: W }); y += 16; }

  /* ------------------------------ point flow */
  sectionTitle('Point by point');
  const rallyEntries = ledger.timeline.filter((e) => (e.type === 'RALLY' || (e.type === 'SANCTION' && e.effects && e.effects.some((x) => x.type === 'SET_WON' || x.type === 'SIDE_OUT'))) && !e.voided && !e.invalid);
  state.sets.forEach((s) => {
    const pts = rallyEntries.filter((e) => e.after && e.after.set === s.number && e.type === 'RALLY');
    if (!pts.length) return;
    const cell = Math.min(9.5, (W - 70) / Math.max(25, pts.length));
    ensure(36);
    doc.text(`Set ${s.number}`, M, y + 12, { size: 8.5, bold: true, color: INK });
    doc.text(`${s.points.A}-${s.points.B}`, M, y + 24, { size: 8, color: MUTED });
    pts.forEach((e, i) => {
      const x = M + 56 + i * cell;
      const rowY = e.team === 'A' ? y + 4 : y + 16;
      doc.rect(x, rowY, cell - 1.2, 10, { fill: col[e.team], radius: 1.5, opacity: e.outcome === 'GENERAL' ? 0.55 : 1 });
      if ((i + 1) % 5 === 0) doc.text(String(i + 1), x - 4, y + 34, { size: 5.5, color: MUTED, align: 'center', width: cell + 8 });
    });
    y += 40;
  });
  ensure(14);
  doc.text(`Top row: ${teams.A.name} · bottom row: ${teams.B.name} · paler squares are points the scorer did not classify.`, M, y + 8, { size: 7, color: MUTED, maxWidth: W });
  y += 14;

  /* ------------------------------ footers */
  const total = doc.pages.length;
  doc.pages.forEach((p, i) => {
    doc.cur = p;
    doc.line(M, A4.h - 32, M + W, A4.h - 32, { color: LINE, width: 0.6 });
    doc.text(`AllSportsLive · ${teams.A.name} vs ${teams.B.name} · generated ${fmtDate(generatedAt || Date.now(), tz)} · report v${version || 1}`, M, A4.h - 20, { size: 7, color: MUTED, maxWidth: W - 70 });
    doc.text(`Page ${i + 1} of ${total}`, M + W - 70, A4.h - 20, { size: 7, color: MUTED, align: 'right', width: 70 });
  });
  return doc.output();

  // A table that never overflows its columns and repeats its header on a new page.
  function table(cols, data, opt) {
    opt = opt || {};
    const rowH = 15, total = cols.reduce((a, c) => a + c[1], 0), scale = W / total;
    const xs = [];
    let x = M;
    cols.forEach((c) => { xs.push(x); x += c[1] * scale; });
    const head = () => {
      doc.rect(M, y, W, rowH + 1, { fill: opt.accent || NAVY, radius: 3 });
      cols.forEach((c, i) => {
        const w = c[1] * scale;
        const num = opt.alignNum && opt.alignNum.indexOf(i) >= 0;
        doc.text(c[0], xs[i] + 3, y + 10.5, { size: 7.5, bold: true, color: onColor(opt.accent || NAVY), align: num ? 'center' : 'left', width: w - 6, maxWidth: w - 6 });
      });
      y += rowH + 2;
    };
    ensure(rowH * 2 + 4);
    head();
    if (!data.length) { doc.text('—', M + 4, y + 10, { size: 8, color: MUTED }); y += rowH; return; }
    data.forEach((r, ri) => {
      if (y + rowH > BOTTOM) { newPage(); head(); }
      if (ri % 2 === 0) doc.rect(M, y, W, rowH, { fill: SOFT });
      const dim = opt.dim && opt.dim[ri];
      r.forEach((v, i) => {
        const w = cols[i][1] * scale;
        const num = opt.alignNum && opt.alignNum.indexOf(i) >= 0;
        doc.text(String(v == null ? '' : v), xs[i] + 3, y + 10.3, { size: 8, color: dim ? '#94a3b8' : INK, bold: i === 1 && !dim && cols.length > 8, align: num ? 'center' : 'left', width: w - 6, maxWidth: w - 6 });
      });
      y += rowH;
    });
    y += 8;
  }
}

module.exports = { build };
