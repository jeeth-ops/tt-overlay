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
```

`server-test.js` is the one that matters most: it feeds the same ball documents
to both engines and fails if the panel's live card and the server's
recalculation disagree about the total, the extras, the overs or a player's
figures. That is the check that keeps "one event, one historical fact" true
rather than aspirational.
