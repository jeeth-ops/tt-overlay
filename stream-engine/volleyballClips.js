// ================================================================
// 🏐 Filing a volleyball point clip on the operator's PC.
//
// Cricket clips go through clipper-helper/clipOrganizer.js (batsmen,
// bowlers, highlights …). A volleyball point has none of that, so it is
// filed by what it is — match, set, point — with a small JSON beside it
// (the point event id, the score at the press, the window). Moving the
// file is the only change; if anything here fails the clip stays exactly
// where it was cut.
// ================================================================
const fs = require('fs');
const path = require('path');

function slug(v, max) {
    return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max || 40) || 'x';
}

async function placeVolleyballClip({ clipsRoot, currentPath, job }) {
    const bm = job.ballMeta || {};
    const matchDir = path.join(clipsRoot, slug(job.matchId, 60), 'Volleyball');
    const setDir = path.join(matchDir, `Set-${Number(bm.set) || 0}`);
    await fs.promises.mkdir(setDir, { recursive: true });
    const score = bm.score ? `${Number(bm.score.A) || 0}-${Number(bm.score.B) || 0}` : 'x-x';
    const name = `Point-${String(Number(bm.pointNo) || 0).padStart(3, '0')}_${slug(bm.teamName || bm.team || 'team', 24)}_${score}_${slug(job.clipId, 80)}.mp4`;
    const dest = path.join(setDir, name);
    if (path.resolve(dest) !== path.resolve(currentPath)) {
        await fs.promises.rename(currentPath, dest);
    }
    const meta = {
        clipId: job.clipId, matchId: job.matchId, sport: 'volleyball',
        eventId: bm.eventId || null, set: bm.set || null, pointNo: bm.pointNo || null,
        team: bm.team || null, teamName: bm.teamName || null, score: bm.score || null,
        tournamentId: bm.tournamentId || null, t0: job.timestamp,
        window: job.window || null, actualPreRollSec: job.actualPreRollSec != null ? job.actualPreRollSec : null,
        localPath: dest, savedAt: Date.now(),
    };
    try {
        await fs.promises.writeFile(path.join(setDir, name.replace(/\.mp4$/, '.json')), JSON.stringify(meta, null, 2));
    } catch (e) { /* the clip itself is what matters */ }
    return { path: dest, info: { category: `Set ${meta.set || '?'}`, matchRoot: matchDir } };
}

module.exports = { placeVolleyballClip, slug };
