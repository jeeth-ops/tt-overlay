// ================================================================
// 🔬 SOURCE PROBE — measure what the capture device REALLY delivers.
//
// The laptop webcam works end to end; Sony → HDMI → AVMATRIX does not. The
// same code runs downstream of both, so the question is what differs at the
// FIRST stage: the frames themselves. Panel settings and the device's
// advertised modes are claims. This module opens the device for a few
// seconds and measures, per frame:
//
//   wall-clock arrival   (Node's receive time)  → the REAL delivery rate
//   device timestamp     (dshow sample time)    → are the stamps honest?
//   checksum of a 64×36 point-sampled thumbnail → identical consecutive
//                                                   frames = the card is
//                                                   REPEATING frames
//   idet (full resolution)                       → progressive or fields?
//
// plus the negotiated media type exactly as ffmpeg reports it (codec, pixel
// format, size, fps, field order) and every "real-time buffer too full"
// capture drop.
//
// From those it derives a NORMALIZATION PLAN — the one camera filter chain
// that turns this particular source into a clean program-rate stream — and
// a verdict that names the FIRST stage where the source misbehaves. See
// STREAM-ENGINE-AUDIT.md §K for the simulations that justify every rule
// here (why `fps=` is replaced by `framestep`, why `decimate` is needed for
// a frame-repeating card, why 50i is decided by measurement).
//
// CLI (on the match PC, with the Stream Engine STOPPED or not holding the
// camera — a capture device can only be opened once):
//
//   node sourceProbe.js --list
//   node sourceProbe.js --device "AVMATRIX USB Capture Video" --program-fps 50
//   node sourceProbe.js --compare "Integrated Camera" "AVMATRIX USB Capture Video" --program-fps 30
// ================================================================
const os = require('os');

// ---------------------------------------------------------------
// Parsers — all pure, all driven by ffmpeg's `-loglevel level+info` text.
// ---------------------------------------------------------------

// "[info]   Stream #0:0: Video: rawvideo (YUY2 / 0x32595559), yuyv422(tv, bt709, top first), 1920x1080, 60 fps, 60 tbr, 10000k tbn"
// The section of ffmpeg's startup log describing input #index.
function inputSection(text, index) {
    const head = String(text || '').split(/Stream mapping:|Output #0/)[0];
    const parts = head.split(/(?=Input #\d+,)/);
    const sec = parts.find((p) => p.startsWith(`Input #${index},`));
    return sec || (index === 0 ? head : '');
}
function parseInputVideoStream(text, index = 0) {
    const inputPart = inputSection(text, index);
    const m = new RegExp(`Stream #${index}:\\d+[^:]*: Video: ([^\\n]+)`).exec(inputPart);
    if (!m) return null;
    const rest = m[1];
    const codec = (/^(\w+)/.exec(rest) || [])[1] || null;
    const fourcc = (/\((\w{4}) \/ 0x[0-9A-Fa-f]+\)/.exec(rest) || [])[1] || null;
    // pixel format is the first ", name" (optionally followed by "(...)") after the codec block
    const pf = /\),?\s*(\w+)(?:\(([^)]*)\))?,\s*\d+x\d+|^\w+,\s*(\w+)(?:\(([^)]*)\))?,\s*\d+x\d+/.exec(rest);
    const pixFmt = pf ? (pf[1] || pf[3]) : null;
    const pixDetail = pf ? (pf[2] || pf[4] || '') : '';
    const size = /(\d{2,5})x(\d{2,5})/.exec(rest);
    const fps = /([\d.]+) fps/.exec(rest);
    let fieldOrder = 'unknown';
    if (/top (coded )?first/.test(pixDetail)) fieldOrder = 'tff';
    else if (/bottom (coded )?first/.test(pixDetail)) fieldOrder = 'bff';
    else if (/progressive/.test(pixDetail)) fieldOrder = 'progressive';
    return {
        codec, fourcc, pixFmt, fieldOrder,
        width: size ? Number(size[1]) : null, height: size ? Number(size[2]) : null,
        fps: fps ? Number(fps[1]) : null,
        raw: rest.trim(),
    };
}

