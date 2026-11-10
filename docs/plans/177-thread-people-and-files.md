# Plan 177, who's in a conversation and all its files, at the top

## The request (verbatim)

> i want to copy some stuff from this design here, i think i like maybe when there are multiple emails in the thread, at the top it tells the users that are on it, i like that all attachments across all emails are on the top too, lets have things like that on the desktop:demo so i can see how it looks

The design shown: under the subject, a row of pills (an avatar and a first name each) for the people on the thread; under the AI summary, "Attachments [4] ⌄" and one compact pill per file (glyph, name, size) gathered from every message; each message still shows its own files.

## What exists

The reader (`components/reader.tsx`) draws a conversation as `ReaderHeader` (the subject and `ThreadChips`: account, message count with expand/collapse all, categories, suggestions; arranged by the design's `readerHeader` variant: `classic`, `chips-display`, `sender-card`), then `ThreadFollowups`, the summary card (`ThreadSummary`, `data-summary-card`), then `Conversation`. Who a message is from and to is only in each message's header ("To: …"), and a folded message shows only its sender. Files are only in each open message's body (`ReaderAttachments` in `attachments.tsx`: a 260 × 56 tile per file, a click downloads it or, while it isn't cached, asks the backend to fetch it). A file in a folded message can't be seen without opening it, and in a long thread finding "the PDF someone sent" means opening messages one by one.

Everything needed is already in `ThreadDetail` (every message's `from`, `to`, `cc`, `isSent`, `attachments`): no backend, store or RPC change.

## Design

Both show only when the conversation has **two or more messages** (with one, its header already says who and its files are right there under it), in every design.

### People (`ThreadPeople`, new `components/thread-people.tsx`)

**Who.** Everyone who wrote or was written to (`from`, `to`, `cc`) across the messages, once each (by email, case-folded), leaving out the user by Reply's own rule (`identitiesIn`: every account's address, a sent message's From, `+tags`, Gmail's dots), so the two never disagree. Senders first, in the order they first wrote, then the people only written to, in the order they first appear. A person's name is the one they sign with (their From), else the first one someone wrote them with, else the address. Nobody left (notes to yourself): nothing shows.

**Each person** is a `Chip` (BoardUI, non-removable) with their `SenderAvatar` (20 px) as its dot and their first name; the full name when two people share a first name, the address when the full names match too or there's no name. The avatar and first name are hidden from screen readers, which hear the full name and address once; the item's title says it too. Avatars follow the reader's rules, read at render (not memoized with the people): icons only outside spam (plan 22), a person's own avatar for someone writing in a conversation with people (`personFor`, on the newest message they wrote), always for someone only written to.

**Many people.** The first 6 chips, then "+N", a link button ("Show N more people") that shows the rest in place. One line in a wide reader; it wraps in a narrow one.

**Where.** The last line of the header block, under the subject (and under the chips line where the design puts it beside the subject), in every `readerHeader` variant, on the column's content line: the chips start where the subject starts. A `ul` named "People in this conversation".

Not a control: clicking a person does nothing yet (out of scope), so no chip is a Tab stop.

### Files (`ThreadAttachments`, in `components/attachments.tsx`)

**Which.** Every file of every message, oldest message first, each with the message it came with (a retry asks for that message's). Never merged: a name and a size don't make two files the same (a second revision of report.pdf can weigh the same), and each copy has its own cache state. Inline images are listed as each message's own list lists them today; nothing new is hidden or shown. The first 12, then "Show all N" (a long conversation's strip stays a few lines; nothing more mounts until asked).

**Look.** A disclosure (`Collapsible`, BoardUI): its trigger reads "Attachments" and the count, muted and tabular, with the chevron; open by default, its state per conversation shown (it starts open on each). The panel holds one compact pill per file: the paperclip glyph (1.15 em, muted), the name (truncated past 14 rem), the size muted, on `bg-tint`, `rounded-md`, 28 px high, hover `bg-accent`. One line wraps to more as needed.

