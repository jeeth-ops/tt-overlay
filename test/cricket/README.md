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
