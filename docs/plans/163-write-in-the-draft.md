# Plan 163: write in the draft

- **Status:** planned; on its own branch (`t3/ai-draft-instruction-flow`), off the redesign branch (plan 162), never merged by the builder.
- **Builds on:** plan 133 (⌘J), 131 (tasks), 144 (Reply ready), 146/147/150 (the gate), 161 and 162 (the rating, the strip as it is).

## The request

The owner, 2026-11-08, verbatim:

> "the 'edit instruction' is way to big, should be a pencil, also its not so clear for me that's the instruction that triggers creating a draft with it, this flow doesn't look right for me, not intuitive, i think we need something more intuitive like writing the instruction right in the draft box, then have a subtle button that treats whatever was written as an instruction, it must be smart and detect if its an order or maybe it's a text and there is a placeholder the user wants to put the ai info there, in that case we would not replace the entire thing, just the placeholder, so that agent that does that must be smart and fast."

The brief adds: one flow in every composer; a subtle AI button that is quiet at rest and clearer when the body holds something it can act on; ⌘J stays (no new shortcut); local rules first, the fast model only when it's genuinely unclear, the drafting model to write; everything ⌘J does today keeps working; no new chrome on a composer where AI isn't being used; the one gate decides; spam triggers nothing.

## What exists

