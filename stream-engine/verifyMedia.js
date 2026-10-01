// ================================================================
// 🧾 VERIFY A RECORDING — the file is the source of truth, not the UI.
//
// Reads every packet's timestamps WITHOUT decoding (`-c copy -f framecrc`),
// so a 7-hour master.mp4 is checked in the time it takes to read it from
// disk. Reports, per stream: codec, resolution, frame rate, timebase, packet
// count, duration, PTS/DTS monotonicity and gaps — and the two numbers that
// settle "does it play at the right speed?":
//
//   media duration vs the real time it was recorded over (--expect-seconds)
//   video duration vs audio duration (A/V drift)
//
//   node verifyMedia.js "StreamEngineData\Recordings\<match>\master.mp4" --expect-seconds 3600
// ================================================================
const { spawn } = require('child_process');

// "#tb 0: 1/15360"  and  "0,     1024,     1024,      512,    12345, 0x1234abcd"
function parseFramecrc(text) {
    const tb = {};
    const streams = {};
    for (const line of String(text).split('\n')) {
        let m = /^#tb (\d+): (\d+)\/(\d+)/.exec(line);
        if (m) { tb[m[1]] = Number(m[2]) / Number(m[3]); continue; }
        if (line.startsWith('#') || !line.trim()) continue;
        const f = line.split(',').map((x) => x.trim());
        if (f.length < 5) continue;
        const idx = f[0];
        const s = streams[idx] || (streams[idx] = { packets: 0, first: null, last: null, lastDur: 0, nonMonotonicDts: 0, maxGap: 0, gaps: 0, prevDts: null, durs: new Map() });
        const dts = Number(f[1]), pts = Number(f[2]), dur = Number(f[3]);
        s.packets++;
        if (s.first === null || pts < s.first) s.first = pts;
        if (s.last === null || pts > s.last) { s.last = pts; s.lastDur = dur; }
        if (s.prevDts !== null) {
            const d = dts - s.prevDts;
            if (d <= 0) s.nonMonotonicDts++;
            if (dur > 0 && d > 1.5 * dur) { s.gaps++; if (d > s.maxGap) s.maxGap = d; }
        }
        s.prevDts = dts;
        s.durs.set(dur, (s.durs.get(dur) || 0) + 1);
    }
    const out = {};
    for (const [idx, s] of Object.entries(streams)) {
        const t = tb[idx] || 1;
        const commonDur = [...s.durs.entries()].sort((a, b) => b[1] - a[1])[0];
        out[idx] = {
            timebase: tb[idx] ? `1/${Math.round(1 / tb[idx])}` : null,
            packets: s.packets,
            durationSec: Number(((s.last - s.first + s.lastDur) * t).toFixed(3)),
            startSec: Number((s.first * t).toFixed(3)),
            packetDurationSec: commonDur ? Number((commonDur[0] * t).toFixed(6)) : null,
            nonMonotonicDts: s.nonMonotonicDts,
            gaps: s.gaps, maxGapSec: Number((s.maxGap * t).toFixed(3)),
        };
    }
    return out;
}

function parseStreams(stderr) {
    const v = /Stream #0:(\d+)[^:]*: Video: ([^,]+).*?, (\d+)x(\d+)[^\n]*?([\d.]+) fps/.exec(stderr);
    const a = /Stream #0:(\d+)[^:]*: Audio: ([^,]+), (\d+) Hz, ([^,]+)/.exec(stderr);
    return {
        video: v ? { index: v[1], codec: v[2].trim(), width: Number(v[3]), height: Number(v[4]), fps: Number(v[5]) } : null,
        audio: a ? { index: a[1], codec: a[2].trim(), sampleRate: Number(a[3]), channels: a[4].trim() } : null,
    };
}