function parseInputAudioStream(text, index = 1) {
    const inputPart = inputSection(text, index) || String(text || '').split(/Stream mapping:|Output #0/)[0];
    const m = /Stream #\d+:\d+[^:]*: Audio: ([^\n]+)/.exec(inputPart);
    if (!m) return null;
    const hz = /(\d+) Hz/.exec(m[1]);
    const ch = /Hz, ([^,]+)/.exec(m[1]);
    return { codec: (/^(\w+)/.exec(m[1]) || [])[1] || null, sampleRate: hz ? Number(hz[1]) : null, channels: ch ? ch[1].trim() : null, raw: m[1].trim() };
}

// "[Parsed_showinfo_2 @ 0x..] [info] n:  12 pts: 1234 pts_time:0.2 ... i:P ... checksum:B72D7B81 ..."
const SHOWINFO_RE = /n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:(-?[\d.]+)(?:.*?\bi:([PTB?]))?(?:.*?checksum:([0-9A-F]{8}))?/;
function parseShowinfoLine(line) {
    if (!/Parsed_showinfo/.test(line)) return null;
    const m = SHOWINFO_RE.exec(line);
    if (!m) return null;
    return { n: Number(m[1]), pts: Number(m[3]), scan: m[4] || null, checksum: m[5] || null };
}

// The LAST idet summary (ffmpeg can print a zeroed one while configuring).
function parseIdet(text) {
    const re = /Multi frame detection: TFF:\s*(\d+)\s+BFF:\s*(\d+)\s+Progressive:\s*(\d+)\s+Undetermined:\s*(\d+)/g;
    let m, last = null;
    while ((m = re.exec(String(text || '')))) last = m;
    if (!last) return null;
    const [tff, bff, progressive, undetermined] = last.slice(1).map(Number);
    return { tff, bff, progressive, undetermined };
}

const CAPTURE_DROP_RE = /real-time buffer .*too full.*frame dropped/i;

// ---------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------
const STANDARD_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120];
function snapRate(fps) {
    if (!(fps > 0)) return null;
    let best = null;
    for (const r of STANDARD_RATES) if (Math.abs(fps - r) / r <= 0.015 && (!best || Math.abs(fps - r) < Math.abs(fps - best))) best = r;
    return best;
}

function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function percentile(arr, p) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
function stdev(arr) {
    if (arr.length < 2) return 0;
    const mu = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, b) => a + (b - mu) ** 2, 0) / (arr.length - 1));
}

// Is the duplicate pattern a regular "1 repeat every N frames" (a card
// converting a slower source up to its fixed output rate)? Returns N or null.
function dupCycle(dupPositions, total) {
    if (dupPositions.length < 4) return null;
    const gaps = [];
    for (let i = 1; i < dupPositions.length; i++) gaps.push(dupPositions[i] - dupPositions[i - 1]);
    const med = median(gaps);
    const regular = gaps.filter((g) => Math.abs(g - med) <= 1).length / gaps.length;
    if (regular < 0.8) return null;
    // Average spacing is the cycle (a 50→60 repeat lands every 6 frames on average,
    // a 25→60 repeat is not "1 in N" at all and is caught by fraction instead).
    const cycle = Math.round((dupPositions[dupPositions.length - 1] - dupPositions[0]) / (dupPositions.length - 1));
    return cycle >= 2 && cycle <= 12 && Math.abs(dupPositions.length / total - 1 / cycle) < 0.35 / cycle ? cycle : null;
}

