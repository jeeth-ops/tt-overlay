// ================================================================
// 🎛 CAPTURE FORMAT — vMix-style, validated, never silently changed.
//
// Two things that were previously conflated and must stay separate:
//
//   CAPTURE FORMAT   what we ask the CAMERA / AVMATRIX card for
//   OUTPUT FORMAT    what the program feed, recording and stream are
//
// They are not the same choice, and the 720x480 case is exactly why.
// "720x480 @ 25p output" must NOT be achieved by forcing the capture card
// down to 720x480: an HDMI camera hands the card 1920x1080, the card is
// asked for something it may not even offer, and if it does offer it the
// downscale happens in the card's firmware with no control over quality.
// The right thing is to capture at the card's best mode and scale to
// 720x480 once, in the compositor, with a known filter. So capture
// resolution defaults to AUTO (take the device's best mode, constrain
// nothing) and output resolution is chosen independently.
//
// 🛠 WHAT THIS REPLACES.
//
// Frame rate used to be clamped with
//
//     const fpsNum = [30, 60].includes(Number(fps)) ? Number(fps) : 30;
//
// in three places. So 25p and 50p — the modes a PAL-region camera and an
// AVMATRIX card actually run in — were not merely unsupported, they were
// silently rewritten to 30. Asking for 25 got 30, and the operator was
// never told; that is the "silent fallback" this module exists to end.
// Every rejection here names what was asked for, what the device really
// offers, and what to do about it.
// ================================================================

// Output resolutions, in the order the operator should see them.
// 720x480 is 4:3 standard-definition (DV/NTSC) — deliberately last, and
// deliberately NOT a capture constraint.
const OUTPUT_RESOLUTIONS = {
    '1080p':  { width: 1920, height: 1080, label: '1920×1080', aspect: '16:9' },
    '720p':   { width: 1280, height: 720,  label: '1280×720',  aspect: '16:9' },
    '480p':   { width: 854,  height: 480,  label: '854×480',   aspect: '16:9' },
    '480sd':  { width: 720,  height: 480,  label: '720×480',   aspect: '4:3'  },
};

// 🎞 VIDEO MODES.
//
// 50i is 50 FIELDS per second = 25 interlaced FRAMES per second, which is
// what the device is asked for (dshow counts frames, not fields). Those
// fields must then be deinterlaced deliberately rather than left to
// whatever the encoder assumes:
//
//   yadif=mode=send_field  one output frame PER FIELD -> 50p
//
// which is the point of shooting 50i in the first place — the motion is
// in the fields, and halving it back to 25p throws away exactly what the
// mode was chosen for. Field order is taken from the stream (tff/bff is
// signalled by the device) rather than hardcoded; yadif's `auto` parity
// follows it.
const VIDEO_MODES = {
    '25p': { label: '25p', captureFps: 25, programFps: 25, interlaced: false },
    '50p': { label: '50p', captureFps: 50, programFps: 50, interlaced: false },
    '50i': { label: '50i (deinterlaced to 50p)', captureFps: 25, programFps: 50, interlaced: true },
    // Kept so existing setups and saved settings keep working unchanged.
    '30p': { label: '30p', captureFps: 30, programFps: 30, interlaced: false },
    '60p': { label: '60p', captureFps: 60, programFps: 60, interlaced: false },
};

// Bitrates per output resolution and PROGRAM frame rate. 25 and 50 exist
// here as first-class rates — the old table had only 30 and 60, so a 25p
// selection would have produced an undefined bitrate.
const DEFAULT_BITRATE_KBPS = {
    '1080p': { 25: 5000, 30: 6000, 50: 10000, 60: 12000 },
    '720p':  { 25: 3000, 30: 3500, 50: 4800,  60: 5500 },
    '480p':  { 25: 1800, 30: 2000, 50: 2200,  60: 2500 },
    '480sd': { 25: 1500, 30: 1800, 50: 2000,  60: 2200 },
};

function defaultBitrateKbps(resolutionKey, programFps) {
    const row = DEFAULT_BITRATE_KBPS[resolutionKey] || DEFAULT_BITRATE_KBPS['1080p'];
    if (row[programFps]) return row[programFps];
    // An unlisted rate is interpolated from 30p rather than falling back to
    // a wrong number — the point is never to invent a silent default.
    return Math.round(row[30] * (Number(programFps) || 30) / 30);
}

