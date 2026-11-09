# Plan 163: write in the draft

- **Status:** built on its own branch (`t3/ai-draft-instruction-flow`), rebased on the redesign branch (plan 162), code-reviewed, run on real models; never merged by the builder. **Consent on first use is superseded** (the owner, 2026-11-08, below): wherever this plan says the fast read or a run asks first, it doesn't.
- **Builds on:** plan 133 (⌘J), 131 (tasks), 144 (Reply ready), 146/147/150 (the gate), 161 and 162 (the rating, the strip as it is).
- **Changed by plan 164** (the owner, 2026-11-09): Send is always the primary; the foot's AI button is a secondary, **Generate with AI** (a body with gaps: **Fill in with AI**), never "Write it"; Send on a note asks with Send as it is (the primary) and Generate with AI; and a change to a written draft goes in the strip's own field ("Ask for a change…"), as main had it, not under the draft in the body (plan 162's revise-by-typing is gone). ⌘J over a strip gives that field the keys instead of regenerating. See `164-composer-ai-buttons.md`; the sections below are as plan 163 built them.

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

- `readBody` is linear and bounded (20,000 characters for the button, 100,000 at a press). The button's glance reads the editor's blocks only up to its limit, never serializing HTML or the whole document, at most every 150 ms while the text changes and never when it doesn't. A unit gate (`fills.test.ts`) holds the glance on a 10 MB document under 2 ms: it reads its first 20,000 characters and stops. The page's typing gates (`pnpm test:ui-perf`) run without AI, so they hold the composer as before, not the glance.
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
11. **Bounded where it costs:** the glance reads the editor's blocks up to its limit without serializing; past 100,000 characters nothing is read; at most 20 gaps and 300 characters a fill; a 10 MB gate on the glance.
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

`a02` and `a03` shoot the new flow (`docs/ui-rating.md` says exactly what changed); no `a03b`, since adding a shot changes the set every round is gated on. The gallery, on real models (see below), every design, light and dark, 1440x900 and 1100x700: the opened body with its hint, the instruction typed, writing, written, the popover with the pencil and its field, the pinned card, gaps typed, filled with one left, and the fills' popover (`/tmp/terno-scratch/plan163/gallery-real/`).

## The owner's decisions while it was built (2026-11-08)

- **Real models for every look.** "please use real models instead of fake ollama ones to get actual valid info on the designs." The gallery and every visual or quality check ran on Pro's real routing (`launch({ ai: true })`); the stub is for the automated tests only. The error state shot comes from a real condition: a gap the conversation can't answer, so the model leaves it and nothing changes.
- **No first-use confirmation.** "lets not have this confirmation at all, they should be informed of this when signin for the ai plan instead, remove all first-time confirmations of this kind." This supersedes the consent parts above and Codex points 2 (plan) and 1–2 (code): the flow asks nothing before the fast read or a run, and what was added for it here was taken out again (the destination-bound key, consent before the fast read, a run waiting on Continue, the extra sentence in the consent's details). The redesign branch's own first-use line is left as it is; it goes when the branches are rebased on main, where Settings → AI discloses it instead. Send still waits while what was typed is being worked on (the guard), whatever the phase.
- **Rebased** on the head of `t3/ai-surfaces-redesign` (itself rebased on main). The ⌘J files hadn't moved since the pencil (`c4ea54cdb`). One conflict: a summary item's Reply is now the ordinary reply there (no instruction), so its side was kept; `openRow({ instruction })` still puts words in an empty body for any caller.

## What the Codex review of the code changed

`codex exec -s read-only` on `git diff` from the redesign branch's pencil, 12 points, all taken, each with a regression test (unit unless said):

1. A fill over a strip skipped consent for a new provider. *Superseded by the owner's decision*: the test went with the consent.
2. Send while consent was asked could mail the instruction. *Superseded as consent*; the guard itself holds for every phase that works on what was typed.
3. An answer landing in a reply with words of its own replaced them. `seedBody` says whether it put the words in; a draft with its own words gets the draft beside them (notes, with Replace). Such a reply also keeps its recipients, and the draft that held the instruction is discarded only once the answer has really landed: where it can't (a reply whose place in its thread expired), nothing typed is lost (e2e).
4. A fill that waited for a message's text restarted at its gaps' old places. It reads the body again.
5. Stop after the instruction was typed over put what came over the new words. It goes below them.
6. Fill again with typing meanwhile put the whole text back. Nothing changes, and the row says the draft changed.
7. An answer to a question after the body was rewritten wrote over the new words from the old instruction. It starts over on what's there.
8. "I will ask him to send it" and "I promised to tell Tom" read as instructions. A directive must open a clause (the start, after punctuation, or "and", "then", "also"); in Spanish too.
9. An instruction in a list routed forever: the serialized email has its bullet, the editor's blocks don't. Comparisons use the blocks.
10. Stop could keep a fill completion would refuse (too long, a blank line, answered twice). The stream finishes such a fill as nothing.
11. Fill again with nothing usable put the placeholders back. Nothing changes.
12. The gap scan was quadratic (20,000 gaps: 204 ms). A linear sweep, at most 200 read.

## On real models

`apps/desktop/e2e/ai-draft-body.smoke.ts` (`TERNO_RATING_REAL=1`), on the rating's demo mailbox, Pro's routing, times read in the page from the press:

| Path | First visible change | Done |
|---|---|---|
| An instruction (the rules know), Sonnet 5.5 | 0.56–0.62 s | 0.98–1.14 s |
| Gaps filled, Sonnet 5.5 | 0.64–0.77 s | 1.29–1.44 s |
| Unsure: Haiku 5.5 reads it first, then Sonnet writes | 1.38–2.11 s | 1.90–2.80 s |

- The fast read costs about 0.8–1.4 s before the first word, which is why the rules decide whatever they can: the common cases (an instruction that asks or tells someone, a gap marked the certain way, an empty body) never wait for it.
- Its readings: "please decline politely, I'm away that week" an instruction (written); "Friday works for me. Can you send me the address of the flat?" and a longer note to the reader, emails (expanded beside, never replaced); "sounds good, see you friday" an email too, which is the safe side.
- The first real run wrote "Could you ask him to send the address of the flat?" to him: an instruction's "him" is usually the person written to, and the rules say so now (`WRITING_PROMPT_VERSION` 8). The next runs: "Friday works for me. Could you send me the address of the flat?"
- Fills used the conversation and the voice ("thanks for turning them around so quickly"), and left "[the date he mentioned]" as typed, since the thread names no date: nothing invented.
- The smoke spent US$0.026.

### The capture, the gallery and the spend, on real models

- **The frozen capture** (`capture.mjs --screens ai`, Pro's routing) reached every AI state, the new `a02` and `a03` included, in Lumen, Atelier, macOS and Graphite, light and dark: 34 shots each, only Anthropic and OpenAI reached (`/tmp/terno-scratch/plan163/capture-real/`).
- **The gallery** (`/tmp/terno-scratch/plan163/gallery-real/`, 257 shots): for each of the five designs, light and dark, at 1440x900 and 1100x700: the body opened for AI with its hint, the instruction typed with the Sparkles lit, writing (the instruction dimmed), streaming, written, the popover with the pencil and its field, the pinned card, gaps typed, a fill streaming into its gap, filled with one gap left as typed, the fills' popover, and nothing to fill (a real condition: the conversation has no phone number, so the model leaves the gap and the row says so). The redesign's first-use line was answered before any shot, so none shows it.
- **What looking changed:** the ready Sparkles' word (it didn't read as lit in Lumen), shown only from 36rem of foot (it wrapped macOS's foot at 1100); a fill's popover no longer offers another language; "nothing to fill" said for one gap or several.
- **Spend, as the app counted it:** the smoke US$0.026 (a first run that failed on the pronoun, under US$0.01); the gallery US$0.22 and again on the final code US$0.20; the capture US$0.28 and again on the final code US$0.27. About **US$1.00** in all.

### Tests

- Unit: `packages/core` `body.test.ts` (44), `packages/ai` (fill and read, 297 in the package), `packages/backend` `writing.test.ts` and `model-stub.test.ts`, `apps/web` `ai-draft.test.ts` (116) and `composer/fills.test.ts` (9), `packages/ui` `contrast.test.ts`.
- e2e on the stub: `ai-draft`, `summaries`, `design-axe`, `dev-mode`, `replies-ready`, `followups` in `e2e`, and their tagged flows in Lumen, Atelier, Luma and Graphite: all pass.
- `pnpm typecheck`, `pnpm lint`: clean. `pnpm test:ui-perf`: 45 passed.
- Real models: `ai-draft-body.smoke.ts` passes (`TERNO_RATING_REAL=1`); `ai-rating.smoke.ts`'s stub case follows the new ⌘J.
- Not run, as asked: `pnpm test:all`, `rate.mjs`.

### Left for the owner

- The fast read adds about a second before the first word on text the rules can't place. Whether that's worth it against writing straight away and deciding the placement afterwards (the model writes the same draft for an instruction or a note) is a product call.
- "sounds good, see you friday" reads as an email (expanded beside it, with Replace) rather than written up in place. Safe, but one more click for someone who meant it as a note.
- A gap's fill is tinted in the primary's 12% wash: it reads clearly through its underline, the tint itself faintly in Lumen light.
- No `a03b`: a rated fill state would change the set every round is gated on.

## Owner's answers (2026-11-08)

The owner answered "Left for the owner" above:

1. **Unclear text starts writing at once.** When the rules can't tell an instruction from the user's own email, ⌘J no longer waits for the fast model's read before the first word.
   - **Design.** The draft is asked at once, as the instruction's own request (`instruction` = what was typed: the rules' notes, said in their voice with nothing added). That request is right if the text is an instruction, and still their words if it's an email. Asking it as `draft` would be wrong: the rules keep a draft's words "as close as you can", so an instruction would come back as itself. The read (`ai.readDraft`) is asked alongside. The stream shows below their words (`notes`, so nothing is dimmed or replaced) until the read answers.
   - **Where it lands:** an instruction with nothing typed since is replaced in one step, and the strip keeps it as what was asked. An email, a failed read, or text typed meanwhile gets the draft beside it with Replace (the safe default). An answer that comes before the read waits in view, over nothing. A read that confirms a gap in their email drops the draft and fills only the gap.
   - The intent step ("who is it for") isn't asked on this path: unsure text names nobody by the rules.
   - **Where:** `writeWhileReading` and `readAside` in `apps/web/src/lib/ai-draft.ts`; `finished` and `stop` read `run.read`.
   - **On real models** (`ai-draft-body.smoke.ts`, Pro's routing, times from the press): first visible change on unsure text **0.62 to 0.88 s** over two runs, the second on the final code (was 1.38 to 2.11 s with the read first), done 1.15 to 1.55 s. Instructions 0.67 to 0.69 s, fills 0.54 to 0.66 s, as before. The readings didn't change: "please decline politely, I'm away that week" replaced; "sounds good, see you friday", "Friday works for me. Can you send me the address of the flat?" and the longer note landed beside, with Replace. The smoke spent US$0.021 and US$0.026.
   - **Tests** (`ai-draft.test.ts`, each failing without the change): writing starts at once with the read alongside; the read says instruction before the answer, which then replaces the text; the answer comes before the read and waits, then lands as the read says, in both orders; a failed read or typing meanwhile leaves it beside; a confirmed gap stops the draft and fills only the gap.
   - **Codex review** (two rounds, every finding fixed with a regression test):
     1. Stop on a held answer inserted a copy without its checks.
     2. A typed-into choice lost Replace.
     3. A run started again once the message's text arrived dropped the read.
     4. Stop after an instruction verdict put what came below the instruction.
     5. A read that answered while the text downloaded was copied back as pending.
     6. A restarted run compared against its own document, not the one the read judged, so words typed while downloading could be replaced.
2. **"sounds good, see you friday" read as an email,** drafted beside with Replace: the owner says that's fine. No change.
3. **The fill's tint, a step stronger:** the primary at **15%** (the wash the date picker and Ask already use), underline kept. The contrast suite's pair moved with it: the ink holds on a composer's card, tint and background in every palette (`contrast.test.ts`). Looked at, filled, in all five designs, light and dark, on the stub (`/tmp/terno-scratch/ai-redesign/fill-tint/sheet-stub.png`), and on real models in Lumen light and dark (`lumen-{light,dark}-real-filled*.png`, US$0.022). It reads as filled without shouting.