// frames: [{ wallMs, pts, checksum, scan }] in arrival order.
function analyseFrames(frames, { warmupSec = 0.5 } = {}) {
    const all = frames.filter((f) => Number.isFinite(f.pts));
    if (all.length < 3) return { ok: false, error: `only ${all.length} frame(s) received — the device delivered (almost) nothing` };
    const t0 = all[0].wallMs;
    const usable = all.filter((f) => f.wallMs - t0 >= warmupSec * 1000);
    const fr = usable.length >= 10 ? usable : all;
    const n = fr.length;
    const wallSpanSec = (fr[n - 1].wallMs - fr[0].wallMs) / 1000;
    const tsSpanSec = fr[n - 1].pts - fr[0].pts;
    const arrivalFps = wallSpanSec > 0 ? (n - 1) / wallSpanSec : null;
    const timestampFps = tsSpanSec > 0 ? (n - 1) / tsSpanSec : null;
    const deltas = [];
    let nonMonotonic = 0, duplicateTimestamps = 0;
    for (let i = 1; i < n; i++) {
        const d = fr[i].pts - fr[i - 1].pts;
        if (d < 0) nonMonotonic++;
        else if (d === 0) duplicateTimestamps++;
        deltas.push(d * 1000);
    }
    const medMs = median(deltas);
    let gaps = 0, missing = 0;
    for (const d of deltas) {
        if (medMs > 0 && d > 1.5 * medMs) { gaps++; missing += Math.round(d / medMs) - 1; }
    }
    // Duplicates: consecutive IDENTICAL point-sampled thumbnails. A real camera
    // frame always differs from the next one somewhere (sensor noise); a
    // bit-identical successor is a repeated frame.
    const dupPositions = [];
    let withChecksum = 0;
    for (let i = 1; i < n; i++) {
        if (!fr[i].checksum || !fr[i - 1].checksum) continue;
        withChecksum++;
        if (fr[i].checksum === fr[i - 1].checksum) dupPositions.push(i);
    }
    const dupFraction = withChecksum ? dupPositions.length / withChecksum : 0;
    const staticContent = withChecksum > 0 && dupFraction > 0.9;
    const cycle = staticContent ? null : dupCycle(dupPositions, withChecksum);
    const flagged = fr.filter((f) => f.scan === 'T' || f.scan === 'B');
    const deliveredFps = arrivalFps; // the wall clock is the ground truth for delivery
    const contentFps = deliveredFps && !staticContent ? deliveredFps * (1 - dupFraction) : deliveredFps;
    return {
        ok: true,
        frames: n, wallSpanSec: round(wallSpanSec, 2), tsSpanSec: round(tsSpanSec, 2),
        arrivalFps: round(arrivalFps, 2),
        timestampFps: round(timestampFps, 2),
        // 1.000 = one second of device time per real second. 0.833 = the device
        // stamps 50 real frames as if they were 60: footage plays 1.2× fast.
        timestampHonesty: wallSpanSec > 0 ? round(tsSpanSec / wallSpanSec, 3) : null,
        interval: { medianMs: round(medMs, 2), p95Ms: round(percentile(deltas, 0.95), 2), maxMs: round(Math.max(...deltas), 2), jitterMs: round(stdev(deltas), 2) },
        gaps, missingFrames: missing, nonMonotonic, duplicateTimestamps,
        duplicates: { count: dupPositions.length, fraction: round(dupFraction, 3), cycle, staticContent },
        contentFps: round(contentFps, 2),
        contentRate: snapRate(contentFps),
        deliveredRate: snapRate(deliveredFps),
        interlaceFlaggedFrames: flagged.length,
    };
}

function round(x, d) { return Number.isFinite(x) ? Number(x.toFixed(d)) : null; }

// Progressive or interlaced, from what the pixels show (idet), with the
// negotiated field order as a tie-breaker. A real interlaced feed is combed
// on almost every frame AND consistently in one field order; progressive
// footage with sharp motion trips idet occasionally in BOTH orders.
function scanVerdict(idet, stream) {
    if (!idet) return { mode: stream && ['tff', 'bff'].includes(stream.fieldOrder) ? 'interlaced' : 'unknown', fieldOrder: stream ? stream.fieldOrder : 'unknown', basis: 'negotiated media type only' };
    const inter = idet.tff + idet.bff;
    const decided = inter + idet.progressive;
    if (!decided) return { mode: 'unknown', fieldOrder: stream ? stream.fieldOrder : 'unknown', basis: 'idet undetermined (static or blank picture?)' };
    const share = inter / decided;
    const dominant = inter ? Math.max(idet.tff, idet.bff) / inter : 0;
    const interlaced = share >= 0.6 && dominant >= 0.85;
    return {
        mode: interlaced ? 'interlaced' : 'progressive',
        fieldOrder: interlaced ? (idet.tff >= idet.bff ? 'tff' : 'bff') : 'progressive',
        basis: `idet: ${idet.tff} TFF / ${idet.bff} BFF / ${idet.progressive} progressive`,
        combedShare: round(share, 2),
    };
}

// ---------------------------------------------------------------
// 🎯 NORMALIZATION PLAN — capture once, normalize once.
//
// Rules (each one pinned by a simulation in STREAM-ENGINE-AUDIT.md §K):
//  1. Card repeating frames (N−1 real + 1 repeat per N) → `decimate=cycle=N`
//     removes exactly the repeats and restores the camera's own cadence.
//  2. Deinterlace ONLY when the pixels are interlaced — never because a
//     dropdown said 50i. Bobbing progressive frames halves vertical detail
//     and doubles the rate into an uneven decimation.
//  3. Rate:  source == program   → passthrough (the relay's CFR grid keeps it)
//            source == k×program → `framestep=k`  — select by COUNT. The fps
//                                   filter anchors its grid on the first
//                                   frame, which puts every odd frame of a
//                                   2:1 source exactly on a rounding edge;
//                                   timestamp jitter then picks the wrong
//                                   one ~40% of the time (judder).
//            anything else       → `fps=program`, and it WILL judder: say so,
//                                   and name the rates that would not.
//  4. Timestamps: device stamps when the probe proved them honest (they are
//     capture-time stamps, immune to ffmpeg reading late); wall clock
//     otherwise.
// ---------------------------------------------------------------
function smoothProgramRates(sourceFps) {
    if (!(sourceFps > 0)) return [];
    return [25, 30, 50, 60].filter((r) => {
        const k = sourceFps / r;
        return k >= 0.99 && Math.abs(k - Math.round(k)) < 0.02;
    });
}

