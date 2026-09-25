// ================================================================
// 🗂️ LOCAL CLIP ORGANISER — turns one freshly-cut clip into a
// broadcast/archive-style folder tree NEXT TO the master recording,
// using nothing but the metadata captured at the moment of the event.
//
//   <recording folder>/Clips/
//     [<Tournament>/]<Match>/
//        Highlights/{4,6,Wickets,Wide-4,Wide-6,No-Ball-4,No-Ball-6,Bye-4,Leg-Bye-4}/
//        Normal/
//        Batsmen/<Player-Name>/<1st-Innings>/
//        Bowlers/<Player-Name>/<1st-Innings>/
//        metadata/<clipId>.json      ← the event, with the real IDs
//
// Two rules this file exists to enforce:
//
//  1. NO INTERNET, EVER. Every decision here is made from the job's own
//     stored metadata (match/innings/over/ball/event/player IDs that the
//     panel sent with the press). Nothing is looked up, resolved or
//     confirmed over the network, so the tree and the filenames are
//     identical whether the laptop is online or completely offline.
//
//  2. ONE PHYSICAL CLIP. ffmpeg runs ONCE per event. The clip lives in
//     exactly one place (its Highlights category, or Normal), and the
//     batsman/bowler folders get HARD LINKS to those same bytes — same
//     20 s MP4, one copy on disk, opens and plays from every folder.
//     Only if the filesystem refuses to link (different volume, or a
//     filesystem without links) does it fall back to a real copy.
//
// Player folders are named from the player's name because a human has to
// browse them — but the name is never the identity: metadata/<clipId>.json
// and Batsmen|Bowlers/<Player>/player.json keep the real playerId, so a
// sanitised folder name is never what a clip is matched back to.
// ================================================================
const fs = require('fs');
const path = require('path');

// Highlight buckets that always exist, so the operator (and any file
// browser) sees the same shape from the first ball of the match.
const HIGHLIGHT_CATEGORIES = ['4', '6', 'Wickets', 'Wide-4', 'Wide-6', 'No-Ball-4', 'No-Ball-6', 'Bye-4', 'Leg-Bye-4'];

// Windows device names can't be used as folder names, whatever the extension.
const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']);

