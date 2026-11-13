// ================================================================
// 🎾 TENNIS CLIPPER — where one point's clip lives on this PC.
//
// A point is filed by what it is — match → set → game → point — in the
// Tennis Clipper's OWN clips folder (TennisClips, beside the vMix
// recording unless setup says otherwise; never the Cricket Clipper's
// Clips folder, never the Volleyball Clipper's VolleyballClips):
//
//   <recording folder>/TennisClips/
//     [<Tournament>/]<Match>/
//        Set-1/Game-05/S1-G05-P031_2-2_40-15_Alcaraz_Ace.mp4   ← the one physical clip
//        Set-1/Moments/S1-G05_Celebration_<id>.mp4              ← a clip pressed by hand
//        Players/<Side>/<Player>/Set-1/…                         ← hard links, + player.json
//        metadata/<clipId>.json                                  ← the point, with the real ids
//
//  1. NO INTERNET. Everything here comes from the point the panel sent
//     with the press (and the corrections it sent afterwards).
//  2. ONE PHYSICAL CLIP. ffmpeg ran once; the players' folders get hard
//     links to the same bytes (a copy only where the disk refuses links).
//
// A folder name is for a person browsing; the player's real id is in
// player.json and metadata/<clipId>.json, never taken from the name.
//
// The folder helpers below are this file's own copies (the Volleyball
// Clipper's vb-organizer.js rules, themselves the Cricket Clipper's, when
// copied) — nothing here requires another sport's file, so no clipper can
// change another.
// ================================================================
const fs = require('fs');
const path = require('path');

// Windows device names can't be used as folder names, whatever the extension.
const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']);

