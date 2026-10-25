# Cricket scoring engine tests

These run the **real** scoring engine out of `cricket-panel.html` (loaded into
jsdom, with the socket/fetch/Firebase dependencies stubbed) and the **real**
canonical derivation out of `server.js` (`deriveBallFacts` +
`buildLiveCardsFromBallsArray`, extracted by name so the tests can never drift
onto a copy of the rules).

```
npm install --no-save jsdom
node test/cricket/test.js         # Laws-of-cricket behaviour of the panel engine
node test/cricket/server-test.js  # the server's derivation, and panel <-> server agreement
node test/cricket/regress.js      # downstream builders, persistence, backward compatibility
node test/cricket/recovery-test.js # the match-data safety net + the Recovery Centre's converters
node test/cricket/outbox-test.js  # the ball outbox: no delivery is lost when the line drops
node test/cricket/clip-attribution-panel-test.js # both panels: every clip names the players of ITS delivery
node test/cricket/clip-linkage-server-test.js    # the website links a clip to the same delivery and dismissed batter
node test/clip-attribution.test.js               # the shared ownership rule + clip organiser folders/names
node test/cricket/clip-editor-server-test.js     # Advanced Clip Editor, server: owner cases 1-9, 403, rollback
node test/cricket/clip-editor-ui-test.js         # Advanced Clip Editor, scorecard UI (owner-only ⋯, preview, save)
node test/cricket/scorecard-clip-download-test.js # scorecard player drawer: download all / 4s / 6s / 4s + 6s / wickets as one video, after picking 16:9 / 9:16 + wagon wheel
node test/cricket/commentary-wagon-wheel-test.js # Full Commentary: a wagon wheel per over (MCA President Cup 2026 + matches from 10 Oct 2026 on), over pips, Fours / Sixes wheel, only changed overs rebuilt
node test/highlight-edit.test.js                 # 🎬 pro edit of downloaded highlights: clip tags, title card with the player's team + figures, the band at every cut, no transition sound (clips' own sound kept), no gap at any join, 9:16 Reels, the wagon wheel (each clip's own shot, never over the middle of the picture), segment cache, plain video if the edit fails
node test/cricket/insert-ball-server-test.js     # Add / Insert / Remove a ball: renumbering, strike, clips, undo, 403
node test/cricket/insert-ball-ui-test.js         # Add / Insert Ball in Edit Scorecard (owner-only ＋, preview, save)
node test/cricket/upcoming-match-test.js         # 📅 Upcoming Match (date only) + saved teams, both panels, server registry, tournament page
node test/cricket/cricket-controls-ui-test.js    # Penalty / Retired Hurt / Overthrow / Super Over / mid-over bowler in BOTH panels
node test/cricket/superover-noball-test.js       # tie -> Super Over -> result, and No-Ball scoring (tests 1-14): both panels, scorecard, overlay
NODE_PATH=$(npm root -g) node test/cricket/overlay-layout-test.js  # 🎯 the overlay's score bar in Chromium at 1920x1080 / 1920x1280 / 1536x864 /
                                                  # 1366x768 / 1280x720 / 854x480: nothing off screen, cut or overlapping in any state (measured from the
                                                  # rendered page), frame by frame through updates, events and innings changes; the chase panel in
                                                  # every chase state (TARGET for 8 s as the chase begins / after each over / when the bar returns,
                                                  # else NEED x RUNS FROM y BALLS; RRR beside CRR), never two faces at once; the team record on 480p;
                                                  # the full-screen TOSS / PLAYING XI (both teams) / MATCH INTRO / BAT + BOWL SCORECARDS with the longest names at 854x480 /
                                                  # 1280x720 / 1920x1080 / 1920x1280: on air, bar off air, nothing off the 5% margin, cut or overlapping,
                                                  # the picture showing through (no full-screen layer over 60% opaque) (ONLY=gfx runs just those)
                                                  # (gsap + webfonts from node_modules when installed: npm install --no-save gsap@3.12.5
                                                  #  @fontsource/inter @fontsource/manrope @fontsource/anton; else their CDNs. SHOTS=<dir> saves pictures)
node test/cricket/wicket-bowler-test.js          # Wicket Details + optional / late / corrected bowler (tests 1-45): both panels, scorecard, overlay, database
node test/cricket/out-types-test.js              # all 16 out types under the Laws, the strike question, bowling 0s/NB/WD: both panels, scorecard, server
node test/cricket/clipper-launcher-test.js       # ▶ Start / ⏹ Stop Clipper from the Clipper panel (asl-clipper:// launcher, hidden), launcher files + zip
node test/cricket/clip-position-test.js          # 4 / 6 / every wicket on the first, middle, last ball: the clip names that ball's batter + bowler (both panels)
node test/cricket/toss-stream-test.js            # toss lists teams by name; YouTube link tick (both panels)
NODE_PATH=$(npm root -g) node test/cricket/broadcast-graphics-test.js  # 🎬 PLAYING XI / TOSS / MATCH INTRO / SCORECARDS: the server's rules (timings, Hold,
                                                  # a new toss time from now, stale stop / skip refused, retries, the end timer never ending a newer
                                                  # graphic, only pictures in url()), then the REAL server + overlay + BOTH panels in Chromium:
                                                  # start in one panel → overlay + the other panel lit; team 1 / team 2 each 10 s readable; stop
                                                  # from the other panel in every phase; skip; overlay reloaded mid-graphic carries on; toss Hold,
                                                  # duration changed while up, ends by itself; replace + old timer; double clicks; missing XI / toss
                                                  # result; reduced motion; the controls one block in both panels (ONLY=rules: no browser);
                                                  # Playing XI AUTO / HOLD (no timer behind HOLD, NEXT TEAM, AUTO from where it is); the Match
                                                  # Arena intro held, reloaded without replaying; INNINGS picked in one panel → the other; BAT /
                                                  # BOWL SCORECARD of each innings with its real figures, every player once, the rest of the
                                                  # squad by name (did not bat / yet to bat / did not bowl / not in XI), the scoring untouched;
                                                  # over-end cards wait while a card is pinned and run again after HIDE SCORECARD; the knockout
                                                  # round read from stage / title (SEMI-FINAL, FINAL …, never a league game); a final's gold
                                                  # ribbon on the intro; with the score bar switched off the graphics still go on air and the
                                                  # bar stays off after; Live Output blurs its camera while one is up, sharp again after
node test/cricket/match-report-test.js           # 📑 scorecard Excel + PDF report with wagon wheels, auto-download at match end: both panels
                                                  # (MR_LIBS=<dir with node_modules/exceljs + jspdf> also builds and checks the real files;
                                                  #  --sync re-inlines match-report.js into both panels)
node test/cricket/run-out-crossing-test.js       # 🏏 Run Out ends (Laws 18.8.2, 18.12.1): "had they crossed?" asked every time; last-ball crossed
                                                  # → the original striker faces the next over; not crossed, striker out, mid-over, a run then a
                                                  # run out, wide / no ball on the 6th ball, the incoming batter, reload + another device, both panels
                                                  # identical, retries, already-scored matches unchanged
node test/cricket/run-out-crossing-server-test.js # the REAL server.js keeps the crossing answer with the delivery (socket logBall, a retry receipted
                                                  # once), Edit Delivery keeps it while it is still a Run Out, the scorecard is unchanged by it
node test/scorecard-viewers.test.js              # 👁 "watching now" beside Visit Website: the REAL server's count (one per browser, check-out, 50 s
                                                  # timeout, per match, made-up ids refused) and the real page in Chromium — both themes, phone
NODE_PATH=$(npm root -g) node test/homepage.test.js   # 🏠 the homepage in Chromium (after npm install): product sections + local WebP pictures,
                                                  # canonical / og:image / JSON-LD, tournaments live first + search / city / dates, latest
                                                  # streams (server: youTubeVideoId / tournamentStreams) + the owner's add / remove / restore,
                                                  # the players' 3-taps phone (finger on every tap target, loop seam, plays only on screen,
                                                  # step jumps, reduced-motion stills, phone tabs), the broadcast TV, the phone background,
                                                  # Cricket / Football / Table Tennis tabs (URL, Back / Forward, keys) + the 16:9 carousel
                                                  # (thumbnail / poster fallback / broken picture, arrows, loading, Try again), the owner's
                                                  # thumbnail editor (pick, drag, keys, save, remove, stale edit), the WhatsApp card, 320–1920px,
                                                  # and the row at 60 fps: its own GPU layer, only transform/opacity moving, LIVE pulses only
                                                  # in view, hero loops resting off screen, arrows on a card's start, the position bar, ← →,
                                                  # a refresh redrawing only what changed (and waiting while the row moves)
node test/tournament-thumbnails-server.test.js    # 🖼️ tournament thumbnails + the sport list on the REAL server (in-memory MongoDB + R2): three
                                                  # sports ('tt' → Table Tennis, no "TT::"), only chhayajeeth@gmail.com may set / move / remove
                                                  # (403 for all else, spoofed claims too), checked by its bytes, too big / small refused,
                                                  # replace + remove clean storage, failed upload / save keep the old one, stale edits refused, audit;
                                                  # the picture's own colours (read at upload; [] grey, null unreadable) on the homepage list
                                                  # and the tournament page (+ its sport); older pictures filled in once per run, never onto a
                                                  # newer picture; a private tournament's page stays "not found" to everyone else
NODE_PATH=$(npm root -g) node test/tournament-cover.test.js   # 🎬 the tournament page's cover in Chromium: its thumbnail edge to edge (laptop + phone,
                                                  # 320–1440, no sideways scroll), vivid — the shade leaves the picture's pixels as they are
                                                  # away from the words — and the words reading on it (contrast measured off the screen, both
                                                  # themes); the page in the picture's colours with real contrast (won / live keep theirs);
                                                  # the card's poster without a picture or when it fails, kept through the 20 s re-draw; the
                                                  # same picture kept (no blink, no entrance again), a new one / new crop replaces it; names
                                                  # and links from the database never markup; works without /tournament-art.js
node test/homepage-streams-server.test.js         # ▶️ homepage Latest streams on the REAL server (in-memory MongoDB): a match's link is "live"
                                                  # only while the panel pings; only chhayajeeth@gmail.com may add / remove / restore (403 for
                                                  # all else); bad links refused; YouTube's title when none typed; restore; the audit log
node test/cricket/points-table-teams-test.js     # 🏆 Points Table lists each team ONCE when its name was typed differently on different matches
                                                  # ("United Cricketers" / "UNITED CRICKETERS "): rows, P/W/L/PTS/NRR, form, overlay card, Team History
                                                  # list, the name shown; both panels
PANEL=cricket-panel3.html node test/cricket/test.js   # the scoring engine suite against the Stream Engine panel
node test/tournament-merge.test.js               # 🔀 Merge Tournaments engine on an in-memory MongoDB (production unique indexes): Jeeth's two IDs (keep either),
                                                  # every match once, points table / leaderboards, similar names never auto-merged, id clash, invalid refs,
                                                  # failure mid-transfer + resume / rollback, idempotent submit, access, media untouched,
                                                  # one ID left on two different players (renamed mid-match) never makes them one,
                                                  # "Undo player changes" of a finished merge (matches stay merged, later edits left alone)
node test/tournament-merge-server.test.js        # the REAL server.js over HTTP: only the two accounts (401/403 on every route), the full flow,
                                                  # old source links → destination, private stays private, live pings after a merge, merge locks (423),
                                                  # undo the player changes (401/403, once, audit)
NODE_PATH=$(npm root -g) node test/tournament-merge-ui.test.js  # the wizard in Chromium against the real server: sign-in / access denied, homepage button,
                                                  # select → preview → player IDs → confirm → progress → done → history → undo player changes,
                                                  # phone + light theme, keyboard
node test/scorecard-model.test.js                # 📷 Import Scorecard: the cricket rules (overs, dismissal lines, FIRST + LAST names, the result,
                                                  # every check on an innings) and the browser's OCR text reader
node test/scorecard-import.test.js               # the import engine with the real server.js player / team functions: Jeeth Kumar Suvarna →
                                                  # Jeeth Suvarna on his own ID, same / similar names always asked, teams + logos, checks,
                                                  # saving once (twice, at once, after a failure, after a restart), commentary display-only
node test/scorecard-extract.test.js              # the photo reader: the real @anthropic-ai/sdk against a stand-in Messages API (request,
                                                  # retries, failures in plain words, strict schemas)
node test/scorecard-import-server.test.js        # the REAL server.js: chhayajeeth@gmail.com only (401/403 on every route), raw photo uploads,
                                                  # background reading, saving, the public tournament page, ball-by-ball tools refuse imports
NODE_PATH=$(npm root -g) node test/scorecard-import-ui.test.js   # the wizard in Chromium: access, entry points, Claude flow (desktop),
                                                  # typed flow with a reload (phone, light), browser reader, the public scorecard page
```

