# Volleyball tests

The volleyball module's own suites. They run the **real** code — the rules
engine, `server.js` with `volleyball-server.js` mounted (in-memory MongoDB
from `test/mongo-memory.js`, a stand-in Firebase that knows only the test
tokens), and, for clips, the **real** Volleyball Clipper — volleyball's own
program (`volleyball-clipper-helper/` → VolleyballClipper.exe, port 5007,
`asl-vb-clipper://`), never the Cricket Panel's Clipper Helper — cutting a
growing fMP4 recording with ffmpeg, plus the older Stream Engine route.
Nothing here talks to a real database, Firebase, Cloudflare R2, Google Drive
or vMix.

```
node test/volleyball/engine.test.js          # FIVB scoring: rally point, sets to 25 / 15, win by 2, best of 5, service order,
                                              # rotation, toss + deciding-set toss, change of courts at 8, substitutions (15.6 / 15.7),
                                              # libero rules, time-outs, sanctions, forfeit, undo / redo / void / correct, idempotency
node test/volleyball/standings-stats.test.js # points policies (3-2-1-0 …), FIVB tie-breaks, groups, round robin, seeded knockout,
                                              # player / team statistics from the timeline, who a rally (and its clip) is about
node test/volleyball/server.test.js          # the API on the real server: permissions, private tournaments, fixtures, lease,
                                              # locking, events, PDF report (versions), clips (ingest, token, R2 stand-in, links),
                                              # two-device clip registration, match keys, audit, cricket isolation,
                                              # more than one hand-made match in a tournament
node test/volleyball/graphics.test.js        # on-air rules (pure): one graphic at a time, the bar leaves first, time on screen
                                              # counted from the end of the entrance, stale / repeated commands, starting-six
                                              # hand-over, the broadcast look validated; the live overlay Automatic / Manual
                                              # (take on / off air, alternatives, hide everything + restore, no timer or graphic
                                              # brings an off-air bar back); ON AIR read from the outputs (monitors not counted)
node test/volleyball/graphics-server.test.js # on-air graphics on the real server: who may take them, refusals with the reason
                                              # (no toss, no line-up…), the server ends timed graphics, rejoin after a restart,
                                              # time-out graphic ends on the next rally, broadcast look per tournament, portraits;
                                              # live-on / live-off / live-mode saved and kept through points, timers and reloads;
                                              # vb:output reports (joined overlays only, cleaned, forgotten on disconnect)
node test/volleyball/clipper-helper.test.js  # the REAL Volleyball Clipper + a growing ffmpeg recording: a point = T0-7 s … T0+3 s
                                              # = 10 s (frame timecodes), short lead-in reported, duplicates, offline → upload once,
                                              # restart resumes, VolleyballClips/…/Set-N + Players/<Team>/<No-Name> links by player
                                              # id, retry, next match isolated, a cricket press refused (it never cuts cricket)
node test/volleyball/clipper-separation.test.js # the REAL Cricket Clipper and Volleyball Clipper side by side, each from its own
                                              # folder (Windows launchers emulated from their files): nothing shared (files, ports,
                                              # links, settings, queues, clips folders, logs); both cutting at once; the "Can not
                                              # find script file" Stop failure reproduced and fixed; cricket STOP / START × 3 and
                                              # volleyball STOP / START × 3, each leaving the other untouched; the real Cricket
                                              # Panel's ▶ Start / ⏹ Stop × 3 (needs jsdom: npm install --no-save jsdom)
NODE_PATH=$(npm root -g) node test/volleyball/clipper-ui.test.js     # Chromium: the panel's 🎬 Clipper — READY only after the
                                              # checks, "Who earned this point?" never blocks scoring, assign later from the six on
                                              # court then, Undo, reload resume, vMix stopped → WARNING, Stop, Quit the Volleyball
                                              # Clipper (it closes itself, nothing else); the Clipper page
NODE_PATH=$(npm root -g) node test/volleyball/clip-e2e.test.js       # the real Stream Engine: a point press -> T0-7 s … T0+3 s,
                                              # finalised after the post-roll, independent jobs, short pre-roll reported honestly
NODE_PATH=$(npm root -g) node test/volleyball/ui.test.js             # Chromium: dashboard -> panel (phone, offline, corrections,
                                              # graphics sheet) -> Clipper relay -> real engine -> scorecard video icon; overlay
NODE_PATH=$(npm root -g) node test/volleyball/overlay-layout.test.js # Chromium: every overlay graphic with long / short names,
                                              # inside the frame, bar off air under it, no name cut short, headings clear
NODE_PATH=$(npm root -g) node test/volleyball/overlay-lifecycle.test.js # Chromium, every frame sampled: a graphic never sits on the
                                              # score bar; the bar returns once with the latest score; timed / held / rapid takes,
                                              # overtaken entrance, reload mid-graphic, server unreachable, layouts, point tags,
                                              # a logo that will not load, vMix-safe CSS, no animation left running; the live
                                              # overlay by hand: off air plays its exit and stays off through points / timers /
                                              # graphics / a reload, corner bug ⇄ score bar never both and never a cut, hide
                                              # everything mid-transition, Automatic ⇄ Manual without a flash
NODE_PATH=$(npm root -g) node test/volleyball/studio.test.js         # Chromium: the graphics studio (/volleyball-studio) —
                                              # preview is not on air, take / dismiss, the look saved and followed by the output,
                                              # team colours; the panel's on-air control centre: ON AIR only once a real output
                                              # has it, 10 s / Hold, unavailable cards say why, the player card, the live overlay
                                              # on / off air from the studio and the panel checked on the output page, a reloaded
                                              # panel reconciles; no sideways scroll on desktop or phone
node stream-engine/test/clipWindow.test.js   # per-job clip windows, sport routes, capture pages (cricket URLs unchanged)
```

The two clipper suites can also run against the packaged programs (`npm run
build` in each clipper's folder): `VB_CLIPPER_BIN=<VolleyballClipper binary>`
for both, plus `CRICKET_CLIPPER_BIN=<ClipperHelper binary>` for
`clipper-separation.test.js`.

Screenshots from the browser suites: `test/out/volleyball/`.