// "Shivam Dubé" → "Shivam-Dube", "O'Brien" → "OBrien", "A/B <x>" → "A-B-x".
// Recognisable to a human, safe on Windows/macOS/Linux, and never empty.
function sanitizeSegment(value, fallback = 'Unknown') {
  let s = String(value == null ? '' : value);
  // Accents → plain letters (é → e) so folders stay readable in any shell.
  try { s = s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (_) { /* very old runtime */ }
  s = s
    .replace(/['"`]/g, '')                       // apostrophes/quotes just disappear
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')  // filesystem-unsafe → space
    .replace(/[\s_]+/g, '-')                     // spaces → dashes
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.\s]+$/g, '');            // no leading/trailing dash or dot (Windows)
  if (s.length > 60) s = s.slice(0, 60).replace(/-+$/, '');
  if (!s) return fallback;
  if (RESERVED.has(s.toUpperCase())) return `${s}-x`;
  return s;
}

// "1st-Innings", "2nd-Innings", … — the browsing level inside a player's folder.
function inningsFolder(innings) {
  const n = Number(innings);
  if (!Number.isFinite(n) || n <= 0) return 'Unknown-Innings';
  const suffix = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
  return `${n}${suffix}-Innings`;
}

// The delivery, exactly as the scoring engine numbers it: over 8, ball 4
// → "08.4". Never "normalised" into 9.0 — 0.6 stays 0.6 until the over
// is actually complete, because that is what the event says.
function ballLabel(meta) {
  const over = Number(meta && meta.over);
  const ball = Number(meta && meta.ballInOver);
  if (!Number.isFinite(over) || !Number.isFinite(ball)) return null;
  return `${String(Math.max(0, Math.trunc(over))).padStart(2, '0')}.${Math.max(0, Math.trunc(ball))}`;
}

// A press whose ball is genuinely unknown (manual clip before any ball
// was recorded) still gets a precise, non-generic name: its clock time.
function timeLabel(t0) {
  const d = new Date(Number(t0) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// What this clip IS — the filename token and the Highlights bucket.
// Driven by the outcome the scorer actually recorded (outcomeLabel, e.g.
// "Wide 4", "No Ball 6", "WICKET — Run Out") and only falling back to the
// trigger's own event type. Order matters: a Wide 4 is sent as eventType
// FOUR, so extras are classified before plain boundaries.
function classifyEvent(meta) {
  const label = String((meta && meta.outcomeLabel) || '').toLowerCase();
  const et = String((meta && meta.eventType) || '').toUpperCase();
  const has = (n) => new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(label);

  if (/wicket/.test(label) || (et === 'WICKET' && !/retired/.test(label))) return { token: 'WICKET', category: 'Wickets', defaultHighlight: true };
  if (/wide/.test(label)) {
    if (has(6)) return { token: 'WIDE6', category: 'Wide-6', defaultHighlight: true };
    if (has(4)) return { token: 'WIDE4', category: 'Wide-4', defaultHighlight: true };
    return { token: 'WIDE', category: 'Other', defaultHighlight: false };
  }
  if (/no[\s-]?ball/.test(label)) {
    if (/leg[\s-]?bye/.test(label) && has(4)) return { token: 'NOBALL-LEGBYE4', category: 'Leg-Bye-4', defaultHighlight: true };
    if (has(6)) return { token: 'NOBALL6', category: 'No-Ball-6', defaultHighlight: true };
    if (has(4)) return { token: 'NOBALL4', category: 'No-Ball-4', defaultHighlight: true };
    return { token: 'NOBALL', category: 'Other', defaultHighlight: false };
  }
  if (/leg[\s-]?bye/.test(label)) return has(4) ? { token: 'LEGBYE4', category: 'Leg-Bye-4', defaultHighlight: true } : { token: 'LEGBYE', category: 'Other', defaultHighlight: false };
  if (/bye/.test(label)) return has(4) ? { token: 'BYE4', category: 'Bye-4', defaultHighlight: true } : { token: 'BYE', category: 'Other', defaultHighlight: false };
  if (/overthrow/.test(label)) {
    if (has(6)) return { token: 'OVERTHROW6', category: '6', defaultHighlight: true };
    if (has(4)) return { token: 'OVERTHROW4', category: '4', defaultHighlight: true };
    return { token: 'OVERTHROW', category: 'Other', defaultHighlight: false };
  }
  if (/retired/.test(label)) return { token: 'RETIRED-HURT', category: 'Other', defaultHighlight: false };
  if (/\bfour\b/.test(label) || et === 'FOUR') return { token: 'FOUR', category: '4', defaultHighlight: true };
  if (/\bsix\b/.test(label) || et === 'SIX') return { token: 'SIX', category: '6', defaultHighlight: true };
  if (/dot ball/.test(label)) return { token: 'DOT', category: 'Other', defaultHighlight: false };
  if (et === 'HIGHLIGHT') return { token: 'HIGHLIGHT', category: 'Other', defaultHighlight: false };
  return { token: et && et !== 'CLIP' ? sanitizeSegment(et, 'CLIP') : 'CLIP', category: 'Other', defaultHighlight: false };
}

// OVER.BALL_EVENT_BATSMAN_vs_BOWLER.mp4
//   08.4_SIX_Rohit-Sharma_vs_Jasprit-Bumrah.mp4
// Never clip1.mp4 / highlight.mp4: the ball (or, failing that, the exact
// clock time), the event and both players are always in the name.
function buildClipFileName(meta) {
  const { token } = classifyEvent(meta);
  const ball = ballLabel(meta) || timeLabel(meta && meta.t0);
  const bat = meta && meta.strikerName ? sanitizeSegment(meta.strikerName, '') : '';
  const bowl = meta && meta.bowlerName ? sanitizeSegment(meta.bowlerName, '') : '';
  const who = bat && bowl ? `_${bat}_vs_${bowl}` : bat ? `_${bat}` : bowl ? `_vs_${bowl}` : '';
  return `${ball}_${token}${who}.mp4`;
}

// Where this match's tree lives inside Clips/. A tournament level only
// exists when the match actually belongs to a tournament, so a single
// match never gets an empty folder above it — and two matches recorded
// into the SAME folder can never mix, because each has its own level.
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

// The folders that must exist for the match whether or not a clip of
// that kind is ever cut — created on the first clip of the match (and on
// "Start Recording"), entirely offline.
async function ensureMatchTree(clipsRoot, meta) {
  const root = matchRootFor(clipsRoot, meta);
  const dirs = [
    path.join(root, 'Normal'),
    path.join(root, 'Batsmen'),
    path.join(root, 'Bowlers'),
    path.join(root, 'metadata'),
    ...HIGHLIGHT_CATEGORIES.map((c) => path.join(root, 'Highlights', c)),
  ];
  for (const d of dirs) await fs.promises.mkdir(d, { recursive: true });
  return root;
}

// Same bytes, two names. A hard link costs nothing and cannot drift out
// of sync with the original; a copy is the fallback for filesystems or
// volumes that refuse one (and is still only ever made from the ONE clip
// ffmpeg produced — a second cut is never run).
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

// A player folder remembers WHO it is, so a clip is never matched back to
// a player by its sanitised folder name (see the header note).
async function writePlayerCard(dir, name, playerId) {
  const file = path.join(dir, 'player.json');
  try {
    let prior = null;
    try { prior = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch (_) { /* first clip for this player */ }
    if (prior && prior.playerId === (playerId || null) && prior.name === name) return;
    await fs.promises.writeFile(file, JSON.stringify({ name, playerId: playerId || null, folder: path.basename(dir), updatedAt: Date.now() }, null, 2));
  } catch (_) { /* browsing aid only — never fail a clip over it */ }
}

async function sameFile(a, b) {
  try {
    const [x, y] = await Promise.all([fs.promises.stat(a), fs.promises.stat(b)]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch (_) { return false; }
}

// Moves a just-cut (or previously-placed) clip to where its metadata says
// it belongs and links it into the batsman's and bowler's folders.
//
// Idempotent and re-runnable: called again when the ball's outcome arrives
// (a HIGHLIGHTS press is cut before the scorer has entered the outcome),
// it moves the same single file to its final category, refreshes the
// links, and removes the ones that no longer apply. Never re-cuts, never
// duplicates, and never needs the network.
//
// Returns { primary, filename, links, matchRoot, category, isHighlight }.
async function placeClip({ clipsRoot, currentPath, meta, previous }) {
  const matchRoot = await ensureMatchTree(clipsRoot, meta);
  const cls = classifyEvent(meta);
  const isHighlight = meta.isHighlight === true ? true : meta.isHighlight === false ? false : cls.defaultHighlight;
  const category = isHighlight ? cls.category : null;
  const primaryDir = isHighlight ? path.join(matchRoot, 'Highlights', category) : path.join(matchRoot, 'Normal');
  await fs.promises.mkdir(primaryDir, { recursive: true });

  const filename = buildClipFileName(meta);
  const primary = path.join(primaryDir, filename);

  // 1️⃣ The one physical clip.
  if (path.resolve(currentPath) !== path.resolve(primary)) {
    if (!(await sameFile(currentPath, primary))) {
      await fs.promises.mkdir(path.dirname(primary), { recursive: true });
      try {
        await fs.promises.rename(currentPath, primary);
      } catch (err) {
        // Cross-volume, or something briefly holding the file (antivirus,
        // an upload reading it): copy+unlink rather than lose the clip.
        await fs.promises.copyFile(currentPath, primary);
        await fs.promises.unlink(currentPath).catch(() => {});
      }
    }
  }

  // 2️⃣ Player views of the same bytes.
  const links = [];
  const inn = inningsFolder(meta.innings);
  const players = [
    { role: 'batsman', top: 'Batsmen', name: meta.strikerName, id: meta.strikerId },
    { role: 'bowler', top: 'Bowlers', name: meta.bowlerName, id: meta.bowlerId },
  ];
  for (const p of players) {
    if (!p.name) continue;
    const dir = path.join(matchRoot, p.top, sanitizeSegment(p.name, 'Unknown-Player'), inn);
    await fs.promises.mkdir(dir, { recursive: true });
    await writePlayerCard(path.dirname(dir), String(p.name), p.id);
    const r = await linkOrCopy(primary, path.join(dir, filename));
    links.push({ role: p.role, playerName: String(p.name), playerId: p.id || null, path: r.path, mode: r.mode, error: r.error || null });
  }

  // 3️⃣ Anything this clip used to be called/filed under is stale now.
  const keep = new Set([path.resolve(primary), ...links.map((l) => path.resolve(l.path))]);
  for (const old of [previous && previous.primary, ...((previous && previous.links) || []).map((l) => l.path)]) {
    if (!old || keep.has(path.resolve(old))) continue;
    await fs.promises.unlink(old).catch(() => {});
  }

  return { primary, filename, links, matchRoot, category, isHighlight };
}

// The event, on disk, next to the clips — the local answer to "which ball,
// which players, which IDs" even if the laptop never goes online again.
async function writeClipMetadata(matchRoot, job) {
  try {
    const dir = path.join(matchRoot, 'metadata');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, `${job.clipId}.json`), JSON.stringify(job, null, 2));
  } catch (_) { /* the persistent queue is the real record — this is a convenience */ }
}

module.exports = {
  HIGHLIGHT_CATEGORIES,
  sanitizeSegment,
  inningsFolder,
  ballLabel,
  classifyEvent,
  buildClipFileName,
  matchFolderSegments,
  matchRootFor,
  ensureMatchTree,
  placeClip,
  writeClipMetadata,
  linkOrCopy,
};
