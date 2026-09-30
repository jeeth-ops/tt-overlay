// ================================================================
// 🎯 ONE REAL SECOND MUST STAY ONE REAL SECOND
// ================================================================
// dshow's -framerate is a REQUEST, not a contract. If the camera or
// capture card actually delivers a different rate, ffmpeg still stamps
// the frames it receives at the rate we asked for, and nothing further
// down the chain notices: 25 real fps stamped as 50 makes media time
// advance half a second per real second, so a 60-second over ends up a
// 30-second file that plays back at double speed — in the master
// recording, in every clip cut from it, and on YouTube. The reverse
// (more frames arriving than requested) plays slow.
//
// None of that is visible without an instrument, so measure it: how much
// MEDIA time ffmpeg reported writing, divided by how much WALL time
// actually passed, over a sliding window.
//   ratio ~= 1.0  → one real second is one recorded second (correct)
//   ratio  < 1.0  → the file is SHORTER than real time → plays FAST
//   ratio  > 1.0  → the file is LONGER than real time  → plays SLOW
// The measured ratio also gives the source's REAL frame rate
// (requested x ratio), which is what §36's "Requested / Actual" display
// needs — and what tells the operator which mode their card is in.
const RATE_WINDOW_MS = 30000;      // sliding window the ratio is measured over
const RATE_MIN_SPAN_MS = 8000;     // below this it's mostly startup noise, not a verdict
const RATE_TOLERANCE = 0.05;       // +/-5%: encoders wobble; a stamped-rate mismatch is 2x or 0.5x, never 3%
function createRateTracker(label) {
    return { label: label || 'Output', samples: [], ratio: null, verdict: 'measuring', spanMs: 0, warnedVerdict: null, requestedFps: null };
}
function noteRateSample(rate, nowMs, outTimeSec) {
    if (!rate || !(outTimeSec > 0)) return;
    const s = rate.samples;
    s.push([nowMs, outTimeSec]);
    // Keep at least two samples so a long stall still has something to
    // compare against rather than silently resetting the measurement.
    while (s.length > 2 && nowMs - s[0][0] > RATE_WINDOW_MS) s.shift();
    const wallSpanMs = nowMs - s[0][0];
    rate.spanMs = wallSpanMs;
    if (wallSpanMs < RATE_MIN_SPAN_MS) return; // hold the previous verdict until there's enough span to judge
    const ratio = ((outTimeSec - s[0][1]) * 1000) / wallSpanMs;
    rate.ratio = ratio;
    rate.verdict = Math.abs(ratio - 1) <= RATE_TOLERANCE ? 'ok' : (ratio < 1 ? 'fast' : 'slow');
    // Log ONCE per verdict change, driven by the measurement itself rather
    // than by whoever happens to poll /status — this is the line that
    // explains a "why is it playing fast?" report, so it has to appear in
    // the console even with no panel open, and must not repeat per frame.
    if (rate.verdict !== rate.warnedVerdict) {
        rate.warnedVerdict = rate.verdict;
        const req = Number(rate.requestedFps) || null;
        if (rate.verdict === 'ok') {
            console.log(`[stream-engine] ${rate.label} timebase OK — ${ratio.toFixed(3)}x real time`);
        } else {
            console.warn(`[stream-engine] ⚠ ${rate.label} timebase ${rate.verdict.toUpperCase()}: ${ratio.toFixed(3)}x real time.` +
                (req ? ` Asked the source for ${req}fps; about ${(req * ratio).toFixed(1)}fps is really arriving.` : '') +
                ` Footage will play too ${rate.verdict}.`);
        }
    }
}
// Health the panel and /status can show — PURE: the warning above is the
// side effect, this only reports. requestedFps is what we ASKED the source
// for; actualFps is what the measurement says is really arriving.
function rateHealth(rate, requestedFps) {
    const req = Number(requestedFps) || null;
    if (rate) rate.requestedFps = req; // so the warning line can name it too
    if (!rate || rate.ratio == null) {
        return { verdict: 'measuring', ratio: null, requestedFps: req, actualFps: null, windowSec: Math.round((rate ? rate.spanMs : 0) / 1000) };
    }
    return {
        verdict: rate.verdict,
        ratio: Number(rate.ratio.toFixed(3)),
        requestedFps: req,
        actualFps: req ? Number((req * rate.ratio).toFixed(2)) : null,
        windowSec: Math.round(rate.spanMs / 1000),
    };
}

module.exports = { RATE_WINDOW_MS, RATE_MIN_SPAN_MS, RATE_TOLERANCE, createRateTracker, noteRateSample, rateHealth };
