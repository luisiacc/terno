# 81: The category snackbar's offers, stacked and explained

## Request (verbatim)

> what does this 4 option that says 'about' do? … its when i moved an item to a category

> that's very unclear, we need a better way to tell this, plus a tooltip explaining it, give me multiple proposals for this

> lets go with your recommendation, also i think we'll need to stack the buttons vertical instead of the sides otehrwise they won't see the full text

The recommendation chosen: label the topic offer like chip 1 ("Everything mentioning", parallel to "Everything from …"), keep its count at the end, and give it a tooltip that names the live words ("Moves every conversation that mentions “api” and “pagos” to Facturas …").

## What exists

- `category-snackbar.tsx` (plans 13, 63): after any categorization, the dock shows a title row (dot, "Moved to Facturas", Undo · z, ×) and one horizontally scrolling `Strip` of chips: 1 sender, 2 domain, 3 list, 4 topic, 5 "Always → filter". Keys 1–5 run them.
- Chip 4 is "About:" + up to 6 term toggles (top two preselected, `quickActions` in both stores) + "More…" (free search text) + "· N" + "View". It files `termsQuery(terms, category)` — every checked word, quoted, `-category:X` — across all mail.
- Problems: "About:" names no action; the toggles read as tags; the kbd "4" in front reads as the count; the row is wider than the dock, so the topic and filter offers sit past the fade and are never seen.
- `Strip` and `Chip` are shared with the similar snackbar (plan 63), whose chips are short; it stays as it is.

## Design

**Stacked offers.** Under the title row, one offer per line (a quiet menu-like list, hairline-free): `[n] label ………… count`. Each line is a full-width button (h-7, rounded, `hover:bg-muted`), the label truncates (full text in `title`), the count is right-aligned, tabular, without the "·". Loading is the same pulse as today. A domain/list that adds nothing beyond the sender still hides (`sameAsSender`); a zero-count scope still hides.

**The topic line.** `[4] Everything mentioning  api ✓  pagos ✓  … More…        View  4`. The apply button is "[4] Everything mentioning"; the toggles follow and wrap onto a second line when they don't fit (6 words max), so every word is visible. "View" and the count sit at the right, the count in the same column as the other lines'. With "More…" open the input takes the toggles' place (placeholder "words or a search…").

**Tooltip** on the topic's apply button (hover and keyboard focus, Base UI `Tooltip`), and the same text as its accessible description (`aria-describedby`, a hidden span):
- words checked: "Moves every conversation that mentions “api” and “pagos” to Facturas, from all your mail. Click a word to add or remove it."
- More… text: "Moves every conversation that matches “recibo from:x” to Facturas, from all your mail."
- nothing checked: "Check a word to move every conversation that mentions it to Facturas."
Words are joined with `formatList` (locale-aware "and"/"y"), quoted per locale (`“…”`, `«…»`).

**Strings** (`en`/`es`): `category.topic` "Everything mentioning" / "Todo lo que menciona"; `category.topicPlaceholder` "words or a search…" / "palabras o una búsqueda…"; new `category.topicName` (the input's name), `category.topicWord`, `category.topicHelp`, `category.topicHelpQuery`, `category.topicHelpEmpty`.

Keys 1–5, z, Esc, focus handling, the 10 s lifetime and pause-on-hover/focus are unchanged. Hovering the tooltip trigger is inside the dock, so it pauses the lifetime as before.

## Tests

- e2e `categorize.spec.ts`: counts read without the "·"; the topic line shows "Everything mentioning"; its tooltip on hover names the checked words and the category and changes when a word is toggled; the apply button's accessible description matches; every offer line is fully inside the snackbar (no horizontal clipping) at the default window size.
- Visual: the snackbar baselines (`visual.spec.ts`) are regenerated and looked at in light and dark.
- Unit: the tooltip text builder (words, query, empty; en and es).

## Perf

No new requests: the counts are the same lazy `categorize.count` calls. The tooltip is the shared Base UI primitive, already in the entry chunk (sidebar). The dock's inset follows the taller card through its existing ResizeObserver.

## Out of scope

- The similar snackbar's chips (archive/spam/trash; short labels, plan 63).
- What the topic matches (`termsQuery`, the term ranking).