- **The row** (`components/composer/ai-draft.tsx`, state in `lib/ai-draft.ts`). ⌘J opens an `AI` row in the form, under Subject: a textarea for the instruction with a Write ↵ button. Enter resolves who it's for (§5 of plan 133, `ai.resolveIntent`), streams into a preview in the body's place, and commits one undo step. Then the row is the **strip**: the instruction on its own line with a pencil (the owner's first fix, `ebb645e2`), the command group Undo · Regenerate · Shorter · Warmer (folded into Rewrite ▾ when narrow), and "Written with AI ▾" (the voice popover).
- **Text already in the body** is "notes": the row's instruction plus the body as `draft`, ending in Replace · Insert below · Discard.
- **The Sparkles button** (`composer/ai-slot.tsx`, `compose-ai` in each composer's foot, `quick-ai` on the reply bar) opens the row.
- **What runs where** (plan 161's real-models table): `writing` (Sonnet 5.5 on Pro) writes; `intent` (Haiku 5.5 on Pro, `INTENT_CLAUDE_MODEL`) answers the one small question with no mail in it.
- **Gaps** (`composer/gaps.ts`): a model's `[placeholders]` are marked in the text (`AI_GAP`), and Send asks before one goes.
- **Programmatic ways in:** the follow-up Nudge (`setInstruction` + `submit`, an instruction the user never typed) and a summary item's Reply (`openRow({ instruction })`, the row holding the item's words).

What's wrong with it, in the owner's words: the instruction lives in a second box above the draft, so it isn't clear that it's what makes the draft; and a draft with a gap in it can't be finished without rewriting the whole thing.

## The design

### One gesture

**You write in the body. ⌘J, or the Sparkles in the composer's foot, acts on what you wrote.** There is no instruction field any more.

| What the body holds | What ⌘J does | Where the result goes |
|---|---|---|
| Nothing | the one-tap draft: answers what the conversation needs (plan 133's Enter-with-nothing) | over the empty body, one undo step |
| **An instruction**: words *about* the email ("friday works for me, ask him to send the address of the flat") | writes the draft from it, with the conversation and your voice, routing as §5 of plan 133 does ("tell tom…") | **replaces the instruction**, one undo step; Undo puts your words back exactly |
| **Your email with gaps**: words *of* the email with placeholders ("Hi Arjun, the flat's address is [address from his last mail], see you [day we agreed]") | fills **only the gaps** | each gap replaced in place, one undo step for all; every fill tinted until you've read it |
| **Your email, nothing marked** | expands it into a full draft that keeps your words (plan 133's notes) | a suggestion **under** your text: Replace · Insert below · Discard. Never replaces without a choice |

Over a strip (AI already wrote): ⌘J with the text untouched is Regenerate. Edited since, ⌘J reads the body again: gaps you marked get filled (the model's own `[gaps]` are left for you: they're facts only you know); anything else is Regenerate, with "Replace your edits?" first.

### Detection: local first

`readBody(text)` in `packages/core/src/writing/body.ts`: pure, bounded, no model. It returns `{ kind: "empty" | "instruction" | "email" | "unsure", gaps: Gap[], maybe: Gap[] }`, where a `Gap` is `{ from, to, text }` in the text's characters.

**What counts as a gap** (the documented rule). The body is read from the editor's own text blocks (`composer/body-text.ts`), not from the serialized email: a list's `- `, a quote's `>` and a link's address are never part of what's read, a gap never spans an image, a line break or two paragraphs, and nothing inside a quote is a gap.

- **Certain**, filled without asking anyone:
  - square brackets holding words or nothing: `[address]`, `[day we agreed]`, `[ ]`, `[…]`, `[...]`, `[NAME]`. Not a link's text (`[text](url)`), not digits alone (`[1]`, a footnote), not `[sic]`, not a task box (`- [ ]`, `- [x]` at a line's start);
  - double curly braces: `{{first name}}`;
  - double angle brackets: `<<address>>`;
  - runs of capital X that can't be a numeral, with what joins them: `XXX`, `XX/XX/XXXX`, `$XX`, `XX:XX` (one gap per run; `XXL` and `XXX-rated` aren't);
  - three or more underscores: `___`.
- **Maybe** (only the fast model can say; without it they stay as typed): a single pair of braces (`{address}` reads as a gap, `{user_id}` may be code), a bare `XX` (a gap, or the numeral twenty), an ellipsis standing alone between spaces or after a colon (`see you … at`, `address: ...`), `??`, `TBD`, `TBC`, a lowercase `xx` that isn't the last line's kisses.
- At most 20 gaps a press, each fill at most 300 characters; past that, the rest stay as typed.

**Instruction or email**, in order, first rule that applies:

1. Empty (or only whitespace): `empty`.
2. Holds an image, is over 1,000 characters (the instruction limit, `WRITING_ONE_OFF_MAX`), or has 3 or more paragraphs: `email`. Over 100,000 characters it isn't read at all: the row says the draft is too long for AI (`errors.ai.draftTooLarge`).
3. Opens with a greeting (`Hi`, `Hello`, `Hey`, `Dear`, `Good morning`, `Hola`, `Buenas`, `Buenos días`, `Buen día`, `Estimado/a`, `Querido/a`, `Qué tal`…, followed by a name or a comma on the first line) or ends with a sign-off line (`Thanks`, `Best`, `Cheers`, `Regards`, `Saludos`, `Un abrazo`, `Atentamente`, `Gracias`…, alone or followed by a name): `email`.
4. **Speaks to the assistant about a third person**, and never to the reader: `ask`, `tell`, `remind`, `thank`, `let … know` with `him`, `her`, `them` or a capitalised name (`tell Tom`); `say`, `reply`, `answer`, `respond` followed by `that`, `yes` or `no`; Spanish imperatives whose clitic points at someone else (`dile`, `pregúntale`, `pídele`, `avísale`, `contéstale`, `respóndele`, `agradécele`, `recuérdale`, `escríbele`) or `di que`, `responde que`, `contesta que`. And none of the reader's words (`you`, `your`, `can you`, `could you`, `tú`, `te`, `usted`, `puedes`, `podrías`, `me pasas`): `instruction`. A bare imperative (`Confirm the appointment at [time]`, `decline politely`) isn't enough: it could be said to the reader.
5. Has a certain gap: `email` (it's your text with a hole in it).
6. Otherwise: `unsure`. Brevity decides nothing: "Friday works for me. Can you send the address?" is an email, and "sounds good, see you friday" could be either.

Then:

- `instruction`: write from it. Gaps inside it are part of what to say ("tell him the address is [from his last mail]"), not holes to fill.
- `email` with certain gaps: fill them (maybe-gaps beside them are taken as punctuation: they've shown how they mark one). With only maybe-gaps: ask the fast model which are gaps. With none: expand (the suggestion).
- `unsure`: ask the fast model, with the maybe-gaps, once. It may say instruction (write from it) or email (fill what it called gaps, else expand beside it).

**Mixed text** (a greeting, a gap, and "also ask him about parking" in the middle) is `email`: the gaps are filled, and every word you typed stays, the instruction-like sentence included. That's the safe reading: a word of yours is never rewritten unless the whole text is an instruction, and then Undo gives every word back. The check line under the text says what was left: nothing silently.

**Cost of a wrong reading.** An instruction read as an email ends in a suggestion beside it, which you can Replace with. An email is replaced only when a certain rule or the fast model called it an instruction, and Undo restores it exactly. Where in doubt, nothing of yours is replaced.

### The fast model's question

`AiTasks.readDraft` (`packages/ai/src/draft-read.ts`), on the `intent` target (Haiku 5.5 on Pro; on other providers, the drafting model, as intent already does). Structured output, effort low, 600 max tokens, a 10 s deadline. It gets **only the text you typed**, with each maybe-gap marked `⟦m1⟧…⟦/m1⟧`, and no other context: no conversation, no recipients, no voice (what you typed may of course name people). It returns `{ kind: "instruction" | "email", gaps: string[] }` (ids of maybe-gaps that are really gaps; unknown ids are an invalid answer). A failure or a timeout is never a block: `unsure` becomes `email`, maybe-gaps stay as typed, and the strip's check line says it couldn't tell.

It's asked only after consent (plan 133's first-use line, whose details now say that reading what you typed sends only those words), since it sends your words to the provider. The first-use line is bound to where the words go (provider, preset and endpoint), and a profile whose storage fails asks every time until it's answered in this session. It isn't asked for an empty body, an obvious instruction, or an email whose gaps are all certain: the common cases cost nothing and add no wait.

### Filling

`ai.compose` gains `fill: { text, gaps: { from, to }[] }`: the text as the editor's blocks read (not the serialized email) and the gaps in it. The backend assembles everything as for a draft (voice, the thread, messages to this person, the snapshot, the cache) and runs `runFill` with its own frozen rules, `FILL_RULES` (`packages/ai/src/writing.ts`, versioned, `FILL_PROMPT_VERSION`):

- The draft goes in the task as `<draft>` with each gap as `<gap n="1">address from his last mail</gap>`: the placeholder's words say what goes there.
- The answer is one `<fill n="1">…</fill>` per gap, in order, nothing else. The fill is exactly the words that replace the gap, fitting the sentence (its case, no added punctuation). A fact that isn't in the material is an empty `<fill n="2"></fill>`: never invented. Tone comes from the voice and the words around it.
- Material is data, as in `WRITING_RULES`; `gap` and `fill` join the neutralized tags, so a draft can't fake one.
- It streams: a `fillFilter` (like `emailFilter`, but nothing outside a `<fill>` ever reaches the composer) emits per gap. Fill events are their own (`aiFill { requestId, gap, text, done }`: the fill so far, whole, and whether its `</fill>` came), so a finished empty fill is told from one still coming. The result is `{ status: "done", fills: (string | null)[] … }`, one per gap: `null` for a fill that never finished, came twice, was over 300 characters or held a blank line, and `""` for "not in the material"; `checks.specifics` runs over the fills only.
- **Language:** the task names none: a fill matches the sentence around it (the rules say so), so a Spanish sentence in an English conversation gets Spanish, and a mixed draft each its own. The budget counts `FILL_RULES` and the marked draft, not `WRITING_RULES`.

**In the composer** (`composer/fills.ts`, a ProseMirror plugin beside `gaps.ts`): the gaps are document ranges, found on the editor's blocks, held in the plugin's state and mapped through every change while it writes, so you can keep typing elsewhere. A gap any change touches is spoiled for good, even if the same text is typed back. Each gap shows its fill as it streams, as a widget in the AI tint right where the placeholder is, the placeholder hidden (decorations: nothing touches the document, its history or autosave). At the end, one transaction replaces every unspoiled gap with its finished fill, keeping the marks the placeholder had (one undo step, history closed on both sides as `insertGenerated` does, its `before` the document just before it), and each filled range keeps a tint and an underline (`AI_FILL`) until you edit inside it or the strip goes. A gap the model left empty stays as typed, marked as a gap, and Send asks about it (plan 161's guard).

The ranges live in the editor's state, which survives pinning and collapsing (the state is kept and given back). If the editor is rebuilt without it (its cache is bounded at eight), or To, Cc, From, the subject or the source moved meanwhile, nothing is applied on its own: the row says the draft changed while it filled, with Fill again.

**Fill again** asks again from the text as it was before the first fill (the stack's `before`, with the gap positions it had), and puts that document back with the new fills in one step, as Regenerate replaces the whole text: typed in since, it asks "Replace your edits?" first, and Undo brings the edits back exactly.

### States

1. **At rest.** Nothing new. The Sparkles in the foot is the one it was, quiet (muted, `compose-ai`).
2. **Something it can act on.** When the body reads as an instruction or holds a certain gap (local rules only, at most every 150 ms while typing, over at most the first 20,000 characters; idle when nothing changes), the Sparkles turns full ink, and its name and tooltip say what it will do: "Write from your note", "Fill 2 gaps", "Draft a reply". An ordinary email being typed leaves it quiet: someone who never uses AI never sees it change.
3. **Opened for AI.** ⌘J from a conversation or the list, the reply bar's Sparkles, the palette: the composer opens (as today) with the caret in the body and the body's placeholder saying "Write the reply, or what it should say, then press ⌘J" (`aiDraft.bodyPlaceholder.*`). No row yet.
4. **Reading.** Only when the fast model is asked: the `AI` row appears with the spinner and "Reading what you wrote…", and Stop.
5. **Writing.** The row: spinner, "Writing…" (or "Filling 2 gaps…", "Rewriting…"), Stop. The instruction stays visible, dimmed, until the first words arrive; then the stream takes its place in the body's type (the old overlay), so the first change is where you were looking. Filling: each gap streams in place.
6. **Written.** The strip, as plan 162 left it, minus the instruction line: Undo · Regenerate · Shorter · Warmer · "Written with AI ▾". For fills: Undo · Fill again · "Written with AI ▾", with no Shorter or Warmer, which would rewrite your words. The check line under the text says what it couldn't fill.
7. **The popover** ("Written with AI ▾") holds what was asked: "From your words: “friday works for me, ask him…”" and an **icon-only pencil** (named "Edit what you asked", with its tooltip). The pencil turns that line into a small field in the popover; Return writes the draft again from the new words (plan 162's rewrite, with its "Replace your edits?"), Esc leaves it. For fills it lists each: "[address from his last mail] → Calle Durango 123". There's no labelled Edit button anywhere.

The questions (who it's for, Forward or New), the first-use consent, the errors, the send guards and "Replace your edits?" stay in the row exactly as they are.

### Undo, exactly

- **Written from an instruction:** Undo takes the draft back and the instruction is in the body again, as typed (the write's `before`), the caret at its end, the row gone, the Sparkles lit: change a word and ⌘J again. ⌘Z takes back the body alone, as today (plan 133 §10.3): a subject the write filled stays until the strip's Undo. Where the editor's history is gone (its cache), the strip's Undo restores the `before` document itself, images and all, rather than its text.
- **Filled:** Undo puts every placeholder back as it was, in one step. Edited since: plan 161's exact restore, with the snack's Undo bringing the edits back.
- **A version on top** (Shorter, Warmer, Regenerate, Fill again, a rewrite): Undo goes back one version, as today.
- **The summary's Reply** puts the item's words in the body as an instruction (state 3 with words): nothing runs until ⌘J. The Nudge still writes from its own instruction, which the user never typed: Undo leaves the body empty.

### Nothing goes while it's working

The instruction is in the body now, so a Send while the AI is reading, resolving, asking a question, asking consent, writing or holding a suggestion would mail the instruction itself. The send guard (`blocksSend`, every path: ⌘↵, Send, Send Later, the palette) stops at every one of those phases, with "Stop and send what's there" as the deliberate way to send the literal body.

### What it acts on is what was there when you pressed

The press takes a snapshot (the document, recipients, account, subject) before anything waits. If the text changes while it reads or works out who it's for, it starts over on what's there now; recipients changed mid-way are asked about again (plan 133). A run's own `binding` is that snapshot, compared by document, so a change of formatting counts too.

### Where it goes, with the instruction in the body

Typing makes a draft "authored", which plan 133's routing read as "the user chose these recipients". With the instruction in the body that's no longer true, so the surface is decided from the recipients alone: a reply whose To and Cc are still the ones Terno filled in is the conversation (§5.2's thread rows: "tell Tom" narrows to Tom, or asks Forward or New), and a new message with no recipients is the list. When the answer lands in another draft (Forward, New message, Reply on a recent thread), the instruction goes with it into that draft's body, so its Undo gives it back there, and the draft it was typed in is dropped if it held nothing else.

### Stop and Esc

- Before any words: it stops, and the body is as you left it (the instruction never left it).
- Partway through a write: what came replaces the instruction as "Stopped part-way" (plan 161 pass 3); Undo brings the instruction back.
- Partway through a fill: gaps whose `</fill>` had come are filled; the rest stay as typed.
- A refusal, a timeout or a lost connection while filling: nothing is applied, and the row says what happened, with Try again. A stop or a cancel never falls back to writing anything.
- Esc on the strip is the form's, as today.

### The narrow window and the pinned card

The strip loses its instruction line, so it's one 38 px line at every width. The fill strip has two commands and fits the pinned card. The popover's field wraps. Looked at in 1440 and 1100, light and dark, every design.

### Light and dark

The fill tint is the gap's gold wash family: a fill reads as "AI put this here", a gap as "this is missing". `AI_FILL` is a pair in `CONTRAST_PAIRS` on the composer's surfaces in every palette, checked by the contrast suite. The ready Sparkles is the ink the other foot icons have on hover.

### What goes away

- The instruction field, its Write ↵ button, the `ai-row-input` test id, ↑ to recall the last instruction, and ⌘J-to-close-an-empty-row.
- The instruction line over the strip and its pencil (the pencil moves into the popover).
- Free-form refining from the field ("make it more formal" over a strip): the popover's pencil writes again from changed words instead; Shorter and Warmer stay.

## Model use, in one table

| Step | Where | Model on Pro | Sends |
|---|---|---|---|
| read the body | local | none | nothing |
| unsure, or maybe-gaps | `readDraft`, `intent` target | Haiku 5.5 | what you typed, and nothing else |
| who it's for (§5) | `parseIntent`, as today | Haiku 5.5 | the instruction and matched names |
| write | `compose`, `writing` | Sonnet 5.5 | as plan 133 |
| fill | `compose` with `fill`, `writing` | Sonnet 5.5 | as plan 133, the draft with its gaps marked |

## Tests

- **Unit** (`packages/core/src/writing/body.test.ts`): each rule and the gap grammar, in English and Spanish: empty; the owner's two examples; a short note; `dile que sí, el viernes`; a greeting with a gap; a sign-off with a gap; mixed (greeting, gap and an instruction sentence); a link `[text](url)`, a footnote `[1]`, a task box; `XXL`; code in braces; maybe-gaps; 1,001 characters; an image; three paragraphs; bounded time on 100,000 characters.
- **Unit** (`packages/ai`): `fillFilter` across split tags and chunk edges; an empty fill; neutralized `gap`/`fill` in a draft; `readDraft`'s validation (unknown ids); the fake's answers.
- **Unit** (`apps/web`): `fills.ts` maps ranges through typing elsewhere, skips a gap typed into, commits in one step, undoes exactly; `lib/ai-draft.test.ts` for each path's state machine (instruction, fill, expand, ⌘J over a strip), stop with and without words, consent before the fast model.
- **Backend:** `ai.compose` with `fill` streams per gap and returns fills, malformed ones refused (duplicate, unterminated, oversized); `ai.readDraft` sends only the text (canary: a thread's words and a recipient's address never in its request).
- **e2e** (`ai-draft.spec.ts`, on the fake): the flow from a conversation and from the list, Undo back to the instruction, Esc before and after words, consent before the read, the fill touching only the gaps (the rest of the body byte-identical), Fill again, the popover's pencil, the ready Sparkles quiet on an ordinary email. `design-axe.spec.ts`: the new states. `summaries.spec.ts`: Reply puts the item in the body. The existing scenarios move to the body.
- **Real models** (`TERNO_RATING_REAL=1`, `scripts/ai-real/`, as `ai-rating.smoke.ts`): detection on the unsure cases, a fill on the demo's flat thread, time to first visible change for each path.

## Performance

- `readBody` is linear and bounded (20,000 characters for the button, 100,000 at a press). The button's glance reads the editor's blocks only up to its limit, never serializing HTML or the whole document, at most every 150 ms while the text changes and never when it doesn't. A perf gate types into a 10 MB draft and holds the glance's cost per keystroke.
- The fill plugin does nothing without a fill session (no decorations, no mapping).
- No new chunk, no lazy loading: plain imports.
- `pnpm test:ui-perf` holds.

## Out of scope

Rewrite on a selection (plan 133's "right after"). Filling gaps in mail the AI didn't help with on Send (no automatic AI). Per-gap Regenerate. Learning which brackets someone uses for themselves.

## Revisions after the Codex review

`codex exec -s read-only` on this plan against the redesign branch, 12 points, all taken (the sections above are written as revised):

1. **Brevity isn't an instruction.** "Friday works for me. Can you send the address?" is a short email, and the plan's 15-word rule would have replaced it. The rule is gone; instructions need a directive about a third person and none of the reader's words, and a bare imperative ("Confirm the appointment at [time]") isn't one. What the rules can't place goes to the fast model, or ends beside your text.
2. **Consent bound to where the words go.** The first-use line was keyed by provider name alone, and a storage failure skipped it. It's now keyed by provider, preset and endpoint, kept in memory when storage fails, asked before the fast read, the routing and the write on every way in (the Nudge included), and its details say what reading what you typed sends. "No mail, no names" became "nothing but what you typed", which can name people.
3. **Routing with the instruction in the body.** Typing made every reply "authored", which would have turned "tell Tom" on a conversation into "Add Tom?". The surface comes from whether the recipients are still Terno's, and the instruction moves with the answer into the draft it lands in.
4. **A snapshot before any wait.** The text can change while the fast model or the routing answers; it starts over on what's there. Runs from the body have their own kind, compared by document.
5. **Editor positions, not serialized text.** A list's markers, quotes and links shift a serialized text's offsets. Gaps are found on the editor's blocks, never across an image, a break or a block, never in a quote.
6. **The send guard covers every phase that would send the instruction:** reading, resolving, a question, consent, writing and a suggestion.
7. **Fill ownership.** The ranges live in the editor's state (kept across pinning and collapsing); a rebuilt editor or moved recipients apply nothing on their own; a spoiled gap stays spoiled.
8. **Fill events say when a fill is done**, and malformed fills are refused, never written; nothing outside a `<fill>` reaches the document; stop, refusal, timeout and a lost connection are each said.
9. **⌘Z takes back the body alone**, as plan 133 says; the strip's Undo restores the `before` document itself when the editor's history is gone, so images survive.
10. **Gap grammar tightened:** `[sic]`, single braces and a bare `XX` are maybes, not certain. A model's own gaps are told from the user's by their text (a user typing the model's exact words, `[Your answer.]`, would have theirs left too: the safe side). Fill again works from the first fill's `before` and its gap positions.
11. **Bounded where it costs:** the glance reads the editor's blocks up to its limit without serializing; past 100,000 characters nothing is read; at most 20 gaps and 300 characters a fill; a 10 MB typing gate.
12. **A fill's language is its sentence's,** not the conversation's; the budget counts the fill's own rules.

## What building it changed

- **The ready Sparkles says what it will do.** A darker glyph alone didn't read as a change in Lumen, where the foot's icons are all close to the ink. Ready, it's a quiet ghost button with a word beside the glyph ("Write it", "Fill 2 gaps"; `aiDraft.ready.*`), the reply bar's style; its name and tooltip say the rest ("Write it from your note with AI ⌘J"). At rest, and while AI works or a strip is up, it's the icon it was.
- **The state machine kept its phases.** `input` now means "opened for AI and nothing more" (`primed`: no row, the body's hint) or "the row asks who it's for"; `reading` is new. The Nudge still writes from an instruction nobody typed (`setInstruction` + `submit`); everything typed goes through `act`. A primed session leaves Esc to the form, so an empty reply ⌘J opened closes on the first Esc (the collapse reads the badge fresh, and `primed` is a badge of its own).
- **A reply narrowed to the person named keeps the body.** `addressReply` refused any written-in reply, and the instruction typed in the body made every one written-in: "tell Tom" never narrowed. With `keepBody` it addresses a reply whose recipients are still Terno's, and leaves the body alone.
- **A draft that held only the instruction leaves the store** when the answer lands in another draft (Forward, New message, Reply on a recent thread): it was saved as it was typed, and `forgetDraft` alone left it in the list.
- **Words go into the editor that's there, at once** (`seedBody` through the controller): a run bound right after read the editor's document from before the words arrived and ended as a suggestion. A run bound before its editor existed compares the words, not a document.
- **A new session asks for no focus.** The old field took the keys when the row appeared; the who-row's Write button did the same and pulled them out of To. Questions and consent still ask (`focus + 1`). An explicit open (a click on a summary item's Reply, the palette, the reply bar) gives the body the keys; the pinned card is focused for ⌘J as for r / a / f.
- **The instruction under the stream goes transparent, not hidden:** `visibility: hidden` could take the keys away, and typing there is how a person says "keep mine" (the draft then ends beside it, with Replace).
- **The guard says what's happening:** "AI is still working on what you wrote." for reading, routing, a question and consent, with Stop and send what's here.
- **The fill tint** is the primary at 12% under the ink with a solid underline; it holds AA on a composer's card, tint and background in every palette (`CONTRAST_PAIRS`, three pairs).

### The capture and the gallery

`a02` and `a03` shoot the new flow (`docs/ui-rating.md` says exactly what changed); no `a03b`, since adding a shot changes the set every round is gated on. The gallery, on the stub, every design, light and dark, 1440x900 and 1100x700: the opened body with its hint, the instruction typed, writing, written, the popover with the pencil and its field, the pinned card, gaps typed, filled with one left, and the fills' popover (`/tmp/terno-scratch/plan163/gallery/`).
