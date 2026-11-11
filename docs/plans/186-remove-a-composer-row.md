# Plan 186: a composer row opened by its button can be taken away again

## Request (verbatim)

> when i add this things using the littke buttons like 'cc' , i can't remove them afte rthat, lets have a little X at the far right, that's light and shows on hover of the row, so they can remove those sections

## What exists

- `DraftFieldsForm` (`apps/web/src/components/inline-draft.tsx`) draws the composer's rows with `Row`: label, control, hairline. The To row carries the small buttons that disclose the others: **Subject** (on a reply, revealed on the row's hover), **Cc** (⌘⇧C), **Bcc** (⌘⇧B) and, with several accounts, **from Name**, which opens the From row.
- A disclosed row stays until the composer closes: `ccOpen`/`bccOpen`/`subjectOpen`/`fromOpen` only ever go true. A row also shows while it has something in it (`d.ccText !== ""`), or when the mode needs it (a new message's or a forward's subject, `showSubject`; a message from an account other than the conversation's, or a new message with several accounts, the From row): a field with something in it is never hidden, so nothing is sent from a field the user can't see.
- BoardUI's close button is `CloseButton` (`packages/ui/src/components/close-button.tsx`, plan 125), used for the filter dialog's "remove condition".

## Design

**A row the user opened gets a remove ×.** `Row` takes `remove?: { label: string; onRemove: () => void }`. With it, the row ends in BoardUI's `CloseButton` (`xs`), on the row's right edge (the same `px-3.5` line where the To row's Cc/Bcc buttons end), on the first line when chips wrap (`self-start`, centred on the 38 px line). It is light: `opacity-0` at rest, shown on the row's hover or while focus is in the row (`group-hover/row`, `group-focus-within/row`), and by its own focus (`focus-reveal:`), with the `duration-fast` opacity fade (none when motion is off, as every `transition-opacity` in the app). Named for screen readers: "Remove Cc", "Remove Bcc", "Remove the subject", "Hide From"; a tooltip says the same.

**Which rows get one** — exactly the rows that taking away would hide:

| Row | × when | Remove does |
| --- | --- | --- |
| Cc, Bcc | always while shown | clears the field and hides the row; if it held addresses, a snack "Cc removed" with Undo puts them back |
| Subject | opened by its button, not edited, not needed by the mode | hides the row (the subject is still the reply's own) |
| From | opened by its button and still sending from the conversation's account | hides the row; the To row's "from Name" says who it's from, as before |

A subject the user changed, a new message's subject, and a From row showing another account than the conversation's keep their row and get no ×: hiding them would hide what will be sent.

**Undo is exact.** The Cc/Bcc text is kept as it was (`auto` is untouched: addresses Terno filled in stay known as Terno's, and an `auto` entry with no text is inert). Undo writes the old text back through `editDraftRecipients`; if the user has put addresses in that field since, `restoreRemoved` (`lib/recipient-field.ts`) puts the old ones first and keeps theirs as they are, an address in both once. Undo does nothing once the draft is gone or has become another (a conversion, another account or source); while it is sending or held, it fails with "The draft can't change while it's being sent or saved. Try again in a moment." and stays ready, with Retry.

**Focus.** The × goes with its row, so focus can't stay on it: it returns to the text where the caret was (`controllerFor(key).focus("keep")`), as when the save-state action leaves.

**Keyboard.** The × is a Tab stop after its row's field (keyboard-reachable, as every control; the disclosure buttons are off the Tab path only because they have shortcuts).

## Tests

- Unit (`recipients.test.ts`): `restoreRemoved` with nothing since, with an overlap (once), with an entry that isn't an address (kept).
- e2e (`compose.spec.ts`, inside the existing To-row test's scenarios):
  - Cc opened, an address typed, × (hover then click): the row goes, the Cc button is back, focus is in the text; Undo in the snack brings the row and the address back.
  - Bcc opened empty, ×: row goes, no snack.
  - Reply: Subject opened by its button, × hides it; once typed into, there is no ×.
  - The × is named ("Remove Cc"), hidden (opacity 0) at rest and visible on hover.

## Perf

None on a hot path: one button per open row, no state beyond what exists.

## Out of scope

- Taking away an edited subject (it would need a "back to the original subject" the draft doesn't keep).
- Taking away the To row (always there).
- A pinned reply's From row: the pinned card doesn't know the conversation's account, so its From row is the one a new message has, and gets no × (it would hide nothing).
- A reply-all whose Cc was taken away and nothing else written is still an empty draft: closed, it goes, and reopening reply-all fills Cc again, as deleting the chips by hand already does.

## Revisions after the Codex review (plan)

1. Undo blocked by a send or a hold no longer counts as done: it throws a plain message, so the undo stays ready with Retry; `editDraftRecipients`' answer is checked.
2. Restoring into a field filled since de-duplicates (`restoreRemoved`, unit-tested) instead of joining text.
3. `z` dropped from the design: focus is back in the text after the ×, where `z` types; the snack's Undo button is the way.
4. Pinned From: recorded as out of scope (no ×, nothing to hide).
5. The From row's Select is `w-fit`: the × takes `ml-auto`, so it's on the far right in every row (checked in a screenshot).
6. Undo checks the draft is still the one it came from (mode, account, conversation, source message, and id once it has one).
7. Restoring resets that field's own chip history, as any outside change does (a conversion); accepted.
8. The reply-all lifetime: recorded as out of scope, consistent with deleting chips by hand.
9. The data part has a unit test now.

## What the Codex code review changed

1. The Undo's guards had no test: `recipient-draft-ownership.test.tsx` now removes Cc, refuses the Undo while sending (it stays ready), retries it after the first save gave the draft its id (it goes back), and refuses it once the draft sends from another account (nothing goes back). Each half fails without its guard.

## Follow-up: the × answers the pointer (the owner, 2026-11-11)

> that little button needs a hover effect, just a slight change on the background should work,make sure buttons like that also have hover effects and they are not inlined so it affects all buttons like that

`CloseButton` itself (not the call site) deepens its wash on hover: the field is the ink at 7%, hovered 12%, pressed 16%, in every palette and both modes. Every close button in the app is this component and none overrides its background, so all of them (chips, dialogs, the snack, Ask, the filter rows, settings lists, the search field) answer the same way. `button.test.tsx` holds the classes on the component.