function rateStep(sourceFps, programFps) {
    const s = Number(sourceFps) || 0, p = Number(programFps) || 0;
    if (!s || !p) return { kind: 'unknown', filter: p ? `fps=${p}` : null };
    const k = s / p;
    if (Math.abs(k - 1) < 0.01) return { kind: 'passthrough', filter: null, ratio: 1 };
    if (k > 1.5 && Math.abs(k - Math.round(k)) < 0.02) return { kind: 'framestep', filter: `framestep=${Math.round(k)}`, ratio: Math.round(k) };
    if (k < 1) return { kind: 'upconvert', filter: `fps=${p}`, ratio: round(k, 3), judder: true, reason: `the source has only ${round(s, 2)} frames per second; ${p} would repeat frames` };
    return { kind: 'uneven', filter: `fps=${p}`, ratio: round(k, 3), judder: true, reason: `${round(s, 2)} fps does not divide evenly into ${p}` };
}

// measurement: analyseFrames() output; scan: scanVerdict(); opts.programFps
function planNormalization(measurement, scan, { programFps }) {
    const m = measurement || {};
    const steps = [];
    const notes = [];
    const honesty = m.timestampHonesty;
    const tsHonest = Number.isFinite(honesty) && Math.abs(honesty - 1) <= 0.01 && !m.nonMonotonic;
    // The compositor times every input — camera, audio, overlay — by ONE
    // clock (arrival wall time, see PROGRAM_CLOCK in nativePipeline.js). The
    // device's own stamps are still measured, because they are evidence: a
    // device that stamps at its nominal rate is exactly what made footage
    // timed by those stamps play fast.
    const timestamps = 'wallclock';
    const deviceTimestamps = !Number.isFinite(honesty) ? 'unknown' : tsHonest ? 'honest' : `nominal (${honesty}× real time)`;
    if (!tsHonest && Number.isFinite(honesty)) notes.push(`the device stamps frames at ${honesty}× real time — footage timed by those stamps would play ${honesty < 1 ? 'FAST' : 'SLOW'}; the program clock (arrival time) is used instead`);
    let sourceFps = m.deliveredRate || m.arrivalFps || null;
    const cycle = m.duplicates && m.duplicates.cycle;
    if (cycle) {
        steps.push(`decimate=cycle=${cycle}`);
        sourceFps = sourceFps ? sourceFps * (cycle - 1) / cycle : null;
        notes.push(`the device repeats 1 frame in every ${cycle} — removing the repeats restores the camera's own ${snapRate(sourceFps) || round(sourceFps, 2)} fps`);
    }
    const interlaced = scan && scan.mode === 'interlaced';
    if (interlaced) {
        steps.push(`yadif=mode=send_field:parity=${scan.fieldOrder === 'bff' ? 'bff' : 'tff'}:deint=all`);
        sourceFps = sourceFps ? sourceFps * 2 : null;
        notes.push(`the picture is interlaced (${scan.fieldOrder}) — each field becomes a frame`);
    }
    const snapped = snapRate(sourceFps) || (sourceFps ? round(sourceFps, 3) : null);
    const rate = rateStep(snapped, programFps);
    if (rate.filter) steps.push(rate.filter);
    const smooth = smoothProgramRates(snapped);
    if (rate.judder) notes.push(`⚠ ${rate.reason} — motion WILL judder. Smooth program rates for this source: ${smooth.join(', ') || 'none of 25/30/50/60'}`);
    return {
        deliveredFps: m.deliveredRate || m.arrivalFps || null,
        timestamps, deviceTimestamps, dedupeCycle: cycle || null, deinterlace: interlaced ? scan.fieldOrder : null,
        sourceFps: snapped, programFps: Number(programFps) || null,
        rate, smoothRates: smooth, cadence: rate.judder ? 'judder' : 'clean',
        chain: steps.join(','), notes,
    };
}

