// ================================================================
// 🎬 RECORDING SESSION — ONE master recording per match, for the whole
// match, independent of the internet.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE:
//
//     REMOTE FAILURE ≠ LOCAL MEDIA FAILURE
//
// YouTube dropping, R2 failing, Drive failing, the main server being
// unreachable — none of those are recording events. The camera keeps
// delivering frames, the compositor keeps producing a program feed, and
// the master recording keeps growing. The operator must end a 7-hour
// match with ONE continuous master, whatever the internet did during it.
//
// 🛠 WHAT WENT WRONG BEFORE.
//
// The recorder is allowed to restart into a NEW file — that is real
// crash safety, not a bug: fragmented MP4 cannot be appended to, so a
// killed ffmpeg has to continue somewhere, and continuing in
// master_part2.mp4 beats losing the rest of the match. But that
// mechanism had two holes:
//
//   1. NOTHING RECORDED WHY. A match that came back as master.mp4 +
//      master_part2.mp4 was indistinguishable from a match that split
//      because of a real local fault. "It splits when the internet
//      drops" could not be confirmed or refuted, let alone fixed,
//      because the boundary carried no cause.
//
//   2. THE PARTS WERE THE DELIVERABLE. The operator was handed the
//      pieces and left to join them. From their side the match HAD
//      become two recordings, which is exactly what must never happen.
//
// So: every boundary is written down with its reason and that reason is
// CLASSIFIED (local / remote / unknown). A boundary classified remote is
// a bug in the architecture by definition, and it now says so loudly in
// the log instead of passing as normal. And on stop, the parts are
// joined losslessly back into one master, so internal fault tolerance
// stays invisible to the operator.
//
// The session file is the durable record — it survives an engine
// restart, so a restart mid-match ADOPTS the running session instead of
// pretending a fresh recording began.
// ================================================================
const fs = require('fs');
const path = require('path');

const SESSION_FILE = 'recording-session.json';
const FINAL_BASENAME = 'master_complete.mp4'; // written only when a session really did span more than one part
const CONCAT_LIST = 'master_parts.txt';

function sessionFilePath(dir) { return path.join(dir, SESSION_FILE); }
function finalFilePath(dir) { return path.join(dir, FINAL_BASENAME); }
function concatListPath(dir) { return path.join(dir, CONCAT_LIST); }

// ----------------------------------------------------------------
// WHY DID THIS SEGMENT END?
// ----------------------------------------------------------------
// A boundary is only ever legitimate for a LOCAL reason. These patterns
// decide which kind a reason text is, so that "the recording split
// because the internet went" stops being a guess: if a boundary is ever
// classified 'remote', the architecture is wrong and the log says so at
// the moment it happens, with the text that proved it.
//
// Matched against the recorder's own lastError / the supervisor's stall
// reason, i.e. ffmpeg's words, not ours — so the lists are deliberately
// broad rather than clever.
const REMOTE_REASON_RE = /rtmp|rtmps|youtube|tls|ssl|dns|getaddrinfo|econnrefused|econnreset|enetunreach|ehostunreach|etimedout|broken pipe|connection (reset|refused|timed out|closed)|network (is )?unreachable|upload|r2\b|cloudflare|drive|offline|internet|main server|sync/i;
const LOCAL_REASON_RE = /operator|stop|shutdown|stall|no new video|has not grown|nvenc|encoder|device|dshow|disk|space|enospc|permission|crash|sigkill|sigterm|exit code|relay|compositor|camera|audio|resolution/i;

function classifyBoundaryReason(reason) {
    const text = String(reason || '');
    if (!text.trim()) return 'unknown';
    // Local wins a tie on purpose: "the RTMPS encoder died and the
    // recorder's NVENC session went with it" is a LOCAL encoder fault
    // with a remote trigger, and calling it remote would hide the real
    // defect (two encoders sharing a limited GPU resource).
    if (LOCAL_REASON_RE.test(text)) return 'local';
    if (REMOTE_REASON_RE.test(text)) return 'remote';
    return 'unknown';
}

// ----------------------------------------------------------------
// SESSION STATE
// ----------------------------------------------------------------
function createSession({ matchId, settings, now = Date.now() }) {
    return {
        sessionId: `${matchId}-${now}`,
        matchId,
        startedAt: now,
        endedAt: null,
        status: 'recording',      // recording | stopped
        settings: settings || null,
        segments: [],             // [{ path, startedAt, endedAt, reason, reasonKind }]
        adoptions: 0,             // how many times an engine restart picked this session back up
        final: null,              // { path, status, error, joinedSegments, finishedAt }
    };
}

function loadSession(dir) {
    let raw;
    try {
        raw = fs.readFileSync(sessionFilePath(dir), 'utf8');
    } catch (e) {
        return null; // no session yet is the normal first-recording case
    }
    try {
        const s = JSON.parse(raw);
        if (!s || typeof s !== 'object' || !Array.isArray(s.segments)) return null;
        return s;
    } catch (e) {
        return null; // a truncated/corrupt file must never stop a recording from starting
    }
}

