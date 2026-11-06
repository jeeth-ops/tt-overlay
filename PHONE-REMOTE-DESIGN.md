# Phone Remote — design system

Everything on the phone (`cricket-remote.html`) is built from one set of
tokens and a small set of components. If you change a component, change it
here once, and the whole Phone Remote stays consistent. The phone never
styles the laptop panel. Its CSS lives only in `cricket-remote.html`, so it
cannot leak into the panels, the overlay or the scorecard.

## Tokens (`:root` in `cricket-remote.html`)

Dark is the default. `:root[data-theme="light"]` redefines the same names,
so a component styled with tokens looks right in both themes. Never put a
raw colour in a component. If no token fits, add one to both theme blocks.

| Group | Tokens | Use |
|---|---|---|
| Surfaces | `--bg` `--bg-2` · `--s1` (card) `--s2` (raised) `--s3` (control) `--s4` (pressed) | page → card → control |
| Lines | `--line` `--line-2` `--line-3` | borders, dividers |
| Text | `--tx` `--tx-2` `--tx-3` `--tx-inv` | primary, secondary, hint, on-colour |
| Accent | `--acc` `--acc-2` `--acc-soft` `--acc-line` `--acc-ink` `--acc-tx` | selected / focused / primary |
| States | `--ok` `--warn` `--bad` `--info`, each with `-soft` (background) and `-tx` (text) | success, waiting, danger, sending |
| Keys | `--key-bg` `--key-line` `--key-tx` `--key-sh` · `--key-ext-*` · `--four*` `--six*` `--wkt*` | the scoring pad |
| Layers | `--hdr-bg` `--nav-bg` `--sheet` `--sheet-line` `--scrim` · `--field` `--field-line` | header, tab bar, sheets, inputs |
| Shape | `--r-xs` `--r-sm` `--r-md` `--r-lg` `--r-xl` · `--sh-1` `--sh-2` | radius, shadow |
| Motion | `--ease` `--ease-out` | every transition |
| Layout | `--hdr` `--nav` `--safe-t` `--safe-b` | header / tab bar height, notch and home-bar insets |

The theme is set before the first paint (an inline script reads `crTheme`).
Settings offers Auto / Light / Dark. Auto follows the phone. A theme change
only swaps tokens: it never re-renders or closes anything that is open.

## Components

| Component | Classes | Rule |
|---|---|---|
| Icon button | `.ibtn` | header actions (theme, settings), 36 px |
| Card / accordion | `.card` · `.acc` `.acc-h` `.acc-b` `.acc-in` | cards open and close smoothly (`grid-template-rows`); the open state is remembered |
| Picker field | `.pick` (`.unset`, `.pending`) | any dropdown with more than 3 choices, and every player list |
| Picker sheet | `#pk` · `.pk-row` `.av` `.tags` `.ck` · `.pk-empty` | bottom sheet; search only for more than 7 choices; player rows show initials in the team colour, C / WK / on strike / bowling / bench / LHB tags |
| Segmented | `.seg.fill` `.so` | 2–3 short choices (toss call, Auto/Light/Dark): one tap, no sheet |
| Switch row | `.tg` (`.tg-d` for a description) | on / off settings and graphics |
| Input | `.fldw` `.fld` `.fld-x` | text fields, with a clear button |
| Dialog | `#dlg` (`.danger`) | the phone's own questions; red only for irreversible actions |
| Sheet | `.sheet` · `.grab` | laptop popups and cards; drag down or Back to close |
| Menu row | `.mrow` (`.danger`) · `.mgrp` | settings list |
| Chips | `.chip` (status) · `.cat` (graphics families, with an on-air count) | |
| Stat tiles | `.tiles` · `.stats` | the panel's stat grids; the score card's run rates |
| Notes / toasts | `.note` · `.toast` | one slim line; identical toasts merge into one |

The laptop sends each control as an item (`t`, `h`, `b`, `seg`, `tg`, `s`,
`i`, `kv`, `ww`). `itemsHtml()` turns items into these components, and
`selectHtml()` decides between segmented and picker. Add a new kind of
control there, built from the classes above, and it appears everywhere.

## Interaction rules

- **Values never change on the phone.** A choice sends the laptop's own
  option value, which is a player's permanent id. The phone does not rename
  or re-key anyone.
- **Back closes the top layer:** picker, dialog, card sheet, settings.
  The laptop's own popups stay until they are answered.
- **No ghost taps.** For 0.4 s after a picker, sheet or dialog closes, its
  clear backdrop swallows the second tap of a double tap. Choosing the same
  value twice sends nothing.
- **A laptop popup wins.** If the laptop opens a popup while a picker is
  open, the picker closes, so a choice never lands in the wrong field.
- **Ask only when it matters.** Scoring never asks. Unpairing, discarding a
  saved run, or scoring after the laptop's score changed does ask, in a
  dialog with real words on the buttons.
- **Nothing covers the scoring.** Clip notes hide while the wagon wheel,
  a sheet, the picker or a dialog is up, and never take a tap meant for them.
  The "Reconnecting…" bar never covers a run key. In landscape it stays
  over the score card, and the score card's questions ("Was that a
  highlight?") and the runs saved offline sit right under the card.
- **Cheap to draw.** No `backdrop-filter`. Animate only `transform`,
  `opacity` and `grid-template-rows`. Respect `prefers-reduced-motion`.
- **Every state exists:** pressed (`:active`), selected (`.on`), focused
  (`:focus-visible`), disabled, sending (`.pending`), done and failed.
- **Sizes:** keys are at least 40 px tall on a 360 × 640 phone and in
  landscape. The layout never scrolls sideways.