// Without a measurement (probe disabled or failed) the plan is built from
// the ADVERTISED device rate — still with count-based decimation, and with
// deinterlacing only if the device genuinely runs at the interlaced frame
// rate (a 60-fps-only card is not delivering 25 interlaced frames).
function planFromAdvertised({ deviceFps, programFps, interlacedSelected }) {
    const steps = [];
    const notes = ['not measured — built from what the device advertises'];
    let src = snapRate(Number(deviceFps)) || Number(deviceFps) || null;
    let deinterlace = null;
    if (interlacedSelected) {
        if (!src || src <= 30.5) { steps.push('yadif=mode=send_field:parity=auto:deint=all'); deinterlace = 'auto'; if (src) src *= 2; }
        else notes.push(`50i was selected but the device runs at ${round(src, 2)} fps — that is progressive delivery (the card has already converted it), so it is NOT deinterlaced`);
    }
    const rate = rateStep(src, programFps);
    if (rate.filter) steps.push(rate.filter);
    if (rate.judder) notes.push(`⚠ ${rate.reason} — motion WILL judder`);
    return { deliveredFps: snapRate(Number(deviceFps)) || Number(deviceFps) || null, timestamps: 'wallclock', dedupeCycle: null, deinterlace, sourceFps: src, programFps: Number(programFps) || null, rate, smoothRates: smoothProgramRates(src), cadence: rate.judder ? 'judder' : 'clean', chain: steps.join(','), notes, measured: false };
}

// How the PRE-FIX compositor chain (`fps=<program>` after an optional yadif
// chosen by the dropdown) would treat this source — so a report can say
// "this is what you were getting".
function legacyChainCadence(measurement, programFps) {
    const m = measurement || {};
    const s = m.deliveredRate || m.arrivalFps, p = Number(programFps);
    if (!s || !p) return 'unknown';
    if (m.duplicates && m.duplicates.cycle) return `judder (the device's repeated frames were kept: ${m.contentRate || m.contentFps}-fps motion in a ${s}-fps grid)`;
    const k = s / p;
    if (Math.abs(k - 1) < 0.01) return 'clean';
    if (k > 1.5 && Math.abs(k - Math.round(k)) < 0.02) return 'judder (fps-filter knife edge on an exact ' + Math.round(k) + ':1 decimation)';
    return 'judder (uneven ' + round(k, 2) + ':1)';
}

// ---------------------------------------------------------------
// Stage verdicts — what fails FIRST.
// ---------------------------------------------------------------
function stageVerdicts(report) {
    const m = report.measurement || {};
    const st = [];
    const push = (stage, status, detail) => st.push({ stage, status, detail });
    if (!m.ok) { push('DELIVERY', 'fail', m.error || 'no frames'); return st; }
    const neg = report.negotiated;
    const req = report.requested || {};
    if (!neg) push('NEGOTIATION', 'warn', 'ffmpeg did not report the negotiated media type');
    else if ((req.width && (neg.width !== req.width || neg.height !== req.height)) || (req.fps && neg.fps && Math.abs(neg.fps - req.fps) / req.fps > 0.02)) {
        push('NEGOTIATION', 'warn', `asked ${req.width || '?'}×${req.height || '?'}@${req.fps || '?'}, device set ${neg.width}×${neg.height}@${neg.fps}`);
    } else push('NEGOTIATION', 'ok', `${neg.width}×${neg.height} ${neg.pixFmt || neg.codec} @ ${neg.fps || '?'} fps (field order: ${neg.fieldOrder})`);
    if (neg && neg.fps && m.arrivalFps && Math.abs(m.arrivalFps - neg.fps) / neg.fps > 0.03) {
        push('DELIVERY', 'warn', `negotiated ${neg.fps} fps but ${m.arrivalFps} frames/s actually arrive`);
    } else push('DELIVERY', 'ok', `${m.arrivalFps} frames/s arrive`);
    if (report.captureDrops > 0 || m.missingFrames > 0) push('CAPTURE', 'fail', `${report.captureDrops} buffer-overflow drops, ${m.missingFrames} frames missing from the timeline (${m.gaps} gaps)`);
    else push('CAPTURE', 'ok', 'no dropped frames');
    const h = m.timestampHonesty;
    if (!Number.isFinite(h) || m.nonMonotonic) push('TIMESTAMPS', 'fail', `${m.nonMonotonic} non-monotonic timestamps`);
    else if (Math.abs(h - 1) > 0.01) push('TIMESTAMPS', 'fail', `device time runs at ${h}× real time — footage stamped with it plays ${h < 1 ? 'FAST' : 'SLOW'}`);
    else push('TIMESTAMPS', 'ok', `device time = real time (${h}×), jitter ${m.interval.jitterMs} ms`);
    if (m.duplicates.staticContent) push('CONTENT', 'warn', 'picture is static — point the camera at movement to measure repeats');
    else if (m.duplicates.cycle) push('CONTENT', 'warn', `device repeats 1 frame in ${m.duplicates.cycle}: ${m.arrivalFps} delivered, ${m.contentFps} real (${m.contentRate || '?'} fps camera)`);
    else if (m.duplicates.fraction > 0.02) push('CONTENT', 'warn', `${Math.round(m.duplicates.fraction * 100)}% repeated frames, irregular`);
    else push('CONTENT', 'ok', `${m.contentFps} unique frames/s`);
    const scan = report.scan || {};
    push('SCAN', scan.mode === 'interlaced' ? 'warn' : 'ok', `${scan.mode || 'unknown'} (${scan.basis || ''})`);
    const plan = report.plan || {};
    if (plan.cadence === 'judder') push('PROGRAM CADENCE', 'fail', `${plan.sourceFps} → ${plan.programFps} fps cannot be smooth. Smooth choices: ${(plan.smoothRates || []).join(', ') || 'none'}`);
    else push('PROGRAM CADENCE', 'ok', `${plan.sourceFps} → ${plan.programFps} fps via ${plan.chain || 'passthrough'}`);
    return st;
}