function verdictFor(report, { expectSeconds = null, tolerance = 0.01 } = {}) {
    const checks = [];
    const v = report.video, a = report.audio;
    if (!v) { checks.push({ check: 'video stream', ok: false, detail: 'no video stream' }); return checks; }
    const frameDur = v.packetDurationSec || (v.fps ? 1 / v.fps : null);
    checks.push({ check: 'frame rate', ok: !!frameDur, detail: `${v.fps} fps declared, ${frameDur ? (1 / frameDur).toFixed(3) : '?'} fps by packet duration` });
    checks.push({ check: 'frame count vs duration', ok: frameDur ? Math.abs(v.packets * frameDur - v.durationSec) <= 2 * frameDur + 0.001 * v.durationSec : false, detail: `${v.packets} frames × ${frameDur ? frameDur.toFixed(5) : '?'} s = ${frameDur ? (v.packets * frameDur).toFixed(2) : '?'} s; timeline ${v.durationSec} s` });
    checks.push({ check: 'video timestamps', ok: v.nonMonotonicDts === 0, detail: `${v.nonMonotonicDts} non-monotonic DTS, ${v.gaps} gap(s)${v.gaps ? `, largest ${v.maxGapSec} s` : ''}` });
    if (a) {
        const drift = a.durationSec - v.durationSec;
        checks.push({ check: 'A/V duration', ok: Math.abs(drift) <= 0.3, detail: `audio ${a.durationSec} s vs video ${v.durationSec} s (${drift >= 0 ? '+' : ''}${drift.toFixed(3)} s)` });
        checks.push({ check: 'audio timestamps', ok: a.nonMonotonicDts === 0, detail: `${a.nonMonotonicDts} non-monotonic DTS, ${a.gaps} gap(s)` });
    }
    if (expectSeconds) {
        const ratio = v.durationSec / expectSeconds;
        const ok = Math.abs(ratio - 1) <= tolerance;
        checks.push({ check: 'SPEED (file vs real time)', ok, detail: `${v.durationSec} s of media for ${expectSeconds} s of real time = ${ratio.toFixed(4)}×${ok ? '' : ratio < 1 ? ' — PLAYS FAST' : ' — PLAYS SLOW'}` });
    }
    return checks;
}

function verifyMedia({ ffmpegPath = 'ffmpeg', file, expectSeconds = null }) {
    return new Promise((resolve) => {
        let out = '', err = '';
        const p = spawn(ffmpegPath, ['-hide_banner', '-nostats', '-i', file, '-map', '0', '-c', 'copy', '-f', 'framecrc', '-'], { windowsHide: true });
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { if (err.length < 100000) err += d; });
        p.on('error', (e) => resolve({ ok: false, error: e.message }));
        p.on('close', () => {
            const streams = parseFramecrc(out);
            const info = parseStreams(err);
            const video = info.video && streams[info.video.index] ? { ...info.video, ...streams[info.video.index] } : null;
            const audio = info.audio && streams[info.audio.index] ? { ...info.audio, ...streams[info.audio.index] } : null;
            const report = { file, video, audio };
            report.checks = verdictFor(report, { expectSeconds });
            report.ok = report.checks.every((c) => c.ok);
            resolve(report);
        });
    });
}

module.exports = { parseFramecrc, parseStreams, verdictFor, verifyMedia };

if (require.main === module) {
    const path = require('path');
    const fs = require('fs');
    const argv = process.argv.slice(2);
    const file = argv.find((x) => !x.startsWith('--') && argv[argv.indexOf(x) - 1] !== '--expect-seconds');
    const i = argv.indexOf('--expect-seconds');
    const expectSeconds = i >= 0 ? Number(argv[i + 1]) : null;
    if (!file) { console.log('usage: node verifyMedia.js <file.mp4> [--expect-seconds N]'); process.exit(2); }
    const ffmpegPath = process.env.FFMPEG_PATH
        || [path.join(__dirname, 'bin', 'ffmpeg.exe'), path.join(__dirname, 'ffmpeg.exe'), path.join(__dirname, 'bin', 'ffmpeg')].find((p) => fs.existsSync(p))
        || 'ffmpeg';
    verifyMedia({ ffmpegPath, file, expectSeconds }).then((r) => {
        if (r.error) { console.log(`✗ ${r.error}`); process.exit(1); }
        const v = r.video, a = r.audio;
        console.log(`${r.file}`);
        if (v) console.log(`  video  ${v.codec} ${v.width}×${v.height} @ ${v.fps} fps, tb ${v.timebase}, ${v.packets} frames, ${v.durationSec} s`);
        if (a) console.log(`  audio  ${a.codec} ${a.sampleRate} Hz ${a.channels}, tb ${a.timebase}, ${a.durationSec} s`);
        for (const c of r.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.check.padEnd(26)} ${c.detail}`);
        process.exit(r.ok ? 0 : 1);
    });
}
