'use strict';
/**
 * highlight-edit.js — the "pro edit" of a downloaded highlights video.
 *
 * A plain compile glues the clips end to end: hard cuts, no titles. This turns
 * the same clips into a package ready to post:
 *
 *   title card ─▶ clip ─▶ band wipe ─▶ clip ─▶ band wipe ─▶ … ─▶ end card
 *
 * - The title card (~2.6 s) opens on the brand band, which whips away onto the
 *   player: the name, the team's badge, the tournament and the match, what the
 *   video holds and the player's figures (runs and balls, fours, sixes /
 *   wickets, overs…) — over a blurred, slowly pushing still of the first clip.
 * - Each clip carries a small event tag at the top left for its first few
 *   seconds (SIX / FOUR / WICKET …, the player, the over and the bowler), gone
 *   long before the ball is bowled: the shot itself is never covered. Top left
 *   on purpose: the broadcast score bar (bottom) and the channel logo (top
 *   right) are already in the picture.
 * - Between clips a branded band sweeps across: a slab in the colour of what
 *   comes next, then the navy panel with the logo. It is motion-blurred while
 *   it rushes in and out, all but stops while it covers the cut (so a cut is
 *   never seen), and a glint of light crosses the logo. It is silent: the only
 *   sound in the video is the clips' own.
 * - The end card (1.6 s): the band clears onto the logo, which springs into
 *   place under a sweep of light, then the website and a fade to black.
 * - Two shapes: 16:9 (YouTube) or 9:16 (Reels / Shorts / status). In 9:16 the
 *   whole 16:9 picture sits in the middle over a blurred copy of itself (the
 *   action is never cropped) and the tag lives in the space above it.
 * - Optionally an animated wagon wheel (highlight-wheel.js): where the shot
 *   went, or the stumps flashing for a bowled. In 16:9 it comes in at the top
 *   left only after the shot, when the tag has long gone; in 9:16 it has the
 *   space under the picture. Either way, never over the batter, the bowler or
 *   the ball.
 * - The footage is sharpened a touch (luma only), for phones.
 * - One H.264 / AAC MP4 (faststart): 1080p or 720p, 25 or 30 fps.
 *
 * Fast, and kind to the live server:
 * - Each clip is rendered on its own into a segment that already holds its
 *   half of the wipe on either side. The band's path is ONE function of time,
 *   split at the cut, so two segments rendered apart meet without a seam —
 *   and a segment can be cached and reused by any later video with that clip.
 * - The band's frames for either side of a cut — in place, motion-blurred
 *   for their speed (a handful of pre-blurred copies of the band, each frame
 *   taking the one it needs), glint and all — are drawn ONCE per format and
 *   colour, as a short clip with alpha. A segment only lays that clip over
 *   its first and last few frames; the rest of it streams straight through.
 * - Every segment is encoded with the same "stitchable" x264 settings, so the
 *   finished picture is a stream copy of the segments (no second encode); the
 *   sound rides in each segment losslessly and is encoded once, as one track.
 * - One ffmpeg at a time, at low priority (nice), so live scoring on the same
 *   machine never waits behind an edit.
 * - Built for the server's ffmpeg 4.1 static build (no xfade, no animated
 *   scale): the wipe's frames are cut from the band picture (crop + pad),
 *   names rise through a mask (drawtext into alphamerge), the logo's spring is
 *   zoompan.
 *
 * Node core only.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const STYLE = 'v3';             // bump when the look changes: old cached segments are left alone
const STING = 0.6;              // the whole wipe, seconds
const HALF = STING / 2;         // each segment's half of it
const EASE_K = 0.85;            // the band rushes in, all but stops over the cut, rushes out
const SHUTTER = 0.5;            // motion blur: the band smears over half a frame's travel (a 180° shutter)
const BLUR = [0, 12, 30, 64, 128]; // the band's pre-blurred copies: box radius along the motion, px at 1080p
const GLINT = [0.16, 0.44];     // stinger time the glint crosses the logo (the cut is at HALF)
const INTRO_SEC = 2.6;
const OUTRO_SEC = 1.6;
const TAG_IN = 0.5;             // the event tag arrives just after the band has gone…
const TAG_HOLD = 3.0;           // …and is gone long before the ball is bowled
const WHEEL_LEAD = 4.0;         // the wheel's shot draws this long before a clip ends: after the shot (the
                                // clip ends POST-ROLL seconds after the scorer's press, made once it is over)
const SHARPEN = { same: 0.5, down: 0.35 }; // luma unsharp (5x5): footage kept or upscaled / scaled down

const ACCENT = { SIX: 'a855f7', FOUR: '3b82f6', WICKET: 'ef4444', HIGHLIGHT: '22c55e', BRAND: 'f59e0b' };
const FONT_DIR = path.join(__dirname, 'assets', 'highlights', 'fonts');
const FONTS = {
  display: path.join(FONT_DIR, 'BigShoulders-Bold.ttf'),       // names, titles, figures
  event: path.join(FONT_DIR, 'InterDisplay-BlackItalic.otf'),  // SIX / FOUR / WICKET
  body: path.join(FONT_DIR, 'Inter-SemiBold.otf')              // over, bowler, website
};
const LOGO = path.join(__dirname, 'logo.png');
const Wheel = require('./highlight-wheel');

/* ------------------------------------------------------------- small helpers */
const r2 = (n) => Math.round(n * 100) / 100;
const f6 = (n) => Number(n).toFixed(6);
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
// Segment lengths are whole multiples of a span that is BOTH whole video frames
// and whole AAC frames (1024 samples at 48 kHz): 16 frames at 30 fps (0.533 s,
// 25 AAC frames), 8 at 25 fps (0.32 s, 15). Picture and sound of every segment
// then end on the same instant, and the joined video has no gap at a cut.
const gridFrames = (fps) => (fps === 25 ? 8 : 16);
function gridLength(sec, fps, mode) {
  const g = gridFrames(fps), n = sec * fps / g;
  return Math.max(1, mode === 'floor' ? Math.floor(n + 1e-6) : Math.round(n)) * g;
}
// A clip keeps all it can of itself, cut down to the grid (at most ~half a second).
const clipFrames = (info, p) => Math.max(gridLength(1.5, p.fps), gridLength(info.duration - 0.05, p.fps, 'floor'));
// A path inside a filtergraph option (Windows drive colons, quotes).
const fpath = (p) => String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
const clampExpr = (e) => `min(max(${e},0),1)`;
// 0 → 1 while `v` (t, or zoompan's frame number) runs from a to a + d.
const prog = (a, d, v = 't') => clampExpr(`(${v}-${r2(a)})/${r2(d)}`);
const easeOut = (u) => `(1-pow(1-${u},3))`;                                  // decelerates into place
const easeIn = (u) => `pow(${u},3)`;                                         // accelerates away
const easeOutBack = (u) => `(1+2.70158*pow(${u}-1,3)+1.70158*pow(${u}-1,2))`; // overshoots a touch, settles
// Text shown on the video: one line, plain printable characters, upper case.
function cleanText(s, max = 64) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, max);
}
function sha1(o) { return crypto.createHash('sha1').update(typeof o === 'string' ? o : JSON.stringify(o)).digest('hex'); }
const hexOf = (c) => { const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(c || '').trim()); if (!m) return null; const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1]; return h.toLowerCase(); };
const rgbOf = (hex) => [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
// CPUs this process may really use: a container's cgroup quota when it has one
// (a hosted server reports the host's cores, not the slice it was given).
function cpuBudget() {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { return ''; } };
  let quota = 0;
  const v2 = read('/sys/fs/cgroup/cpu.max').split(/\s+/);
  if (v2[0] && v2[0] !== 'max' && Number(v2[1]) > 0) quota = Number(v2[0]) / Number(v2[1]);
  if (!quota) {
    const q = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us')), per = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
    if (q > 0 && per > 0) quota = q / per;
  }
  const os = require('os');
  const cores = (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1;
  return Math.max(1, Math.min(cores, quota ? Math.floor(quota) || 1 : cores));
}
// Memory this process may really use (MB): the container's limit when it has one.
function memBudgetMB() {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { return ''; } };
  const v2 = read('/sys/fs/cgroup/memory.max'), v1 = read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const lim = Number(v2 && v2 !== 'max' ? v2 : v1);
  const total = require('os').totalmem();
  return Math.round((lim > 0 && lim < total ? lim : total) / 1048576);
}

/* ------------------------------------------------------- the clip's tag text */
// What the event tag on a clip says. clip: a clips-collection doc (or the same
// fields): eventType, outcomeLabel, strikerName, bowlerName, fielderName,
// dismissedPlayerName, dismissalType, over (0-based), ballInOver.
function cardForClip(clip) {
  const c = clip || {};
  const ev = String(c.eventType || '').toUpperCase();
  const at = (c.over != null && c.ballInOver != null) ? `${Number(c.over)}.${Number(c.ballInOver)} OV` : '';
  const bowler = cleanText(c.bowlerName || c.bowler, 40);
  const striker = cleanText(c.strikerName || c.striker, 40);
  const join = (...parts) => parts.filter(Boolean).join('  ·  ');
  if (ev === 'SIX' || ev === 'FOUR') {
    return { kind: ev, label: ev, title: striker || 'BATTER', sub: join(at, bowler && `OFF ${bowler}`) };
  }
  if (ev === 'WICKET') {
    const out = cleanText(c.dismissedPlayerName || c.dismissedPlayer || c.strikerName || c.striker, 40) || 'BATTER';
    const type = String(c.dismissalType || '').toLowerCase();
    const fielder = cleanText(c.fielderName || c.fielder, 40);
    let how = '';
    if (/caught/.test(type)) how = fielder && fielder !== bowler ? `CAUGHT ${fielder}${bowler ? ` · BOWLED ${bowler}` : ''}` : (bowler ? `CAUGHT & BOWLED ${bowler}` : 'CAUGHT');
    else if (/^bowled/.test(type)) how = bowler ? `BOWLED ${bowler}` : 'BOWLED';
    else if (/lbw/.test(type)) how = bowler ? `LBW · ${bowler}` : 'LBW';
    else if (/stump/.test(type)) how = fielder ? `STUMPED ${fielder}${bowler ? ` · ${bowler}` : ''}` : 'STUMPED';
    else if (/run ?out/.test(type)) how = fielder ? `RUN OUT · ${fielder}` : 'RUN OUT';
    else if (/hit wicket/.test(type)) how = bowler ? `HIT WICKET · ${bowler}` : 'HIT WICKET';
    else how = cleanText(c.dismissalType, 30) || (bowler ? `WICKET · ${bowler}` : '');
    return { kind: 'WICKET', label: 'WICKET', title: out, sub: join(how, at) };
  }
  const label = cleanText(c.outcomeLabel, 18) || 'HIGHLIGHT';
  return { kind: 'HIGHLIGHT', label, title: striker || 'HIGHLIGHT', sub: join(at, bowler && `BOWLER ${bowler}`) };
}

