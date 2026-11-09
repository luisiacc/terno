# Plan 164: the composer's AI buttons

- **Status:** built on its own branch, on the AI redesign branch (`t3/ai-surfaces-redesign`, plans 162 and 163); never merged by the builder.
- **Builds on:** plan 163 (write in the draft), plan 162's pass after ai162-r04 (the note for AI, Send's question, revising by typing under the draft), plan 158 (Send asks at the action row), plan 161 (the strip, its Undo, "Replace your edits?"), main's instruction row (plan 161, pass 3).

## The request

The owner, verbatim:

1. "'write it' should not become primary button here, send action should still be the primary button, make the 'write it' a secondary button with an icon with and outline, also i don't know if 'write it' is a good word here for what it does, maybe "Generate with AI" would be better."
   (Screenshot: an instruction typed in a reply's body shows "For AI · not sent"; the foot shows a dark primary "Write it ⌘J" with Send shrunk to an icon.)
2. "here for editing and adding new custom instructions after one has already been written, i'm not sure this flow will be understood by people, i think have some kind of way to do an instruction in the AI field is better, like the main branch did"
   (Screenshot: left, main, where the change goes in an "AI" instruction row above the body with Write ↵ and Undo; right, the redesign, where "shorter, more casual" is typed under the draft in the body and the strip reads "Edited after AI" until ⌘J.)

The brief adds: Send is always the primary; the AI button is BoardUI's secondary with the AI icon and "Generate with AI" (es "Generar con IA"), replacing every "Write it"; the ⌘J hint stays, no new shortcut; a body read as a draft with placeholders gets the same button filling only those (one label or a second, said why); Send on an unwritten note asks with plan 158's pattern, no AI check; revising after a draft goes through an instruction field in the AI strip, with a submit, Undo and the quick changes (Regenerate, Shorter, Warmer) quiet and icon-only where secondary; typing under the draft is no longer the revise path; every composer (inline reply, compose, pinned).

## What exists (the redesign branch)

- **The foot** (`inline-draft.tsx`, `new-message.tsx`, `pinned-draft.tsx`): `SendOrAsk` › `SendOrWrite` (Send, or the note's pair) · Aa · Attach · Link · `AiDraftButton` (`compose-ai`) · Saved … pin · bin · Save and close. `@container/foot`.
- **The note for AI** (`noteState`, `lib/ai-draft-state.ts`): the body reads as an instruction (`readBody`, rules only), or ⌘J opened the composer for AI and the rules say `unsure`; also after a failure that wrote nothing. The body shows a 5% wash and "✦ For AI · not sent" (`AiNoteSlot`). In that state `SendOrWrite` puts **Write it ⌘J** (filled primary, `compose-ai[data-ready][data-note]`) in Send's place and Send becomes an outlined icon, `aria-disabled`, "Send is off while this is a note for AI…"; the foot's own Sparkles steps out.
- **Gaps ready** (glance `fill:n`, no strip): the foot's Sparkles is a ghost button with a word, "Fill 2 gaps" (shown from 36 rem of foot).
- **Send on a note** (`compose.ts` `send`, `isNote`): asks at the action row (`useEmptySend` with `reason: "note"`, `EmptySendQuestion`): "This reads as a note for AI." **Write it** (filled, focused) · **Send as it is** (outline). Esc, typing or Cancel put it away; a second Send (⌘↵) sends.
- **The strip** (`ai-draft.tsx` `Strip`): one line: a button group Undo · Regenerate · Shorter · Warmer (Shorter and Warmer fold into Rewrite ▾ under 30 rem), the quoted instruction (a button that opens the provenance), "Written with AI ▾" (its popover: the voice, what was asked with a pencil that rewrites from new words). A fill's strip: Undo · Fill again.
- **Revising by typing** (`revisionOf`, `act`): words added at the end of the AI's draft are the change; ⌘J sends them as a free-form refine, and they leave the body with the old version. Until ⌘J the provenance reads "Edited after AI".
- **Main's way** (`git show main:apps/web/src/components/composer/ai-draft.tsx`, `Field`): ⌘J over a strip opens the row's field ("What should change?"), Enter or **Write ↵** runs `replacing(key, { how: "refine", instruction })` (asks "Replace your edits?" over an edit), **Undo** beside it.

## The design

### 1. Send is always the primary

`SendOrWrite` goes: every composer's foot starts with `SendButton` (the split primary with Send later), in every state. Send is never `aria-disabled` for a note.

### 2. The AI button: "Generate with AI", a secondary, in the Sparkles' own place

`AiDraftButton` has three looks, one element (`compose-ai`), in the place the Sparkles has always had (after Link):

| Body | Look | Name | Tooltip |
|---|---|---|---|
| Ordinary (an email, nothing to act on) | the quiet Sparkles icon, as today | "Write with AI" / "Draft a reply with AI" | name + ⌘J |
| A note for AI (an instruction; or ⌘J opened it and the rules can't tell) | **secondary** (`variant="outline"`: 1 px border on card over `shadow-xs`) with the Sparkles and **"Generate with AI"**, a ⌘J keycap | "Generate with AI" | "Writes the email from your note" + ⌘J |
| The user's email with gaps (`fill:n`, no strip) | the same secondary, **"Fill in with AI"** | "Fill in with AI" | "Fills only the gap you marked; every other word stays" (plural: "the 2 gaps") + ⌘J |

- **Why a second label for gaps.** "Generate" promises new text in place of what's there, which is exactly what a fill doesn't do: it keeps every word and puts words only where the user left holes. Someone who wrote their own email and sees "Generate with AI" would fear losing it. "Fill in with AI" says what happens and is as short. The count lives in the tooltip and the strip, not the button, so the button's width doesn't change with the count.
- **Why in the Sparkles' place, not beside Send.** The glance changes while typing (a sentence becomes "…ask him to send the address" mid-word). Beside Send, Aa, Attach and Link would jump 170 px right and back as the reading flips; in its own place, only what follows it moves (the "Saved" status, which is screen-reader-only on a narrow foot). Send never moves.
- **Width.** The word shows from a foot wide enough for the whole row on one line, and the keycap from a wider one (container queries on `/foot`, set from measurements at 1100 and 1440 in every design and the pinned card). Below the word's threshold it is the same outlined button with the glyph alone, its name and tooltip unchanged: it still reads as lit (a bordered button among bare icons), never as the quiet one. The foot never wraps for it.
- **Keyboard:** ⌘J, as today (`aria-keyshortcuts="Meta+J"`). No new shortcut.

### 3. Send on a note asks, as plan 158 does

Send (the button, ⌘↵, Send later's picker, the palette) on a note for AI asks once, at the action row, in Send's place (`EmptySendQuestion`, `reason: "note"`): **"This reads as a note for AI, not the email."** then **Send as it is** (the primary, as plan 158's question's Send is) and **✦ Generate with AI** (secondary). Esc, typing or a click away put it away; a second ⌘↵ sends (plan 158). Focus, when the click took it from Send, goes to **Generate with AI**: Return there is the safe answer. The decision is `isNote` read at the moment of the send (rules only, no model). Nothing else changes in the guard.

### 4. Revising: the change field in the strip

After a draft lands (not a fill), the strip is one line, as main's field and the redesign's strip together:

`AI` | **[ Ask for a change… ↑ ]** | **↶ Undo** · ⟳ · ⇲ · ☺ | **Written with AI ▾**

- **The field** (`ai-change-input`): a one-line `textarea` that grows with what it holds (`field-sizing-content`), on the row's own surface as To and Subject are (no box, no ring; the row's label goes to the ink while it has the keys). Placeholder **"Ask for a change…"** (es "Pide un cambio…"). Return (or the submit) runs main's free-form refine: `replacing(key, { how: "refine", instruction })`, so over an edit it asks "Replace your edits?" first, and Undo brings the previous version back exactly. Shift+Return is a new line. Esc with text empties it; Esc on an empty field is the form's.
- **The submit** (`ai-change-submit`): icon-only (an up arrow), inside the field's end, named "Make this change" with its tooltip and ↵ keycap; `aria-disabled` and muted while the field is empty, the ink once it holds words.
- **Undo** keeps its glyph and word (recovery leads, plan 161); **Regenerate, Shorter and Warmer** become icon-only ghost buttons (glyph at 16 px, named and with tooltips "Regenerate", "Shorter", "Warmer"), quiet (muted, the ink on hover). Icons from Hugeicons: Regenerate the existing `RefreshCw`; Shorter and Warmer new catalog lines, picked by eye at 16 px.
- **Narrow** (the strip under 30 rem, the pinned card): the field keeps at least 10 rem; Shorter and Warmer fold into the existing Rewrite ▾ menu (now an icon-only "More changes" trigger); Regenerate stays.
- **What was asked** leaves the line (the field takes its place); it stays whole in the provenance popover, with its pencil, as plan 163 has it.
- **⌘J over a strip:** gives the field the keys (with words in it, it submits them); the user's own gaps typed into the draft are still filled (plan 163). It is no longer Regenerate (Regenerate is its button).
- **While it rewrites:** the row's status line, "Rewriting…" with Stop, as today; the field's words go with the run (they're the change being made) and the field is empty when the strip comes back. A failure keeps the words in the run, and Try again asks them again.
- **A fill's strip** keeps Undo · Fill again · provenance, with no field: a free-form change would rewrite the user's own words, which a fill promises not to (plan 163's reason for no Shorter or Warmer).

### 5. Typing under the draft is just editing

`revisionOf` and its path in `act` go. Words typed after the AI's draft are the user's edits, nothing more: the provenance says "Edited after AI ▾" (plan 161's plain note that the draft was changed since), Undo restores exactly (plan 161), and a change from the field or a quick change over an edit asks "Replace your edits?" first. "No change: the draft already says that." (`sameNote`) stays for a field change whose answer equals the body.

### Strings (en and es together)

Changed: `aiDraft.ready.write`, `aiDraft.note.write`, `aiDraft.whoWrite` → "Generate with AI" / "Generar con IA"; `aiDraft.ready.fill` → "Fill in with AI" / "Completar con IA"; `aiDraft.button.write` (name) → "Generate with AI"; `aiDraft.button.fill` (name) → "Fill in with AI"; `aiDraft.note.question` → "This reads as a note for AI, not the email."; `aiDraft.note.description` → "…Press {keys} to generate the email from it." New: `aiDraft.generate.tip`, `aiDraft.fillIn.tip` (plural), `aiDraft.change.placeholder`, `aiDraft.change.submit`, `aiDraft.moreChanges`. Gone: `aiDraft.note.sendOff`.

## Tests

- **Unit** (`apps/web/src/lib/ai-draft.test.ts`): ⌘J over a strip with words after the draft no longer refines from them (it asks the field to take focus); the field's refine over an edited strip asks first, untouched runs at once; Undo after a field change restores exactly; the field's text over a fill strip does nothing. `revisionOf`'s tests go with it.
- **e2e** (`apps/web/e2e/ai-draft.spec.ts`): the note test rewritten: at 1100 and 1440, Send the primary (`compose-send-group`), `compose-ai` an outlined button with "Generate with AI" left of nothing it pushes, the foot one line; a click on Send asks "This reads as a note for AI, not the email." with Send as it is and Generate with AI; Esc puts it away; Generate with AI from the question writes; then the strip's field: "make it shorter" + Return replaces the draft, Undo gives the previous version back; typing under the draft and ⌘J doesn't rewrite from it (the field gets the keys). Fill: "Fill in with AI". The strip test (one line, its commands at every width, folded when narrow, nothing clipped) moves to the field and icon buttons. `design-axe.spec.ts`: the new strip and the note state axe-clean in light and dark.
- **Baselines:** none hold the note state or the strip (checked: no `toHaveScreenshot` covers them). If one changes, it's looked at before it's updated.
- **The rating's capture** (`scripts/ui-rating/capture.mjs`) waits on `compose-ai[data-ready]`, which the labelled button keeps.

## Performance

No new work: the glance is the same one (150 ms throttle), the field is a controlled textarea in the row (no editor), no new model call (the field's refine is plan 161's free-form refine, one call as before; the read for Send is the rules). No lazy loading.

## Out of scope

The popover's pencil (rewrite from new words) stays as plan 163 left it. The body's "For AI · not sent" label and wash stay. Reply ready, the follow-up Nudge and the summary's Reply are unchanged.

## Revisions after the Codex review

`codex exec -s read-only` on this plan against the redesign branch, 12 points (`/tmp/terno-scratch/p164/composer/critique.md`). Taken:

1. **⌘J over a strip, in order:** words in the change field are made; an untouched draft's strip gives the field the keys (a fill's strip: Fill again); typed in since, gaps the user marked are filled, otherwise the field takes the keys (a fill's strip asks "Replace your edits?" and fills again). The row's question, confirmation and guard branches answer ⌘J first, as before. The field is the strip's one `data-ai-default`, and `takeFocusRequest` keeps a remount from taking the keys again.
2. **The field's words live in the session** (`change`), so they survive the form going (pinning, collapsing, another thread) and "Keep editing". While the change runs the field is empty; a Stop or a failure gives the words back (unless something new was typed there); Try again takes them again.
3. **A dedicated `change(key)`**: trims, bounds to the instruction limit, ignores blank words, runs only from the strip (never while a run, a question or a confirmation is up), never on a fill's strip.
4. **Keys in the field:** Return and ⌘Return make the change (never the form's Send); Shift+Return is a new line; ⌘⇧Return is the form's Send later; IME composition is left alone; Esc with words empties the field and stops there; Esc on an empty field is the form's.
5. **Name and ring:** the field is named "A change to the draft", described ("Return rewrites the draft with this change. Undo brings this version back."), and keeps a text field's ring (the border in the ring color and a soft 2 px ring, lighter than Input's 3 px: the strip's line is 38 px).
6. **A failed note** (the row `failed`) still shows Generate with AI: the button reads the note state first and treats only a working row or a strip as "nothing to light up".
7. **The question's way out:** a quiet × (BoardUI's close button, "Cancel") beside its two answers; Esc and typing still put it away. No click-away dismissal was added (plan 158's question has none either), and the plan no longer promises one.
8. **The narrow strip:** under 30 rem Shorter and Warmer fold into "More changes" (…); under 24 rem Undo keeps its glyph with its name and tooltip; the field shrinks before anything else. Measured at 1100 in macOS and in the pinned card, English and Spanish.
9. **The foot at narrow widths:** measured rather than promised. The whole label from a 33 rem foot, "Generate" / "Fill in" from 31 rem, the bordered glyph alone below (macOS at 1100); the ⌘J keycap from 36 rem. The note question's text truncates before its buttons do, as plan 158's did.
10. **Tests that break:** the old accessible names, `compose-note-actions`, "Fill 2 gaps with AI", visible "Regenerar", ⌘J-as-Regenerate in `ai-draft.test.ts`: all updated; Spanish now covers the field, the icon names and the note's question.
11. **Undo after a field change:** covered over an edit (Replace, then Undo gives back the draft and the edit) in unit and e2e; a fill's strip has no field.
12. **Completion:** the Codex code review and its fixes are recorded below. `pnpm test:all` and the rating are the lead's (they batch them across this round's branches).

## What the Codex review of the code changed

`codex exec -s read-only` on `git diff 023d22b61..HEAD` (the prompt of `codex-review.sh`, which isn't in this checkout's scratch), four findings, all taken, each with a regression test that fails without the fix:

1. **A change stopped after the body was typed into lost the strip and its words** (Stop fell through to removing the session). A rewrite stopped then keeps the strip as it was, marked edited, and gives the field its words back (`ai-draft.test.ts`).
2. **A failed change asked again over an edit could run twice:** Try again went through "Replace your edits?", whose Replace consumed the field's words only for a fresh change, so they stayed and ⌘J ran them again. Replace on a retried change from the field empties it too (`ai-draft.test.ts`).
3. **A change that failed as "not configured" lost its words** (that branch returned before giving them back) (`ai-draft.test.ts`).
4. **The field was hand-built** beside BoardUI's input group. It is `InputGroup` with `InputGroupTextarea` and an `InputGroupButton` addon now, at the strip's size; the deviation (28 px, the lighter ring) is written in `packages/ui/BOARDUI.md`, which also no longer calls ⌘J's instruction a header row (`ai-draft.spec.ts` checks the slots).
