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
node test/cricket/insert-ball-server-test.js     # Add / Insert / Remove a ball: renumbering, strike, clips, undo, 403
node test/cricket/insert-ball-ui-test.js         # Add / Insert Ball in Edit Scorecard (owner-only ＋, preview, save)
node test/cricket/upcoming-match-test.js         # 📅 Upcoming Match (date only) + saved teams, both panels, server registry, tournament page
node test/cricket/cricket-controls-ui-test.js    # Penalty / Retired Hurt / Overthrow / Super Over / mid-over bowler in BOTH panels
node test/cricket/superover-noball-test.js       # tie -> Super Over -> result, and No-Ball scoring (tests 1-14): both panels, scorecard, overlay
node test/cricket/wicket-bowler-test.js          # Wicket Details + optional / late / corrected bowler (tests 1-45): both panels, scorecard, overlay, database
node test/cricket/out-types-test.js              # all 16 out types under the Laws, the strike question, bowling 0s/NB/WD: both panels, scorecard, server
node test/cricket/match-report-test.js           # 📑 scorecard Excel + PDF report with wagon wheels, auto-download at match end: both panels
                                                  # (MR_LIBS=<dir with node_modules/exceljs + jspdf> also builds and checks the real files;
                                                  #  --sync re-inlines match-report.js into both panels)
PANEL=cricket-panel3.html node test/cricket/test.js   # the scoring engine suite against the Stream Engine panel
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