// "Shivam Dubé" → "Shivam-Dube", "O'Brien" → "OBrien", "A/B <x>" → "A-B-x".
// Recognisable to a human, safe on Windows/macOS/Linux, and never empty.
function sanitizeSegment(value, fallback = 'Unknown') {
  let s = String(value == null ? '' : value);
  try { s = s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (_) { /* very old runtime */ }
  s = s
    .replace(/['"`]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.\s]+$/g, '');
  if (s.length > 60) s = s.slice(0, 60).replace(/-+$/, '');
  if (!s) return fallback;
  if (RESERVED.has(s.toUpperCase())) return `${s}-x`;
  return s;
}

// A tournament level only when the match belongs to one; the match's own
// id in its folder name, so two matches in the same folder never mix.
function matchFolderSegments(meta) {
  const segs = [];
  const tournament = meta && (meta.tournamentName || meta.tournamentId);
  if (tournament) segs.push(sanitizeSegment(tournament, 'Tournament'));
  const label = meta && meta.matchLabel ? sanitizeSegment(meta.matchLabel, '') : '';
  const id = sanitizeSegment((meta && (meta.matchId || meta.tournamentMatchId)) || 'match', 'match');
  segs.push(label ? `${label}_${id}` : `Match-${id}`);
  return segs;
}
function matchRootFor(clipsRoot, meta) {
  return path.join(clipsRoot, ...matchFolderSegments(meta));
}

// Same bytes, two names (a copy only where the disk refuses a hard link).
async function linkOrCopy(src, dest) {
  try {
    const [a, b] = await Promise.all([fs.promises.stat(src), fs.promises.stat(dest).catch(() => null)]);
    if (b && b.ino && a.ino === b.ino && b.dev === a.dev) return { path: dest, mode: 'link', existing: true };
    if (b) await fs.promises.unlink(dest).catch(() => {});
  } catch (_) { /* src missing is reported by the link/copy below */ }
  try {
    await fs.promises.link(src, dest);
    return { path: dest, mode: 'link' };
  } catch (err) {
    if (err && err.code === 'EEXIST') return { path: dest, mode: 'link', existing: true };
    try {
      await fs.promises.copyFile(src, dest);
      return { path: dest, mode: 'copy' };
    } catch (err2) {
      return { path: dest, mode: 'failed', error: err2.message };
    }
  }
}

// The point, on disk next to its clip — the local answer to "which point,
// which players, which ids" even if the laptop never goes online again.
async function writeClipMetadata(matchRoot, record) {
  try {
    const dir = path.join(matchRoot, 'metadata');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, `${record.clipId}.json`), JSON.stringify(record, null, 2));
  } catch (_) { /* the persistent queue is the real record — this is a convenience */ }
}

// What the point was, as a word for a filename (the website's clip kinds).
const TYPE_WORD = {
  ACE: 'Ace', WINNER: 'Winner', LONG_RALLY: 'Long-Rally', BREAK_POINT: 'Break-Point', MATCH_POINT: 'Match-Point', SET_POINT: 'Set-Point',
  DOUBLE_FAULT: 'Double-Fault', RETURN: 'Return-Winner', NET_POINT: 'Net-Point', CELEBRATION: 'Celebration', POINT: '', MANUAL: 'Clip',
};

const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
const pad = (v, n) => String(int(v) || 0).padStart(n, '0');

async function ensurePointTree(clipsRoot, meta) {
  const root = matchRootFor(clipsRoot, meta);
  for (const d of [path.join(root, 'Players'), path.join(root, 'metadata')]) await fs.promises.mkdir(d, { recursive: true });
  return root;
}

// The score of a game as tennis says it: 15-30, 40-40, AD-40 (a tie-break: 5-4).
function pointWords(points, tiebreak) {
  const a = int(points && points.A) || 0, b = int(points && points.B) || 0;
  if (tiebreak) return `${a}-${b}`;
  const W = ['0', '15', '30', '40'];
  if (a >= 3 && b >= 3) return a === b ? '40-40' : a > b ? 'AD-40' : '40-AD';
  return `${W[Math.min(a, 3)]}-${W[Math.min(b, 3)]}`;
}

// The side's name for a file: the player's surname (singles) or the pair's ("Bopanna-Ebden").
function sideWord(p) {
  const name = p.sideName || (p.sides && p.side && p.sides[p.side]) || p.side || '';
  const words = String(name).split(/\s*\/\s*|\s+&\s+/).map((n) => n.trim().split(/\s+/).pop()).filter(Boolean);
  return sanitizeSegment(words.join('-') || 'Side', 'Side');
}

// "S1-G05-P031_2-2_40-15_Alcaraz_Ace.mp4" — set, game, point, the games and
// the points after it (side A first), who won it and what it was. A clip
// pressed by hand: "S1-G05_Celebration_<id>.mp4" (its moment, no point).
function pointFileName(p, clipId) {
  p = p || {};
  const set = int(p.set) || 0;
  const how = TYPE_WORD[p.kind] ? `_${TYPE_WORD[p.kind]}` : '';
  if (!p.eventId) {
    const tail = sanitizeSegment(String(clipId || '').split('_clip-').pop() || 'clip', 'clip').slice(0, 16);
    const who = p.players && p.players[0] && p.players[0].name ? `_${sanitizeSegment(p.players[0].name, '')}` : '';
    return `S${set}-G${pad(p.game, 2)}${how || '_Clip'}${who}_${tail}.mp4`.replace(/_+/g, '_');
  }
  const sc = p.score || {};
  const games = sc.games ? `${int(sc.games.A) || 0}-${int(sc.games.B) || 0}` : 'x-x';
  const pts = sc.points ? pointWords(sc.points, sc.tiebreak) : 'x-x';
  return `S${set}-G${pad(p.game, 2)}-P${pad(p.pointNo, 3)}_${games}_${pts}_${sideWord(p)}${how}.mp4`.replace(/_+\.mp4$/, '.mp4');
}

function playerFolder(p) {
  return sanitizeSegment(p.name || p.playerId || 'Player', 'Player');
}

async function writePlayerCard(dir, p) {
  const file = path.join(dir, 'player.json');
  try {
    const card = { name: p.name || null, playerId: p.playerId || null, side: p.side || null, sideName: p.sideName || null };
    let prior = null;
    try { prior = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch (_) { /* first clip for this player */ }
    if (prior && prior.playerId === card.playerId && prior.name === card.name) return;
    await fs.promises.writeFile(file, JSON.stringify(Object.assign(card, { folder: path.basename(dir), updatedAt: Date.now() }), null, 2));
  } catch (_) { /* a browsing aid — never fail a clip over it */ }
}

async function sameFile(a, b) {
  try {
    const [x, y] = await Promise.all([fs.promises.stat(a), fs.promises.stat(b)]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch (_) { return false; }
}

// The players a clip is filed under: those who earned or made the point —
// never the one whose error gave it away (a double fault is not a highlight
// of the server's); a clip pressed by hand: the player the operator chose.
// (once each — an ace's server is both its ace and its winner)
function creditedPlayers(p) {
  const seen = new Set();
  return (p.players || []).filter((x) => x && x.playerId && x.role !== 'error' && !seen.has(x.playerId) && seen.add(x.playerId)).slice(0, 4);
}

// Moves the cut clip to Set-N/Game-M/ under its point name (a hand-pressed
// clip to Set-N/Moments/) and links it into the credited players' folders.
// Re-run when a correction arrives (what kind of point, who won it, the
// point undone): the same single file is renamed and re-linked, links that
// no longer apply are removed — never a second cut, never the network.
// → { primary, filename, links, matchRoot, category }
async function placePointClip({ clipsRoot, currentPath, meta, previous, clipId }) {
  const matchRoot = await ensurePointTree(clipsRoot, meta);
  const p = meta.point || {};
  const setName = `Set-${int(p.set) || 0}`;
  const dir = p.eventId ? path.join(matchRoot, setName, `Game-${pad(p.game, 2)}`) : path.join(matchRoot, setName, 'Moments');
  await fs.promises.mkdir(dir, { recursive: true });
  const filename = pointFileName(p, clipId);
  const primary = path.join(dir, filename);

  if (path.resolve(currentPath) !== path.resolve(primary) && !(await sameFile(currentPath, primary))) {
    try {
      await fs.promises.rename(currentPath, primary);
    } catch (err) {
      await fs.promises.copyFile(currentPath, primary);
      await fs.promises.unlink(currentPath).catch(() => {});
    }
  }

  const links = [];
  const sides = (meta.point && meta.point.sides) || {};
  // an undone point keeps its file (it was played) but is no one's highlight
  for (const pl of p.voided ? [] : creditedPlayers(p)) {
    const side = sanitizeSegment(sides[pl.side] || pl.side || 'Side', 'Side');
    const pdir = path.join(matchRoot, 'Players', side, playerFolder(pl), setName);
    await fs.promises.mkdir(pdir, { recursive: true });
    await writePlayerCard(path.dirname(pdir), Object.assign({ sideName: sides[pl.side] || null }, pl));
    const r = await linkOrCopy(primary, path.join(pdir, filename));
    links.push({ role: pl.role || 'player', playerName: pl.name || null, playerId: pl.playerId, path: r.path, mode: r.mode, error: r.error || null });
  }

  const keep = new Set([path.resolve(primary), ...links.map((l) => path.resolve(l.path))]);
  for (const old of [previous && previous.primary, ...((previous && previous.links) || []).map((l) => l.path)]) {
    if (!old || keep.has(path.resolve(old))) continue;
    await fs.promises.unlink(old).catch(() => {});
  }
  return { primary, filename, links, matchRoot, category: p.eventId ? `Set ${int(p.set) || '?'} · Game ${int(p.game) || '?'}` : `Set ${int(p.set) || '?'} · Moments` };
}

module.exports = { TYPE_WORD, sanitizeSegment, matchRootFor, linkOrCopy, writeClipMetadata, ensurePointTree, pointWords, pointFileName, creditedPlayers, placePointClip };
