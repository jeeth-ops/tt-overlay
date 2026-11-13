# Tennis tests

The lawn-tennis module's own suites (not the table-tennis `tt-*` pages). They
run the **real** code — the scoring engine, `server.js` with
`tennis-server.js` mounted (in-memory MongoDB from `test/mongo-memory.js`, a
stand-in Firebase that knows only the test tokens, a stand-in R2), the real
pages in Chromium, and for clips the **real** Tennis Clipper — tennis's own
program (`tennis-clipper-helper/` → TennisClipper.exe, port 5009,
`asl-tn-clipper://`) — cutting a growing fMP4 recording with ffmpeg. Nothing
here talks to a real database, Firebase, Cloudflare R2, Google Drive or vMix.

```
node test/tennis/engine.test.js       # ITF scoring: 0/15/30/40, deuce, advantage, No-Ad (receiver's choice), sets 6-0 … 7-6,
                                      # advantage sets, 7 / 10 / custom tie-breaks (2-point margin, server rotation, ends every
                                      # 6 points), match tie-breaks, best of 3 / 5 / one set / pro set / short sets / Fast4, no
                                      # empty sets; serving order singles + doubles, receiving positions, court (deuce / ad);
                                      # faults, lets, aces, double faults, foot faults; change of ends; pause / suspend /
                                      # resume / retire / walkover / default / abandon; game / break / set / match point with
                                      # counts; foot faults (a fault; on the second serve a double fault); undo / redo / void /
                                      # correct (O(1) undo, no copy of the match), idempotency;
                                      # property test: incremental == full replay; performance
node test/tennis/stats-draw.test.js   # statistics from the timeline (unavailable is not 0), who a point (and its clip) is
                                      # about; seeded knockout draws, byes, third place, round robin, group standings
node test/tennis/graphics.test.js     # on-air rules (pure): one scene at a time, the bug leaves first, timed / held, stale
                                      # and repeated commands, call-outs once per point, lower thirds, layouts, ON AIR read
                                      # from the outputs (monitors not counted)
node test/tennis/server.test.js       # the API on the real server: permissions, private tournaments, players (no
                                      # duplicates), events and draws (a winner moves on only when verified), matches,
                                      # controller lease, events + idempotency, statistics, PDF report, clips (ingest,
                                      # token, R2 stand-in), graphics, isolation from cricket and volleyball
NODE_PATH=$(npm root -g) node test/tennis/clipper-helper.test.js  # the REAL Tennis Clipper + a growing ffmpeg recording:
                                      # T0-7 s … T0+3 s (frame timecodes), the match's own window, a short lead-in reported,
                                      # Set-N/Game-M filing + player links (never the double-faulter's), a correction renames
                                      # the same file (no re-cut, no re-upload), hand-pressed clips → Moments, offline →
                                      # upload once, restart resumes, cricket / volleyball presses refused, vMix stopped
NODE_PATH=$(npm root -g) node test/tennis/overlay.test.js         # Chromium, every frame sampled: vMix-safe CSS on a
                                      # transparent 1920×1080 canvas, the bug following the score, a call-out once (repeats,
                                      # undo, reload), never a scene on the bug, the bug back once with the current score,
                                      # rapid takes, timed scenes, reload mid-scene, lower thirds, layouts, output reports
NODE_PATH=$(npm root -g) node test/tennis/overlay-layout.test.js  # Chromium: EVERY graphic one by one — all 17 scenes (each
                                      # in its match state), all 8 lower thirds (the scrolling ticker too), all 12 call-outs,
                                      # the singles and doubles bug — with a very long and a very short name, portraits and a
                                      # wide logo: every word inside 1920×1080, none cut short, pictures loaded and not
                                      # stretched, each one in and out
NODE_PATH=$(npm root -g) node test/tennis/ui.test.js              # Chromium: the panel (keys, buttons, corrections, undo /
                                      # redo, faults, foot faults, aces), the network dropping (kept, sent once, across a reload), the phone
                                      # remote taking over and handing back, graphics to air with ON AIR confirmed, the public
                                      # match centre, a winner moving through the draw, the dashboard and who may use it,
                                      # the player page, overlay links and Clipper page, phone widths
```

The homepage's Tennis tab, tile and card are covered in `test/homepage.test.js`.

Screenshots go to `test/out/tennis/` (git-ignored). `TN_CLIPPER_BIN=<a
TennisClipper binary from npm run build>` runs the Clipper suite against the
packaged program instead of its source.