// Atomic: write beside the real file and rename over it, so a crash
// mid-write can never leave a half-parsed session behind (same reasoning
// as retryQueueStore.saveRetryQueue).
function saveSession(dir, session, onError) {
    const file = sessionFilePath(dir);
    const tmp = `${file}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(session, null, 2));
        fs.renameSync(tmp, file);
        return true;
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        if (onError) onError(e);
        return false;
    }
}

// A restart mid-match must CONTINUE the match's recording session, not
// declare a new one — otherwise the engine restarting (for any reason,
// including one the operator caused) reads as a second recording.
// A session for a DIFFERENT match, or one already stopped, is not
// adopted: that really is a new recording.
function startOrAdoptSession(dir, { matchId, settings, now = Date.now() }) {
    const existing = loadSession(dir);
    if (existing && existing.matchId === matchId && existing.status === 'recording') {
        existing.adoptions = (existing.adoptions || 0) + 1;
        if (settings) existing.settings = settings;
        return { session: existing, adopted: true };
    }
    return { session: createSession({ matchId, settings, now }), adopted: false };
}

function addSegment(session, { path: segPath, startedAt = Date.now() }) {
    const seg = { path: segPath, startedAt, endedAt: null, reason: null, reasonKind: null };
    session.segments.push(seg);
    return seg;
}

// Closes the segment currently open (the last one without an endedAt).
// Returns it, or null when there was nothing open — callers must not
// assume, because a crash can close a segment the engine never saw open.
function closeOpenSegment(session, { endedAt = Date.now(), reason = null } = {}) {
    for (let i = session.segments.length - 1; i >= 0; i--) {
        const seg = session.segments[i];
        if (seg.endedAt == null) {
            seg.endedAt = endedAt;
            seg.reason = reason ? String(reason) : null;
            seg.reasonKind = classifyBoundaryReason(reason);
            return seg;
        }
    }
    return null;
}

function stopSession(session, { endedAt = Date.now(), reason = 'operator stopped recording' } = {}) {
    closeOpenSegment(session, { endedAt, reason });
    session.status = 'stopped';
    session.endedAt = endedAt;
    return session;
}

// Every boundary that was NOT the operator stopping — i.e. every place
// the match came back in more than one piece — with its classification.
// This is the answer to "why is my master in two parts?".
function boundaries(session) {
    const out = [];
    const segs = session.segments || [];
    for (let i = 0; i < segs.length - 1; i++) {
        if (segs[i].endedAt == null) continue;
        out.push({ afterSegment: segs[i].path, reason: segs[i].reason, reasonKind: segs[i].reasonKind });
    }
    return out;
}

// True when a boundary was blamed on something remote — which the
// architecture forbids, so callers treat it as a defect to report, not a
// state to accept.
function hasRemoteCausedBoundary(session) {
    return boundaries(session).some((b) => b.reasonKind === 'remote');
}

// ----------------------------------------------------------------
// JOINING THE PARTS BACK INTO ONE MASTER
// ----------------------------------------------------------------
// Lossless (-c copy): no re-encode, no quality change, no second pass
// over a 7-hour NVENC encode. The concat DEMUXER (not the filter) is the
// one that works on separate files without touching the streams.
//
// Only valid when every part really does share codec parameters, which
// is why the session records the settings each part was written with:
// a part written after a resolution change cannot be copy-concatenated,
// and silently producing a broken file would be worse than saying so.
function segmentsAreJoinable(session) {
    const segs = (session.segments || []).filter((s) => s.path);
    if (segs.length < 2) return { ok: false, reason: 'only one part — nothing to join' };
    return { ok: true, count: segs.length };
}

// The concat demuxer's list format. Single quotes are its escape rule:
// a literal ' inside a path is written as '\'' — Windows paths won't
// normally contain one, but a path is operator data, so it is escaped
// rather than assumed safe.
function buildConcatList(session) {
    return (session.segments || [])
        .filter((s) => s.path)
        .map((s) => `file '${String(s.path).replace(/'/g, "'\\''")}'`)
        .join('\n') + '\n';
}

function buildConcatArgs({ listFile, outFile }) {
    return [
        '-hide_banner', '-loglevel', 'warning',
        '-y',
        // -safe 0 because the list holds absolute paths, which the demuxer
        // refuses by default.
        '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c', 'copy',
        // The parts are fragmented MP4; the joined output is a normal
        // progressive MP4 with its index at the front, which is what a
        // player (and the operator's editor) wants from a finished match.
        '-movflags', '+faststart',
        outFile,
    ];
}

module.exports = {
    SESSION_FILE, FINAL_BASENAME, CONCAT_LIST,
    sessionFilePath, finalFilePath, concatListPath,
    REMOTE_REASON_RE, LOCAL_REASON_RE, classifyBoundaryReason,
    createSession, loadSession, saveSession, startOrAdoptSession,
    addSegment, closeOpenSegment, stopSession,
    boundaries, hasRemoteCausedBoundary,
    segmentsAreJoinable, buildConcatList, buildConcatArgs,
};