`server-test.js` is the one that matters most: it feeds the same ball documents
to both engines and fails if the panel's live card and the server's
recalculation disagree about the total, the extras, the overs or a player's
figures. That is the check that keeps "one event, one historical fact" true
rather than aspirational.

`recovery-test.js` covers the guard that stops a write erasing an innings
(`guardMatchRecordWrite`) and the two converters the Recovery Centre rebuilds a
lost match with (`matchRecordFromPanelState`, `ballDocsFromPanelState`).

`outbox-test.js` boots the real panel with a socket it can take offline and
checks the promise the ball outbox makes: a delivery is on disk before it is
sent, it is re-sent until the server acknowledges it, and a re-send reuses its
ballUid so it can never become a second ball.

`clip-attribution-panel-test.js` drives both live panels (`cricket-panel.html`,
`cricket-panel3.html`) through the real wicket modals on the last ball of an
over (12.6): run out of the striker / non-striker (with 0, 1, 2 completed
runs), bowled, caught, FOUR, SIX, a no-ball boundary, a crease that changes
while the wicket modal is open, a cancelled wicket press, and an undo +
re-score. After each it moves the match on (new batsman, next over, next
bowler) and checks that the clip request, the clip re-label, the website
classification and the ball-log row still name the delivery's own players.

The ownership rule itself lives in `/clip-attribution.js`; the two panels
carry an inlined copy. Edit the module, then `node test/clip-attribution.test.js --sync`.