function overallHealth(stages) {
    if (stages.some((s) => s.status === 'fail')) return 'FAIL';
    if (stages.some((s) => s.status === 'warn')) return 'WARNING';
    return 'HEALTHY';
}

function buildReport({ label, device, requested, stderrText, frames, captureDrops, programFps, cpu }) {
    const negotiated = parseInputVideoStream(stderrText);
    const audio = parseInputAudioStream(stderrText, 1);
    const measurement = analyseFrames(frames);
    const scan = scanVerdict(parseIdet(stderrText), negotiated);
    const plan = measurement.ok ? planNormalization(measurement, scan, { programFps }) : null;
    const report = { label: label || device || 'source', device: device || null, requested: requested || {}, negotiated, audio, captureDrops: captureDrops || 0, measurement, scan, plan, cpu: cpu || null, at: new Date().toISOString() };
    if (plan) plan.legacyCadence = legacyChainCadence(measurement, programFps);
    report.stages = stageVerdicts(report);
    report.health = overallHealth(report.stages);
    const firstBad = report.stages.find((s) => s.status !== 'ok');
    report.firstProblem = firstBad || null;
    return report;
}

// Side by side, and the FIRST stage where the control is fine and the
// problem source is not.
function compareReports(a, b) {
    const rows = [];
    const v = (r, f) => { try { const x = f(r); return x == null ? '—' : String(x); } catch (e) { return '—'; } };
    const fields = [
        ['DEVICE', (r) => r.device],
        ['RESOLUTION', (r) => r.negotiated && `${r.negotiated.width}×${r.negotiated.height}`],
        ['REQUESTED FPS', (r) => r.requested && r.requested.fps],
        ['NEGOTIATED FPS', (r) => r.negotiated && r.negotiated.fps],
        ['ACTUAL FPS (arrival)', (r) => r.measurement.arrivalFps],
        ['UNIQUE FPS (content)', (r) => r.measurement.contentFps],
        ['SCAN MODE', (r) => r.scan && `${r.scan.mode} (${r.scan.fieldOrder})`],
        ['PIXEL FORMAT', (r) => r.negotiated && `${r.negotiated.pixFmt || '?'} (${r.negotiated.codec}${r.negotiated.fourcc ? '/' + r.negotiated.fourcc : ''})`],
        ['AUDIO FORMAT', (r) => r.audio && `${r.audio.codec} ${r.audio.sampleRate} Hz ${r.audio.channels}`],
        ['TIMESTAMP SOURCE', (r) => r.plan && `program clock; device stamps ${r.plan.deviceTimestamps}`],
        ['TIMEBASE (device/real)', (r) => r.measurement.timestampHonesty && `${r.measurement.timestampHonesty}×`],
        ['FRAME INTERVAL', (r) => `${r.measurement.interval.medianMs} ms ±${r.measurement.interval.jitterMs}`],
        ['DROPPED FRAMES', (r) => `${r.captureDrops} overflow / ${r.measurement.missingFrames} missing`],
        ['DUPLICATED FRAMES', (r) => `${r.measurement.duplicates.count}${r.measurement.duplicates.cycle ? ` (1 in ${r.measurement.duplicates.cycle})` : ''}`],
        ['CPU (system)', (r) => r.cpu && `${r.cpu.percent}%`],
        ['OLD CHAIN CADENCE', (r) => r.plan && r.plan.legacyCadence],
        ['NEW CHAIN', (r) => r.plan && (r.plan.chain || 'passthrough')],
        ['NEW CHAIN CADENCE', (r) => r.plan && r.plan.cadence],
        ['HEALTH', (r) => r.health],
    ];
    for (const [name, f] of fields) rows.push({ name, a: v(a, f), b: v(b, f) });
    let firstDivergence = null;
    const bStages = new Map((b.stages || []).map((s) => [s.stage, s]));
    for (const sa of a.stages || []) {
        const sb = bStages.get(sa.stage);
        if (sb && sa.status === 'ok' && sb.status !== 'ok') { firstDivergence = { stage: sa.stage, control: sa.detail, problem: sb.detail, status: sb.status }; break; }
    }
    return { rows, firstDivergence };
}

