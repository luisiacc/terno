# 81: The category snackbar's offers, stacked and explained

## Request (verbatim)

> what does this 4 option that says 'about' do? … its when i moved an item to a category

> that's very unclear, we need a better way to tell this, plus a tooltip explaining it, give me multiple proposals for this

> lets go with your recommendation, also i think we'll need to stack the buttons vertical instead of the sides otehrwise they won't see the full text

The recommendation chosen: label the topic offer like chip 1 ("Everything mentioning", parallel to "Everything from …"), keep its count at the end, and give it a tooltip that names the live words ("Adds every conversation that mentions “api” and “pagos” to Facturas …").

## What exists

- `category-snackbar.tsx` (plans 13, 63): after any categorization, the dock shows a title row (dot, "Moved to Facturas", Undo · z, ×) and one horizontally scrolling `Strip` of chips: 1 sender, 2 domain, 3 list, 4 topic, 5 "Always → filter". Keys 1–5 run them.
- Chip 4 is "About:" + up to 6 term toggles (top two preselected, `quickActions` in both stores) + "More…" (free search text) + "· N" + "View". It files `termsQuery(terms, category)` — every checked word, quoted, `-category:X` — across all mail.
- Problems: "About:" names no action; the toggles read as tags; the kbd "4" in front reads as the count; the row is wider than the dock, so the topic and filter offers sit past the fade and are never seen.
- `Strip` and `Chip` are shared with the similar snackbar (plan 63), whose chips are short; it stays as it is.

## Design

**Stacked offers.** Under the title row, one offer per line (a quiet menu-like list, hairline-free): `[n] label ………… count`. Each line is a full-width button (h-7, rounded, `hover:bg-muted`), the label truncates (full text in `title`), the count is right-aligned, tabular, without the "·". Loading is the same pulse as today. A domain/list that adds nothing beyond the sender still hides (`sameAsSender`); a zero-count scope still hides.

**The topic line.** `[4] Everything mentioning  api ✓  pagos ✓  … More…        View  4`. The apply button is "[4] Everything mentioning"; the toggles follow and wrap onto a second line when they don't fit (6 words max), so every word is visible. "View" and the count sit at the right, the count in the same column as the other lines'. With "More…" open the input takes the toggles' place (placeholder "words or a search…").

**Tooltip** on the topic's apply button (hover and keyboard focus, Base UI `Tooltip`), and the same text as its accessible description (`aria-describedby`, a hidden span):
- words checked: "Adds every conversation that mentions “api” and “pagos” to Facturas, from all your mail. Click a word to add or remove it."
- More… text: "Adds every conversation that matches “recibo from:x” to Facturas, from all your mail."
- nothing checked: "Check a word to add every conversation that mentions it to Facturas."
Words are joined with `formatList` (locale-aware "and"/"y"), quoted per locale (`“…”`, `«…»`).

**Strings** (`en`/`es`): `category.topic` "Everything mentioning" / "Todo lo que menciona"; `category.topicPlaceholder` "words or a search…" / "palabras o una búsqueda…"; new `category.topicName` (the input's name), `category.topicWord`, `category.topicHelp`, `category.topicHelpQuery`, `category.topicHelpEmpty`.

Keys 1–5, z, Esc, focus handling, the 10 s lifetime and pause-on-hover/focus are unchanged. Hovering the trigger or the tooltip pauses the lifetime as before: the tooltip is a React portal of the bar, so the bar's `onPointerLeave` doesn't fire on the way onto it.

## Tests

- e2e `categorize.spec.ts`: counts read without the "·"; the topic line shows "Everything mentioning"; its tooltip on hover names the checked words and the category and changes when a word is toggled; the apply button's accessible description matches; every offer line is fully inside the snackbar (no horizontal clipping) at the default window size.
- Visual: the snackbar baselines (`visual.spec.ts`) are regenerated and looked at in light and dark.
- Unit: the tooltip text builder (words, query, empty; en and es).

## Perf

No new requests: the counts are the same lazy `categorize.count` calls. The tooltip is the shared Base UI primitive, already in the entry chunk (sidebar). The dock's inset follows the taller card through its existing ResizeObserver.

## Out of scope

- The similar snackbar's chips (archive/spam/trash; short labels, plan 63).
- What the topic matches (`termsQuery`, the term ranking).

## Revisions after the Codex review (plan)

1. `snack.spec`'s ≤ 84 px bound for the categorization bar is replaced by a stacked bound (title + 28 px per line + the topic's word lines); the similar bar keeps its compact checks.
2. A new `snack.spec` test: with the taller categorization bar up, the list's last row and the keyboard's row stay above it.
3. The topic isn't one fixed-height line: its label line is h-7 and its words get their own wrapping line under it, indented to the label (the first try, words beside the label, wrapped into a narrow column five lines tall in the screenshot).
4. The topic line is a plain container; its apply button, words, More…, View are siblings (no nested buttons).
5. The apply button is `aria-disabled`, not `disabled`, with nothing checked: it stays focusable, its tooltip and description say how to start, and `run` ignores it.
6. Reading the tooltip holds the countdown. A `"tip"` pause reason was tried and dropped: the tooltip is a React portal of the bar, so the bar's `onPointerLeave` never fires on the way onto it; the test covers it.
7. The description is our own hidden span via `aria-describedby` (Base UI's tooltip adds none); tested in the words, More… and empty states.
8. Esc in More… gives focus back to More… (it used to drop to the body).
9. A blank More… still files the checked words, so the help says the words.
10. `visual.spec`'s readiness waits for a bare count; baselines regenerated and looked at.
11. `Chip`/`Strip` stay as they are for the similar snackbar; the category bar has its own `Offer`.
12. Spanish input name said "archivar" (archive); now "añadir a la categoría".

## What the Codex code review changed

- The help said "Moves", but `categorize.apply` only adds the category (a thread keeps its others): every string now says "Adds"/"Añade".
- The e2e checks the visible tooltip after toggling a word and with More… text, not only the description, and opens it from the keyboard (Tab onto 4).
- The countdown test hovers the tooltip itself for 11 s, then replaces the bar with 1 while the tooltip is open and checks the next snack still expires.