/* --------------------------------------------------------- the wagon wheel */
const WHEEL_PLACE = { fineleg: ['SHORT FINE LEG', 'FINE LEG'], squareleg: ['SQUARE LEG', 'DEEP SQUARE LEG'], midwicket: ['MID-WICKET', 'DEEP MID-WICKET'],
  midon: ['MID-ON', 'LONG-ON'], midoff: ['MID-OFF', 'LONG-OFF'], cover: ['COVER', 'DEEP COVER'], point: ['POINT', 'DEEP POINT'], thirdman: ['GULLY', 'THIRD MAN'] };
// What a clip's wheel shows. w: { event: SIX / FOUR / WICKET / …, runs, how
// (dismissal type), shot: { zone, depth, hand, x, y } } — the delivery's own
// data. A boundary reaches the rope; a bowled / lbw / stumped / hit wicket
// (or a wicket with no shot) flashes the stumps; anything else with no shot
// has no wheel. → { kind, end, label, mark } or null.
function wheelFor(w) {
  if (!w) return null;
  const ev = String(w.event || '').toUpperCase();
  const kind = ev === 'SIX' || ev === 'FOUR' || ev === 'WICKET' ? ev : 'RUN';
  const how = String(w.how || '').toLowerCase();
  const atStumps = kind === 'WICKET' && (/bowled|lbw|stump|hit wicket/.test(how) || !w.shot);
  let end = null;
  if (!atStumps) {
    end = w.shot ? Wheel.shotPoint(w.shot, kind === 'SIX' || kind === 'FOUR') : null;
    if (!end) return null;
    end = end.map(v => Math.round(v * 10) / 10);
  }
  const zone = w.shot && WHEEL_PLACE[w.shot.zone];
  const place = !atStumps && zone ? zone[w.shot.depth === 'deep' ? 1 : 0] : '';
  const runs = Math.max(0, Math.round(Number(w.runs) || 0));
  const head = kind === 'WICKET' ? (cleanText(w.how, 18) || 'WICKET') : kind === 'RUN' ? `${runs} RUN${runs === 1 ? '' : 'S'}` : kind;
  return { kind, end, label: [head, place].filter(Boolean).join('  ·  '), mark: kind === 'SIX' ? '6' : kind === 'FOUR' ? '4' : kind === 'WICKET' ? 'W' : String(runs) };
}

/* ---------------------------------------------------------- filtergraphs */
// Collects a command's inputs and filter chains, handing out input numbers and
// unique labels as it goes.
function graph() {
  const inputs = [], chains = [];
  let n = 0;
  return {
    input(args) { inputs.push(args); return inputs.length - 1; },
    file(f) { return this.input(['-i', f]); },
    add(s) { chains.push(s); },
    label(prefix) { n++; return `${prefix}${n}`; },
    args() { return [].concat(...inputs); },
    script() { return chains.join(';\n'); }
  };
}
// A still image repeated for the length of a segment: decoded and converted
// to the blend format once (not once per frame), and timed in whole frames of
// the video (a still's own time base is 1/25).
const loopImg = (inp, fps, label, pre = '') => `[${inp}:v]${pre}format=yuva420p,loop=loop=-1:size=1:start=0,settb=1/${fps},setpts=N[${label}]`;