// ----------------------------------------------------------------
// WHICH MODES BELONG TO WHICH RESOLUTION
// ----------------------------------------------------------------
// The operator must not be offered a combination the product does not
// support, and 720x480 is the case that matters: it is a 4:3
// standard-definition profile and 25p is the only mode for it here.
// Offering 50p/50i there would be a promise the pipeline is not making.
//
// This is also why the operator never sees the device's raw capability list
// (PAL 50i, NTSC 59.94i, FILM 23.976, 100p, 120p, 200p …). Those are device
// noise; the panel shows production profiles.
const MODES_BY_RESOLUTION = {
    '1080p': ['25p', '50p', '50i', '30p', '60p'],
    '720p':  ['25p', '50p', '50i', '30p', '60p'],
    '480p':  ['25p', '50p', '30p'],
    '480sd': ['25p'],
};
function modesFor(resolutionKey) {
    return MODES_BY_RESOLUTION[resolutionKey] || MODES_BY_RESOLUTION['1080p'];
}
function isAllowedCombination(resolutionKey, modeKey) {
    return modesFor(resolutionKey).includes(modeKey);
}

function resolveOutput(resolutionKey, modeKey) {
    const res = OUTPUT_RESOLUTIONS[resolutionKey] ? resolutionKey : '1080p';
    // A combination that is not offered for this resolution falls back to the
    // first mode that IS — and the caller reports it, never silently.
    const mode = (VIDEO_MODES[modeKey] && isAllowedCombination(res, modeKey)) ? modeKey : modesFor(res)[0];
    const { width, height } = OUTPUT_RESOLUTIONS[res];
    const m = VIDEO_MODES[mode];
    return {
        resolution: res, width, height,
        mode, programFps: m.programFps, captureFps: m.captureFps,
        interlacedSource: m.interlaced,
        bitrateKbps: defaultBitrateKbps(res, m.programFps),
    };
}

// ----------------------------------------------------------------
// CAPABILITY VALIDATION — against what the device really reports
// ----------------------------------------------------------------
// `offered` is parseDshowVideoModes()'s output: [{width,height,minFps,
// maxFps,compressed}]. A device advertising a RANGE (minFps 5, maxFps 60)
// will accept any rate in it and then deliver whatever the camera feeds
// it — which is the AVMATRIX pass-through behaviour that produced the
// wrong-speed recordings. So a range match is reported as a WEAKER result
// than an exact match, and the caller says so instead of promising it.
function validateCaptureMode(offered, { captureFps, captureWidth = null, captureHeight = null }) {
    const modes = Array.isArray(offered) ? offered : [];
    if (!modes.length) {
        return {
            ok: true, confidence: 'unknown',
            detail: 'The device did not report its modes, so nothing could be checked in advance. It will be opened unconstrained and the real rate measured once it runs.',
        };
    }
    const sizeMatches = (captureWidth && captureHeight)
        ? modes.filter((m) => m.width === captureWidth && m.height === captureHeight)
        : modes;
    if (!sizeMatches.length) {
        return {
            ok: false, confidence: 'none',
            detail: `This device does not offer ${captureWidth}×${captureHeight}. It offers: ${describeOffered(modes)}.`,
        };
    }
    const exact = sizeMatches.filter((m) => Math.round(m.minFps) === Math.round(captureFps) && Math.round(m.maxFps) === Math.round(captureFps));
    if (exact.length) {
        return { ok: true, confidence: 'exact', detail: `The device reports ${captureFps} fps as a fixed mode.` };
    }
    const inRange = sizeMatches.filter((m) => captureFps >= Math.floor(m.minFps) && captureFps <= Math.ceil(m.maxFps));
    if (inRange.length) {
        return {
            ok: true, confidence: 'range',
            detail: `The device advertises ${Math.round(inRange[0].minFps)}–${Math.round(inRange[0].maxFps)} fps as a range, so it will ACCEPT ${captureFps} without promising to deliver it. Capture cards commonly pass through whatever the camera sends instead. The real rate is measured once running — watch FPS (req/actual).`,
        };
    }
    // 🛠 A DEVICE THAT ONLY RUNS FASTER IS NOT A DEVICE THAT CANNOT DO THIS.
    // This used to return a flat "not available" for any rate the device does
    // not list — so an AVMATRIX card fixed at 60 fps was reported as unable to
    // do 30p, which is false: 60 decimates to 30 perfectly, two frames to one.
    // What actually matters is whether the decimation is EVEN. 60 -> 30 is
    // 2:1 and smooth; 60 -> 25 is 2.4:1 and there is no even way to drop 35 of
    // every 60 frames, so it judders no matter what the rest of the chain
    // does. That is arithmetic, not a bug, and the operator is told which
    // rates this device CAN give smoothly.
    const faster = sizeMatches.filter((m) => captureFps < Math.ceil(m.maxFps));
    if (faster.length) {
        const best = faster.reduce((a, b) => (b.maxFps > a.maxFps ? b : a));
        const src = Math.round(best.maxFps);
        const ratio = best.maxFps / captureFps;
        const even = Math.abs(ratio - Math.round(ratio)) < 0.02;
        const clean = [60, 50, 30, 25].filter((r) => r <= best.maxFps && Math.abs(best.maxFps / r - Math.round(best.maxFps / r)) < 0.02);
        if (even) {
            return {
                ok: true, confidence: 'decimated',
                detail: `The device ADVERTISES ${src} fps and ${captureFps} divides into it evenly (${Math.round(ratio)}:1), so every ${ratio === 2 ? 'other' : Math.round(ratio) + 'th'} frame is kept — smooth IF the card really carries ${src} fps. A 50 Hz (PAL) camera behind a 60-only card is not: the source probe measures what actually arrives when the camera opens.`,
            };
        }
        // 🛠 A WARNING, NOT A REFUSAL. This used to return ok:false and block
        // Go Live — and on the operator's UC2018 that was exactly wrong: the
        // card ADVERTISES only 60 fps, but carrying a 25p Sony it delivers 25
        // unique frames held over the 60 slots (measured), so 25p is the one
        // smooth choice and the check refused it. The advertised rate cannot
        // decide cadence; the source probe measures it when the camera opens.
        return {
            ok: true, confidence: 'uneven',
            detail: `This device ADVERTISES ${src} fps, and ${captureFps} does not divide evenly into that (${ratio.toFixed(2)}:1) — smooth only if the camera's real rate fits ${captureFps}` +
                (clean.length ? ` (from a real ${src} fps: ${clean.join(', ')})` : '') +
                `. A 50 Hz camera behind a 60-only card usually carries 25 or 50 real frames — the engine measures this when the camera opens.`,
        };
    }
    return {
        ok: false, confidence: 'none',
        detail: `This device does not offer ${captureFps} fps${captureWidth ? ` at ${captureWidth}×${captureHeight}` : ''}. It offers: ${describeOffered(sizeMatches)}.`,
    };
}

