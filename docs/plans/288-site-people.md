# Plan 288: People on the site, in Terno Pro

- **Status:** built.
- **Builds on:** plan 97 (terno.app), plan 224 (“What matters” as Pro's lead, the demo pictures), plan 281 (People), plan 287 (People's filter).

## The request (verbatim)

> we have added the People view and we need to put that on the marketing site as the part with the pro plan, lets add it

## What exists

- Pro's section (`parts/pro.tsx`, shared by Midnight, Lumen and Letter): its header, “What matters” (plan 224), the drafted reply large (`PRO_LEAD`), then four smaller features (`PRO_MORE`: Ask, Follow-ups, the digest, summaries), then what AI sends and the own-key note. Pro's title and body already promise what People shows: “Nothing slips. Pro keeps track for you: who's waiting on your answer, what you promised, and who hasn't replied.”
- People (plan 281, landed 2026-11-26): a view below Inbox, only while AI features are offered (Pro, the user's own key or a local model: the same gate as “What matters”). One list, the people with something open first, longest waiting first, with how long; then everyone you've written to. A person's page: what's open between you (your promises, conversations waiting on your answer, their requests, replies they owe you), each with Done and Later and one Undo, and your recent conversations. Search by name and address only, instant. A chip's menu shows the same at a glance and acts on it.
- The pictures of AI features come from the AI demo (`./run.sh demoai`) through `shots/demo-shots.ts`, light and dark, at 2×, on a copy of the demo's profile (plan 224's second round).

## Design

### Placement

People is a wide feature in Pro's grid, between the two pairs: the drafted reply (wide), Ask and Follow-ups, **People (wide)**, the digest and summaries. Two wide features with pairs between keep the grid's rhythm (a fifth small tile would leave one alone on its row). `parts/pro.tsx` holds the order for the three designs: `PRO_PEOPLE` and `PRO_PAIRS` (the four, two by two) replace `PRO_MORE`.

- **Midnight:** a card across the grid, as the reply's, its picture in the same frame.
- **Lumen:** the picture in a window and its words under it, as the reply's, between the two rows of tiles.
- **Letter:** a Pro feature in the column with a wide figure and its caption, as the reply's.

### The picture