`clip-editor-server-test.js` runs the real `correctDelivery` / `runClipEdit` /
`requireOwner` code from `server.js` on an in-memory database: FOUR → SIX,
changing the dismissed batter of a run out, changing batsman and bowler,
Caught → Run Out → Bowled (bowler credit), several fields in one save, the
last ball of an over, an old delivery several overs back, a failing scorecard
rebuild (everything rolls back) and another Gmail account (403, nothing
changes).

`insert-ball-server-test.js` generates innings by the Laws and then scores the
same match with one ball forgotten — the way a live panel does: every later
ball numbered one early and the strike wrong after it. Inserting the missing
ball must give back the true innings: every ball's number and striker, the
team total, the overs, every batter's runs, and every clip still on its own
delivery. Also: a gap, the last ball of an over, Wide / No Ball, 4 / 6,
Bowled / Caught / Run Out (striker, non-striker, with runs), both innings and a
3rd (Test) innings, the live innings guard, remove + undo, rollback, 403.

`match-lock-test.js` runs the real MATCH LOCK CODES block, the socket gate and
the match-save check from `server.js` on an in-memory lock store, and both
panels against those real routes: the operator's own code typed twice
(6-7 letters and numbers, unique; refused when letters-only, too short, the two
don't match, or already used), locking left to the operator (Schedule Upcoming Match / Create New
Match), ▶ Start / ▶ Resume asking for the code, wrong code refused, one laptop
at a time (the laptop that lost the match is stopped by the server and its
balls wait until the code is entered again), the wrong-code limit, the owner's
admin list / remove, and matches without a code unchanged.

`history-cards-test.js` covers the POINTS TABLE, TEAM HISTORY and PLAYER
HISTORY cards. In both panels it checks the payloads: each team's short name,
colour, logo (within the size budget) and last-5 form; a DRAWN match reads
"Drawn", not "Lost"; a team's rank and record, with each opponent's look; and
a player's runs, not-out and bowling figures match by match. On the overlay it
checks the full-size cards (the rows, chips, tiles and the runs/wickets chart)
and the score bar going off air while a card is up and coming back when the
last card is hidden. It also checks that a re-send with nothing new changes
nothing, and that two cards never pile up: the newer card goes on top, and the
older one steps back and returns once the newer one leaves.