// ---------------------------------------------------------------
// Runner
// ---------------------------------------------------------------
function dshowInputArgs({ device, width, height, fps, audioDevice }) {
    const args = ['-f', 'dshow', '-rtbufsize', '256M'];
    if (width && height) args.push('-video_size', `${width}x${height}`);
    if (fps) args.push('-framerate', String(fps));
    args.push('-i', `video=${device}`);
    if (audioDevice) args.push('-f', 'dshow', '-i', `audio=${audioDevice}`);
    return args;
}

function probeArgs(inputArgs, maxSeconds) {
    return [
        '-hide_banner', '-nostats', '-loglevel', 'level+info',
        ...inputArgs,
        // idet on the full-resolution picture; the checksum on a point-sampled
        // thumbnail (neighbor = exact source pixels, so sensor noise still
        // tells two real frames apart, while a repeated frame is identical).
        '-filter_complex', '[0:v]idet,scale=64:36:flags=neighbor,showinfo[m]',
        '-map', '[m]', '-t', String(maxSeconds), '-f', 'null', '-',
    ];
}

function cpuTimes() {
    return os.cpus().reduce((acc, c) => { const t = c.times; acc.idle += t.idle; acc.total += t.user + t.nice + t.sys + t.idle + t.irq; return acc; }, { idle: 0, total: 0 });
}

// spawnFfmpeg(args, opts) → ChildProcess. Resolves with a report; never rejects.
function runProbe({ spawnFfmpeg, inputArgs, seconds = 6, label, device, requested, programFps = 30 }) {
    return new Promise((resolve) => {
        const frames = [];
        let text = '';
        let buf = '';
        let captureDrops = 0;
        const cpu0 = cpuTimes();
        let proc;
        try {
            proc = spawnFfmpeg(probeArgs(inputArgs, seconds * 3 + 5), { stdio: ['pipe', 'ignore', 'pipe'] });
        } catch (e) {
            return resolve(buildReport({ label, device, requested, stderrText: '', frames: [], programFps, cpu: null, captureDrops: 0 }));
        }
        let firstFrameAt = null;
        const stopTimer = setInterval(() => {
            if (firstFrameAt && Date.now() - firstFrameAt >= seconds * 1000) { clearInterval(stopTimer); try { proc.stdin.write('q'); } catch (e) {} }
        }, 100);
        const hardTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, (seconds + 20) * 1000);
        proc.stdin && proc.stdin.on('error', () => {});
        proc.on('error', () => {});
        proc.stderr.on('data', (chunk) => {
            const now = Date.now();
            buf += chunk.toString();
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx).replace(/\r$/, '');
                buf = buf.slice(idx + 1);
                const f = parseShowinfoLine(line);
                if (f) { if (!firstFrameAt) firstFrameAt = now; frames.push({ ...f, wallMs: now }); continue; }
                if (CAPTURE_DROP_RE.test(line)) captureDrops++;
                if (/color_range:/.test(line)) continue;
                if (text.length < 200000) text += line + '\n';
            }
        });
        proc.on('close', () => {
            clearInterval(stopTimer); clearTimeout(hardTimer);
            if (buf) text += buf;
            const cpu1 = cpuTimes();
            const dt = cpu1.total - cpu0.total;
            const cpu = dt > 0 ? { percent: Math.round(100 * (1 - (cpu1.idle - cpu0.idle) / dt)) } : null;
            const report = buildReport({ label, device, requested, stderrText: text, frames, captureDrops, programFps, cpu });
            report.stderrTail = text.split('\n').filter((l) => /\[(warning|error|fatal)\]/.test(l)).slice(-10);
            resolve(report);
        });
    });
}

