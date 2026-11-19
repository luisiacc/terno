# 219: Saving a rule starts a new one; "Created for you" folds away

## Request (verbatim)

> some changes here needed on the 'rules' settings page.
>
> when I save a rule and click any of the 2 save buttons, it should create it and redirect or juts show the form to create a new rule, not stay on the same rule, its confusing that nothing happens when i click the save button.
>
> also the 'created for you' list that's on the left can be very big, we can have it collapsed by default and can be expanded, and it can say nicely how many are created

(With a screenshot of the Rules dialog: an AI rule open, "Archive wbx subjects" first in the list, eight rules under "Created for you".)

## What exists

- `FiltersDialog` (`apps/web/src/components/filters-dialog.tsx`): the list on the left (unsaved AI rules, the user's rules, then Terno's under "Created for you", then suggestions) and the builder on the right. Its two buttons, **Save and apply to N conversations** and **Save for new mail**, call `save(applyExisting)`.
- `save` writes the rule, then loads the saved rule back into the builder (`load(draftOf(f))`) and says "Rule saved" in a snack. The snack dock sits under the dialog (as `filters-tab.tsx` and `snippets.ts` already note), so the user sees nothing change: the same rule, the same form. That's the confusion.
- "Created for you" is a plain heading above every automatic rule; with dozens of them the list is mostly Terno's.

## Design

### 1. A save starts a new rule, and says what it saved

- After either save succeeds, the builder starts a new, empty rule, exactly as **New** does (the AI request box empty and open, no explanation, no unsaved AI row for the saved rule). Same guard as today: if another rule was loaded while the save was out, the builder keeps that one.
- The footer says it, on the left where Delete sits for a saved rule: a check and "Saved “Archive wbx subjects”." or, for Save and apply, "Saved “…”, and started applying it to existing mail." (the job's end stays in its snack, which outlives the dialog). It's a `role="status"` line, so a screen reader hears it. It stays until the new rule is touched or another is opened: it's tied to the draft object it was said over, so any edit (a new draft) quiets it with no timer and no clearing code.
- The "Rule saved" snack goes (nobody saw it, and it would show late when the dialog closes). Applying keeps its progress snack (plan 89).
- Focus still goes to the saved rule's row in the list (plan 162, after ai162-r02), now scrolled into view: Enter opens it again, and the row is where it went.
- The preview's `note` (plan 161, a rule prefilled from an action) belongs to that rule only: loading any other rule (New, a row, after a save) drops it. Before, New kept it under an empty rule.

### 2. "Created for you" folds, and counts

- Terno's rules sit in a `Collapsible` (`@terno/ui`, plan 125's disclosure, already used for attachments) whose trigger reads "8 rules created for you" with the chevron; closed by default.
- Open from the start when the rule the dialog opens on is one of Terno's (Settings → Rules → Edit on an automatic rule), so the open rule's row is in sight.
- A closed panel isn't rendered (Collapsible's default): no rows to draw until it's opened.
- Esc from a text field goes to the open rule's row; when that row is folded away it falls back to New, as it already does for a rule not in the list.

Settings → Rules (`filters-tab.tsx`) was left as is at first; the owner then asked for it too (below).

## Tests

- e2e `filters.spec.ts` (the AI scenario): after Save and apply, the builder is a new rule (name empty, AI prompt shown), the footer says "Saved “…”, and started applying it to existing mail.", focus is on the saved rule's row; typing in the new rule quiets the line.
- e2e `filters.spec.ts`, new scenario: with automatic rules, the group is closed and reads "2 rules created for you"; its rows aren't there until it's opened; opening shows them. Opening the dialog on an automatic rule from Settings starts it open (`settings.spec.ts`, which already does that).
- `settings.spec.ts`: the save-then-edit-again path reopens the rule from the list, as a user now would.

## Perf

Fewer rows drawn when closed; one string per save. No hot path.

## Out of scope

- Updating the footer line when the apply job ends (its snack says it).

## Revisions after the Codex review (plan)

Twelve points. Taken:

- **Typing the next request didn't quiet the line** (it changes the prompt, not the draft): the line shows only while the request box is empty too. Unit test.
- **Scroll and focus after a save ran even when another rule was opened meanwhile**: both now sit behind the same guard as the reset.
- **Opened from Settings on one of Terno's far down the list**: the open rule's row is scrolled into view once, when the list first arrives.
- **A prefilled rule's note survived a rule AI wrote in its place**: generating drops it too. Unit test.
- **"Applying it…" would stay after the job ended**: the line says what happened ("…and started applying it to existing mail."), not what's going on.
- Existing e2e that leaned on the old behaviour (the saved rule left open, the "Rule saved" snack) now find the saved row by id and read the footer.

Not taken: three races between clicking Save and its answer (editing, reopening the same AI rule, closing the dialog meanwhile). A local save answers in milliseconds, and each was already possible before; the guard that keeps a rule opened meanwhile stays. "Focus stays on Save" doesn't happen: both buttons are disabled while saving, so focus falls to `<body>` and goes to the row (the e2e asserts it). Keyboard and hidden-row reachability of the disclosure are Base UI's (a closed panel isn't rendered).

## What the Codex code review changed

Nothing: it found no defects in 077380ba6.

## Tests run

- Unit: `filters-dialog.test.tsx` (13, two new), the i18n catalog tests, `source-scan.test.ts`.
- e2e (`--project=e2e`): `filters.spec.ts` "AI filters and learned filters", `settings.spec.ts` "Created for you…", `category-forwarding.spec.ts` "from a filter", `folder-drop.spec.ts`: all pass.
- Screenshots and axe of the dialog (saved line, group open) in light and dark: clean.
- Typecheck of `@terno/web` fails only in `full-message.tsx`, another series' uncommitted work.

## Follow-up: Settings → Rules folds too (owner, 2026-11-19)

> yes lets collapse it there as well and say how many there are

- `SettingsGroup` (`settings/parts.tsx`) takes `fold`: the group's root becomes a `Collapsible` (still a `<section>`), its card the panel, and the caller's title holds the `CollapsibleTrigger`. The footer stays visible, so a folded group still says what it holds.
- Terno's group reads "2 rules created for you ⌄", the chevron beside the words (Turn all off keeps the line's end); closed by default.
- Its open state is kept for the session (a module object in `filters-tab.tsx`): Edit opens the builder and the tab mounts again on the way back, so it comes back as it was left.
- "Created for you" (`filters.group.auto`) is no longer used anywhere and leaves both catalogs.
- `settings.spec.ts`: folded with its count and the footer, no rows; opened, two; back from the builder, still open, the count now one.
- Codex code review of the follow-up, one finding: the panel clips (it moves), and the card inside it drew its ring and Relief's depth outside its box, so they were cut. Folding, the panel is now the card itself (an element's own shadow isn't clipped by its overflow). `settings.spec.ts` checks the open panel carries the card's shadow; seen in Relief, light and dark.