`ai-people`: the whole window at 1280×800 (the reply's size, so the two wide features read as one set): the sidebar with People below Inbox, the list with Open first, and a person's page with what's open between you and your conversations. From the demo: People opened, the first person in Open chosen, nothing hovered. On a phone it's cropped to the person's page, as the reply's is to the reading pane (`.site-pro-people`). The demo mailbox is fictional; the capture checks that no address of the demo account's own is painted.

### Copy (en and es)

As revised after the Codex review (below):

- Title: “What’s open with each person.” / «Lo pendiente con cada persona.»
- Body: “People puts first the ones with something open: what they asked of you, what you promised them, conversations waiting on your answer, replies you’re waiting for. Then everyone else you write to. Choose someone to see what’s open between you and your recent conversations.”
- Points: “Longest waiting first, with how long”; “Mark items Done or move them to Later, with Undo”; “Search by name or address as you type”.
- Alt text for the picture; the meta description is left alone (it already names Pro by its AI).
- Spanish uses the app's words: «Personas», «Pendiente», «Más tarde».

Every claim is the app's (plan 281's “As built” and the owner's decisions): the order and how long (decision 1), Done and Later with one Undo (§6, decision 6), search by name and address only (§4).

## Tests

- `render.test.ts`: in every home design, Pro holds People's title, body and points and both modes of `ai-people`; the order is the reply, Ask, Follow-ups, People, the digest, summaries; People's title is an h3 like its neighbours'.
- `e2e/site.spec.ts`: the page's axe runs (light and dark, every design) cover the new feature; run them.
- Typecheck (es must match en's shape).

## Perf

Static HTML, one more pair of pictures, lazy like the rest (only the shown mode loads). No script.

## Out of scope

- A section of its own or a link in the hero (People is a Pro feature like the others; “What matters” stays the hero's news).
- A picture of the chip's card.

## Revisions after the Codex review

Twelve points, all taken:

1. **Not “everyone”.** Open can hold people you've never written to; Everyone is the people you write to, by plan 278's person rule and the filters, up to 5,000. The title is “What's open with each person.”, and the body names the two groups.
2. **The four kinds, in the app's words.** The body names their requests (missing before), your promises, conversations waiting on your answer and replies you're waiting for (Follow-ups' rows), not “who owes you a reply”, and “recent conversations” (20, with a link to the rest), not “see it all”.
3. **The order point** says longest waiting first, with how long; the Spanish says «cuánto lleva», not «desde cuándo».
4. **Done and Later** without “on each” (put-off items and Later's presets differ): “Mark items Done or move them to Later, with Undo”.
5. **Search** “as you type”, not “instantly” (it waits for the contacts index on a cold open).
6. **The designs' structure:** Midnight, a card across the hairline grid; Lumen, the wide block between two lists of tiles (each `<ul>` keeps only `<li>`s); Letter, a Pro feature with the figure on the wide track (`letter-wide`), as the reply's.
7. **Privacy in the picture:** the capture runs on a copy of the demo's profile; the window is checked in both modes for any painted address but the chosen person's own. The demo's owner is the mock mailbox's fictional Luis Cordero (`packages/mock-data`).
8. **The person is chosen, not the first row:** Split, no search or filter, the list from its top; of the Open people wholly in view, the one whose page shows the most kinds, then the most items above Conversations. Before each mode's capture, the row, an item, a conversation and the sidebar's People are checked inside the window.
9. **Its own crop:** each wide picture has its crop box as variables (`--crop-x`, `--crop-y`); People's was measured (the page's content at x 667–1250 from y 64) and happens to fit the reply's box.
10. **Assets:** `ai-people` alt text in both languages, general enough that a retake on another person stays true; both modes at 1× and 2× in `shots.json`; `demo-shots.ts` takes `--only=` and encodes only what it took.
11. **Render tests** cover all six design-and-language pairs (the preview routes are English only): the features' order, People's body and points between its title and the digest's, one picture pair between Follow-ups' title and the digest's, in its own crop box.
12. **e2e:** People's picture joins plan 224's light/dark test (each mode real, the switch shows the other, the files differ); a new test checks the phone crop at 390 and 320 px in every design.

## Taking the picture

On a copy of the AI demo's profile (`rsync` without `Singleton*`), started as plan 224 says, then `pnpm --filter @terno/site shots:demo -- --only=ai-people`. The first pick, Liam Taylor, showed a conversation typed into the demo by hand (“hi”, two words of body), not fixture mail. The capture now skips a page whose conversations in view have a subject under 4 characters or a snippet under 24 (the fixture's are whole sentences); it took Natalia Navarro: a conversation waiting on your answer and three requests, then her recent conversations.

## What the Codex code review changed

Twelve findings; ten fixed, two declined:

1. **The window must be the demo's mailbox.** Before anything is changed or taken, every account in the window must be one of `@terno/mock-data`'s (all its accounts and the contacts fixture's); a window on real mail is refused. This guards all three demo pictures.
2. **The address check compares whole addresses**, painted text only (a text range's box, not its element's), and allows the person's own address only in their page's head. A refusal says why and never echoes the words.
3. **Filters are cleared through the app** (`setPeopleFilter(NO_PEOPLE_FILTER)`; the old click only reached the empty list's button), a focused account stops the run with what to do, and the run checks that no filter chip is left.
4. **Candidates come from the app's state:** Open's keys from People's store, not a row's words (an `@` in a request no longer skips it), and the kinds from the items' own kinds, not their labels. Every candidate is checked as a picture before it's ranked, so a winner can't fail the capture.
5. **The hand-typed check runs again right before each mode's capture.** It stays a heuristic by length. The demo has no record of which conversations were typed by hand, and the check can only refuse a candidate, never pass a wrong picture. Declined: matching the fixture's conversation ids, which the demo doesn't keep.
6. **Copy:** “the others you’ve written to” (Everyone is capped and filtered by plan 278), and “replies you’re waiting for in Follow-ups” (they come from Follow-ups), in both languages.
7. **Declined:** at 640 px and wider, Lumen shows the whole window, so text is small until Enlarge. The drafted reply's picture already works this way. Changing the breakpoint for both is a design change, not this plan's.
8. **Alt text leads with what the phone crop shows:** the person's page first, then the list beside it.
9. **Declined:** Lumen puts the picture before the feature's heading, as it does for the drafted reply. That's the design's idiom, and the alt text describes the picture.
10. **The pictures' e2e checks each mode's 1× and 2× file:** both must be served as WebP (a 404 used to pass the “two different files” check), for “What matters”, Follow-ups and People.
11. **People's picture is its own:** the render test checks that no other feature's title or picture sits between People's picture and People's title. A new e2e checks that the picture is as wide as the drafted reply's in every design at 1440 px.
12. **Each run captures into its own folder** (`.shots-raw-ai/run-<time>`) and encodes only that folder, so a retake that fails after its light frame can't pair it with an older dark one.

Retaken after the fixes: the same choice, Natalia Navarro, with Liam Taylor's page skipped for a hand-typed conversation.
