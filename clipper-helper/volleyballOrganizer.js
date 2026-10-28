// ================================================================
// 🏐 VOLLEYBALL POINT CLIPS — where one point's clip lives on this PC.
//
// The cricket tree (clipOrganizer.js: Highlights / Batsmen / Bowlers) has
// no place for a rally, so a volleyball point is filed by what it is —
// match → set → point — beside the master recording, with the same two
// rules as cricket:
//
//   <recording folder>/Clips/
//     [<Tournament>/]<Match>/
//        Set-1/S1-P027_15-12_PUN_Kill_7-Arjun-Kumar.mp4   ← the one physical clip
//        Players/<Team>/<7-Arjun-Kumar>/Set-1/…            ← hard links, + player.json
//        metadata/<clipId>.json                            ← the point, with the real ids
//
//  1. NO INTERNET. Everything here comes from the point the panel sent
//     with the press (and the attribution it sent afterwards).
//  2. ONE PHYSICAL CLIP. ffmpeg ran once; the players' folders get hard
//     links to the same bytes (a copy only where the disk refuses links).
//
// A folder name is for a person browsing; the player's real id is in
// player.json and metadata/<clipId>.json, never taken from the name.
// ================================================================
const fs = require('fs');
const path = require('path');
const organizer = require('./clipOrganizer');

const { sanitizeSegment, matchRootFor, linkOrCopy, writeClipMetadata } = organizer;

// How the point was won, as a word for a filename / folder.
const TYPE_WORD = { kill: 'Kill', ace: 'Ace', block: 'Block', opp_error: 'Opp-Error', team: 'Team-Point' };

const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

async function ensurePointTree(clipsRoot, meta) {
  const root = matchRootFor(clipsRoot, meta);
  for (const d of [path.join(root, 'Players'), path.join(root, 'metadata')]) await fs.promises.mkdir(d, { recursive: true });
  return root;
}

// "S1-P027_15-12_PUN_Kill_7-Arjun-Kumar.mp4" — set, point, the score after
// it (team A first), who won it, how, and the player credited (if any).
function pointFileName(p) {
  p = p || {};
  const set = int(p.set) || 0;
  const no = String(int(p.pointNo) || 0).padStart(3, '0');
  const sc = p.score ? `${int(p.score.A) || 0}-${int(p.score.B) || 0}` : 'x-x';
  const team = sanitizeSegment(p.teamShort || p.teamName || p.team || 'Team', 'Team');
  const how = TYPE_WORD[p.attribution] ? `_${TYPE_WORD[p.attribution]}` : '';
  const lead = (p.players || [])[0];
  const who = lead && lead.name ? `_${sanitizeSegment(`${lead.number != null && lead.number !== '' ? lead.number + '-' : ''}${lead.name}`, '')}` : '';
  return `S${set}-P${no}_${sc}_${team}${how}${who}.mp4`.replace(/_+\.mp4$/, '.mp4');
}

function playerFolder(p) {
  return sanitizeSegment(`${p.number != null && p.number !== '' ? p.number + '-' : ''}${p.name || p.playerId || 'Player'}`, 'Player');
}

async function writePlayerCard(dir, p) {
  const file = path.join(dir, 'player.json');
  try {
    const card = { name: p.name || null, number: p.number != null ? String(p.number) : null, playerId: p.playerId || null, team: p.team || null, teamName: p.teamName || null };
    let prior = null;
    try { prior = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch (_) { /* first clip for this player */ }
    if (prior && prior.playerId === card.playerId && prior.name === card.name && prior.number === card.number) return;
    await fs.promises.writeFile(file, JSON.stringify(Object.assign(card, { folder: path.basename(dir), updatedAt: Date.now() }), null, 2));
  } catch (_) { /* a browsing aid — never fail a clip over it */ }
}

async function sameFile(a, b) {
  try {
    const [x, y] = await Promise.all([fs.promises.stat(a), fs.promises.stat(b)]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch (_) { return false; }
}

// Moves the cut clip to Set-N/ under its point name and links it into the
// credited players' folders. Re-run when the attribution arrives (or is
// changed): the same single file is renamed and re-linked, links that no
// longer apply are removed — never a second cut, never the network.
// → { primary, filename, links, matchRoot, category }
async function placePointClip({ clipsRoot, currentPath, meta, previous }) {
  const matchRoot = await ensurePointTree(clipsRoot, meta);
  const p = meta.point || {};
  const setDir = path.join(matchRoot, `Set-${int(p.set) || 0}`);
  await fs.promises.mkdir(setDir, { recursive: true });
  const filename = pointFileName(p);
  const primary = path.join(setDir, filename);

  if (path.resolve(currentPath) !== path.resolve(primary) && !(await sameFile(currentPath, primary))) {
    try {
      await fs.promises.rename(currentPath, primary);
    } catch (err) {
      await fs.promises.copyFile(currentPath, primary);
      await fs.promises.unlink(currentPath).catch(() => {});
    }
  }

  const links = [];
  const teamNames = meta.teamNames || {};
  for (const pl of (p.players || []).slice(0, 4)) {
    if (!pl || !pl.playerId) continue;
    const team = sanitizeSegment(teamNames[pl.team] || pl.team || 'Team', 'Team');
    const dir = path.join(matchRoot, 'Players', team, playerFolder(pl), `Set-${int(p.set) || 0}`);
    await fs.promises.mkdir(dir, { recursive: true });
    await writePlayerCard(path.dirname(dir), Object.assign({ teamName: teamNames[pl.team] || null }, pl));
    const r = await linkOrCopy(primary, path.join(dir, filename));
    links.push({ role: pl.role || 'player', playerName: pl.name || null, playerId: pl.playerId, path: r.path, mode: r.mode, error: r.error || null });
  }

  const keep = new Set([path.resolve(primary), ...links.map((l) => path.resolve(l.path))]);
  for (const old of [previous && previous.primary, ...((previous && previous.links) || []).map((l) => l.path)]) {
    if (!old || keep.has(path.resolve(old))) continue;
    await fs.promises.unlink(old).catch(() => {});
  }
  return { primary, filename, links, matchRoot, category: `Set ${int(p.set) || '?'}` };
}

module.exports = { TYPE_WORD, ensurePointTree, pointFileName, placePointClip, writeClipMetadata };
