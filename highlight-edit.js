'use strict';
/**
 * highlight-edit.js — the "pro edit" of a downloaded highlights video.
 *
 * A plain compile glues the clips end to end: hard cuts, no titles. This turns
 * the same clips into a package ready to post:
 *
 *   title card ─▶ clip ─▶ band wipe ─▶ clip ─▶ band wipe ─▶ … ─▶ end card
 *
 * - The opening (4.8 s), in acts that follow one another — never everything
 *   at once:
 *     1. the brand: the band whips away onto a dark stage, team-colour shards
 *        sweep across, light lines run in, our logo springs up through a ring
 *        of light with a glint across it, then draws back;
 *     2. the teams: their colours slide in as panels (one each, from either
 *        side; a whole panel for one team), their badges rise on white discs,
 *        their names rise through a mask, VS between them;
 *     3. the match: the title card — the tournament, the match and venue, the
 *        player's name rising into place, what the video holds and the
 *        player's figures (runs and balls, fours, sixes / wickets, overs…),
 *        the team panel — over a blurred, slowly pushing still of the first clip;
 *     4. into the footage: the band sweeps in and the first clip is under it.
 * - Each clip carries an event tag at the top left for its first few seconds:
 *   a strip in the batting team's colour, the event (SIX / FOUR / WICKET …),
 *   the team's badge, the player, the over and the bowler — each part sliding
 *   in after the one before and out in reverse; gone long before the ball is
 *   bowled, so the shot itself is never covered. Top left on purpose: the
 *   broadcast score bar (bottom) and the channel logo (top right) are already
 *   in the picture.
 * - Between clips a branded band sweeps across: a slab in the colour of what
 *   comes next, then the navy panel with the logo. It is motion-blurred while
 *   it rushes in and out, all but stops while it covers the cut (so a cut is
 *   never seen), and a glint of light crosses the logo. It is silent: at a cut
 *   there is only the clips' own sound.
 * - The end card (3.2 s): the band clears onto a stage framed by shards in the
 *   teams' colours; the logo springs into place under a sweep of light; the
 *   player (or the teams), the tournament and what the video held rise under
 *   it, then the website, and a fade to black.
 * - The sound: each clip's own — commentary and crowd untouched — brought to
 *   one level (a single gain per clip, towards -16 LUFS, never past -1 dBTP,
 *   so no clip jumps out or clips), and under the opening and the end card
 *   only, a soft sound design made here from noise and tones (whooshes with
 *   the shards and panels, a low thump under the logo, a shimmer with its
 *   glint): nothing sampled, nothing licensed, never over a clip.
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
 *   names rise through a mask (drawtext into alphamerge), the logo's spring
 *   and the rings of light are zoompan, panels and shards are stills drawn
 *   once (geq on one frame, held) and moved by overlay expressions.
 *
 * Node core only.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const STYLE = 'v4';             // bump when the look changes: old cached segments are left alone
const STING = 0.6;              // the whole wipe, seconds
const HALF = STING / 2;         // each segment's half of it
const EASE_K = 0.85;            // the band rushes in, all but stops over the cut, rushes out
const SHUTTER = 0.5;            // motion blur: the band smears over half a frame's travel (a 180° shutter)
const BLUR = [0, 12, 30, 64, 128]; // the band's pre-blurred copies: box radius along the motion, px at 1080p
const GLINT = [0.16, 0.44];     // stinger time the glint crosses the logo (the cut is at HALF)
const INTRO_SEC = 4.8;          // the opening: brand · teams · the match · into the footage
const OUTRO_SEC = 3.2;
const ACT = { teams: 1.15, card: 2.45 };   // when the opening's second and third acts begin (s)
// A clip's level: one gain towards -16 LUFS (integrated), at most +6 dB up or
// 10 dB down, and never so much that its true peak passes -1 dBTP.
const LOUD = { target: -16, up: 6, down: 10, ceiling: -1.0 };
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
const easeInOut = (u) => `(${u}*${u}*(3-2*${u}))`;                          // smooth start and stop
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
// team (optional): the batting side's { name, short, color, logo } — its
// colour and badge go on the tag (the logo itself only as a fingerprint here:
// the card is part of the cached segment's key).
function cardForClip(clip, team) {
  const c = clip || {};
  const card = cardOf(c);
  if (team && (team.name || team.short)) {
    card.team = { short: cleanText(team.short || String(team.name).split(/\s+/).map(w => w[0]).join(''), 6), color: hexOf(team.color) || null,
      logo: team.logo ? sha1(String(team.logo)).slice(0, 12) : null };
  }
  return card;
}
function cardOf(c) {
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
  // ⚡ How many ffmpegs at once: one per core but one (that core is left for
  // the live server on the same machine), at most four, and no more than the
  // memory holds (~700 MB each, all in) — ONE on a small server (two CPUs or
  // less: the live server comes first, exactly as before). A clip's segment
  // is a filtergraph (drawtext, overlays) that runs mostly on one core, so
  // separate clips side by side use the machine far better than more threads
  // inside one. Measured, 50 clips at 720p on 4 cores: one at a time 137 s,
  // two 99 s, three 86 s, four 82 s. HIGHLIGHT_PARALLEL / opts.parallel overrides.
  const cores = cpuBudget();
  // 🎮 NVIDIA NVENC, only when asked for (opts.encoder 'nvenc' /
  // HIGHLIGHT_ENCODER=nvenc) AND this ffmpeg has h264_nvenc AND a real
  // one-frame encode works on this machine — else x264, as always. Every
  // segment of a video comes from the one encoder (the finished picture is a
  // copy of them), and the encoder is part of a cached segment's key.
  let encoder = 'x264';
  if (String(opts.encoder || '').toLowerCase() === 'nvenc') {
    try {
      const t = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30:d=0.2', '-frames:v', '2', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { timeout: 20000 });
      if (t.status === 0) encoder = 'nvenc';
      else log('NVENC asked for but not usable here — encoding with x264');
    } catch (e) { log('NVENC asked for but not usable here — encoding with x264'); }
  }
  const parallel = Math.max(1, Math.min(encoder === 'nvenc' ? 2 : 4, Number(opts.parallel) || (cores <= 2 ? 1 : Math.min(cores - 1, Math.floor(memBudgetMB() / 700) || 1))));
  // Decoder / encoder threads each: the cores per ffmpeg, rounded up, at most
  // 2 (beyond that each thread only adds frames held in memory).
  const threads = Math.max(1, Math.min(opts.threads || Math.ceil(cores / parallel) || 1, opts.threads ? 3 : 2));
  fs.mkdirSync(cacheDir, { recursive: true });

  // Low priority where the OS has it: the live server on the same machine
  // always comes first.
  let niceOk = false;
  if (process.platform !== 'win32' && opts.nice !== false) {
    try { niceOk = spawnSync('nice', ['-n', '1', 'true']).status === 0; } catch (e) { niceOk = false; }
  }
  const niceLevel = String(opts.niceLevel == null ? 12 : opts.niceLevel);

  // At most `parallel` ffmpegs across every job (one, on a small server):
  // jobs interleave segment by segment instead of fighting over the CPU.
  // A job's `signal` (AbortController) cancels it: a command still waiting
  // never starts, a running one is killed.
  let active = 0, queued = 0;
  const waiting = [];
  const abortError = () => Object.assign(new Error('cancelled'), { cancelled: true });
  // Waits for shared work (the band's frames, the graphics — made once, kept
  // for every video) — but a cancelled video stops waiting at once; the
  // shared work itself goes on and is kept for the next one.
  function untilAbort(pr, signal) {
    if (!signal) return pr;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const on = () => reject(abortError());
      signal.addEventListener('abort', on, { once: true });
      pr.then((v) => { signal.removeEventListener('abort', on); resolve(v); }, (e) => { signal.removeEventListener('abort', on); reject(e); });
    });
  }
  function run(args, { timeoutMs = 15 * 60 * 1000, totalSec = 0, onProgress, signal } = {}) {
    if (signal && signal.aborted) return Promise.reject(abortError());
    const go = () => {
      active++;
      return exec(args, timeoutMs, totalSec, onProgress, signal).finally(() => { active--; const n = waiting.shift(); if (n) n(); });
    };
    if (active < parallel) return go();
    queued++;
    return new Promise((resolve, reject) => waiting.push(() => {
      queued--;
      if (signal && signal.aborted) { reject(abortError()); const n = waiting.shift(); if (n) n(); return; }
      go().then(resolve, reject);
    }));
  }
  function exec(args, timeoutMs, totalSec, onProgress, signal) {
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
      const onAbort = () => { p.kill('SIGKILL'); };
      if (signal) { signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); }
      const off = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); };
      p.on('error', (e) => { off(); reject(e); });
      p.on('close', (code) => { off(); if (signal && signal.aborted) return reject(abortError()); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.trim().slice(-1500)}`)); });
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
    const video = encoder === 'nvenc'
      // the same quality target and caps as x264's, a key frame every 2 s, no B-frames (every segment opens and closes cleanly)
      ? ['-c:v', 'h264_nvenc', '-preset', 'slow', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-maxrate', big ? '6M' : '4M', '-bufsize', big ? '12M' : '8M',
        '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(p.fps), '-g', String(p.fps * 2), '-bf', '0', '-forced-idr', '1', '-spatial_aq', '1']
      : ['-c:v', 'libx264', '-preset', preset, '-crf', '23', '-maxrate', big ? '6M' : '4M', '-bufsize', big ? '12M' : '8M',
        '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-r', String(p.fps),
        '-x264-params', `stitchable=1:keyint=${p.fps * 2}:min-keyint=${p.fps}`];
    return [...video,
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
    // The opening's logo: drawn at 1.3x the size it settles at, on a box twice
    // the frame it is shown in — zoompan springs it from 0.65 of its size to
    // all of it, always scaling down (sharp).
    out.Ci = even(S * 0.30 * 1.25); out.introZ = 1 / 0.65;
    out.logoIntro = path.join(dir, 'logo-intro.png');
    await makeOnce(out.logoIntro, ['-i', LOGO, '-vf', `scale=-2:${even(S * 0.30 * 1.3)}:flags=lanczos,format=rgba,pad=${2 * out.Ci}:${2 * out.Ci}:(ow-iw)/2:(oh-ih)/2:color=black@0`, '-frames:v', '1']);
    out.shineIntro = path.join(dir, 'shine-intro.png');
    await makeOnce(out.shineIntro, ['-f', 'lavfi', '-i', `color=c=white@0:s=${3 * out.Ci}x${out.Ci},format=rgba`, '-vf',
      `geq=r=255:g=255:b=255:a='210*exp(-pow((X-${1.5 * out.Ci}-0.45*(Y-${out.Ci / 2}))/${r2(out.Ci * 0.08)},2))'`, '-frames:v', '1']);
    // A ring of light (it grows out from behind the logo and fades): a soft
    // white circle line with a warm glow round it.
    out.RR = even(S * 0.62);
    out.ring = path.join(dir, 'ring.png');
    const rr0 = `(hypot(X-${out.RR / 2},Y-${out.RR / 2})-${r2(out.RR * 0.2)})`;   // small: zoompan only enlarges, so it grows from here
    await makeOnce(out.ring, ['-f', 'lavfi', '-i', `color=c=white@0:s=${out.RR}x${out.RR},format=rgba`, '-vf',
      // (its alpha falls to nothing well inside the picture's edges: the glow is never cut off square)
      `geq=r=255:g='238+17*exp(-pow(${rr0}/${r2(3 * k)},2))':b='200+55*exp(-pow(${rr0}/${r2(3 * k)},2))':a='min(255,235*exp(-pow(${rr0}/${r2(2.6 * k)},2))+60*exp(-pow(${rr0}/${r2(14 * k)},2)))*clip((${r2(out.RR * 0.46)}-hypot(X-${out.RR / 2},Y-${out.RR / 2}))/${r2(out.RR * 0.1)},0,1)'`, '-frames:v', '1']);

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
  async function withWipes(G, p, a, inLabel, outLabel, n, { head, tail, signal }) {
    let cur = inLabel;
    const lay = async (kind, side, at) => {
      const ly = G.label('ly'), o = G.label('w');
      G.add(`[${G.file(await untilAbort(a.sting(kind, side), signal))}:v]settb=1/${p.fps},setpts=N+${at}[${ly}]`);
      G.add(`[${cur}][${ly}]overlay=0:0:eof_action=pass[${o}]`);
      cur = o;
    };
    if (head) await lay(head, 'head', 0);
    if (tail) await lay(tail, 'tail', n - windowSpan(p, 'tail').n);
    G.add(`[${cur}]null[${outLabel}]`);
  }

  /* --------------------------------------------- stills drawn in a graph */
  // A picture drawn inside a graph — geq on ONE frame, then held for the
  // length of the segment: as cheap for a long card as for a short one.
  function heldStill(G, p, w, h, expr, label) {
    G.add(`color=c=black@0:s=${even(w)}x${even(h)}:r=${p.fps}:d=0.1,format=rgba,geq=${expr},loop=loop=-1:size=1:start=0,settb=1/${p.fps},setpts=N[${label}]`);
  }
  // A slanted slab (a parallelogram leaning by sp over its height) in a
  // colour deepening downwards, with faint diagonal ribs and a hairline on
  // its leading edge; drawn at half size (it is only seen moving, or behind
  // sharp type) and scaled up. side: which edge leans ('right' / 'left' /
  // 'bottom' / 'top' / 'both').
  function slab(G, p, w, h, hex, side, label, o = {}) {
    const q = 0.5, W2 = even(w * q), H2 = even(h * q), sp = Math.round((o.sp != null ? o.sp : h * 0.18) * q), hair = Math.max(1, Math.round(2 * p.k));
    const [R, Gc, B] = rgbOf(hex || ACCENT.BRAND);
    // u: how far inside the slab, from its slanted edge(s)
    const u = side === 'right' ? `(${W2}-${sp}*(${H2}-Y)/${H2}-X)` : side === 'left' ? `(X-${sp}*Y/${H2})`
      : side === 'bottom' ? `(${H2}-${sp}*X/${W2}-Y)` : side === 'top' ? `(Y-${sp}*(${W2}-X)/${W2})`
      : `min(X-${sp}*(${H2}-Y)/${H2},${W2}-${sp}*Y/${H2}-X)`;
    const shade = `(${o.top == null ? 1.0 : o.top}-${o.fall == null ? 0.42 : o.fall}*Y/${H2})`;
    const rib = `(1+0.05*sin((X+Y)/${r2(9 * p.k)}))`;
    const c = (v) => `if(lt(${u},${hair}),245,clip(${v}*${shade}*${rib},0,255))`;
    const a = `255*clip(${u}/1.5,0,1)*${o.alpha == null ? 1 : o.alpha}`;
    G.add(`color=c=black@0:s=${W2}x${H2}:r=${p.fps}:d=0.1,format=rgba,geq=r='${c(R)}':g='${c(Gc)}':b='${c(B)}':a='${a}',scale=${even(w)}:${even(h)}:flags=bicubic,loop=loop=-1:size=1:start=0,settb=1/${p.fps},setpts=N[${label}]`);
  }
  // A team's badge on a white disc ringed in its colour (its initials when it
  // has no badge) → { file, size } (the size with its ring).
  async function teamDisc(p, team, D, dir, name, signal) {
    const ring = Math.max(3, Math.round(D * 0.045)), DD = even(D + 2 * ring);
    const col = hexOf(team && team.color) || ACCENT.BRAND, [r, g, b] = rgbOf(col);
    const G = graph();
    const rr = `hypot(X-${DD / 2},Y-${DD / 2})`, inner = `lt(${rr},${r2(D / 2 - 1)})`;
    G.add(`[${G.input(['-f', 'lavfi', '-i', `color=c=black@0:s=${DD}x${DD},format=rgba`])}:v]geq=r='if(${inner},255,${r})':g='if(${inner},255,${g})':b='if(${inner},255,${b})':a='255*${clampExpr(`${DD / 2}-${rr}`)}'[d]`);
    const badge = team ? await badgeFile(team.logo, dir, `${name}-badge`) : null;
    if (badge) {
      const box = Math.round(D * 0.66);
      G.add(`[${G.file(badge)}:v]scale=${box}:${box}:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba[lg]`);
      G.add(`[d][lg]overlay=x=(W-w)/2:y=(H-h)/2:format=rgb[f]`);
    } else {
      const initials = cleanText((team && (team.short || String(team.name || '').split(/\s+/).map(w => w[0]).join(''))) || '', 4) || 'TEAM';
      const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 150;
      G.add(`[d]${drawtext({ font: FONTS.display, file: textFile(dir, `${name}-ini`, initials), size: Math.round(D * (initials.length > 3 ? 0.34 : 0.42)),
        color: light ? '0x0b1220' : `0x${col}`, x: '(w-text_w)/2', y: '(h-text_h)/2' })}[f]`);
    }
    const file = path.join(dir, `${name}.png`);
    await run(withScript(dir, G, ['-map', '[f]', '-frames:v', '1', file]), { signal });
    return { file, size: DD };
  }
  // A picture springing in (zoompan): from `from` of its size to all of it
  // (overshooting a touch), starting `at`, for frames [0, n) of the segment —
  // the file is a box twice the frame it is shown in. → label (frames 0…n).
  function springIn(G, p, file, box, n, { at, dur = 0.5, from, out }) {
    const Z = 1 / from, fps = p.fps, u = clampExpr(`(on-${r2(at * fps)})/${r2(dur * fps)}`);
    const back = out ? `-${r2((Z - 1) * out.by)}*${easeIn(clampExpr(`(on-${r2(out.at * fps)})/${r2(out.dur * fps)}`))}` : '';
    const L = G.label('spr');
    G.add(`[${G.file(file)}:v]format=rgba,zoompan=z='1+${r2(Z - 1)}*${easeOutBack(u)}${back}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${n}:s=${box}x${box}:fps=${fps},format=rgba[${L}]`);
    return L;
  }
  // A ring of light growing out (zoompan from half its size) and fading,
  // over [at, at + dur], as a stream of exactly those frames, timed to them.
  function ringBurst(G, p, a, at, dur, label) {
    const fps = p.fps, nf = Math.max(2, Math.round(dur * fps)), u = clampExpr(`on/${nf - 1}`);
    G.add(`[${G.file(a.ring)}:v]format=rgba,zoompan=z='1+0.9*${easeOut(u)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${nf}:s=${a.RR}x${a.RR}:fps=${fps},format=rgba,` +
      `fade=t=out:st=${f6(dur * 0.35)}:d=${f6(dur * 0.65)}:alpha=1,settb=1/${fps},setpts=N+${Math.round(at * fps)}[${label}]`);
  }

  /* -------------------------------------------------------- sound design */
  // The opening's and the end card's sound, made here — noise and tones
  // shaped by ffmpeg, nothing sampled or licensed — quiet (never past -12
  // dBFS), and only ever under the cards (never over a clip). events:
  // [{ type: whoosh | impact | shimmer | riser, at, dur, db }] — db: the
  // event's own true peak (dBFS). The sources' own peaks, measured: ffmpeg's
  // sine is 1/8 (-18.1 dBFS); pink noise kept to 260 Hz – 4.2 kHz peaks at
  // -7.7 dBFS, kept to 1.2 – 9 kHz at -9.9 — the envelopes make up the rest.
  function sfxTrack(G, T, events, label) {
    const parts = [], dur = f6(T + 0.25);
    const CAL = { whoosh: 7.7, riser: 9.9, impact: 18.1, shimmer: 18.1 };
    events.forEach((e) => {
      const L = G.label('sx'), a = r2(e.at), d = r2(e.dur || 0.4);
      const pk = Math.round(Math.pow(10, ((e.db == null ? -20 : e.db) + (CAL[e.type] || 0)) / 20) * 1000) / 1000;
      if (e.type === 'whoosh') {
        // pink noise through a band, swelling and falling away
        const env = `${pk}*if(between(t,${a},${r2(a + d)}),pow(sin(PI*(t-${a})/${d}),1.7),0)`;
        G.add(`anoisesrc=color=pink:amplitude=1:sample_rate=48000:nb_samples=256:duration=${dur},highpass=f=${e.lo || 260},lowpass=f=${e.hi || 4200},volume='${env}':eval=frame,aformat=sample_fmts=fltp:channel_layouts=stereo[${L}]`);
      } else if (e.type === 'impact') {
        // a low thump: a deep tone dying away fast
        const env = `${pk}*if(gte(t,${a}),exp(-(t-${a})*${r2(e.decay || 7)}),0)`;
        G.add(`sine=frequency=${e.f || 58}:sample_rate=48000:samples_per_frame=256:duration=${dur},volume='${env}':eval=frame,aformat=sample_fmts=fltp:channel_layouts=stereo[${L}]`);
      } else if (e.type === 'shimmer') {
        // two high tones, a fifth apart, ringing out
        const env = `${pk}*if(gte(t,${a}),exp(-(t-${a})*${r2(e.decay || 4)}),0)`;
        const s1 = G.label('sh'), s2 = G.label('sh');
        G.add(`sine=frequency=${e.f || 2093}:sample_rate=48000:samples_per_frame=256:duration=${dur}[${s1}]`);
        G.add(`sine=frequency=${Math.round((e.f || 2093) * 1.5)}:sample_rate=48000:samples_per_frame=256:duration=${dur}[${s2}]`);
        G.add(`[${s1}][${s2}]amix=inputs=2:duration=longest,volume='${env}':eval=frame,aformat=sample_fmts=fltp:channel_layouts=stereo[${L}]`);
      } else {
        // a riser: high noise building to the cut
        const env = `${pk}*if(between(t,${a},${r2(a + d)}),pow((t-${a})/${d},2.2),0)`;
        G.add(`anoisesrc=color=pink:amplitude=1:sample_rate=48000:nb_samples=256:duration=${dur},highpass=f=${e.lo || 1200},lowpass=f=${e.hi || 9000},volume='${env}':eval=frame,aformat=sample_fmts=fltp:channel_layouts=stereo[${L}]`);
      }
      parts.push(L);
    });
    G.add(`${parts.map(x => `[${x}]`).join('')}amix=inputs=${parts.length}:duration=longest:dropout_transition=0,volume=${parts.length},alimiter=limit=0.25:level=false[${label}]`);
  }
  // A clip's loudness (EBU R128 integrated, LUFS) and true peak (dBTP), from
  // its sound alone. → { I, peak } or null (no sound, or unreadable).
  function loudness(file) {
    return new Promise((resolve) => {
      const pr = spawn(ffmpegPath, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      pr.stderr.on('data', (d) => { err += d; if (err.length > 40000) err = err.slice(-20000); });
      pr.on('error', () => resolve(null));
      pr.on('close', () => {
        const sum = err.slice(err.lastIndexOf('Summary:'));
        const I = /I:\s+(-?[\d.]+) LUFS/.exec(sum), tp = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(sum);
        resolve(I && Number(I[1]) > -70 ? { I: Number(I[1]), peak: tp && tp[1] !== '-inf' ? Number(tp[1]) : null } : null);
      });
    });
  }
  // The one gain (dB) a clip gets (LOUD): 0 when its loudness is unknown.
  // (a mono clip plays in both ears: it is 3 dB louder than measured)
  const gainFor = (L, mono) => {
    if (!L || opts.level === false) return 0;
    let g = Math.max(-LOUD.down, Math.min(LOUD.up, LOUD.target - (L.I + (mono ? 3.01 : 0))));
    if (L.peak != null) g = Math.min(g, LOUD.ceiling - L.peak);
    return Math.round(g * 10) / 10;
  };
  const sfxOn = opts.sfx !== false;

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
  function risingText(G, dir, name, { text, font, size, at, dur = 0.42, T, p, color = 'white', align }) {
    const bw = even(Math.max(16, Math.ceil(size * 0.62 * text.length + size))), bh = even(size * 1.32), pad = Math.round(size * 0.1);
    const m = G.label('mask'), f = G.label('fill'), o = G.label('txt');
    const tx = align === 'center' ? '(w-text_w)/2' : '0';
    G.add(`color=c=black:s=${bw}x${bh}:r=${p.fps}:d=${f6(T)},format=gray,drawtext=fontfile='${fpath(font)}':textfile='${fpath(textFile(dir, name, text))}':expansion=none:fontsize=${size}:fontcolor=white:x=${tx}:y='${pad}+${bh}*(1-${easeOut(prog(at, dur))})',lut=c0='clip((val-16)*255/219,0,255)'[${m}]`);
    G.add(`color=c=${color}:s=${bw}x${bh}:r=${p.fps}:d=${f6(T)},format=yuva420p[${f}]`);
    G.add(`[${f}][${m}]alphamerge[${o}]`);
    return { label: o, w: bw, h: bh, pad };
  }

  // A team colour made to show on the picture: a very dark one lifted.
  const vivid = (hex) => { if (!hex) return null; const [r, g, b] = rgbOf(hex); const L = 0.2126 * r + 0.7152 * g + 0.0722 * b; if (L >= 46) return hex; const f = 0.42; return [r, g, b].map(v => Math.round(v + (255 - v) * f).toString(16).padStart(2, '0')).join(''); };
  // The stacked event tag at the top left: the team strip, the event pill, the
  // team's badge and the name, then over · bowler. Each part slides in after
  // the one before and out in reverse. Small: it says what is coming and gets
  // out of the way of the shot. → { text (drawtext filters), strip, disc }:
  // where the strip and the badge go (overlays, laid by renderClip).
  function tagFilters(p, card, dir, T, hasDisc) {
    const k = p.k, x0 = Math.round(46 * k), y0 = Math.round(40 * k);
    const accent = `0x${ACCENT[card.kind] || ACCENT.HIGHLIGHT}`;
    const outAt = Math.max(TAG_IN + 1.2, Math.min(TAG_IN + TAG_HOLD, T - HALF - 0.6));
    const dist = Math.round(560 * k);
    const label = cleanText(card.label, 18), title = cleanText(card.title, 40), sub = cleanText(card.sub, 72);
    const pillSize = Math.round(28 * k), nameSize = fitSize(title, Math.round(56 * k), Math.round(760 * k) / 0.42), subSize = Math.round(22 * k);
    const pb = Math.round(9 * k), nb = Math.round(11 * k), sb = Math.round(8 * k);
    const nameY = y0 + Math.round(pillSize * 1.2 + 2 * pb + 5 * k);
    const subY = nameY + Math.round(nameSize * 0.98 + 2 * nb + 5 * k);
    const nameH = Math.round(nameSize * 0.98 + 2 * nb), gapD = Math.round(8 * k);
    const disc = hasDisc ? { size: even(nameH), x: x0, y: nameY - nb, inAt: TAG_IN + 0.04, outAt: outAt + 0.07, dist } : null;
    const nameX = x0 + nb + (disc ? disc.size + gapD : 0);
    const team = card.team && vivid(card.team.color);
    const bottom = sub ? subY + Math.round(subSize * 0.95) + sb : nameY + Math.round(nameSize * 0.98) + nb;
    const strip = team ? { color: team, w: Math.max(4, Math.round(8 * k)), h: bottom - y0, x: x0 - Math.round(16 * k), y: y0, inAt: TAG_IN - 0.06, outAt: outAt + 0.14, dist } : null;
    const f = [];
    f.push(drawtext({ font: FONTS.event, file: textFile(dir, 'tag-label', label), size: pillSize, color: 'white', box: `${accent}@1.0`, boxBorder: pb,
      x: slideX(x0 + pb, dist, TAG_IN, outAt + 0.10), y: y0 + pb, alpha: fadeAlpha(TAG_IN, outAt + 0.10), from: TAG_IN, to: outAt + 0.45 }));
    f.push(drawtext({ font: FONTS.display, file: textFile(dir, 'tag-title', title), size: nameSize, color: 'white', box: '0x0b1220@0.88', boxBorder: nb,
      x: slideX(nameX, dist, TAG_IN + 0.06, outAt + 0.05), y: nameY, alpha: fadeAlpha(TAG_IN + 0.06, outAt + 0.05), from: TAG_IN + 0.06, to: outAt + 0.4 }));
    if (sub) {
      f.push(drawtext({ font: FONTS.body, file: textFile(dir, 'tag-sub', sub), size: subSize, color: '0xdbe4f0', box: '0x131c30@0.88', boxBorder: sb,
        x: slideX(x0 + sb, dist, TAG_IN + 0.12, outAt), y: subY, alpha: fadeAlpha(TAG_IN + 0.12, outAt), from: TAG_IN + 0.12, to: outAt + 0.35 }));
    }
    return { text: f.join(','), strip, disc };
  }
  // An overlay that slides with the tag (slideX) and fades with it.
  function layTagPart(G, p, cur, part, srcLabel) {
    const o = G.label('tg'), fl = G.label('tf');
    G.add(`[${srcLabel}]fade=t=in:st=${f6(part.inAt)}:d=0.22:alpha=1,fade=t=out:st=${f6(part.outAt + 0.08)}:d=0.22:alpha=1[${fl}]`);
    G.add(`[${cur}][${fl}]overlay=x='${slideX(part.x, part.dist, part.inAt, part.outAt)}':y=${part.y}:eval=frame:enable='between(t,${r2(part.inAt)},${r2(part.outAt + 0.5)})'[${o}]`);
    return o;
  }

  // 9:16: where the 16:9 picture sits — the full width, a little above the
  // middle when the wheel needs the space under it (the same for every clip
  // of a video, so the picture never jumps).
  function portraitBox(p, wheelOn) {
    const ch = even(p.w * 9 / 16);
    return { cw: p.w, ch, y: wheelOn ? even(p.h * 0.29) : even((p.h - ch) / 2) };
  }
  // 9:16: the event tag in the space above the picture, centred, there for
  // the whole clip (it covers nothing): the team's badge beside the event
  // pill / NAME, underlined in the team's colour / over · bowler.
  // → { text, disc, line }: the badge and the underline are overlays.
  function tagPortrait(p, card, dir, T, box, hasDisc) {
    const k = p.k, W = p.w;
    const accent = `0x${ACCENT[card.kind] || ACCENT.HIGHLIGHT}`;
    const label = cleanText(card.label, 18), title = cleanText(card.title, 40), sub = cleanText(card.sub, 72);
    const pillSize = Math.round(40 * k), pb = Math.round(13 * k), nameSize = fitSize(title, Math.round(104 * k), Math.round(W * 0.88) / 0.45);
    const subSize = fitSize(sub, Math.round(30 * k), Math.round(W * 0.9) / 0.6);
    const hPill = Math.round(pillSize * 1.22 + 2 * pb), gap1 = Math.round(26 * k), gap2 = Math.round(16 * k);
    const team = card.team && vivid(card.team.color);
    const lineGap = team ? Math.round(18 * k) : 0, lineH = team ? Math.max(3, Math.round(6 * k)) : 0;
    const hBlock = hPill + gap1 + nameSize + lineGap + lineH + (sub ? gap2 + Math.round(subSize * 1.2) : 0);
    const top = Math.max(Math.round(150 * k), Math.round((box.y - hBlock) / 2 + 36 * k));
    const rise = (y, at) => `${y}+${Math.round(30 * k)}*(1-${easeOut(prog(at, 0.42))})`;
    // the badge and the pill side by side, centred together (the pill's width
    // from its letters: Inter Display Black Italic is about 0.64 em a letter)
    const D = hasDisc ? even(hPill * 1.15) : 0, gapD = hasDisc ? Math.round(16 * k) : 0;
    const pillW = Math.round(label.length * pillSize * 0.64 + 2 * pb);
    const gx = Math.round((W - (D + gapD + pillW)) / 2);
    const disc = hasDisc ? { size: D, x: gx, y: top + Math.round((hPill - D) / 2), at: TAG_IN - 0.04 } : null;
    const yName = top + hPill + gap1;
    const line = team ? { color: team, w: Math.round(150 * k), h: lineH, x: Math.round((W - 150 * k) / 2), y: yName + nameSize + lineGap, at: TAG_IN + 0.2 } : null;
    const f = [];
    f.push(drawtext({ font: FONTS.event, file: textFile(dir, 'tag-label', label), size: pillSize, color: 'white', box: `${accent}@1.0`, boxBorder: pb,
      x: hasDisc ? `${gx + D + gapD + pb}` : '(w-text_w)/2', y: rise(top + pb, TAG_IN), alpha: prog(TAG_IN, 0.3) }));
    f.push(drawtext({ font: FONTS.display, file: textFile(dir, 'tag-title', title), size: nameSize, color: 'white',
      x: '(w-text_w)/2', y: rise(yName, TAG_IN + 0.08), alpha: prog(TAG_IN + 0.08, 0.3) }));
    if (sub) f.push(drawtext({ font: FONTS.body, file: textFile(dir, 'tag-sub', sub), size: subSize, color: '0xdbe4f0',
      x: '(w-text_w)/2', y: rise(yName + nameSize + lineGap + lineH + gap2, TAG_IN + 0.16), alpha: prog(TAG_IN + 0.16, 0.3) }));
    return { text: f.join(','), disc, line, rise };
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
  // disc: the batting team's badge on its disc ({ file }, for the tag), or
  // null; gain: the clip's one level change (dB, see LOUD).
  async function renderClip({ src, info, card, wheel, wheelOn, profile: p, assets, out, workDir, onProgress, signal, disc, gain = 0 }) {
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
        const tg = tagFilters(p, card, dir, T, !!disc);
        G.add(`[0:v]fps=${p.fps},${fit},format=yuv420p,${sharp},trim=end_frame=${n},setpts=PTS-STARTPTS[vb]`);
        let cv = 'vb';
        if (tg.strip) {
          const st = G.label('strip');
          G.add(`color=c=0x${tg.strip.color}:s=${tg.strip.w}x${even(tg.strip.h)}:r=${p.fps}:d=${f6(T)},format=yuva420p[${st}]`);
          cv = layTagPart(G, p, cv, tg.strip, st);
        }
        if (tg.disc) {
          const dl = G.label('disc');
          G.add(loopImg(G.file(disc.file), p.fps, dl, `scale=${tg.disc.size}:${tg.disc.size}:flags=lanczos,format=rgba,`));
          cv = layTagPart(G, p, cv, tg.disc, dl);
        }
        G.add(`[${cv}]${tg.text}[v0]`);
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
        const tg = tagPortrait(p, card, dir, T, box, !!disc);
        G.add(`[v1][${lg}]overlay=x=${Math.round(46 * k)}:y=${Math.round(56 * k)}:shortest=1[v2]`);
        let cv = 'v2';
        if (tg.disc) {
          const dl = G.label('disc'), df = G.label('df'), o = G.label('tg');
          G.add(loopImg(G.file(disc.file), p.fps, dl, `scale=${tg.disc.size}:${tg.disc.size}:flags=lanczos,format=rgba,`));
          G.add(`[${dl}]fade=t=in:st=${f6(tg.disc.at)}:d=0.3:alpha=1[${df}]`);
          G.add(`[${cv}][${df}]overlay=x=${tg.disc.x}:y='${tg.rise(tg.disc.y, tg.disc.at)}':eval=frame:shortest=1[${o}]`);
          cv = o;
        }
        if (tg.line) {
          const ln = G.label('uline'), o = G.label('tg');
          G.add(`color=c=0x${tg.line.color}:s=${even(tg.line.w)}x${tg.line.h}:r=${p.fps}:d=${f6(T)},format=yuva420p,fade=t=in:st=${f6(tg.line.at)}:d=0.3:alpha=1[${ln}]`);
          G.add(`[${cv}][${ln}]overlay=x='${tg.line.x}-${Math.round(40 * k)}*(1-${easeOut(prog(tg.line.at, 0.4))})':y=${tg.line.y}:eval=frame:shortest=1[${o}]`);
          cv = o;
        }
        G.add(`[${cv}]${tg.text}[v0]`);
      }
      const spec = wheelOn ? wheelFor(wheel) : null;
      const cur = spec && addWheel(G, p, dir, spec, T, 'v0', 'vw', box) ? 'vw' : 'v0';
      await withWipes(G, p, assets, cur, 'vout', n, { head: card.kind in ACCENT ? card.kind : 'HIGHLIGHT', tail: 'BRAND', signal });
      // mono goes to both ears at its own level (the default upmix would lower it 3 dB)
      const up = info.hasAudio && info.mono ? 'pan=stereo|c0=c0|c1=c0,' : '';
      // its one level change (a single gain: its own dynamics, commentary and crowd, untouched)
      const lev = info.hasAudio && gain ? `volume=${gain}dB,` : '';
      G.add(`[${aIn}]${up}${lev}${cutAudio(T)},afade=t=in:d=0.05,afade=t=out:st=${f6(T - 0.12)}:d=0.12[aout]`);
      await run(withScript(dir, G, ['-map', '[vout]', '-map', '[aout]', ...encodeArgs(p), '-frames:v', String(n), out]), { totalSec: T, onProgress, signal });
      return { duration: T, wheel: cur === 'vw' };
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  // The blurred picture behind a title card, small (it is all soft light):
  // darkened from the left for the text.
  async function stillFrom(src, info, p, out, atSec, signal) {
    const at = Math.max(0, Math.min((info && info.duration ? info.duration - 0.2 : 1), atSec));
    const w = even(p.w / 4), h = even(p.h / 4);
    await run(['-ss', String(r2(at)), '-i', src, '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h},format=rgba`, '-filter_complex',
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=7:2,eq=saturation=0.8:brightness=-0.05,format=rgba[s];` +
      `[1:v]geq=r=4:g=8:b=18:a='min(255,225*pow(1-X/W,1.3)+100*pow(Y/H,2.4)+55)'[d];[s][d]overlay=format=rgb[o]`,
      '-map', '[o]', '-frames:v', '1', out], { signal });
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
  async function buildHero(p, title, dir, signal) {
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
    await run(withScript(dir, G, ['-map', `[${cur}]`, '-frames:v', '1', file]), { signal });
    return { file, x: X0, y: 0, w: PW, h: PH };
  }

  // The opening (INTRO_SEC), in the four acts at the top of this file: the
  // brand, the teams, the match (the title card), into the footage.
  // title: { kicker, line, venue, first, title, pill, meta, stats: [{ value, label, sub }],
  //          team: { name, short, color, logo }, teams: [two of those], kind }
  async function renderIntro({ title, bgSrc, bgInfo, profile: p, assets, out, workDir, signal }) {
    const dir = fs.mkdtempSync(path.join(workDir, 'intro-'));
    try {
      const k = p.k, W = p.w, H = p.h, n = gridLength(INTRO_SEC, p.fps), T = n / p.fps, fps = p.fps, S = Math.min(W, H);
      const kind = ACCENT[title.kind] ? title.kind : 'BRAND';
      const accent = `0x${ACCENT[kind]}`;
      const O = ACT.card, A2 = ACT.teams;               // the clocks of the third and second acts
      const okTeam = (t) => !!(t && (t.name || t.short));
      const pair = (Array.isArray(title.teams) ? title.teams.filter(okTeam) : []).slice(0, 2);
      const teams = pair.length === 2 ? pair : okTeam(title.team) ? [title.team] : [];
      const two = teams.length === 2;
      const colA = vivid(hexOf(teams[0] && teams[0].color)) || ACCENT[kind];
      const colB = two ? (vivid(hexOf(teams[1].color)) || ACCENT.BRAND) : (kind === 'BRAND' ? '38b2c1' : ACCENT.BRAND);
      const bg = bgSrc ? await stillFrom(bgSrc, bgInfo, p, path.join(dir, 'bg.png'), 1.2, signal) : null;
      const hero = await buildHero(p, title, dir, signal);
      const discs = [];
      for (let t = 0; t < teams.length; t++) discs.push(await teamDisc(p, teams[t], even(S * (two ? 0.28 : 0.34)), dir, `act2-${t}`, signal));
      const kicker = cleanText(title.kicker, 60), first = cleanText(title.first, 40);
      const line = [cleanText(title.line, 70), cleanText(title.venue, 40)].filter(Boolean).join('  ·  ').slice(0, 96);
      const main = cleanText(title.title, 40) || 'HIGHLIGHTS', pill = cleanText(title.pill, 28), meta = cleanText(title.meta, 70);
      const stats = (Array.isArray(title.stats) ? title.stats : []).map(st => ({ value: cleanText(st && st.value, 9), label: cleanText(st && st.label, 14), sub: cleanText(st && st.sub, 16) }))
        .filter(st => st.value).slice(0, 4);

      // ---- the title card's layout (the third act)
      // 16:9: the text at the left of the team panel; 9:16: under it, across
      const x0 = Math.round((p.portrait ? 72 : 110) * k), maxW = p.portrait ? W - 2 * x0 : Math.round(W * 0.5);
      const firstSize = fitSize(first, Math.round(84 * k), maxW / 0.5), mainSize = fitSize(main, Math.round(176 * k), maxW / 0.46);
      const lineSize = fitSize(line, Math.round(32 * k), maxW / 0.55), pillSize = Math.round(36 * k), pb = Math.round(13 * k);
      // the figures: each as wide as its widest line (font widths measured),
      // with a gap and a hairline between — shrunk together if they would
      // not fit the width
      const gapW = Math.round(64 * k);
      const cellWidths = (v, l, sb) => stats.map(st => Math.max(st.value.length * 0.48 * v, st.label.length * 0.74 * l, st.sub.length * 0.6 * sb));
      let fz = 1;
      if (stats.length) { const tw = cellWidths(92 * k, 25 * k, 22 * k).reduce((a, b) => a + b + gapW, -gapW); if (tw > maxW) fz = Math.max(0.6, maxW / tw); }
      const vSize = Math.round(92 * k * fz), lSize = Math.round(25 * k * fz), sSize = Math.round(22 * k * fz);
      // top to bottom, each group with room round it, the block centred in
      // the space under the logo: match line / first name / NAME / pill / figures
      const hLine = line ? lineSize + Math.round(46 * k) : 0, hFirst = first ? Math.round(firstSize * 1.06) : 0, hMain = mainSize;
      const hRow = Math.round(pillSize * 1.22 + 2 * pb), gMain = Math.round(40 * k), gStats = Math.round(64 * k);
      const hStats = stats.length ? Math.round(vSize * 1.04 + lSize * 1.3 + (stats.some(st => st.sub) ? sSize * 1.5 : 0)) : (meta ? Math.round(40 * k) : 0);
      const total = hLine + hFirst + hMain + gMain + hRow + (hStats ? gStats + hStats : 0);
      const yLine = p.portrait ? Math.max(hero.h + Math.round(70 * k), Math.round(hero.h + (H - hero.h - total) / 2))
        : Math.max(Math.round(205 * k), Math.round((H - total) / 2 + 40 * k));
      const yFirst = yLine + hLine, yMain = yFirst + hFirst, yRow = yMain + hMain + gMain, yStats = yRow + hRow + gStats;

      const G = graph();
      // ---- the stage: the blurred first clip pushing in slowly (done small:
      // it is all soft), under a deep navy veil for the first two acts that
      // lifts as the title card comes in, a drift of team-colour light over it
      const bgIdx = bg ? G.file(bg) : G.input(['-f', 'lavfi', '-i', `color=c=0x0d1526:s=${even(W / 4)}x${even(H / 4)}`]);
      G.add(`[${bgIdx}:v]scale=${W}:${H}:flags=bicubic,zoompan=z='1.0+${r2(0.09 / n * 10000) / 10000}*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${n}:s=${even(W / 2)}x${even(H / 2)}:fps=${fps},` +
        `scale=${W}:${H}:flags=bicubic,setsar=1,format=yuv420p,trim=end_frame=${n},setpts=PTS-STARTPTS[bg0]`);
      G.add(`color=c=0x050a14:s=${W}x${H}:r=${fps}:d=${f6(T)},format=yuva420p,fade=t=out:st=${f6(O - 0.28)}:d=0.5:alpha=1[veil]`);
      G.add(`[bg0][veil]overlay=0:0:shortest=1[st0]`);
      const gw = even(W * 1.1), gh = even(H * 1.1), [gr, gg, gb] = rgbOf(colA);
      G.add(`color=c=black@0:s=${even(gw / 4)}x${even(gh / 4)}:r=${fps}:d=0.1,format=rgba,geq=r=${gr}:g=${gg}:b=${gb}:a='110*exp(-(pow((X-W/2)/(W*0.3),2)+pow((Y-H/2)/(H*0.32),2)))',` +
        `scale=${gw}:${gh}:flags=bicubic,loop=loop=-1:size=1:start=0,settb=1/${fps},setpts=N,fade=t=in:st=0:d=0.5:alpha=1,fade=t=out:st=${f6(O - 0.45)}:d=0.5:alpha=1[glow]`);
      G.add(`[st0][glow]overlay=x='-${Math.round(W * 0.4)}+${Math.round(W * 0.32)}*t/${r2(O)}':y=-${Math.round(H * 0.05)}:eval=frame:enable='lt(t,${r2(O + 0.1)})'[st1]`);

      // ---- act 1: the brand
      const cx = Math.round(W / 2), cy = Math.round(H * (p.portrait ? 0.42 : 0.46)), Ci = assets.Ci;
      // team-colour shards sweeping across, crossing behind the logo
      const wA = even(W * (p.portrait ? 0.7 : 0.5)), wB = even(W * (p.portrait ? 0.52 : 0.36)), spS = Math.round(H * 0.3);
      slab(G, p, wA, H, colA, 'both', 'shA', { sp: spS, top: 1.06, fall: 0.38 });
      slab(G, p, wB, H, colB, 'both', 'shB', { sp: spS, top: 1.0, fall: 0.42 });
      G.add(`[st1][shA]overlay=x='-${wA}+${W + wA}*${easeInOut(prog(0.18, 0.68))}':y=0:eval=frame:enable='between(t,0.16,0.88)'[a1]`);
      G.add(`[a1][shB]overlay=x='${W}-${W + wB}*${easeInOut(prog(0.28, 0.64))}':y=0:eval=frame:enable='between(t,0.26,0.94)'[a2]`);
      // two lines of light running in to the logo from either side
      const lw = even(W * 0.3), lh = Math.max(2, Math.round(3 * k)), gapL = Math.round(Ci * 0.56);
      heldStill(G, p, lw, lh, `r=255:g=244:b=214:a='255*pow(X/W,1.5)'`, 'lnL');
      heldStill(G, p, lw, lh, `r=255:g=244:b=214:a='255*pow(1-X/W,1.5)'`, 'lnR');
      G.add(`[lnL]fade=t=out:st=0.95:d=0.25:alpha=1[lnLf]`);
      G.add(`[lnR]fade=t=out:st=0.95:d=0.25:alpha=1[lnRf]`);
      G.add(`[a2][lnLf]overlay=x='-${lw}+${cx - gapL}*${easeOut(prog(0.3, 0.42))}':y=${cy - Math.round(lh / 2)}:eval=frame:enable='between(t,0.28,1.25)'[a3]`);
      G.add(`[a3][lnRf]overlay=x='${W}-${W - cx - gapL}*${easeOut(prog(0.3, 0.42))}':y=${cy - Math.round(lh / 2)}:eval=frame:enable='between(t,0.28,1.25)'[a4]`);
      // a ring of light grows out from behind the logo as it springs up
      ringBurst(G, p, assets, 0.34, 0.75, 'rng1');
      G.add(`[a4][rng1]overlay=x=${cx - assets.RR / 2}:y=${cy - assets.RR / 2}:eof_action=pass[a5]`);
      // the logo: springs from 0.65 of its size, a glint crosses it, then it draws back and fades
      const nL = Math.round((A2 + 0.3) * fps);
      const lgo = springIn(G, p, assets.logoIntro, Ci, nL, { at: 0.3, dur: 0.56, from: 0.65, out: { at: A2 - 0.16, dur: 0.3, by: 0.5 } });
      G.add(`[${lgo}]split[lgA][lgM]`);
      G.add(`[lgM]alphaextract[lgal]`);
      G.add(`[${G.file(assets.shineIntro)}:v]format=rgba,loop=loop=-1:size=1:start=0,settb=1/${fps},setpts=N,trim=end_frame=${nL},crop=w=${Ci}:h=${Ci}:x='${2 * Ci}-${2 * Ci}*${prog(0.66, 0.44)}':y=0,alphaextract[lgsa]`);
      G.add(`[lgsa][lgal]blend=all_mode=multiply:shortest=1[lgma]`);
      G.add(`color=c=white:s=${Ci}x${Ci}:r=${fps}:d=${f6(nL / fps)},format=yuva420p[lgwh]`);
      G.add(`[lgwh][lgma]alphamerge[lgshn]`);
      G.add(`[lgA][lgshn]overlay=0:0:format=auto:shortest=1,fade=t=in:st=0.28:d=0.16:alpha=1,fade=t=out:st=${f6(A2 - 0.14)}:d=0.28:alpha=1[lgF]`);
      G.add(`[a5][lgF]overlay=x=${cx - Ci / 2}:y=${cy - Ci / 2}:eof_action=pass[a6]`);
      let cur = 'a6';

      // ---- act 2: the teams — panels in their colours, badges rising on
      // their discs, names rising under them; they leave as the title card comes
      const out2 = O - 0.32;
      const leave = (d = 0) => easeIn(prog(out2 + d, 0.32));
      const lay = (src, x, y, from, to) => { const o = G.label('c'); G.add(`[${cur}][${src}]overlay=x='${x}':y='${y}':eval=frame:enable='between(t,${r2(from)},${r2(to)})'[${o}]`); cur = o; };
      const spots = [];
      if (two && !p.portrait) {
        const PW = even(W * 0.56), sp = Math.round(H * 0.16);
        slab(G, p, PW, H, colA, 'right', 'pA', { sp, top: 0.92, fall: 0.5 });
        slab(G, p, PW, H, colB, 'left', 'pB', { sp, top: 0.92, fall: 0.5 });
        lay('pA', `-${PW}*(1-${easeOut(prog(A2, 0.42))})-${PW}*${leave()}`, '0', A2 - 0.02, O + 0.05);
        lay('pB', `${W - PW}+${PW}*(1-${easeOut(prog(A2 + 0.06, 0.42))})+${PW}*${leave(0.02)}`, '0', A2 + 0.04, O + 0.07);
        spots.push({ x: Math.round(W * 0.26), y: Math.round(H * 0.42), dx: `-${PW}*${leave()}`, dy: '' }, { x: Math.round(W * 0.74), y: Math.round(H * 0.42), dx: `+${PW}*${leave(0.02)}`, dy: '' });
      } else if (two) {
        const PH = even(H * 0.54), sp = Math.round(W * 0.16);
        slab(G, p, W, PH, colA, 'bottom', 'pA', { sp, top: 0.92, fall: 0.5 });
        slab(G, p, W, PH, colB, 'top', 'pB', { sp, top: 0.92, fall: 0.5 });
        lay('pA', '0', `-${PH}*(1-${easeOut(prog(A2, 0.42))})-${PH}*${leave()}`, A2 - 0.02, O + 0.05);
        lay('pB', '0', `${H - PH}+${PH}*(1-${easeOut(prog(A2 + 0.06, 0.42))})+${PH}*${leave(0.02)}`, A2 + 0.04, O + 0.07);
        spots.push({ x: cx, y: Math.round(H * 0.25), dx: '', dy: `-${PH}*${leave()}` }, { x: cx, y: Math.round(H * 0.73), dx: '', dy: `+${PH}*${leave(0.02)}` });
      } else if (teams.length === 1) {
        const sp = Math.round(H * 0.2), PW = even(W + sp);
        slab(G, p, PW, H, colA, 'both', 'pA', { sp, top: 0.95, fall: 0.5 });
        lay('pA', `${W}*(1-${easeOut(prog(A2, 0.46))})-${Math.round(sp / 2)}-${PW}*${leave()}`, '0', A2 - 0.02, O + 0.05);
        spots.push({ x: cx, y: Math.round(H * (p.portrait ? 0.4 : 0.42)), dx: `-${PW}*${leave()}`, dy: '' });
      }
      if (teams.length) {
        // a glint of light runs across the panels once they are in
        const gl = G.label('gl'), glw = even(assets.glintW + Math.round(0.324 * H));
        G.add(loopImg(G.file(assets.glint), fps, gl, 'format=rgba,'));
        lay(gl, `-${glw}+${W + glw}*${prog(A2 + 0.52, 0.6)}`, '0', A2 + 0.5, A2 + 1.15);
      }
      spots.forEach((sp, t) => {
        const at = A2 + 0.26 + 0.08 * t, DD = discs[t].size, dl = G.label('d2'), df = G.label('d2f');
        G.add(loopImg(G.file(discs[t].file), fps, dl, 'format=rgba,'));
        G.add(`[${dl}]fade=t=in:st=${f6(at)}:d=0.3:alpha=1[${df}]`);
        lay(df, `${sp.x - DD / 2}${sp.dx}`, `${sp.y - DD / 2}+${Math.round(46 * k)}*(1-${easeOut(prog(at, 0.5))})${sp.dy}`, at, O + 0.1);
        const nm = cleanText(teams[t].name || teams[t].short, 32);
        const size = fitSize(nm, Math.round((two ? 52 : 64) * k), Math.round(W * (two && !p.portrait ? 0.4 : 0.8)) / 0.45);
        const r = risingText(G, dir, `t2n${t}`, { text: nm, font: FONTS.display, size, at: at + 0.14, T, p, align: 'center' });
        lay(r.label, `${sp.x - r.w / 2}${sp.dx}`, `${sp.y + DD / 2 + Math.round(24 * k) - r.pad}${sp.dy}`, at + 0.1, O + 0.1);
      });
      if (two) {
        // VS between them, in a navy disc ringed in the brand colour, with a ring of light
        const vy = p.portrait ? Math.round(H * 0.49) : Math.round(H * 0.42), vsD = even(S * 0.14), vat = A2 + 0.44;
        const rr = `hypot(X-${vsD / 2},Y-${vsD / 2})`, inr = `lt(${rr},${r2(vsD * 0.4)})`;
        ringBurst(G, p, assets, vat, 0.62, 'rng2');
        lay('rng2', `${cx - assets.RR / 2}`, `${vy - assets.RR / 2}`, vat, vat + 0.62);
        G.add(`color=c=black@0:s=${vsD}x${vsD}:r=${fps}:d=0.1,format=rgba,geq=r='if(${inr},11,245)':g='if(${inr},18,158)':b='if(${inr},32,11)':a='255*${clampExpr(`${vsD / 2}-${rr}`)}',` +
          `${drawtext({ font: FONTS.display, file: textFile(dir, 'vs2', 'VS'), size: Math.round(vsD * 0.42), color: 'white', x: '(w-text_w)/2', y: '(h-text_h)/2' })},` +
          `loop=loop=-1:size=1:start=0,settb=1/${fps},setpts=N,fade=t=in:st=${f6(vat)}:d=0.22:alpha=1,fade=t=out:st=${f6(out2)}:d=0.24:alpha=1[vs]`);
        lay('vs', `${cx - vsD / 2}`, `${vy - vsD / 2}+${Math.round(24 * k)}*(1-${easeOut(prog(vat, 0.34))})`, vat, O);
      }

      // ---- act 3: the title card — the team panel slides in (from the
      // right in 16:9, down from the top in 9:16), our logo and the kicker,
      // the match line, the name rising into place, the pill, the figures
      const hi = G.file(hero.file), hp = G.label('hero'), into = `(1-${easeOut(prog(O + 0.05, 0.55))})`;
      G.add(loopImg(hi, fps, hp));
      lay(hp, p.portrait ? '0' : `${hero.x}+${W - hero.x}*${into}`, p.portrait ? `-${hero.h}*${into}` : '0', O, T + 1);
      const li = G.file(assets.logoSmall), lg = G.label('logo');
      G.add(loopImg(li, fps, lg, 'format=rgba,'));
      G.add(`[${lg}]fade=t=in:st=${f6(O + 0.15)}:d=0.3:alpha=1[${lg}f]`);
      const logoY = Math.round((p.portrait ? 56 : 70) * k), logoH = even(Math.min(W, H) * 0.075);
      lay(`${lg}f`, `${x0}`, `${logoY}`, O + 0.1, T + 1);
      const text = [];
      if (kicker) text.push(drawtext({ font: FONTS.body, file: textFile(dir, 'kicker', kicker), size: Math.round(30 * k), color: '0xe2e8f0',
        x: `${x0 + logoH + Math.round(22 * k)}-${Math.round(20 * k)}*(1-${easeOut(prog(O + 0.2, 0.4))})`, y: `${logoY + Math.round(logoH / 2 - 18 * k)}`, alpha: prog(O + 0.2, 0.3), from: O + 0.15 }));
      if (line) {
        text.push(`drawbox=x=${x0}:y=${yLine + Math.round(3 * k)}:w=${Math.max(3, Math.round(6 * k))}:h=${lineSize}:color=${accent}@1:t=fill:enable='gte(t,${r2(O + 0.24)})'`);
        text.push(drawtext({ font: FONTS.body, file: textFile(dir, 'line', line), size: lineSize, color: '0xf1f5f9',
          x: `${x0 + Math.round(20 * k)}-${Math.round(26 * k)}*(1-${easeOut(prog(O + 0.24, 0.4))})`, y: `${yLine}`, alpha: prog(O + 0.24, 0.3), from: O + 0.2 }));
      }
      if (text.length) { const o = G.label('c'); G.add(`[${cur}]${text.join(',')}[${o}]`); cur = o; }
      const rise = (name, opt, y) => {
        const r = risingText(G, dir, name, { ...opt, T, p });
        lay(r.label, `${x0 - Math.round(opt.size * 0.04)}`, `${y - r.pad}`, opt.at - 0.02, T + 1);
      };
      if (first) rise('first', { text: first, font: FONTS.display, size: firstSize, at: O + 0.26, color: '0xdbe4f0' }, yFirst);
      rise('main', { text: main, font: FONTS.display, size: mainSize, at: first ? O + 0.34 : O + 0.28 }, yMain);
      const barW = Math.round(84 * k), barH = Math.max(4, Math.round(8 * k));
      const bar = G.label('bar');
      G.add(`[${G.input(['-f', 'lavfi', '-i', `color=c=${accent}:s=${barW}x${barH}:r=${fps}:d=${f6(T)}`])}:v]format=yuva420p[${bar}]`);
      const yPillText = yRow + pb;
      const barY = yPillText + Math.round(pillSize * 0.62) - Math.round(barH / 2);
      lay(bar, `${x0}-${barW}*(1-${easeOut(prog(O + 0.46, 0.4))})`, `${barY}`, O + 0.44, T + 1);
      const rest = [];
      if (pill) rest.push(drawtext({ font: FONTS.event, file: textFile(dir, 'pill', pill), size: pillSize, color: 'white', box: `${accent}@1.0`, boxBorder: pb,
        x: `${x0 + barW + Math.round(22 * k) + pb}-${Math.round(36 * k)}*(1-${easeOut(prog(O + 0.52, 0.4))})`, y: `${yPillText}`, alpha: prog(O + 0.52, 0.25), from: O + 0.5 }));
      if (stats.length) {
        const widths = cellWidths(vSize, lSize, sSize);
        let xx = x0;
        const xs = widths.map(w => { const x = xx; xx += Math.round(w) + gapW; return x; });
        stats.forEach((st, t) => {
          const at = O + 0.64 + 0.08 * t, sx = xs[t];
          const up = (dy) => `${dy}+${Math.round(26 * k)}*(1-${easeOut(prog(at, 0.36))})`;
          if (t) rest.push(`drawbox=x=${sx - Math.round(gapW / 2)}:y=${yStats + Math.round(14 * k)}:w=${Math.max(1, Math.round(2 * k))}:h=${hStats - Math.round(14 * k)}:color=white@0.2:t=fill:enable='gte(t,${r2(at)})'`);
          rest.push(drawtext({ font: FONTS.display, file: textFile(dir, `sv${t}`, st.value), size: vSize, color: 'white', x: `${sx}`, y: up(yStats), alpha: prog(at, 0.25), from: at - 0.02 }));
          rest.push(drawtext({ font: FONTS.body, file: textFile(dir, `sl${t}`, st.label.split('').join(' ')), size: lSize, color: accent, x: `${sx + Math.round(3 * k)}`,
            y: up(yStats + Math.round(vSize * 1.04)), alpha: prog(at + 0.04, 0.25), from: at }));
          if (st.sub) rest.push(drawtext({ font: FONTS.body, file: textFile(dir, `ss${t}`, st.sub), size: sSize, color: '0xa9b6c8', x: `${sx + Math.round(3 * k)}`,
            y: up(yStats + Math.round(vSize * 1.04 + lSize * 1.5)), alpha: prog(at + 0.08, 0.25), from: at + 0.04 }));
        });
      } else if (meta) {
        rest.push(drawtext({ font: FONTS.body, file: textFile(dir, 'meta', meta), size: Math.round(30 * k), color: '0xdbe4f0',
          x: `${x0}`, y: `${yStats}`, alpha: prog(O + 0.66, 0.3), from: O + 0.64 }));
      }
      if (rest.length) { const o = G.label('c'); G.add(`[${cur}]${rest.join(',')}[${o}]`); cur = o; }
      // ---- act 4: it opens on the band leaving (in the video's colour), and ends on it arriving
      await withWipes(G, p, assets, cur, 'vout', n, { head: kind, tail: 'BRAND', signal });
      if (sfxOn) {
        const ev = [
          { type: 'whoosh', at: 0.0, dur: 0.36, db: -21, lo: 320, hi: 3800 },      // the band leaving
          { type: 'whoosh', at: 0.16, dur: 0.72, db: -17, lo: 220, hi: 5200 },     // the shards
          { type: 'impact', at: 0.33, db: -13, f: 56, decay: 6 },                  // the logo
          { type: 'shimmer', at: 0.68, db: -25, f: 2093, decay: 3.5 }              // its glint
        ];
        if (teams.length) ev.push({ type: 'whoosh', at: A2 - 0.05, dur: 0.52, db: -18 }, { type: 'whoosh', at: out2 - 0.02, dur: 0.4, db: -22, lo: 400 });
        if (two) ev.push({ type: 'impact', at: A2 + 0.44, db: -16, f: 74, decay: 9 });
        ev.push({ type: 'whoosh', at: O + 0.02, dur: 0.5, db: -22 },              // the team panel
          { type: 'riser', at: T - 0.86, dur: 0.56, db: -22 },                     // into the footage…
          { type: 'whoosh', at: T - 0.32, dur: 0.34, db: -19 });                   // …the band arriving
        sfxTrack(G, T, ev, 'sfx');
        G.add(`[sfx]${cutAudio(T)}[aout]`);
      } else G.add(`[${silence(G, T)}:a]${cutAudio(T)}[aout]`);
      await run(withScript(dir, G, ['-map', '[vout]', '-map', '[aout]', ...encodeArgs(p), '-frames:v', String(n), out]), { totalSec: T, signal });
      return { duration: T };
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  // The end card (OUTRO_SEC): the band clears onto a stage framed by shards in
  // the teams' colours; our logo springs into place under a sweep of light;
  // the player (or the teams), the tournament and what the video held rise
  // under it, then the website; then black.
  async function renderOutro({ kind = 'BRAND', title = {}, profile: p, assets, out, workDir, site, signal }) {
    const dir = fs.mkdtempSync(path.join(workDir, 'outro-'));
    try {
      const k = p.k, W = p.w, H = p.h, n = gridLength(OUTRO_SEC, p.fps), T = n / p.fps, C = assets.C, fps = p.fps, S = Math.min(W, H);
      const siteText = cleanText(site || 'allsportslivestreams.com', 48).toLowerCase();
      const okTeam = (t) => !!(t && (t.name || t.short));
      const pair = (Array.isArray(title.teams) ? title.teams.filter(okTeam) : []).slice(0, 2);
      const teams = pair.length === 2 ? pair : okTeam(title.team) ? [title.team] : [];
      const colA = vivid(hexOf(teams[0] && teams[0].color)) || ACCENT.BRAND;
      const colB = teams.length === 2 ? (vivid(hexOf(teams[1].color)) || '38b2c1') : '38b2c1';
      const who = [cleanText(title.first, 40), cleanText(title.title, 40)].filter(Boolean).join(' ');
      const what = [cleanText(title.kicker, 50), cleanText(title.meta, 60)].filter(Boolean).join('  ·  ').slice(0, 96);
      const G = graph();
      const bgi = G.file(assets.endBg);
      G.add(`[${bgi}:v]scale=${W}:${H}:flags=bicubic,setsar=1,format=yuv420p,loop=loop=-1:size=1:start=0,settb=1/${fps},setpts=N,trim=end_frame=${n}[bg]`);
      // the frame: two shards in the teams' colours leaning in from either edge, and staying
      const wA = even(W * (p.portrait ? 0.56 : 0.36)), wB = even(W * (p.portrait ? 0.46 : 0.28)), sp = Math.round(H * 0.22);
      slab(G, p, wA, H, colA, 'both', 'fA', { sp, top: 0.95, fall: 0.5, alpha: 0.92 });
      slab(G, p, wB, H, colB, 'both', 'fB', { sp, top: 0.95, fall: 0.5, alpha: 0.88 });
      G.add(`[bg][fA]overlay=x='-${wA}+${Math.round(wA * 0.62)}*${easeOut(prog(0.1, 0.52))}':y=0:eval=frame:shortest=1[f1]`);
      G.add(`[f1][fB]overlay=x='${W}-${Math.round(wB * 0.66)}*${easeOut(prog(0.16, 0.52))}':y=0:eval=frame:shortest=1[f2]`);
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
      const yLogo = Math.round(H * (p.portrait ? 0.3 : 0.33) - C / 2);
      // a ring of light grows out from behind it as it springs (as in the opening)
      ringBurst(G, p, assets, 0.26, 0.75, 'orng');
      G.add(`[f2][orng]overlay=x=${Math.round(W / 2 - assets.RR / 2)}:y=${Math.round(yLogo + C / 2 - assets.RR / 2)}:eof_action=pass[f3]`);
      G.add(`[f3][lgf]overlay=x=${Math.round((W - C) / 2)}:y=${yLogo}:shortest=1[b1]`);
      let cur = 'b1';
      const lay = (src, x, y, from) => { const o = G.label('c'); G.add(`[${cur}][${src}]overlay=x='${x}':y='${y}':eval=frame:enable='gte(t,${r2(from)})'[${o}]`); cur = o; };
      // the player (or the teams), rising through a mask; the tournament and what the video held
      let y = Math.round(H * (p.portrait ? 0.5 : 0.6));
      if (who) {
        const size = fitSize(who, Math.round(84 * k), Math.round(W * 0.84) / 0.45);
        const r = risingText(G, dir, 'who', { text: who, font: FONTS.display, size, at: 0.6, T, p, align: 'center' });
        lay(r.label, `${Math.round(W / 2 - r.w / 2)}`, `${y - r.pad}`, 0.58);
        y += Math.round(size * 1.18);
      }
      const ys = [];
      if (what) {
        const size = fitSize(what, Math.round(28 * k), Math.round(W * 0.86) / 0.55);
        const o = G.label('c');
        G.add(`[${cur}]${drawtext({ font: FONTS.body, file: textFile(dir, 'what', what), size, color: '0xcbd5e1', x: '(w-text_w)/2',
          y: `${y}+${Math.round(18 * k)}*(1-${easeOut(prog(0.74, 0.4))})`, alpha: prog(0.74, 0.3), from: 0.72 })}[${o}]`);
        cur = o; y += Math.round(size * 2.1);
      }
      const ySite = Math.max(y + Math.round(10 * k), Math.round(H * (p.portrait ? 0.62 : 0.8)));
      const ul = G.label('ul');
      G.add(`[${G.input(['-f', 'lavfi', '-i', `color=c=0x${ACCENT.BRAND}:s=${Math.round(120 * k)}x${Math.max(3, Math.round(5 * k))}:r=${fps}:d=${f6(T)}`])}:v]format=yuva420p,fade=t=in:st=0.95:d=0.2:alpha=1[${ul}]`);
      { const o = G.label('c');
        G.add(`[${cur}]${drawtext({ font: FONTS.body, file: textFile(dir, 'site', siteText), size: Math.round(36 * k), color: 'white',
          x: '(w-text_w)/2', y: `${ySite}+${Math.round(22 * k)}*(1-${easeOut(prog(0.86, 0.4))})`, alpha: prog(0.86, 0.3), from: 0.84 })}[${o}]`);
        cur = o; }
      lay(ul, `${Math.round(W / 2 - 60 * k)}`, `${ySite + Math.round(60 * k)}`, 0.9);
      await withWipes(G, p, assets, cur, 'bw', n, { head: kind, tail: null, signal });
      G.add(`[bw]fade=t=out:st=${f6(T - 0.4)}:d=0.4[vout]`);
      if (sfxOn) {
        sfxTrack(G, T, [
          { type: 'whoosh', at: 0.0, dur: 0.34, db: -21, lo: 320, hi: 3800 },     // the band leaving
          { type: 'whoosh', at: 0.1, dur: 0.56, db: -19, lo: 240, hi: 4600 },     // the shards
          { type: 'impact', at: 0.26, db: -14, f: 54, decay: 5 },                  // the logo
          { type: 'shimmer', at: 0.74, db: -26, f: 1760, decay: 3 }                // its sweep of light
        ], 'sfx');
        G.add(`[sfx]${cutAudio(T)},afade=t=out:st=${f6(T - 0.6)}:d=0.6[aout]`);
      } else G.add(`[${silence(G, T)}:a]${cutAudio(T)}[aout]`);
      await run(withScript(dir, G, ['-map', '[vout]', '-map', '[aout]', ...encodeArgs(p), '-frames:v', String(n), out]), { totalSec: T, signal });
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
  async function concat(segs, out, workDir, signal) {
    const list = path.join(workDir, `concat-${Date.now()}.txt`);
    fs.writeFileSync(list, segs.map(s => `file '${String(s.file).replace(/'/g, "'\\''")}'\nduration ${s.dur.toFixed(6)}\noutpoint ${s.dur.toFixed(6)}`).join('\n'));
    try {
      await run(['-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v', '-map', '0:a', '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4', out], { signal });
    } finally {
      fs.unlink(list, () => {});
    }
  }

  /* ------------------------------------------------------------- cache */
  const segDir = path.join(cacheDir, 'segments');
  fs.mkdirSync(segDir, { recursive: true });
  function segmentKey(clipKey, card, p, wheelOn, spec, gain) { return sha1({ STYLE, clipKey, card, p: p.key, wheelOn: !!wheelOn, spec: spec || null, gain: gain || 0, enc: encoder === 'x264' ? undefined : encoder }); }
  const inflight = new Map(); // segment key → the render making it
  // segments a video being made is using: never trimmed from under it (a
  // long video's own segments can be more than the whole cache allows)
  const pinned = new Map(); // file → how many videos are using it
  const pin = (f) => pinned.set(f, (pinned.get(f) || 0) + 1);
  const unpin = (f) => { const n = (pinned.get(f) || 0) - 1; if (n > 0) pinned.set(f, n); else pinned.delete(f); };
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
      const removable = files.filter(x => !pinned.has(x.f) && !/\.part\.mkv$/.test(x.n));
      let total = files.reduce((n, x) => n + x.size, 0);
      let free = freeBytes();
      for (const x of removable) {
        if (total <= cacheMaxBytes && free >= 1024 * 1048576) break;
        fs.unlinkSync(x.f); total -= x.size; free += x.size;
      }
    } catch (e) { /* best effort */ }
  }

  /* ---------------------------------------------------------- the whole */
  // clips: [{ file, clipKey, card, wheel?, team? }] in play order (files
  // already local; wheel: the delivery's data, see wheelFor; team: the
  // batting side { name, short, color, logo } for the tag's badge — the card
  // made with cardForClip(clip, team)). title: see renderIntro.
  // format: '16:9' (default) or '9:16'; wheel: lay each clip's wagon wheel on.
  // onProgress(0…1, message); onStage(stage, done, total) — 'probe', 'assets',
  // 'intro', 'clips', 'outro', 'encode', 'validate' — what is really being done;
  // signal: an AbortController's signal, to cancel (rejects with .cancelled).
  // strict: a clip that cannot be played fails the whole video (with
  // .unusable, the clips' indexes) instead of being left out quietly.
  // dropSources: each clip's local file is removed once its segment is made
  // (the first clip's once the title card, which shows its picture, is made
  // too) — about half the disk a long video needs. Only for a caller that
  // will not read those files again.
  // Segments are rendered `parallel` at a time (see above), kept in play order;
  // the title and end cards are made alongside them. The finished file is
  // written beside `out` and moved into place only once it has been checked:
  // its picture and sound are there and it is as long as its parts — a
  // half-written or short video is never handed out.
  async function renderHighlight(args) {
    const mine = [];
    try { return await renderHighlightNow(args, mine); } finally { mine.forEach(unpin); }
  }
  async function renderHighlightNow({ clips, title, out, workDir, site, format, wheel: wheelOn, onProgress = () => {}, onStage = () => {}, signal, strict = false, dropSources = false }, mine) {
    const started = Date.now();
    let reused = 0;
    const stop = () => { if (signal && signal.aborted) throw abortError(); };
    onStage('probe', 0, clips.length);
    // four at a time: a probe is a whole ffmpeg, and two hundred of them at
    // once would swamp a small server
    // (and each clip's loudness, for its one level change — see LOUD)
    const infos = new Array(clips.length), louds = new Array(clips.length).fill(null);
    let probed = 0, pi = 0;
    await Promise.all(Array.from({ length: Math.min(4, clips.length) }, async () => {
      while (pi < clips.length) {
        if (signal && signal.aborted) return;
        const i = pi++;
        infos[i] = await probe(clips[i].file);
        if (infos[i] && infos[i].hasAudio && opts.level !== false) louds[i] = await loudness(clips[i].file);
        if (++probed % 10 === 0) onStage('probe', probed, clips.length);
      }
    }));
    stop();
    const usable = clips.map((c, i) => ({ ...c, info: infos[i], index: i, gain: gainFor(louds[i], infos[i] && infos[i].mono) })).filter(c => c.info && c.info.duration > 0.8);
    const unusable = clips.map((c, i) => (infos[i] && infos[i].duration > 0.8) ? null : i).filter(i => i !== null);
    if (!usable.length) throw Object.assign(new Error('no playable clips'), { unusable });
    if (strict && unusable.length) throw Object.assign(new Error(`${unusable.length} clip(s) could not be played`), { unusable });
    onStage('probe', clips.length, clips.length);
    const p = pickProfile(usable.map(c => c.info), format);
    onProgress(0.02, 'Getting the graphics ready…');
    onStage('assets', 0, 1);
    const assets = await untilAbort(ensureAssets(p), signal);
    stop();
    // the batting teams' badges for the tags, once each (a disc a little
    // bigger than any tag needs: each segment scales it to its own)
    const discs = new Map();
    const discKey = (c) => (c.card && c.card.team && c.team) ? `${c.card.team.short}|${c.card.team.color}|${c.card.team.logo}` : null;
    for (const c of usable) {
      const dk = discKey(c);
      if (dk && !discs.has(dk)) discs.set(dk, await teamDisc(p, c.team, even(130 * p.k), workDir, `tagdisc-${discs.size}`, signal));
    }
    stop();
    onStage('assets', 1, 1);
    const total = usable.reduce((n, c) => n + c.info.duration, 0) + INTRO_SEC + OUTRO_SEC;
    const doneSec = new Array(usable.length + 2).fill(0);   // seconds of source done: each clip, the intro, the outro
    let lastMsg = '';
    const report = (msg) => { if (msg) lastMsg = msg; onProgress(Math.min(0.97, 0.04 + 0.92 * doneSec.reduce((a, b) => a + b, 0) / total), lastMsg); };

    // the title and end cards, alongside the clips (each waits for a free ffmpeg like any segment)
    const clipSegs = new Array(usable.length);
    let introDone = false;
    onStage('intro', 0, 1);
    const intro = path.join(workDir, 'intro.mkv'), outro = path.join(workDir, 'outro.mkv');
    const introP = renderIntro({ title: title || {}, bgSrc: usable[0].file, bgInfo: usable[0].info, profile: p, assets, out: intro, workDir, signal })
      .then(r => { doneSec[usable.length] = INTRO_SEC; onStage('intro', 1, 1); report('Opening done'); return r; });
    const drop = (i) => { if (dropSources) fs.unlink(usable[i].file, () => {}); };
    introP.then(() => { introDone = true; if (clipSegs[0]) drop(0); }, () => {});
    introP.catch(() => {});

    let next = 0, finished = 0, failed = null;
    onStage('clips', 0, usable.length);
    const worker = async () => {
      while (next < usable.length && !failed) {
        stop();
        const i = next++;
        const c = usable[i];
        const msg = `Editing clip ${i + 1} of ${usable.length} — titles & transitions…`;
        const key = c.clipKey ? segmentKey(c.clipKey, c.card, p, wheelOn, wheelOn ? wheelFor(c.wheel) : null, c.gain) : null;
        let seg = key ? cached(key) : null;
        if (!seg && key && inflight.has(key)) seg = await inflight.get(key).catch(() => null); // another video is making it right now
        if (seg) reused++;
        if (!seg) {
          report(msg);
          const make = (async () => {
            const target = key ? path.join(segDir, `${key}.${process.pid}-${Date.now()}-${i}.part.mkv`) : path.join(workDir, `seg-${i}.mkv`);
            try {
              await renderClip({ src: c.file, info: c.info, card: c.card, wheel: c.wheel, wheelOn, profile: p, assets, out: target, workDir, signal,
                disc: discKey(c) ? discs.get(discKey(c)) : null, gain: c.gain,
                onProgress: (f) => { doneSec[i] = c.info.duration * f; report(msg); } });
            } catch (e) { fs.unlink(target, () => {}); throw e; }
            if (!key) return target;
            const final = path.join(segDir, `${key}.mkv`);
            fs.renameSync(target, final);
            return final;
          })();
          if (key) inflight.set(key, make);
          try { seg = await make; } finally { if (key) inflight.delete(key); }
        }
        clipSegs[i] = { file: seg, dur: clipFrames(c.info, p) / p.fps };
        if (key) { pin(seg); mine.push(seg); }
        if (i !== 0 || introDone) drop(i);
        doneSec[i] = c.info.duration;
        finished++;
        onStage('clips', finished, usable.length);
        report(`Edited ${finished} of ${usable.length} clips`);
      }
    };
    // the first failure stops the other workers taking new clips; every
    // ffmpeg of this video has finished before the error goes back (nothing
    // still writing into a folder the caller is about to remove)
    await Promise.all(Array.from({ length: Math.min(parallel, usable.length) }, () => worker().catch(e => { failed = failed || e; })));
    if (failed) { await introP.catch(() => {}); throw failed; }
    const introLen = await introP;
    stop();
    onStage('outro', 0, 1);
    const outroLen = await renderOutro({ kind: 'BRAND', title: title || {}, profile: p, assets, out: outro, workDir, site, signal });
    doneSec[usable.length + 1] = OUTRO_SEC;
    onStage('outro', 1, 1);
    const segs = [{ file: intro, dur: introLen.duration }, ...clipSegs, { file: outro, dur: outroLen.duration }];
    stop();
    onProgress(0.97, 'Putting the video together…');
    onStage('encode', 0, 1);
    const part = `${out}.part`;
    try {
      await concat(segs, part, workDir, signal);
      onStage('encode', 1, 1);
      // the check: picture and sound there, as long as its parts (within half a second)
      onStage('validate', 0, 1);
      const want = segs.reduce((n, x) => n + x.dur, 0);
      const got = await probe(part);
      if (!got || !got.hasAudio || Math.abs(got.duration - want) > 0.5 || got.width !== p.w || got.height !== p.h) {
        throw new Error(`the finished video did not check out (${got ? `${got.width}x${got.height}, ${got.duration.toFixed(2)} s of ${want.toFixed(2)} s${got.hasAudio ? '' : ', no sound'}` : 'unreadable'})`);
      }
      fs.renameSync(part, out);
      onStage('validate', 1, 1);
    } catch (e) { fs.unlink(part, () => {}); throw e; }
    trimCache();
    const secs = (Date.now() - started) / 1000;
    log(`${usable.length} clip(s) at ${p.key}${wheelOn ? ' with wheels' : ''} in ${secs.toFixed(1)} s (${reused} from the cache, ${parallel} at a time, ${encoder})`);
    onProgress(1, 'Done');
    return { profile: p, included: usable.length, skipped: clips.length - usable.length, unusable, reused, seconds: secs, format: p.portrait ? '9:16' : '16:9', encoder,
      gains: usable.map(c => c.gain) };
  }

  return { renderHighlight, renderClip, renderIntro, renderOutro, concat, probe, loudness, gainFor, pickProfile, ensureAssets, cardForClip, wheelFor, queueLength: () => queued, parallel, threads, encoder, STYLE,
    // the frame counts it will use (tests): a clip, and the title / end cards
    framesOf: (info, p) => clipFrames(info, p), cardFrames: (p) => ({ intro: gridLength(INTRO_SEC, p.fps), outro: gridLength(OUTRO_SEC, p.fps) }),
    // where things go (tests): the 9:16 picture, a clip's wheel, when its shot draws
    layout: { portraitBox, wheelPlace, wheelLead: WHEEL_LEAD } };
}

module.exports = { createHighlightEditor, cardForClip, wheelFor, STYLE };