function formatReport(r) {
    const m = r.measurement;
    const lines = [`── ${r.label} ──`];
    if (!m.ok) { lines.push(`  ✗ ${m.error}`); if (r.stderrTail) lines.push(...r.stderrTail.map((l) => '    ' + l)); return lines.join('\n'); }
    for (const s of r.stages) lines.push(`  ${s.status === 'ok' ? '✓' : s.status === 'warn' ? '⚠' : '✗'} ${s.stage.padEnd(16)} ${s.detail}`);
    if (r.plan) {
        lines.push(`  → normalize: ${r.plan.chain || 'passthrough'}  (device stamps: ${r.plan.deviceTimestamps})`);
        for (const n of r.plan.notes) lines.push(`    • ${n}`);
    }
    lines.push(`  HEALTH: ${r.health}`);
    return lines.join('\n');
}

function formatComparison(a, b) {
    const { rows, firstDivergence } = compareReports(a, b);
    const w = Math.max(18, ...rows.map((r) => r.a.length)) + 2;
    const out = [`${''.padEnd(24)}${'A: ' + a.label}`.padEnd(24 + w) + `B: ${b.label}`];
    for (const r of rows) out.push(`${r.name.padEnd(24)}${r.a.padEnd(w)}${r.b}`);
    out.push('');
    out.push(firstDivergence
        ? `FIRST POINT OF DIVERGENCE: ${firstDivergence.stage}\n  A: ${firstDivergence.control}\n  B: ${firstDivergence.problem}`
        : 'No stage where A is healthy and B is not.');
    return out.join('\n');
}

module.exports = {
    parseInputVideoStream, parseInputAudioStream, parseShowinfoLine, parseIdet,
    analyseFrames, scanVerdict, planNormalization, planFromAdvertised, rateStep,
    smoothProgramRates, snapRate, legacyChainCadence, stageVerdicts, buildReport, compareReports,
    dshowInputArgs, probeArgs, runProbe, formatReport, formatComparison, CAPTURE_DROP_RE,
};

// ---------------------------------------------------------------
// CLI
// ---------------------------------------------------------------
if (require.main === module) {
    const path = require('path');
    const fs = require('fs');
    const { spawn } = require('child_process');
    const argv = process.argv.slice(2);
    const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
    const has = (name) => argv.includes(name);
    const ffmpeg = process.env.FFMPEG_PATH
        || [path.join(__dirname, 'bin', 'ffmpeg.exe'), path.join(__dirname, 'ffmpeg.exe'), path.join(__dirname, 'bin', 'ffmpeg')].find((p) => fs.existsSync(p))
        || 'ffmpeg';
    const spawnFfmpeg = (args, o) => spawn(ffmpeg, args, { windowsHide: true, ...o });
    const seconds = Number(opt('--seconds', 6));
    const programFps = Number(opt('--program-fps', 30));
    const size = opt('--size', null);
    const [w, h] = size ? size.split('x').map(Number) : [null, null];
    const fps = opt('--fps', null) ? Number(opt('--fps')) : null;
    const audioDevice = opt('--audio', null);
    const probeOne = (device, label) => {
        const lavfi = opt('--lavfi', null);
        const inputArgs = device === '@lavfi' ? ['-re', '-f', 'lavfi', '-i', lavfi] : dshowInputArgs({ device, width: w, height: h, fps, audioDevice });
        console.log(`probing "${label || device}" for ${seconds}s …`);
        return runProbe({ spawnFfmpeg, inputArgs, seconds, label: label || device, device, requested: { width: w, height: h, fps }, programFps });
    };
    (async () => {
        if (has('--list')) {
            const p = spawnFfmpeg(['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { stdio: ['ignore', 'ignore', 'pipe'] });
            p.stderr.pipe(process.stdout);
            return;
        }
        let out;
        if (has('--compare')) {
            const i = argv.indexOf('--compare');
            const a = await probeOne(argv[i + 1], `A (control) ${argv[i + 1]}`);
            const b = await probeOne(argv[i + 2], `B (problem) ${argv[i + 2]}`);
            console.log('\n' + formatReport(a) + '\n\n' + formatReport(b) + '\n\n' + formatComparison(a, b));
            out = { a, b, comparison: compareReports(a, b) };
        } else if (opt('--device', null)) {
            const r = await probeOne(opt('--device'));
            console.log('\n' + formatReport(r));
            out = r;
        } else {
            console.log('usage:\n  node sourceProbe.js --list\n  node sourceProbe.js --device "<name>" [--size 1920x1080] [--fps 60] [--program-fps 50] [--seconds 6] [--audio "<name>"]\n  node sourceProbe.js --compare "<control device>" "<problem device>" [--program-fps 30]');
            return;
        }
        const file = opt('--out', null);
        if (file) { fs.writeFileSync(file, JSON.stringify(out, null, 2)); console.log(`\nfull report written to ${file}`); }
    })();
}