**Act.** A pill is a button that does exactly what the message's tile does: download the cached file, or ask the backend for it (the "sync requested" snack) while it isn't cached. That logic moves out of `ReaderAttachments` into one hook both use (`useAttachmentOpen`), with one busy key for a download or a retry (the tile's retry never said it was busy), so the two can't drift. Its accessible name is the tile's ("Download name size"), built by one function.

**Where.** After the summary card (or the follow-ups line, or the header, when there's no card), before the conversation, whose hairline then separates the files from the first message. The gap above it is the header's own gap; under it, the same gap the summary card leaves.

**Copy.** `reader.people` ("People in this conversation"; es "Personas en esta conversación"), `reader.morePeople` ("+{count}"), `reader.showPeople` ("Show # more people"; es "Mostrar # personas más"), `reader.allAttachments` (the files list's name, "Every file in this conversation"; es "Todos los archivos de esta conversación"), `reader.showAllAttachments` ("Show all {count}"; es "Mostrar los {count}"). The trigger reuses `reader.attachments`. Strings in `en` and `es` together.

### Rendering

Both are pure functions of `detail.messages` (memoized on it, and the user's addresses), drawn with the header: no subscription of their own, nothing per keystroke or per scroll. They render with the header when a message opens or folds (the fold lives in `Thread`), which is a pass over at most 6 chips and 12 pills; the disclosure's and "+N"'s state is their own, so toggling them renders nothing else. The conversation's render-count probe (`renderProbe("Conversation")`) is unchanged.

## Tests

- Unit (`thread-people.test.ts`, new): who's listed and in what order; the user and an alias left out; dedup by case-folded address; first names, full names when two share one, the address without a name; the cap and the rest's count.
- Unit (`thread-attachments.test.ts`, new): files gathered oldest first; the same name and size kept once, the newest copy; none for a one-message thread.
- Unit (`reader` jsdom, extended): a two-message thread shows the people line and the files strip; one message shows neither; clicking a strip pill downloads through the same path as the message's tile; the disclosure folds and unfolds.
- e2e: in the reader spec that opens a multi-message thread, assert both are present and named (`getByRole("list", { name: "People in this conversation" })`, the "Attachments" disclosure), and axe stays clean (the design-axe spec covers the reader in light and dark).
- Visual: screenshots of a multi-message thread with files in light and dark, in the classic, chips-display and sender-card designs, looked at for alignment with the subject.

## Performance

A thread of 40 messages is a few hundred addresses and files: one pass each, memoized on the messages array. No list is virtualized (a cap of 6 chips; files are as many as the messages' own lists already render). No change to any gate's hot path (list, `j`/`k`, typing); the reader's open-thread gate (`test:ui-perf`) is run to confirm.

## Out of scope

- Clicking a person (filter by them, compose to them, contact card).
- A preview of a file, file-type icons or colors (one glyph today, from the icon set).
- Remembering the files disclosure's open/closed state across conversations.
- The screenshot's date range line, toolbar and reactions.

## Revisions after the Codex review of the plan

Twelve points. Taken:

1. **Name and size don't identify a file**: no merging (above); each file keeps its own message and cache state.
2. **The user's addresses**: Reply's rule (`identitiesIn`), not a second one.
3. **Names**: the sender's own name wins over how others addressed them; full names that collide fall back to the address; the newest message each one wrote is kept for `personFor` (a list sender first seen as a recipient).
4. **Spam and avatars**: the people are memoized on the messages and addresses only; `icons` and `personOf` are read at each render.
6. **Unbounded files**: the first 12, then "Show all".
7. **One busy key** for downloads and retries, one label function; the tile's retry now says it's busy.
9. **"+N" for keyboards**: a button that shows the rest, not a title.
10. **Spacing**: the people line closes the header block in each variant (classic, chips-display, sender-card with several messages), outside the subject's row; the files' gap under them is the summary card's own `mb-4`.
12. **Axe**: the reader e2e scans both new parts in light and dark.

Not taken: 5 (render isolation behind memo: the header already renders with every fold, and these add a few chips; React Compiler memoizes their elements), 8 (incomplete attachment metadata: the strip shows what's known and follows the thread's refreshes, as each message's list does), 11 (drafts aren't in `messages`; nothing about them changes).

## Revisions after the Codex code review

Three findings, all fixed with a test that fails without the fix:

1. **"+N" and "Show all" dropped focus** (the button left the page as it was pressed). Each is now one toggle that stays, "Show fewer" once open (`aria-expanded`), so focus stays on it and the rest fold back (`reader.showFewer`).
2. **No test held the avatar rules as they change**: a conversation turning spam (or no longer with people) with the same messages now re-asks each avatar without icons (`thread-overview.test.tsx`).
3. **"Surname, Given" read wrong** for surnames of several words ("García López, Ana" said "García") and for companies ("Acme, Inc." said "Inc."). The given name is whatever follows the comma unless it's a company's ending.

## The mail's first line (plan 158): rule dropped

`reader.spec` held the first message's first line in the reader's upper third (under 300 px at 1440 × 900). The people line (34 px) put it at 328–332 px in Atelier and Graphite. The owner: "that's fine, you can remove that strict rule". The assertion is gone; the test keeps the toolbar on the column and the measure.

## After the owner looked (demo)

"The attachments need a bit more margin on the top", and with an AI summary above them it must look good too. The strip has `mt-5`: its margin collapses with the header's (12 px) or a card's (16 px), so the gap above "Attachments" is 20 px whichever is there. The people line has 4 px of padding under it (a margin would collapse into the header's), so its chips sit 16 px off a summary card's edge instead of 12. Looked at with and without a summary, light and dark, in macOS, Lumen and Atelier.