function describeOffered(modes) {
    const seen = [...new Set(modes.map((m) => {
        const rate = Math.round(m.minFps) === Math.round(m.maxFps)
            ? `${Math.round(m.maxFps)}`
            : `${Math.round(m.minFps)}–${Math.round(m.maxFps)}`;
        return `${m.width}×${m.height} @ ${rate}fps${m.compressed ? ' (mjpeg)' : ''}`;
    }))];
    return seen.slice(0, 12).join(', ') + (seen.length > 12 ? `, +${seen.length - 12} more` : '');
}

// ----------------------------------------------------------------
// THE COMPOSITOR'S CAMERA FILTER CHAIN
// ----------------------------------------------------------------
// Order matters and is not arbitrary:
//
//   yadif BEFORE scale — deinterlacing a frame that has already been
//   resized blends the two fields together first, so the fields can no
//   longer be separated and the result is permanently soft. Deinterlace
//   at the source resolution, then scale.
//
// `parity=-1` (auto) takes field order from the stream, which the device
// signals; hardcoding tff would invert motion on a bff source.
function cameraFilterChain({ interlacedSource, sourceWidth, sourceHeight, outWidth, outHeight, programFps }) {
    const parts = [];
    if (interlacedSource) parts.push('yadif=mode=send_field:parity=-1:deint=all');
    const needsScale = !sourceWidth || !sourceHeight || sourceWidth !== outWidth || sourceHeight !== outHeight;
    if (needsScale) parts.push(`scale=${outWidth}:${outHeight}:flags=bicubic`);
    parts.push('setsar=1');
    parts.push(`fps=${programFps}`);
    parts.push('format=yuv420p');
    return parts.join(',');
}

// ----------------------------------------------------------------
// REQUESTED vs ACTUAL
// ----------------------------------------------------------------
// "Selected 50p" and "the device is delivering 50" are different facts, and
// the panel must never show the first as if it were the second. A rate within
// 2% counts as matched (encoders and cards wobble); anything else is a
// MISMATCH with both numbers named.
function captureMatch(requestedFps, actualFps) {
    const req = Number(requestedFps) || null;
    const act = Number(actualFps) || null;
    if (!req) return { status: 'unknown', requestedFps: req, actualFps: act };
    if (!act) return { status: 'measuring', requestedFps: req, actualFps: null };
    const matched = Math.abs(act - req) / req <= 0.02;
    return { status: matched ? 'matched' : 'mismatch', requestedFps: req, actualFps: Number(act.toFixed(2)) };
}

// What the operator sees: the format at each stage of the chain, so a
// mismatch anywhere is visible instead of inferred.
function activeFormatSummary({ source, program, recording, youtube }) {
    const fmt = (s) => (s && s.width ? `${s.width}×${s.height} @ ${s.fps || '?'}${s.interlaced ? 'i' : 'p'}` : null);
    return { source: fmt(source), program: fmt(program), recording: fmt(recording), youtube: fmt(youtube) };
}

module.exports = {
    OUTPUT_RESOLUTIONS, VIDEO_MODES, DEFAULT_BITRATE_KBPS,
    defaultBitrateKbps, resolveOutput,
    MODES_BY_RESOLUTION, modesFor, isAllowedCombination, captureMatch,
    validateCaptureMode, describeOffered,
    cameraFilterChain, activeFormatSummary,
};
