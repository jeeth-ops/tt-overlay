# Phone Remote — feature parity with the laptop panel

The phone never scores or renders on its own. Every phone press is a
command, and the laptop panel carries it out by pressing its **own**
control (see `cricket-remote.js` and `cricket-remote-host.js`). So the
phone uses the same scoring rules, overlay updates, clips and recording
as the laptop. "On the phone" below means the laptop's control can be
pressed from the phone and shows its live state there.

The inventory was produced by reading every button, switch, dropdown and
input inside each `card-*` element of `cricket-panel.html` and
`cricket-panel3.html` (`inventory.js` on the test rig), then checking it
against the phone's sections.

## Scoring

| Laptop | Phone |
|---|---|
| 0 1 2 3 4 5 6, Wicket, Wide, No Ball, Bye, Leg Bye, Overthrow | Scoring pad. Runs 0–6 are also saved on the phone when offline. |
| Wicket details (type, who is out, fielder, runs completed, crossed) | The laptop's own popup, shown on the phone |
| Caught / Stumped / Run out / Retired / extras / overthrow popups | Same (mirrored popups) |
| New batsman, new bowler (over complete), mid-over bowler, bowler assign | Same |
| Undo last ball | Undo (only if the last ball is still the one the phone saw) |
| Swap strike | Swap |
| Penalty runs, Retired, Impact player | Penalty / Retired buttons and Match Events |
| Wagon wheel | Docked wheel above the pad: drag to aim, release to save; tied to the delivery |
| Edit Scorecard (delete from the end, transfer an over) — owner accounts only | Match Events → Edit Scorecard. Shown on the phone only when the laptop shows it. |
| Free hit, Super Over bar | Match Events |
| Start next innings, Declare, Stumps / Resume day (panel 3), Draw | Innings |

## Match

| Laptop card | Phone | Laptop only (and why) |
|---|---|---|
| Toss | Toss (Match tab and Graphics) | — |
| Team Squads & Roles | Playing XI, captain, keeper | Removing or renaming players, squad import (data editing) |
| At the Crease, Current Bowler, New Batsman | All controls | — |
| Match Setup → review + Start Match | Start Match | Team names, colours, logos (file upload), format, overs, wickets, batting side, target: set up before the match on the laptop |
| Match Setup → venue, YouTube link (Day 1–4 in a Test), Day on the overlay | Day, Venue & Stream | — |
| Match Type → Save This Match | Save, Reports & Checks (tournament mode) | Single / Tournament switch, create / delete tournament, Create New Match, Schedule, Matches list (resume / delete): these change which match is on the panel |
| Session → Check this innings adds up, Excel, PDF, both, auto-download, tournament Excel | Save, Reports & Checks (files are made and saved on the laptop) | Reset Match (destructive; laptop only) |
| Overlay / LED / scorecard links | Match → Links (copy / share on the phone) | Opening the previews (they are for the laptop screen) |
| Theme colours | — | Visual design of the overlay, set before the match |

## Graphics

| Laptop card | Phone |
|---|---|
| Score bug visible | Graphics → Score Bug |
| Broadcast Graphics (match intro, team intro, toss, Playing XI, batting / bowling card, …) | Graphics → Broadcast Graphics, with ON AIR state |
| Player & bowler stat cards, team stats | Graphics → Stat Cards |
| Current batsmen & bowler cards (panel 3) | Graphics → Player & Bowler Cards |
| Summary graphics (innings / match summary) | Graphics → Summary |
| Manual milestone trigger | Graphics → Milestones |
| Tournament history / points table (tournament mode) | Graphics → Tournament Graphics |
| On air now / take off air | Graphics → On air now |

## Clips and live

| Laptop card | Phone | Laptop only (and why) |
|---|---|---|
| Recording (start / stop, status) | Clips → Recording | Drive connection, data folder, resolution (machine setup) |
| Clipper Helper (panel 1) | Clips → Clipper | Download / open the helper |
| Highlight / clip now | Clip button and Clips → Clip Now. Status comes from the laptop's own clip job. | — |
| Live Studio (panel 3): health, GO LIVE, STOP STREAM, lower quality | Clips → Live Stream (YouTube) | Stream URL, stream key, devices, encoder settings. The browser may ask for screen-capture permission on the first GO LIVE, and that has to be accepted on the laptop. |
| Program monitor (panel 3) | — | A video preview for the laptop screen |

## Not applicable on the phone

Panel navigation buttons, light/dark switch, Match ID + Connect (the phone
is paired to one match), the Phone Remote button itself, Player Helper
(a separate phone tool), scorecard file import.
