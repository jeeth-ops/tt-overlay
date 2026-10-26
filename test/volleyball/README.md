# Volleyball tests

The volleyball module's own suites. They run the **real** code — the rules
engine, `server.js` with `volleyball-server.js` mounted (in-memory MongoDB
from `test/mongo-memory.js`, a stand-in Firebase that knows only the test
tokens), and, for clips, the **real** Stream Engine from a temp copy cutting
real video with ffmpeg. Nothing here talks to a real database, Firebase,
Cloudflare R2 or Google Drive.

```
node test/volleyball/engine.test.js          # FIVB scoring: rally point, sets to 25 / 15, win by 2, best of 5, service order,
                                              # rotation, toss + deciding-set toss, change of courts at 8, substitutions (15.6 / 15.7),
                                              # libero rules, time-outs, sanctions, forfeit, undo / redo / void / correct, idempotency
node test/volleyball/standings-stats.test.js # points policies (3-2-1-0 …), FIVB tie-breaks, groups, round robin, seeded knockout,
                                              # player / team statistics from the timeline, who a rally (and its clip) is about
node test/volleyball/server.test.js          # the API on the real server: permissions, private tournaments, fixtures, lease,
                                              # locking, events, PDF report (versions), clips (ingest, token, R2 stand-in, links),
                                              # two-device clip registration, match keys, audit, cricket isolation
NODE_PATH=$(npm root -g) node test/volleyball/clip-e2e.test.js       # the real Stream Engine: a point press -> T0-7 s … T0+3 s,
                                              # finalised after the post-roll, independent jobs, short pre-roll reported honestly
NODE_PATH=$(npm root -g) node test/volleyball/ui.test.js             # Chromium: dashboard -> panel (phone, offline, corrections)
                                              # -> Clipper relay -> real engine -> scorecard video icon; overlay, tournament page
NODE_PATH=$(npm root -g) node test/volleyball/overlay-layout.test.js # Chromium: every overlay graphic with long / short names,
                                              # inside the frame, clear of the bar, no name cut short
node stream-engine/test/clipWindow.test.js   # per-job clip windows, sport routes, capture pages (cricket URLs unchanged)
```

Screenshots from the browser suites: `test/out/volleyball/`.
