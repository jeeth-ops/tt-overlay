// ================================================================
// 🎯 CLIP WINDOW + ROUTE — per job, frozen at the moment the event is
// accepted.
//
// Cricket keeps exactly what it always had: T0-15s → T0+5s, forwarded to
// /api/clips/ingest. A request may now name its own window (volleyball:
// 7s before the press, 3s after it — the scorer presses just AFTER the
// spike, block or rally-ending touch, so the action is in the pre-roll)
// and its sport, which decides where the finished clip is sent. Both are
// bounded, so a malformed request can never ask for a 10-minute clip or
// point the upload at an arbitrary path.
// ================================================================
const CRICKET = Object.freeze({ preRollSec: 15, postRollSec: 5 });
const LIMITS = Object.freeze({ preMin: 1, preMax: 30, postMin: 1, postMax: 15 });
const ROUTES = Object.freeze({
    cricket: Object.freeze({ sport: 'cricket', ingestPath: '/api/clips/ingest', statusPath: '/api/clips/status/' }),
    volleyball: Object.freeze({ sport: 'volleyball', ingestPath: '/api/volleyball/clips/ingest', statusPath: '/api/volleyball/clips/status/' }),
});

function routeFor(sport) {
    return ROUTES[sport] || ROUTES.cricket;
}

function bounded(v, lo, hi, d) {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(hi, Math.max(lo, n));
}

// The window a job is cut with. `req` may carry preRollSec / postRollSec;
// anything missing or invalid falls back to the cricket defaults.
function buildWindow(t0, req) {
    req = req || {};
    const preRollSec = bounded(req.preRollSec, LIMITS.preMin, LIMITS.preMax, CRICKET.preRollSec);
    const postRollSec = bounded(req.postRollSec, LIMITS.postMin, LIMITS.postMax, CRICKET.postRollSec);
    return Object.freeze({
        t0,
        startWall: t0 - preRollSec * 1000,
        endWall: t0 + postRollSec * 1000,
        preRollSec,
        postRollSec,
    });
}

// How much of the asked-for pre-roll the recording actually holds. A
// recording (or a recorder restart) that began less than preRollSec before
// the press cannot supply the whole pre-roll — the clip is still cut, but
// it is reported as short rather than passed off as complete.
// `startSec` is the window start in the recording segment's own seconds
// (negative when the window starts before the segment does).
function actualPreRoll(window, startSec) {
    const missing = Math.max(0, -Number(startSec || 0));
    return Math.max(0, Math.round((window.preRollSec - missing) * 100) / 100);
}

// What the website is told about the cut, beside the file itself.
function clipMetaFor(job, extra) {
    const w = job.window || {};
    return Object.assign({
        sport: job.sport || 'cricket',
        preRollSec: w.preRollSec,
        postRollSec: w.postRollSec,
        windowStart: w.startWall,
        windowEnd: w.endWall,
        t0: w.t0,
        actualPreRollSec: job.actualPreRollSec != null ? job.actualPreRollSec : null,
        partialPreRoll: !!job.partialPreRoll,
        durationSec: job.clipDurationSec != null ? job.clipDurationSec : null,
        sessionId: job.sessionId || null,
    }, extra || {});
}

// The pages the engine opens for a match: the Live Output window it
// captures (camera + overlay) and the overlay the native compositor
// renders. Cricket — anything not registered as another sport — gets
// exactly the paths it always had; a volleyball match shows the volleyball
// overlay (with its key, which a private match needs, when one was given).
function capturePagesFor(sport, matchId, opts) {
    const o = opts || {};
    const id = encodeURIComponent(matchId);
    const cam = `video=${encodeURIComponent(o.videoDeviceId || '')}&videoLabel=${encodeURIComponent(o.videoLabel || '')}`;
    if (sport === 'volleyball') {
        const key = /^[a-f0-9]{6,64}$/i.test(String(o.overlayKey || '')) ? `&key=${o.overlayKey}` : '';
        return { liveOutput: `/volleyball-live-output?match=${id}&${cam}${key}`, overlay: `/volleyball-overlay?match=${id}${key}` };
    }
    return { liveOutput: `/live-output.html?room=${id}&${cam}`, overlay: `/cricket-overlay?room=${id}` };
}

module.exports = { CRICKET, LIMITS, ROUTES, routeFor, buildWindow, actualPreRoll, clipMetaFor, capturePagesFor };