/* ------------------------------------------------------------------ ffmpeg */
function createHighlightEditor(opts = {}) {
  const ffmpegPath = opts.ffmpegPath;
  const log = opts.log || (() => {});
  const cacheDir = opts.cacheDir || path.join(require('os').tmpdir(), 'scorvix-highlight-cache');
  const cacheMaxBytes = opts.cacheMaxBytes || 1536 * 1048576;
  const preset = opts.preset || 'superfast';
  // Decoder / encoder threads: the cores really available, at most 3 (beyond
  // that each thread only adds frames held in memory on a small server).
  const threads = Math.max(1, Math.min(opts.threads || cpuBudget(), 3));
  fs.mkdirSync(cacheDir, { recursive: true });

  // Low priority where the OS has it: the live server on the same machine
  // always comes first.
  let niceOk = false;
  if (process.platform !== 'win32' && opts.nice !== false) {
    try { niceOk = spawnSync('nice', ['-n', '1', 'true']).status === 0; } catch (e) { niceOk = false; }
  }
  const niceLevel = String(opts.niceLevel == null ? 12 : opts.niceLevel);

  // One ffmpeg at a time across every job: jobs interleave segment by
  // segment instead of fighting over the CPU.
  let chain = Promise.resolve();
  let queued = 0;
  function run(args, { timeoutMs = 15 * 60 * 1000, totalSec = 0, onProgress } = {}) {
    queued++;
    const p = chain.then(() => { queued--; return exec(args, timeoutMs, totalSec, onProgress); }, () => { queued--; return exec(args, timeoutMs, totalSec, onProgress); });
    chain = p.catch(() => {});
    return p;
  }
  function exec(args, timeoutMs, totalSec, onProgress) {
    return new Promise((resolve, reject) => {
      const full = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...(onProgress ? ['-progress', 'pipe:1', '-nostats'] : []), ...args];
      const p = niceOk ? spawn('nice', ['-n', niceLevel, ffmpegPath, ...full], { stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(ffmpegPath, full, { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; if (err.length > 6000) err = err.slice(-6000); });
      let buf = '';
      p.stdout.on('data', (d) => {
        if (!onProgress) return;
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          const m = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
          if (m && totalSec > 0) onProgress(Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / totalSec));
        }
      });
      const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.trim().slice(-1500)}`)); });
    });
  }
  // A long filtergraph goes in a script file (no command-line length limit,
  // no shell quoting).
  function withScript(dir, G, outArgs) {
    const f = path.join(dir, `graph-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(f, G.script(), 'utf8');
    return [...G.args(), '-filter_complex_script', f, ...outArgs];
  }
  // ffmpeg -i with no output: the stream lines on stderr are the probe.
  function probe(file) {
    return new Promise((resolve) => {
      const p = spawn(ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', () => resolve(null));
      p.on('close', () => {
        const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
        const v = /Stream #\d+:\d+[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(err);
        const f = /Stream #\d+:\d+[^\n]*Video:[^\n]*?([\d.]+) fps/.exec(err) || /Stream #\d+:\d+[^\n]*Video:[^\n]*?([\d.]+) tbr/.exec(err);
        if (!d || !v) return resolve(null);
        resolve({
          duration: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]),
          width: Number(v[1]), height: Number(v[2]), fps: f ? Number(f[1]) : 30,
          hasAudio: /Stream #\d+:\d+[^\n]*Audio:/.test(err),
          mono: /Stream #\d+:\d+[^\n]*Audio:[^\n]*\bmono\b/.test(err)
        });
      });
    });
  }

  /* ---------------------------------------------------------- the format */
  // 1080p when any clip is ~1080p, else 720p. 50/60 fps → 25/30: half the
  // frames to encode, and what the social apps play anyway.
  // A small server (one CPU, or under ~1 GB of memory) renders 720p: a 1080p
  // encode takes ~220 MB next to the live server, and ~1.6x the time.
  const maxHeight = opts.maxHeight || (memBudgetMB() < 1000 || cpuBudget() < 2 ? 720 : 1080);
  // format '9:16' stands the same picture on end: 1080 x 1920 or 720 x 1280.
  // k scales the design (drawn for 1080 on the short side).
  function pickProfile(probes, format) {
    const ok = probes.filter(Boolean);
    const maxH = Math.max(0, ...ok.map(p => p.height));
    const short = maxH >= 1000 && maxHeight >= 1080 ? 1080 : 720, long = short === 1080 ? 1920 : 1280;
    const portrait = format === '9:16';
    const w = portrait ? short : long, h = portrait ? long : short;
    const fpss = ok.map(p => p.fps).filter(f => f > 0);
    const pal = fpss.length > 0 && fpss.every(f => Math.abs(f - 25) < 1.5 || Math.abs(f - 50) < 1.5);
    const fps = pal ? 25 : 30;
    return { w, h, fps, k: short / 1080, portrait, key: `${w}x${h}p${fps}` };
  }
  function encodeArgs(p) {
    const big = p.h >= 1080;
    return ['-c:v', 'libx264', '-preset', preset, '-crf', '23', '-maxrate', big ? '6M' : '4M', '-bufsize', big ? '12M' : '8M',
      '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-r', String(p.fps),
      '-x264-params', `stitchable=1:keyint=${p.fps * 2}:min-keyint=${p.fps}`,
      // Lossless sound inside a segment (MKV + FLAC): AAC would put an encoder
      // delay at the start of every segment, and the joins would stutter. The
      // finished video gets ONE AAC encode of the whole soundtrack.
      '-c:a', 'flac', '-ar', '48000', '-ac', '2', '-threads', String(threads), '-f', 'matroska'];
  }
  // Silence of exactly a segment's length (the title and end cards).
  const silence = (G, T) => G.input(['-f', 'lavfi', '-t', String(r2(T + 0.5)), '-i', 'anullsrc=r=48000:cl=stereo']);
  const cutAudio = (T) => `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${f6(T)},asetpts=PTS-STARTPTS,apad,atrim=end_sample=${Math.round(T * 48000)}`;

  /* ------------------------------------------------------------ the art */
  // The band, from its leading edge in: a white hairline, a slab in the
  // accent colour (deepening towards the panel), a second hairline, then the
  // navy panel with the logo on a soft light — and the same again on the
  // trailing edge. Slanted; wider than the frame by m, so for a moment it
  // covers all of it.
  function bandGeom(p) {
    const k = p.k;
    const s = Math.round(0.324 * p.h), m = Math.round(320 * k);
    const hl = Math.max(2, Math.round(6 * k)), gap = Math.round(14 * k), aw = Math.round(250 * k), hl2 = Math.max(2, Math.round(4 * k));
    const side = hl2 + aw + gap + hl, L = side + Math.round(30 * k);
    const Bw = p.w + s + m, IW = even(L + s + Bw + L);
    // the picture has an empty margin on each side wider than the biggest
    // blur, so a blurred copy is never cut off by its own edge
    const pad = Math.round((BLUR[BLUR.length - 1] + 24) * k), PW = IW + 2 * pad;
    return { s, m, hl, gap, aw, hl2, side, L, Bw, IW, pad, PW, xs: -IW, xe: p.w, span: p.w + IW };
  }
  // x of the band's picture (its margin included) at stinger time tau
  // (0 … STING) — the same function on both sides of a cut, which is what
  // makes two separately rendered halves meet.
  function bandLeft(g, tau) {
    const U = tau / STING;
    return g.xs + g.span * (U + EASE_K * Math.sin(2 * Math.PI * U) / (2 * Math.PI)) - g.pad;
  }
  // The frames of a segment the band is on, as stinger time: the head (its
  // first frames, the band leaving) and the tail (its last frames, the band
  // arriving). The same for every segment of a format.
  function windowSpan(p, side) {
    if (side === 'head') return { tau0: HALF, n: Math.ceil(HALF * p.fps - 1e-6) };
    const n = Math.floor(HALF * p.fps + 1e-6);
    return { tau0: HALF - n / p.fps, n };
  }
  // Which blurred copy a frame at stinger time tau takes: the band's travel
  // during the shutter, as a box radius in 1080p pixels.
  function blurLevel(p, g, tau) {
    const v = 1 + EASE_K * Math.cos(2 * Math.PI * tau / STING);
    const want = (g.span / STING / p.fps) * v * SHUTTER / 2 / p.k;
    let best = 0;
    BLUR.forEach((r, i) => { if (Math.abs(Math.log((r + 4) / (want + 4))) < Math.abs(Math.log((BLUR[best] + 4) / (want + 4)))) best = i; });
    return best;
  }

  const assetsMemo = new Map();
  function ensureAssets(p) {
    const key = `${STYLE}-${p.key}`;
    if (!assetsMemo.has(key)) assetsMemo.set(key, buildAssets(p, path.join(cacheDir, 'assets', key)).catch((e) => { assetsMemo.delete(key); throw e; }));
    return assetsMemo.get(key);
  }
  // Assets are written under temporary names and moved into place, so a crash
  // half-way never leaves a broken file that a later render would trust.
  async function makeAll(files, argsFor) {
    if (files.every(f => fs.existsSync(f))) return;
    const tmps = files.map(f => { const ext = path.extname(f); return `${f.slice(0, -ext.length)}.${process.pid}.tmp${ext}`; });
    try {
      await run(argsFor(tmps));
      tmps.forEach((t, i) => fs.renameSync(t, files[i]));
    } catch (e) { tmps.forEach(t => fs.unlink(t, () => {})); throw e; }
  }
  const makeOnce = (file, args) => makeAll([file], ([tmp]) => [...args, tmp]);

  async function buildAssets(p, dir) {
    fs.mkdirSync(dir, { recursive: true });
    const g = bandGeom(p), k = p.k, W = p.w, H = p.h;
    const S = Math.min(W, H), C = even(S * 0.48);  // the end card's logo box
    const out = {
      dir, C,
      glint: path.join(dir, 'glint.png'), glintW: Math.round(380 * k),
      logoSmall: path.join(dir, 'logo-small.png'),
      logoSpring: path.join(dir, 'logo-spring.png'), springZ: 1 / 0.86,
      shine: path.join(dir, 'shine.png'),
      endBg: path.join(dir, 'end-bg.png')
    };
    await makeOnce(out.logoSmall, ['-i', LOGO, '-vf', `scale=-2:${even(S * 0.075)}:flags=lanczos,format=rgba`, '-frames:v', '1']);
    // The end card's logo, on a box twice the size it is shown at: zoompan
    // then only ever scales it down, so the spring stays sharp.
    const springLogo = even(2 * S * 0.30 / out.springZ);
    await makeOnce(out.logoSpring, ['-i', LOGO, '-vf', `scale=-2:${springLogo}:flags=lanczos,format=rgba,pad=${2 * C}:${2 * C}:(ow-iw)/2:(oh-ih)/2:color=black@0`, '-frames:v', '1']);
    // A soft slanted streak of light (rides along the band, across the logo).
    const gw = out.glintW;
    await makeOnce(out.glint, ['-f', 'lavfi', '-i', `color=c=white@0:s=${even(gw + g.s)}x${H},format=rgba`, '-vf',
      `geq=r=255:g=255:b=255:a='50*exp(-pow((X-${g.s}*(${H}-Y)/${H}-${gw / 2})/${r2(gw / 5)},2))'`, '-frames:v', '1']);
    // The sweep of light across the end card's logo: a streak in the middle of
    // a strip three logo-boxes wide, cropped through a moving window.
    await makeOnce(out.shine, ['-f', 'lavfi', '-i', `color=c=white@0:s=${3 * C}x${C},format=rgba`, '-vf',
      `geq=r=255:g=255:b=255:a='200*exp(-pow((X-${1.5 * C}-0.45*(Y-${C / 2}))/${r2(C * 0.09)},2))'`, '-frames:v', '1']);
    // 9:16: the picture's rounded corners, as a mask (white inside).
    if (p.portrait) {
      const cw = W, ch = even(W * 9 / 16), R = Math.round(30 * k);
      out.corner = path.join(dir, 'corner.png');
      const dx = `max(${R - 0.5}-X,X-${cw - 0.5 - R})`, dy = `max(${R - 0.5}-Y,Y-${ch - 0.5 - R})`;
      await makeOnce(out.corner, ['-f', 'lavfi', '-i', `color=c=black:s=${cw}x${ch},format=gray`, '-vf',
        `geq=lum='255*${clampExpr(`${R}+0.5-hypot(max(${dx},0),max(${dy},0))`)}'`, '-frames:v', '1']);
    }
    // The end card's background: deep navy, lighter behind the logo (drawn
    // small, it is all soft light).
    const ew = even(W / 4), eh = even(H / 4);
    const glow = `exp(-(pow((X-${ew / 2})/${r2(ew * 0.42)},2)+pow((Y-${eh * 0.44})/${r2(eh * 0.5)},2)))`;
    await makeOnce(out.endBg, ['-f', 'lavfi', '-i', `color=c=black:s=${ew}x${eh},format=rgb24`, '-vf',
      `geq=r='6+20*${glow}':g='10+30*${glow}':b='22+50*${glow}'`, '-frames:v', '1']);

    // The band in each accent colour, lazily: sharp, plus its blurred copies;
    // and from them the band's frames for either side of a cut.
    const bands = new Map(), stings = new Map();
    out.band = (kind) => {
      const kd = ACCENT[kind] ? kind : 'HIGHLIGHT';
      if (!bands.has(kd)) bands.set(kd, buildBand(p, g, dir, kd).catch((e) => { bands.delete(kd); throw e; }));
      return bands.get(kd);
    };
    out.sting = (kind, side) => {
      const kd = ACCENT[kind] ? kind : 'HIGHLIGHT', key = `${kd}-${side}`;
      if (!stings.has(key)) stings.set(key, buildSting(p, g, dir, out, kd, side).catch((e) => { stings.delete(key); throw e; }));
      return stings.get(key);
    };
    return out;
  }
  // One ffmpeg for a colour: the art drawn at half size (it is only ever seen
  // rushing past, or for a few frames behind the sharp logo), scaled up for
  // the sharp copy with a full-size logo; the blurred copies stay half size
  // (blur hides it) and are scaled up when used.
  async function buildBand(p, g, dir, kind) {
    const files = BLUR.map((_, i) => path.join(dir, `band-${kind}-${i}.png`));
    const [R, G, B] = rgbOf(ACCENT[kind]);
    const H = p.h, k = p.k, q = 0.5, hw = even(g.PW * q), hh = even(H * q);
    const s = g.s * q, L = (g.pad + g.L) * q, Bw = g.Bw * q, aw = g.aw * q, gap = g.gap * q, hl = Math.max(1, g.hl * q), hl2 = Math.max(1, g.hl2 * q);
    const u = `(X-${L}-${s}*(${hh}-Y)/${hh})`;                       // along the band, from the panel's left edge
    const out = `if(lt(${u},${Bw / 2}),-${u},${u}-${Bw})`;            // how far outside the panel (< 0 inside)
    const inBody = `lt(${out},0)`, inHair2 = `between(${out},0,${hl2})`;
    const inSlab = `gt(${out},${hl2})*lte(${out},${hl2 + aw})`, inHair = `gt(${out},${hl2 + aw + gap})*lte(${out},${hl2 + aw + gap + hl})`;
    const cx = L + s / 2 + Bw / 2, cy = hh / 2;
    const halo = `22*exp(-(pow((X-${cx})/${r2(560 * k * q)},2)+pow((Y-${cy})/${r2(360 * k * q)},2)))`;
    const ch = (c, top, bot) => `if(${inHair}+${inHair2},245,if(${inSlab},${c}*(0.62+0.38*(${out}-${hl2})/${aw}),${top}+${bot - top}*Y/${hh}+${halo}))`;
    const alpha = `if(${inBody}+${inHair2}+${inSlab},255,if(${inHair},230,0))`;
    const LH = even(Math.min(p.w, H) * 0.25), shPad = Math.round(60 * k), shR = Math.max(2, Math.round(22 * k));
    const cxF = Math.round(g.pad + g.L + g.s / 2 + g.Bw / 2);
    const shadow = (h, pad, r) => `scale=-2:${h}:flags=lanczos,format=rgba,pad=iw+${2 * pad}:ih+${2 * pad}:${pad}:${pad}:color=black@0,lutrgb=r=0:g=0:b=0:a=val*0.55,boxblur=luma_radius=${r}:luma_power=2:alpha_radius=${r}:alpha_power=2`;
    const fc = [
      `[0:v]geq=r='${ch(R, 8, 18)}':g='${ch(G, 14, 30)}':b='${ch(B, 27, 54)}':a='${alpha}',split[ha][hb]`,
      `[1:v]format=rgba,split=4[l1][l2][l3][l4]`,
      `[l1]${shadow(LH, shPad, shR)}[sf]`, `[l2]scale=-2:${LH}:flags=lanczos[lf]`,
      `[l3]${shadow(LH / 2, Math.round(shPad / 2), Math.max(1, Math.round(shR / 2)))}[sh]`, `[l4]scale=-2:${LH / 2}:flags=lanczos[lh]`,
      `[ha]scale=${g.PW}:${H}:flags=bicubic[up]`,
      `[up][sf]overlay=x=${cxF}-w/2:y=(H-h)/2+${Math.round(10 * k)}:format=rgb[u1]`,
      `[u1][lf]overlay=x=${cxF}-w/2:y=(H-h)/2:format=rgb[o0]`,
      `[hb][sh]overlay=x=${Math.round(cx)}-w/2:y=(H-h)/2+${Math.round(5 * k)}:format=rgb[h1]`,
      `[h1][lh]overlay=x=${Math.round(cx)}-w/2:y=(H-h)/2:format=rgb,split=${BLUR.length - 1}${BLUR.slice(1).map((_, i) => `[b${i + 1}]`).join('')}`,
      ...BLUR.slice(1).map((r, i) => `[b${i + 1}]format=gbrap,avgblur=sizeX=${Math.max(1, Math.round(r * k * q))}:sizeY=1,format=rgba[o${i + 1}]`)
    ].join(';');
    await makeAll(files, (tmps) => ['-f', 'lavfi', '-i', `color=c=black@0:s=${hw}x${hh},format=rgba`, '-i', LOGO, '-filter_complex', fc,
      ...tmps.flatMap((t, i) => ['-map', `[o${i}]`, '-frames:v', '1', t])]);
    return files;
  }

  // The band's frames for one side of a cut, drawn once per format and colour:
  // each frame with the band already in place, blurred for its speed and with
  // its glint, on a transparent picture the size of the video — a short
  // lossless clip with alpha. A segment then only lays it over its first or
  // last few frames: one small decode, no per-frame work, little memory.
  // (Built a frame per ffmpeg: one band picture in memory at a time.)
  async function buildSting(p, g, dir, a, kind, side) {
    const file = path.join(dir, `sting-${kind}-${side}.mov`);
    if (fs.existsSync(file)) return file;
    const levels = await a.band(kind);
    const { tau0, n } = windowSpan(p, side), W = p.w, H = p.h;
    const tmp = fs.mkdtempSync(path.join(dir, 'sting-'));
    try {
      // one frame per ffmpeg (a band picture at a time: little memory) …
      for (let j = 0; j < n; j++) {
        const tau = tau0 + j / p.fps, bx = Math.round(bandLeft(g, tau));
        const x0 = Math.max(0, bx), x1 = Math.min(W, bx + g.PW), f = path.join(tmp, `f${String(j).padStart(3, '0')}.png`);
        if (x1 <= x0) { await run(['-f', 'lavfi', '-i', `color=c=black@0:s=${W}x${H},format=rgba`, '-frames:v', '1', f]); continue; }
        const args = ['-i', levels[blurLevel(p, g, tau)]];
        let fc = `[0:v]scale=${g.PW}:${H}:flags=bicubic,format=rgba,crop=${x1 - x0}:${H}:${x0 - bx}:0,pad=${W}:${H}:${x0}:0:color=black@0[f]`;
        // the glint: inside the panel, crossing the logo at the cut
        if (tau >= GLINT[0] - 1e-6 && tau <= GLINT[1] + 1e-6) {
          const u = Math.min(1, Math.max(0, (tau - GLINT[0]) / (GLINT[1] - GLINT[0])));
          const gx = Math.round(bandLeft(g, tau) + g.pad + g.L + g.Bw * (0.28 + 0.44 * u) - a.glintW / 2);
          args.push('-i', a.glint);
          fc += `;[f][1:v]overlay=x=${gx}:y=0:format=rgb[f]`.replace(/\[f\]$/, '[g]');
        }
        await run([...args, '-filter_complex', fc, '-map', /\[g\]$/.test(fc) ? '[g]' : '[f]', '-frames:v', '1', f]);
      }
      // … then the frames, in order, as one short lossless clip with alpha
      // (QuickTime Animation: run-length, so mostly-empty frames are small and
      // decode in a few MB)
      await makeOnce(file, ['-framerate', String(p.fps), '-i', path.join(tmp, 'f%03d.png'), '-c:v', 'qtrle', '-pix_fmt', 'argb', '-frames:v', String(n), '-f', 'mov']);
      return file;
    } finally {
      fs.rm(tmp, { recursive: true, force: true }, () => {});
    }
  }
  // [inLabel] (n frames, whole frames of the video for time base) → its head
  // (the band leaving, over its first frames) and / or tail (the band
  // arriving, over its last frames) laid on → [outLabel]. Each stinger clip
  // is timed to its own frames: before it the overlay passes the picture
  // through untouched, after it likewise (eof_action=pass). Nothing is split
  // or held back, so the clip streams through in a few frames of memory.
  async function withWipes(G, p, a, inLabel, outLabel, n, { head, tail }) {
    let cur = inLabel;
    const lay = async (kind, side, at) => {
      const ly = G.label('ly'), o = G.label('w');
      G.add(`[${G.file(await a.sting(kind, side))}:v]settb=1/${p.fps},setpts=N+${at}[${ly}]`);
      G.add(`[${cur}][${ly}]overlay=0:0:eof_action=pass[${o}]`);
      cur = o;
    };
    if (head) await lay(head, 'head', 0);
    if (tail) await lay(tail, 'tail', n - windowSpan(p, 'tail').n);
    G.add(`[${cur}]null[${outLabel}]`);
  }

  /* -------------------------------------------------------- the text bits */
  function textFile(dir, name, text) {
    const f = path.join(dir, `${name}.txt`);
    fs.writeFileSync(f, text, 'utf8');
    return f;
  }
  // A line that slides in from the left (ease-out) after `inAt`, holds, and
  // slides back out (ease-in) at `outAt`.
  function slideX(x0, dist, inAt, outAt) {
    return `${x0}-${dist}*(1-${easeOut(prog(inAt, 0.38))})-${dist}*${easeIn(prog(outAt, 0.30))}`;
  }
  function fadeAlpha(inAt, outAt) {
    return `min(${prog(inAt, 0.22)},1-${prog(outAt + 0.08, 0.22)})`;
  }
  function drawtext({ font, file, size, color, box, boxBorder, x, y, alpha, from, to }) {
    return `drawtext=fontfile='${fpath(font)}':textfile='${fpath(file)}':expansion=none:fontsize=${size}:fontcolor=${color}` +
      (box ? `:box=1:boxcolor=${box}:boxborderw=${boxBorder}` : '') + `:x='${x}':y='${y}'` + (alpha ? `:alpha='${alpha}'` : '') +
      (from != null ? `:enable='between(t,${r2(from)},${r2(to == null ? 1e6 : to)})'` : '');
  }
  // Big names shrink to fit: a 26-letter name still sits on one line.
  const fitSize = (text, base, width) => Math.max(Math.round(base * 0.55), Math.min(base, Math.floor(width / Math.max(1, text.length))));
  // A line of white text that rises into place through the line it sits on
  // (masked), starting at `at`: one small canvas, its mask drawn by drawtext.
  function risingText(G, dir, name, { text, font, size, at, dur = 0.42, T, p, color = 'white' }) {
    const bw = even(Math.max(16, Math.ceil(size * 0.62 * text.length + size))), bh = even(size * 1.32), pad = Math.round(size * 0.1);
    const m = G.label('mask'), f = G.label('fill'), o = G.label('txt');
    G.add(`color=c=black:s=${bw}x${bh}:r=${p.fps}:d=${f6(T)},format=gray,drawtext=fontfile='${fpath(font)}':textfile='${fpath(textFile(dir, name, text))}':expansion=none:fontsize=${size}:fontcolor=white:x=0:y='${pad}+${bh}*(1-${easeOut(prog(at, dur))})',lut=c0='clip((val-16)*255/219,0,255)'[${m}]`);
    G.add(`color=c=${color}:s=${bw}x${bh}:r=${p.fps}:d=${f6(T)},format=yuva420p[${f}]`);
    G.add(`[${f}][${m}]alphamerge[${o}]`);
    return { label: o, w: bw, h: bh, pad };
  }

  // The stacked event tag at the top left: event pill / name / over · bowler.
  // Small: it says what is coming and gets out of the way of the shot.
  function tagFilters(p, card, dir, T) {
    const k = p.k, x0 = Math.round(46 * k), y0 = Math.round(40 * k);
    const accent = `0x${ACCENT[card.kind] || ACCENT.HIGHLIGHT}`;
    const outAt = Math.max(TAG_IN + 1.2, Math.min(TAG_IN + TAG_HOLD, T - HALF - 0.6));
    const dist = Math.round(560 * k);
    const label = cleanText(card.label, 18), title = cleanText(card.title, 40), sub = cleanText(card.sub, 72);
    const pillSize = Math.round(28 * k), nameSize = fitSize(title, Math.round(56 * k), Math.round(760 * k) / 0.42), subSize = Math.round(22 * k);
    const pb = Math.round(9 * k), nb = Math.round(11 * k), sb = Math.round(8 * k);
    const nameY = y0 + Math.round(pillSize * 1.2 + 2 * pb + 5 * k);
    const subY = nameY + Math.round(nameSize * 0.98 + 2 * nb + 5 * k);
    const f = [];
    f.push(drawtext({ font: FONTS.event, file: textFile(dir, 'tag-label', label), size: pillSize, color: 'white', box: `${accent}@1.0`, boxBorder: pb,
      x: slideX(x0 + pb, dist, TAG_IN, outAt + 0.10), y: y0 + pb, alpha: fadeAlpha(TAG_IN, outAt + 0.10), from: TAG_IN, to: outAt + 0.45 }));
    f.push(drawtext({ font: FONTS.display, file: textFile(dir, 'tag-title', title), size: nameSize, color: 'white', box: '0x0b1220@0.88', boxBorder: nb,
      x: slideX(x0 + nb, dist, TAG_IN + 0.06, outAt + 0.05), y: nameY, alpha: fadeAlpha(TAG_IN + 0.06, outAt + 0.05), from: TAG_IN + 0.06, to: outAt + 0.4 }));
    if (sub) {
      f.push(drawtext({ font: FONTS.body, file: textFile(dir, 'tag-sub', sub), size: subSize, color: '0xdbe4f0', box: '0x131c30@0.88', boxBorder: sb,
        x: slideX(x0 + sb, dist, TAG_IN + 0.12, outAt), y: subY, alpha: fadeAlpha(TAG_IN + 0.12, outAt), from: TAG_IN + 0.12, to: outAt + 0.35 }));
    }
    return f.join(',');
  }

  // 9:16: where the 16:9 picture sits — the full width, a little above the
  // middle when the wheel needs the space under it (the same for every clip
  // of a video, so the picture never jumps).
  function portraitBox(p, wheelOn) {
    const ch = even(p.w * 9 / 16);
    return { cw: p.w, ch, y: wheelOn ? even(p.h * 0.29) : even((p.h - ch) / 2) };
  }
  // 9:16: the event tag in the space above the picture, centred, there for
  // the whole clip (it covers nothing): event pill / NAME / over · bowler.
  function tagPortrait(p, card, dir, T, box) {
    const k = p.k, W = p.w;
    const accent = `0x${ACCENT[card.kind] || ACCENT.HIGHLIGHT}`;
    const label = cleanText(card.label, 18), title = cleanText(card.title, 40), sub = cleanText(card.sub, 72);
    const pillSize = Math.round(40 * k), pb = Math.round(13 * k), nameSize = fitSize(title, Math.round(104 * k), Math.round(W * 0.88) / 0.45);
    const subSize = fitSize(sub, Math.round(30 * k), Math.round(W * 0.9) / 0.6);
    const hPill = Math.round(pillSize * 1.22 + 2 * pb), gap1 = Math.round(26 * k), gap2 = Math.round(16 * k);
    const hBlock = hPill + gap1 + nameSize + (sub ? gap2 + Math.round(subSize * 1.2) : 0);
    const top = Math.max(Math.round(150 * k), Math.round((box.y - hBlock) / 2 + 36 * k));
    const rise = (y, at) => `${y}+${Math.round(30 * k)}*(1-${easeOut(prog(at, 0.42))})`;
    const f = [];
    f.push(drawtext({ font: FONTS.event, file: textFile(dir, 'tag-label', label), size: pillSize, color: 'white', box: `${accent}@1.0`, boxBorder: pb,
      x: '(w-text_w)/2', y: rise(top + pb, TAG_IN), alpha: prog(TAG_IN, 0.3) }));
    f.push(drawtext({ font: FONTS.display, file: textFile(dir, 'tag-title', title), size: nameSize, color: 'white',
      x: '(w-text_w)/2', y: rise(top + hPill + gap1, TAG_IN + 0.08), alpha: prog(TAG_IN + 0.08, 0.3) }));
    if (sub) f.push(drawtext({ font: FONTS.body, file: textFile(dir, 'tag-sub', sub), size: subSize, color: '0xdbe4f0',
      x: '(w-text_w)/2', y: rise(top + hPill + gap1 + nameSize + gap2, TAG_IN + 0.16), alpha: prog(TAG_IN + 0.16, 0.3) }));
    return f.join(',');
  }

  // The clip's wagon wheel (spec: wheelFor): the field pops in, then the shot
  // draws, its marker springs in with the number on it and what happened
  // under the wheel. 16:9: top left, only at the end of the clip, after the
  // shot and long after the tag; 9:16: in the space under the picture for the
  // whole clip, the shot drawing at the same moment. Laid on [inLabel] →
  // [outLabel]; false when the clip is too short to hold it.
  // Where a clip's wheel goes: { D (size), x, y, labelSize, lb } — 16:9 the
  // top left corner; 9:16 centred in the space under the picture (box).
  function wheelPlace(p, box) {
    const k = p.k;
    const D = even(p.portrait ? p.w * 0.5 : 300 * k);
    const labelSize = Math.round((p.portrait ? 32 : 22) * k), lb = Math.round((p.portrait ? 12 : 8) * k);
    const x = p.portrait ? Math.round((p.w - D) / 2) : Math.round(46 * k);
    const below = box.y + box.ch, room = p.h - below;
    const y = p.portrait ? Math.round(below + (room - D - labelSize * 1.3 - 2 * lb - 18 * k) / 2) : Math.round(40 * k);
    return { D, x, y, labelSize, lb };
  }
  function addWheel(G, p, dir, spec, T, inLabel, outLabel, box) {
    const k = p.k, fps = p.fps, tm = Wheel.timings;
    const { D, x, y, labelSize, lb } = wheelPlace(p, box);
    const shotAt = p.portrait ? Math.max(1.0, T - WHEEL_LEAD) : Math.max(TAG_IN + TAG_HOLD + 0.75, T - WHEEL_LEAD);
    const plateAt = p.portrait ? HALF + 0.05 : shotAt - tm.PLATE_SEC - 0.05;
    if (shotAt + tm.DRAW_SEC + tm.POP_SEC > T - HALF) return false;
    const plate = Wheel.plateFrames({ size: D, fps }), shot = Wheel.shotFrames({ size: D, fps, spec });
    const pf = path.join(dir, 'wheel-plate.rgba'), sf = path.join(dir, 'wheel-shot.rgba');
    fs.writeFileSync(pf, plate.data);
    fs.writeFileSync(sf, shot.data);
    const raw = (f) => G.input(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${D}x${D}`, '-framerate', String(fps), '-i', f]);
    const wp = G.label('wp'), ws = G.label('ws'), wa = G.label('wa'), wb = G.label('wb');
    G.add(`[${raw(pf)}:v]settb=1/${fps},setpts=N+${Math.round(plateAt * fps)}[${wp}]`);
    G.add(`[${raw(sf)}:v]settb=1/${fps},setpts=N+${Math.round(shotAt * fps)}[${ws}]`);
    // both hold their last frame to the end of the clip (eof_action=repeat)
    G.add(`[${inLabel}][${wp}]overlay=x=${x}:y=${y}:eof_action=repeat[${wa}]`);
    G.add(`[${wa}][${ws}]overlay=x=${x}:y=${y}:eof_action=repeat[${wb}]`);
    const m = Wheel.markerPx(D, spec), markAt = shotAt + (spec.end ? tm.DRAW_SEC - 0.06 : 0.12) + tm.POP_SEC * 0.6;
    const text = [
      drawtext({ font: FONTS.display, file: textFile(dir, 'wheel-mark', spec.mark), size: Math.max(10, Math.round(m.r * 1.55)), color: spec.kind === 'RUN' ? '0x0b1220' : 'white',
        x: `${Math.round(x + m.x)}-text_w/2`, y: `${Math.round(y + m.y)}-text_h/2`, alpha: prog(markAt, 0.12), from: markAt }),
      drawtext({ font: FONTS.body, file: textFile(dir, 'wheel-label', spec.label), size: labelSize, color: 'white', box: '0x0b1220@0.85', boxBorder: lb,
        x: `${x + Math.round(D / 2)}-text_w/2`, y: `${y + D + Math.round(10 * k) + lb}+${Math.round(14 * k)}*(1-${easeOut(prog(markAt, 0.35))})`, alpha: prog(markAt, 0.3), from: markAt })
    ];
    G.add(`[${wb}]${text.join(',')}[${outLabel}]`);
    return true;
  }

  /* ----------------------------------------------------------- segments */
  // One clip → one segment: fitted to the format (16:9, or 9:16 with the
  // picture in the middle), sharpened a touch, its tag, its wagon wheel
  // (wheelOn: the video has wheels; wheel: this clip's delivery), both wipe
  // halves, and its own sound (nothing added: a touch of fade at each end,
  // against clicks).
  async function renderClip({ src, info, card, wheel, wheelOn, profile: p, assets, out, workDir, onProgress }) {
    const dir = fs.mkdtempSync(path.join(workDir, 'seg-'));
    try {
      const n = clipFrames(info, p), T = n / p.fps, k = p.k;
      const G = graph();
      G.input(['-threads', String(threads), '-i', src]);
      const aIn = info.hasAudio ? '0:a' : `${silence(G, T)}:a`;
      const box = p.portrait ? portraitBox(p, !!wheelOn) : { cw: p.w, ch: p.h, y: 0 };
      const fit = (info.width === box.cw && info.height === box.ch) ? 'setsar=1'
        : `scale=${box.cw}:${box.ch}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${box.cw}:${box.ch}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
      // a touch of sharpening (luma only): a little less when the picture is
      // being scaled down, which sharpens it already
      const sharp = `unsharp=5:5:${info.height > box.ch + 8 ? SHARPEN.down : SHARPEN.same}:5:5:0`;
      if (!p.portrait) {
        G.add(`[0:v]fps=${p.fps},${fit},format=yuv420p,${sharp},trim=end_frame=${n},setpts=PTS-STARTPTS,${tagFilters(p, card, dir, T)}[v0]`);
      } else {
        // the picture, corners rounded, over a blurred, darkened copy of itself
        const bw = even(p.w / 4), bh = even(p.h / 4), lg = G.label('logo');
        G.add(`[0:v]fps=${p.fps},format=yuv420p,trim=end_frame=${n},setpts=PTS-STARTPTS,split[s1][s2]`);
        G.add(`[s1]${fit},${sharp},format=yuva420p[pic]`);
        G.add(`[${G.file(assets.corner)}:v]format=gray,loop=loop=-1:size=1:start=0,settb=1/${p.fps},setpts=N[cm]`);
        G.add(`[pic][cm]alphamerge[picr]`);
        G.add(`[s2]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=8:2,eq=brightness=-0.16:saturation=0.85,scale=${p.w}:${p.h}:flags=bicubic,setsar=1[bg]`);
        G.add(`[bg][picr]overlay=x=0:y=${box.y}:format=yuv420[v1]`);
        G.add(loopImg(G.file(assets.logoSmall), p.fps, lg, 'format=rgba,'));
        G.add(`[v1][${lg}]overlay=x=${Math.round(46 * k)}:y=${Math.round(56 * k)}:shortest=1,${tagPortrait(p, card, dir, T, box)}[v0]`);
      }
      const spec = wheelOn ? wheelFor(wheel) : null;
      const cur = spec && addWheel(G, p, dir, spec, T, 'v0', 'vw', box) ? 'vw' : 'v0';
      await withWipes(G, p, assets, cur, 'vout', n, { head: card.kind in ACCENT ? card.kind : 'HIGHLIGHT', tail: 'BRAND' });
      // mono goes to both ears at its own level (the default upmix would lower it 3 dB)
      const up = info.hasAudio && info.mono ? 'pan=stereo|c0=c0|c1=c0,' : '';
      G.add(`[${aIn}]${up}${cutAudio(T)},afade=t=in:d=0.05,afade=t=out:st=${f6(T - 0.12)}:d=0.12[aout]`);
      await run(withScript(dir, G, ['-map', '[vout]', '-map', '[aout]', ...encodeArgs(p), '-frames:v', String(n), out]), { totalSec: T, onProgress });
      return { duration: T, wheel: cur === 'vw' };
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  // The blurred picture behind a title card, small (it is all soft light):
  // darkened from the left for the text.
  async function stillFrom(src, info, p, out, atSec) {
    const at = Math.max(0, Math.min((info && info.duration ? info.duration - 0.2 : 1), atSec));
    const w = even(p.w / 4), h = even(p.h / 4);
    await run(['-ss', String(r2(at)), '-i', src, '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h},format=rgba`, '-filter_complex',
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=7:2,eq=saturation=0.8:brightness=-0.05,format=rgba[s];` +
      `[1:v]geq=r=4:g=8:b=18:a='min(255,225*pow(1-X/W,1.3)+100*pow(Y/H,2.4)+55)'[d];[s][d]overlay=format=rgb[o]`,
      '-map', '[o]', '-frames:v', '1', out]);
    return out;
  }
  // A team badge given as a data: URL → a file ffmpeg can read, or null.
  async function badgeFile(dataUrl, dir, name = 'badge') {
    const m = /^data:image\/(png|jpe?g|webp|gif);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
    if (!m) return null;
    const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    if (buf.length < 64 || buf.length > 2 * 1048576) return null;
    const f = path.join(dir, `${name}.${m[1].toLowerCase().replace('jpeg', 'jpg')}`);
    fs.writeFileSync(f, buf);
    // an image has no duration: only ask that ffmpeg reads a picture from it
    const ok = await new Promise((resolve) => {
      const pr = spawn(ffmpegPath, ['-hide_banner', '-i', f, '-frames:v', '1', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      pr.stderr.on('data', (d) => { err += d; });
      pr.on('error', () => resolve(false));
      pr.on('close', (code) => { const v = /Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(err); resolve(code === 0 && !!v && Number(v[1]) > 8 && Number(v[2]) > 8); });
    });
    return ok ? f : null;
  }
  // The team panel of the title card, as one picture: a slanted navy slab
  // edged in the team's colour — at the right in 16:9, across the top in 9:16
  // — the team's badge on a white disc (its initials when it has no badge)
  // and its name; both teams side by side for a whole match, our logo when
  // there is no team. → { file, x, y, w, h }
  async function buildHero(p, title, dir) {
    const k = p.k, W = p.w, H = p.h;
    const ok = (t) => !!(t && (t.name || t.short));
    const both = (Array.isArray(title.teams) ? title.teams.filter(ok) : []).slice(0, 2);
    const list = both.length === 2 ? both : ok(title.team) ? [title.team] : [];
    const twin = list.length === 2;
    const brand = ACCENT[title.kind] || ACCENT.BRAND;
    const [er, eg, eb] = rgbOf((list.length === 1 && hexOf(list[0].color)) || brand);
    // the slab: its slanted inner edge (16:9 the left, 9:16 the bottom), then
    // a hairline, a gap and a strip in the team's colour along it
    let PW, PH, X0 = 0, edge, D, midX, cy, half;
    if (!p.portrait) {
      const sp = Math.round(H * 0.17);
      X0 = Math.round(W * 0.665) - sp; PW = even(W - X0 + 10 * k); PH = H;
      edge = `(X-${sp}*(${H}-Y)/${H})`;
      D = even(H * (twin ? 0.2 : 0.3)); midX = Math.round((sp / 2 + PW - 10 * k) / 2); cy = Math.round(H * (twin ? 0.43 : 0.42));
    } else {
      const sp = Math.round(H * 0.09);
      PW = W; PH = even(H * 0.4);
      edge = `(${PH}-${sp}*X/${W}-Y)`;
      D = even(W * (twin ? 0.25 : 0.34)); midX = Math.round(W / 2); cy = Math.round(PH * 0.47);
    }
    half = twin ? Math.round(D * (p.portrait ? 1.06 : 0.82)) : 0;
    const hair = Math.max(2, Math.round(3 * k)), gap = Math.round(8 * k), strip = Math.round(12 * k);
    const inStrip = `between(${edge},${hair + gap},${hair + gap + strip})`, inHair = `between(${edge},0,${hair})`, inPanel = `gt(${edge},${hair + gap + strip})`;
    const ch = (t, top, bot) => `if(${inStrip},${t},if(${inHair},235,${top}+${bot - top}*Y/${PH}))`;
    const G = graph();
    G.add(`[${G.input(['-f', 'lavfi', '-i', `color=c=black@0:s=${PW}x${PH},format=rgba`])}:v]geq=r='${ch(er, 15, 7)}':g='${ch(eg, 23, 12)}':b='${ch(eb, 42, 25)}':a='if(${inPanel}+${inStrip},242,if(${inHair},220,0))'[pan]`);
    const ring = Math.max(3, Math.round((twin ? 6 : 7) * k)), DD = D + 2 * ring;
    // a disc: a ring in the team's colour round a white face, edges smoothed
    const disc = async (team, i) => {
      const [r, g, b] = rgbOf((team && hexOf(team.color)) || brand);
      const rr = `hypot(X-${DD / 2},Y-${DD / 2})`, inner = `lt(${rr},${D / 2 - 1})`;
      const d = G.label('disc'), face = G.label('face');
      G.add(`[${G.input(['-f', 'lavfi', '-i', `color=c=black@0:s=${DD}x${DD},format=rgba`])}:v]geq=r='if(${inner},255,${r})':g='if(${inner},255,${g})':b='if(${inner},255,${b})':a='255*${clampExpr(`${DD / 2}-${rr}`)}'[${d}]`);
      const badge = team ? await badgeFile(team.logo, dir, `badge${i}`) : null;
      if (badge || !team) {
        const lg = G.label('lg'), box = Math.round(D * (badge ? 0.66 : 0.72));
        G.add(`[${G.file(badge || LOGO)}:v]scale=${box}:${box}:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba[${lg}]`);
        G.add(`[${d}][${lg}]overlay=x=(W-w)/2:y=(H-h)/2:format=rgb[${face}]`);
      } else {
        const initials = cleanText(team.short || String(team.name).split(/\s+/).map(w => w[0]).join(''), 4);
        const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 150;   // too light to read on white: navy instead
        G.add(`[${d}]${drawtext({ font: FONTS.display, file: textFile(dir, `initials${i}`, initials), size: Math.round(D * (initials.length > 3 ? 0.34 : 0.42)),
          color: light ? '0x0b1220' : `0x${hexOf(team.color) || brand}`, x: '(w-text_w)/2', y: '(h-text_h)/2' })}[${face}]`);
      }
      return face;
    };
    let cur = 'pan';
    const slots = twin ? [{ team: list[0], cx: midX - half }, { team: list[1], cx: midX + half }] : [{ team: list[0] || null, cx: midX }];
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i], face = await disc(s.team, i), o = G.label('p');
      G.add(`[${cur}][${face}]overlay=x=${s.cx - DD / 2}:y=${cy - DD / 2}:format=rgb[${o}]`);
      cur = o;
      if (s.team) {
        const name = cleanText(s.team.name || s.team.short, 32), room = twin ? half * 1.84 : p.portrait ? W * 0.8 : (PW - H * 0.17 - 60 * k) * 0.9;
        const size = fitSize(name, Math.round((twin ? 40 : 60) * k), Math.round(room) / 0.44), t = G.label('p');
        G.add(`[${cur}]${drawtext({ font: FONTS.display, file: textFile(dir, `team${i}`, name), size, color: 'white', x: `${s.cx}-text_w/2`, y: `${cy + DD / 2 + Math.round((twin ? 24 : 30) * k)}` })}[${t}]`);
        cur = t;
      }
    }
    if (twin) {
      const t = G.label('p');
      G.add(`[${cur}]${drawtext({ font: FONTS.display, file: textFile(dir, 'vs', 'VS'), size: Math.round(D * 0.3), color: `0x${brand}`, x: `${midX}-text_w/2`, y: `${cy}-text_h/2` })}[${t}]`);
      cur = t;
    }
    const file = path.join(dir, 'hero.png');
    await run(withScript(dir, G, ['-map', `[${cur}]`, '-frames:v', '1', file]));
    return { file, x: X0, y: 0, w: PW, h: PH };
  }

  // Title card: the band clears onto the player — kicker, match, name, what
  // the video holds and their figures, the team panel at the right.
  // title: { kicker, line, first, title, pill, meta, stats: [{ value, label, sub }], team: { name, short, color, logo }, kind }
  async function renderIntro({ title, bgSrc, bgInfo, profile: p, assets, out, workDir }) {
    const dir = fs.mkdtempSync(path.join(workDir, 'intro-'));
    try {
      const k = p.k, W = p.w, H = p.h, n = gridLength(INTRO_SEC, p.fps), T = n / p.fps;
      const kind = ACCENT[title.kind] ? title.kind : 'BRAND';
      const accent = `0x${ACCENT[kind]}`;
      const bg = bgSrc ? await stillFrom(bgSrc, bgInfo, p, path.join(dir, 'bg.png'), 1.2) : null;
      const hero = await buildHero(p, title, dir);
      const kicker = cleanText(title.kicker, 60), line = cleanText(title.line, 70), first = cleanText(title.first, 40);
      const main = cleanText(title.title, 40) || 'HIGHLIGHTS', pill = cleanText(title.pill, 28), meta = cleanText(title.meta, 70);
      const stats = (Array.isArray(title.stats) ? title.stats : []).map(s => ({ value: cleanText(s && s.value, 9), label: cleanText(s && s.label, 14), sub: cleanText(s && s.sub, 16) }))
        .filter(s => s.value).slice(0, 4);

      // 16:9: the text at the left of the team panel; 9:16: under it, across
      const x0 = Math.round((p.portrait ? 72 : 110) * k), maxW = p.portrait ? W - 2 * x0 : Math.round(W * 0.5);
      const firstSize = fitSize(first, Math.round(84 * k), maxW / 0.5), mainSize = fitSize(main, Math.round(176 * k), maxW / 0.46);
      const lineSize = Math.round(32 * k), pillSize = Math.round(36 * k), pb = Math.round(13 * k);
      // the figures: each as wide as its widest line (font widths measured),
      // with a gap and a hairline between — shrunk together if they would
      // not fit the width
      const gapW = Math.round(64 * k);
      const cellWidths = (v, l, sb) => stats.map(s => Math.max(s.value.length * 0.48 * v, s.label.length * 0.74 * l, s.sub.length * 0.6 * sb));
      let fz = 1;
      if (stats.length) { const tw = cellWidths(92 * k, 25 * k, 22 * k).reduce((a, b) => a + b + gapW, -gapW); if (tw > maxW) fz = Math.max(0.6, maxW / tw); }
      const vSize = Math.round(92 * k * fz), lSize = Math.round(25 * k * fz), sSize = Math.round(22 * k * fz);
      // top to bottom, each group with room round it, the block centred in
      // the space under the logo: match line / first name / NAME / pill / figures
      const hLine = line ? lineSize + Math.round(46 * k) : 0, hFirst = first ? Math.round(firstSize * 1.06) : 0, hMain = mainSize;
      const hRow = Math.round(pillSize * 1.22 + 2 * pb), gMain = Math.round(40 * k), gStats = Math.round(64 * k);
      const hStats = stats.length ? Math.round(vSize * 1.04 + lSize * 1.3 + (stats.some(s => s.sub) ? sSize * 1.5 : 0)) : (meta ? Math.round(40 * k) : 0);
      const total = hLine + hFirst + hMain + gMain + hRow + (hStats ? gStats + hStats : 0);
      const yLine = p.portrait ? Math.max(hero.h + Math.round(70 * k), Math.round(hero.h + (H - hero.h - total) / 2))
        : Math.max(Math.round(205 * k), Math.round((H - total) / 2 + 40 * k));
      const yFirst = yLine + hLine, yMain = yFirst + hFirst, yRow = yMain + hMain + gMain, yStats = yRow + hRow + gStats;
      const G = graph();
      const bgIdx = bg ? G.file(bg) : G.input(['-f', 'lavfi', '-i', `color=c=0x0d1526:s=${even(W / 4)}x${even(H / 4)}`]);
      // a slow push-in on the blurred picture (done small: it is all soft)
      G.add(`[${bgIdx}:v]scale=${W}:${H}:flags=bicubic,zoompan=z='1.0+${r2(0.07 / n * 10000) / 10000}*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${n}:s=${even(W / 2)}x${even(H / 2)}:fps=${p.fps},` +
        `scale=${W}:${H}:flags=bicubic,setsar=1,format=yuv420p,trim=end_frame=${n},setpts=PTS-STARTPTS[bg0]`);
      // the team panel slides in: from the right (16:9), down from the top (9:16)
      const hi = G.file(hero.file), hp = G.label('hero'), into = `(1-${easeOut(prog(0.05, 0.55))})`;
      G.add(loopImg(hi, p.fps, hp));
      G.add(`[bg0][${hp}]overlay=` + (p.portrait ? `x=0:y='-${hero.h}*${into}'` : `x='${hero.x}+${W - hero.x}*${into}':y=0`) + `:eval=frame:shortest=1[bg2]`);
      // our logo and the kicker, top left
      const li = G.file(assets.logoSmall), lg = G.label('logo');
      G.add(loopImg(li, p.fps, lg, 'format=rgba,'));
      G.add(`[${lg}]fade=t=in:st=0.15:d=0.3:alpha=1[${lg}f]`);
      const logoY = Math.round((p.portrait ? 56 : 70) * k), logoH = even(Math.min(W, H) * 0.075);
      G.add(`[bg2][${lg}f]overlay=x=${x0}:y=${logoY}:shortest=1[bg3]`);
      let cur = 'bg3';
      const text = [];
      if (kicker) text.push(drawtext({ font: FONTS.body, file: textFile(dir, 'kicker', kicker), size: Math.round(30 * k), color: '0xe2e8f0',
        x: `${x0 + logoH + Math.round(22 * k)}-${Math.round(20 * k)}*(1-${easeOut(prog(0.2, 0.4))})`, y: `${logoY + Math.round(logoH / 2 - 18 * k)}`, alpha: prog(0.2, 0.3) }));
      if (line) {
        text.push(`drawbox=x=${x0}:y=${yLine + Math.round(3 * k)}:w=${Math.max(3, Math.round(6 * k))}:h=${lineSize}:color=${accent}@1:t=fill:enable='gte(t,0.24)'`);
        text.push(drawtext({ font: FONTS.body, file: textFile(dir, 'line', line), size: lineSize, color: '0xf1f5f9',
          x: `${x0 + Math.round(20 * k)}-${Math.round(26 * k)}*(1-${easeOut(prog(0.24, 0.4))})`, y: `${yLine}`, alpha: prog(0.24, 0.3) }));
      }
      if (text.length) { G.add(`[${cur}]${text.join(',')}[t1]`); cur = 't1'; }
      // the name rises into place: first name, then the big surname
      const rise = (name, opt, y) => {
        const r = risingText(G, dir, name, { ...opt, T, p });
        const o = G.label('c');
        G.add(`[${cur}][${r.label}]overlay=x=${x0 - Math.round(opt.size * 0.04)}:y=${y - r.pad}:shortest=1[${o}]`);
        cur = o;
      };
      if (first) rise('first', { text: first, font: FONTS.display, size: firstSize, at: 0.26, color: '0xdbe4f0' }, yFirst);
      rise('main', { text: main, font: FONTS.display, size: mainSize, at: first ? 0.34 : 0.28 }, yMain);
      // accent bar, the pill, then what the video holds or the figures
      const barW = Math.round(84 * k), barH = Math.max(4, Math.round(8 * k));
      const bar = G.label('bar');
      G.add(`[${G.input(['-f', 'lavfi', '-i', `color=c=${accent}:s=${barW}x${barH}:r=${p.fps}:d=${f6(T)}`])}:v]format=yuva420p[${bar}]`);
      const yPillText = yRow + pb;
      const barY = yPillText + Math.round(pillSize * 0.62) - Math.round(barH / 2);
      G.add(`[${cur}][${bar}]overlay=x='${x0}-${barW}*(1-${easeOut(prog(0.46, 0.4))})':y=${barY}:eval=frame:shortest=1[c_bar]`);
      cur = 'c_bar';
      const rest = [];
      if (pill) rest.push(drawtext({ font: FONTS.event, file: textFile(dir, 'pill', pill), size: pillSize, color: 'white', box: `${accent}@1.0`, boxBorder: pb,
        x: `${x0 + barW + Math.round(22 * k) + pb}-${Math.round(36 * k)}*(1-${easeOut(prog(0.52, 0.4))})`, y: `${yPillText}`, alpha: prog(0.52, 0.25) }));
      if (stats.length) {
        const widths = cellWidths(vSize, lSize, sSize);
        let cx = x0;
        const xs = widths.map(w => { const x = cx; cx += Math.round(w) + gapW; return x; });
        stats.forEach((s, i) => {
          const at = 0.64 + 0.08 * i, cx = xs[i];
          const up = (dy) => `${dy}+${Math.round(26 * k)}*(1-${easeOut(prog(at, 0.36))})`;
          if (i) rest.push(`drawbox=x=${cx - Math.round(gapW / 2)}:y=${yStats + Math.round(14 * k)}:w=${Math.max(1, Math.round(2 * k))}:h=${hStats - Math.round(14 * k)}:color=white@0.2:t=fill:enable='gte(t,${r2(at)})'`);
          rest.push(drawtext({ font: FONTS.display, file: textFile(dir, `sv${i}`, s.value), size: vSize, color: 'white', x: `${cx}`, y: up(yStats), alpha: prog(at, 0.25) }));
          rest.push(drawtext({ font: FONTS.body, file: textFile(dir, `sl${i}`, s.label.split('').join('\u2009')), size: lSize, color: accent, x: `${cx + Math.round(3 * k)}`,
            y: up(yStats + Math.round(vSize * 1.04)), alpha: prog(at + 0.04, 0.25) }));
          if (s.sub) rest.push(drawtext({ font: FONTS.body, file: textFile(dir, `ss${i}`, s.sub), size: sSize, color: '0xa9b6c8', x: `${cx + Math.round(3 * k)}`,
            y: up(yStats + Math.round(vSize * 1.04 + lSize * 1.5)), alpha: prog(at + 0.08, 0.25) }));
        });
      } else if (meta) {
        rest.push(drawtext({ font: FONTS.body, file: textFile(dir, 'meta', meta), size: Math.round(30 * k), color: '0xdbe4f0',
          x: `${x0}`, y: `${yStats}`, alpha: prog(0.66, 0.3) }));
      }
      if (rest.length) { G.add(`[${cur}]${rest.join(',')}[c_rest]`); cur = 'c_rest'; }
      // opens on the band leaving (in the video's colour), ends on it arriving
      await withWipes(G, p, assets, cur, 'vout', n, { head: kind, tail: 'BRAND' });
      G.add(`[${silence(G, T)}:a]${cutAudio(T)}[aout]`);
      await run(withScript(dir, G, ['-map', '[vout]', '-map', '[aout]', ...encodeArgs(p), '-frames:v', String(n), out]), { totalSec: T });
      return { duration: T };
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  // End card: the band clears onto our logo, which springs into place under a
  // sweep of light; the website rises under it; then black.
  async function renderOutro({ kind = 'BRAND', profile: p, assets, out, workDir, site }) {
    const dir = fs.mkdtempSync(path.join(workDir, 'outro-'));
    try {
      const k = p.k, W = p.w, H = p.h, n = gridLength(OUTRO_SEC, p.fps), T = n / p.fps, C = assets.C, fps = p.fps;
      const siteText = cleanText(site || 'allsportslivestreams.com', 48).toLowerCase();
      const G = graph();
      const bgi = G.file(assets.endBg);
      G.add(`[${bgi}:v]scale=${W}:${H}:flags=bicubic,setsar=1,format=yuv420p,loop=loop=-1:size=1:start=0,settb=1/${fps},setpts=N,trim=end_frame=${n}[bg]`);
      // the spring: zoompan from 0.86 of the size to a touch past it, settling
      const li = G.file(assets.logoSpring);
      const u = clampExpr(`(on-${r2(0.24 * fps)})/${r2(0.5 * fps)}`);
      G.add(`[${li}:v]format=rgba,zoompan=z='1+${r2(assets.springZ - 1)}*${easeOutBack(u)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${n}:s=${C}x${C}:fps=${fps},format=rgba,split[lg][lgm]`);
      // the sweep of light, only where the logo is
      const si = G.file(assets.shine);
      G.add(`[lgm]alphaextract[la]`);
      G.add(`[${si}:v]format=rgba,loop=loop=-1:size=1:start=0,settb=1/${fps},setpts=N,crop=w=${C}:h=${C}:x='${2 * C}-${2 * C}*${prog(0.68, 0.46)}':y=0,alphaextract[sa]`);
      G.add(`[sa][la]blend=all_mode=multiply:shortest=1[ma]`);
      G.add(`color=c=white:s=${C}x${C}:r=${fps}:d=${f6(T)},format=yuva420p[wh]`);
      G.add(`[wh][ma]alphamerge[shn]`);
      G.add(`[lg][shn]overlay=0:0:format=auto:shortest=1,fade=t=in:st=0.22:d=0.24:alpha=1[lgf]`);
      const yLogo = Math.round(H * 0.44 - C / 2);
      G.add(`[bg][lgf]overlay=x=${Math.round((W - C) / 2)}:y=${yLogo}:shortest=1[b1]`);
      const ySite = yLogo + Math.round(C / 2 + Math.min(W, H) * 0.15 + 26 * k);
      const ul = G.label('ul');
      G.add(`[${G.input(['-f', 'lavfi', '-i', `color=c=0x${ACCENT.BRAND}:s=${Math.round(120 * k)}x${Math.max(3, Math.round(5 * k))}:r=${fps}:d=${f6(T)}`])}:v]format=yuva420p,fade=t=in:st=0.55:d=0.2:alpha=1[${ul}]`);
      G.add(`[b1]${drawtext({ font: FONTS.body, file: textFile(dir, 'site', siteText), size: Math.round(36 * k), color: 'white',
        x: '(w-text_w)/2', y: `${ySite}+${Math.round(22 * k)}*(1-${easeOut(prog(0.42, 0.4))})`, alpha: prog(0.42, 0.3) })}[b2]`);
      G.add(`[b2][${ul}]overlay=x=${Math.round(W / 2 - 60 * k)}:y=${ySite + Math.round(60 * k)}:shortest=1[b3]`);
      await withWipes(G, p, assets, 'b3', 'bw', n, { head: kind, tail: null });
      G.add(`[bw]fade=t=out:st=${f6(T - 0.32)}:d=0.32[vout]`);
      G.add(`[${silence(G, T)}:a]${cutAudio(T)}[aout]`);
      await run(withScript(dir, G, ['-map', '[vout]', '-map', '[aout]', ...encodeArgs(p), '-frames:v', String(n), out]), { totalSec: T });
      return { duration: T };
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  // The finished video: the segments' picture copied as it is, their sound
  // encoded once into one AAC track, the index at the front.
  // segs: [{ file, dur }]. Each segment is cut to exactly its own length: the
  // AAC encoder flushes one frame past the end, which would otherwise push the
  // next segment ~20 ms late and leave a jolt at every join.
  async function concat(segs, out, workDir) {
    const list = path.join(workDir, `concat-${Date.now()}.txt`);
    fs.writeFileSync(list, segs.map(s => `file '${String(s.file).replace(/'/g, "'\\''")}'\nduration ${s.dur.toFixed(6)}\noutpoint ${s.dur.toFixed(6)}`).join('\n'));
    try {
      await run(['-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v', '-map', '0:a', '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4', out]);
    } finally {
      fs.unlink(list, () => {});
    }
  }

  /* ------------------------------------------------------------- cache */
  const segDir = path.join(cacheDir, 'segments');
  fs.mkdirSync(segDir, { recursive: true });
  function segmentKey(clipKey, card, p, wheelOn, spec) { return sha1({ STYLE, clipKey, card, p: p.key, wheelOn: !!wheelOn, spec: spec || null }); }
  const inflight = new Map(); // segment key → the render making it
  function cached(key) {
    const f = path.join(segDir, `${key}.mkv`);
    try { const st = fs.statSync(f); if (st.size > 1024) { const now = new Date(); fs.utimesSync(f, now, now); return f; } } catch (e) { /* not there */ }
    return null;
  }
  // Oldest first out once the cache is over its size, or the disk runs low.
  function freeBytes() { try { const st = fs.statfsSync(segDir); return st.bavail * st.bsize; } catch (e) { return Infinity; } }
  function trimCache() {
    try {
      const now = Date.now();
      const files = fs.readdirSync(segDir).map(n => { const f = path.join(segDir, n); const st = fs.statSync(f); return { f, n, size: st.size, at: st.mtimeMs }; })
        .filter(x => { if (/\.part\.mkv$/.test(x.n) && now - x.at > 3600000) { fs.unlink(x.f, () => {}); return false; } return true; }) // an abandoned half-render
        .sort((a, b) => a.at - b.at);
      let total = files.reduce((n, x) => n + x.size, 0);
      let free = freeBytes();
      for (const x of files) {
        if (total <= cacheMaxBytes && free >= 1024 * 1048576) break;
        fs.unlinkSync(x.f); total -= x.size; free += x.size;
      }
    } catch (e) { /* best effort */ }
  }

  /* ---------------------------------------------------------- the whole */
  // clips: [{ file, clipKey, card, wheel? }] in play order (files already
  // local; wheel: the delivery's data, see wheelFor). title: see renderIntro.
  // format: '16:9' (default) or '9:16'; wheel: lay each clip's wagon wheel on.
  // onProgress(0…1, message).
  async function renderHighlight({ clips, title, out, workDir, site, format, wheel: wheelOn, onProgress = () => {} }) {
    const started = Date.now();
    let reused = 0;
    const infos = await Promise.all(clips.map(c => probe(c.file)));
    const usable = clips.map((c, i) => ({ ...c, info: infos[i] })).filter(c => c.info && c.info.duration > 0.8);
    if (!usable.length) throw new Error('no playable clips');
    const p = pickProfile(usable.map(c => c.info), format);
    onProgress(0.02, 'Getting the graphics ready…');
    const assets = await ensureAssets(p);
    const segs = [];
    const total = usable.reduce((n, c) => n + c.info.duration, 0) + INTRO_SEC + OUTRO_SEC;
    let done = 0;
    const step = (sec, msg) => (f) => onProgress(Math.min(0.97, 0.04 + 0.92 * (done + sec * f) / total), msg);

    const intro = path.join(workDir, 'intro.mkv');
    const introLen = await renderIntro({ title: title || {}, bgSrc: usable[0].file, bgInfo: usable[0].info, profile: p, assets, out: intro, workDir });
    done += INTRO_SEC; step(0, 'Title card done')(0);
    segs.push({ file: intro, dur: introLen.duration });

    for (let i = 0; i < usable.length; i++) {
      const c = usable[i];
      const msg = `Editing clip ${i + 1} of ${usable.length} — titles & transitions…`;
      const key = c.clipKey ? segmentKey(c.clipKey, c.card, p, wheelOn, wheelOn ? wheelFor(c.wheel) : null) : null;
      let seg = key ? cached(key) : null;
      if (!seg && key && inflight.has(key)) seg = await inflight.get(key).catch(() => null); // another video is making it right now
      if (seg) reused++;
      if (!seg) {
        onProgress(Math.min(0.97, 0.04 + 0.92 * done / total), msg);
        const make = (async () => {
          const target = key ? path.join(segDir, `${key}.${process.pid}-${Date.now()}.part.mkv`) : path.join(workDir, `seg-${i}.mkv`);
          try {
            await renderClip({ src: c.file, info: c.info, card: c.card, wheel: c.wheel, wheelOn, profile: p, assets, out: target, workDir, onProgress: step(c.info.duration, msg) });
          } catch (e) { fs.unlink(target, () => {}); throw e; }
          if (!key) return target;
          const final = path.join(segDir, `${key}.mkv`);
          fs.renameSync(target, final);
          return final;
        })();
        if (key) inflight.set(key, make);
        try { seg = await make; } finally { if (key) inflight.delete(key); }
      }
      segs.push({ file: seg, dur: clipFrames(c.info, p) / p.fps });
      done += c.info.duration;
    }

    const outro = path.join(workDir, 'outro.mkv');
    const outroLen = await renderOutro({ kind: 'BRAND', profile: p, assets, out: outro, workDir, site });
    segs.push({ file: outro, dur: outroLen.duration });
    onProgress(0.97, 'Putting the video together…');
    await concat(segs, out, workDir);
    trimCache();
    log(`${usable.length} clip(s) at ${p.key}${wheelOn ? ' with wheels' : ''} in ${((Date.now() - started) / 1000).toFixed(1)} s (${reused} from the cache)`);
    onProgress(1, 'Done');
    return { profile: p, included: usable.length, skipped: clips.length - usable.length, format: p.portrait ? '9:16' : '16:9' };
  }

  return { renderHighlight, renderClip, renderIntro, renderOutro, concat, probe, pickProfile, ensureAssets, cardForClip, wheelFor, queueLength: () => queued, STYLE,
    // the frame counts it will use (tests): a clip, and the title / end cards
    framesOf: (info, p) => clipFrames(info, p), cardFrames: (p) => ({ intro: gridLength(INTRO_SEC, p.fps), outro: gridLength(OUTRO_SEC, p.fps) }),
    // where things go (tests): the 9:16 picture, a clip's wheel, when its shot draws
    layout: { portraitBox, wheelPlace, wheelLead: WHEEL_LEAD } };
}

module.exports = { createHighlightEditor, cardForClip, wheelFor, STYLE };
