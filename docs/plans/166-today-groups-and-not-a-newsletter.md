# Plan 166: Today's two groups, and "Not a newsletter"

- **Status:** built on the AI redesign branch (`t3/ai-surfaces-redesign`), code-reviewed (see the last sections). "Revisions after the Codex review" and "What the code review changed" override the sections before them.
- **Builds on:** plan 145 (Today and the digest), plan 161 and 162 (the redesigned Today and digest page), plan 17 (waiting), plan 142 (follow-ups).

## The request

Two items from the owner.

> 1. **Split Today's "Needs you" into two groups.** Asked "Split Today's Needs you into 'Your turn' and 'Waiting for your reply' groups?", the owner said yes. Today rows currently mix "Your turn: they replied" and "Waiting for your reply" reasons under one "Needs you" header (`packages/core/src/today.ts` `TodayWhy`, `today.why.*` strings, the Today list component in apps/web). Make two labelled groups in the list with the same header style as the existing section labels, order the groups sensibly (say which and why), keep the owner's rule that Today shows 12 needs-you rows in total (the cap is shared, not per group; "See all in Inbox" stays), and drop the per-row reason prefix where the group header now says it (keep anything the header doesn't say). Keep keyboard navigation, selection holding (revision 9's held rows), virtualization and render counts working; `today.perf.test.ts` must hold.
>
> 2. **"Not a newsletter."** The owner asked: "for the newsletter digest, do we currently give the users the ability to say that something is not a newsletter? in case we made a classification mistake". Today there is no such control (unticking spares a row for one day only; plan 145 listed a persistent "never in the digest" list as out of scope). Build it: each digest row gets a quiet way (row's context menu and a hover/focus icon-only control, matching the page's existing row controls) to say "Not a newsletter". It removes the row from the digest and from the archive batch at once, and keeps that sender out of future digests (a local per-sender list in settings or the DB, both stores SQLite and IndexedDB if it's data; candidates are scanned locally, so the exclusion applies in the candidate scan before any model call, which also saves tokens). Exact Undo through the existing snack. A place to see and remove excluded senders: a small list in Settings → AI → Newsletter digest (or wherever digest settings live). No model call, no AI check. Conformance tests in both stores if it touches the candidate query, unit and e2e tests, en+es strings ("Not a newsletter" / "No es un boletín").

## What exists

- **Needs you** (`TodayService.list`, `packages/backend/src/today.ts`): at most `TODAY_NEEDS_MAX` (12) rows, in this order, each thread once: promises due (by due time), nudges due, then waiting threads newest first through `store.today.waitingPage`, whose `hasSent` becomes `why.wrote`. One `needsYou` section with `more` (what "See all in Inbox" counts), then `reminders`.
- **The list** (`flattenToday`, `apps/web/src/state/today.ts`): turns sections into rows and `TodayGroup { kind: "needsYou" | "reminders"; at }`. A heading is space the virtualizer reserves on the row before a group (`estimateSize`, `paddingStart`) and is drawn `aria-hidden` (`TodayHeading`, `thread-list.tsx`); each group's first row says its name to assistive tech (`sectionName` → `ThreadRow section`). Held rows (revision 9) are spliced back at their old index and shift later groups.
- **The reason** (`reasonOf` → `useToday.reasons`, read by `useReason` in `thread-row.tsx`): waiting rows lead their line with "Your turn: they replied" (`wrote`, the ink) or "Waiting for your reply" (not `wrote`, the quiet ink), then "·", then the summary or snippet. Promises read "You said: …", nudges "No reply from {name} in N days", in the snippet's place (`whyLine`).
- **The digest page** (`digest-page.tsx`): rows are a tick (`Checkbox`) and one open button (sender, subject, state, date; the line; a chevron). No menu, no other control. Its keys (j/k/x/Enter/Esc) are `digestKeys`, and they stand down while a menu is open (`menuOpen`).
- **Candidates** (`TodayService.candidates`): a walk of messages by arrival, each page filtered by `store.today.digestFacts` (both stores), then `findCode`, then the 40 cap. `DigestFact.from` is the sender's name or address, and `DigestItem` (stored in `ai_digests.body_json`) has no address. With the digest off, the same scan is "Automated mail".
- **The digest settings:** `DigestGroup` in `settings/ai-summaries.tsx` (Settings → AI → Newsletter digest): the switch and, when on, where it runs.
- **Small stored values:** `store.settings.get/set` (both stores) already keeps Today's own keys (`today:notified`), apart from `AppSettings`.

## Design

### 1. Two groups

**The groups.** Needs you's rows go to one of two groups by their reason, `needsGroup(why)` in `@terno/core`:

- **Your turn** (`yourTurn`): the conversation is yours to move. Promises due ("You said: …"), nudges due ("No reply from Ana in 5 days"), and waiting threads you've written in (`wrote`: they replied).
- **Waiting for your reply** (`waitingForYou`): a new conversation from someone you write to, that you haven't answered (`wrote === false`).

**Order: Your turn first.** It's the stronger signal: a conversation you're already in, where the other person answered you, or a promise or nudge you set that's now due. "Waiting for your reply" is plan 145's softer rule (the single new conversation from a contact), so it follows. It also keeps plan 145's order, which already put promises and nudges first.

**The cap stays shared.** The backend picks the same 12 as now (promises, nudges, then the newest waiting), and the list groups them. So "The newest 12 of 41 that need you" stays true, "See all in Inbox" is unchanged, and the RPC doesn't change. A group with no rows has no heading; Reminders follow as before.

**The headings** are the existing section heading (`TodayHeading`: the ink, `text-sm`, medium, on the rows' content line), "Your turn" and "Waiting for your reply" (es "Te toca", "Esperan tu respuesta"), in place of "Needs you". The page's sentence ("3 need you") still says what the whole is. Each group's first row says its group's name to assistive tech ("Your turn, …"), as sections do now.

**The reason prefix goes** where the heading says it: a waiting row no longer leads with "Your turn: they replied" or "Waiting for your reply"; its line is the summary or the snippet. **What the heading doesn't say stays:** a promise's "You said: …" and a nudge's "No reply from Ana in 5 days" are their lines, as now. The action preview's row tags (`action.row.*`), which share the row's reason slot, are untouched.

**How:** `flattenToday` splits the `needsYou` section into its two groups, stable (each keeps the backend's order inside it). `TodayGroup.kind` becomes `"yourTurn" | "waitingForYou" | "reminders"`. The virtualizer already reserves a heading per group, so a third one needs nothing new; held rows shift groups as before. `useToday.reasons` and its read in `useReason` go.

### 2. "Not a newsletter"

**The control,** on each row of the digest (not on "Automated mail", which hasn't claimed anything is a newsletter):

- **An icon-only button** (`IconButton`, ghost, `icon-xs`, the catalog's new `Ban`: Hugeicons' `UnavailableIcon`), named "Not a newsletter" with that tooltip. It sits at the row's right end of its first line, where the date is, shown on the row's hover and on its own keyboard focus (`focus-reveal:`), the date giving way to it, so the row's text and the chevron don't move and the row's edge stays the Archive button's.
- **The row's context menu** (`ContextMenu` on the row): "Open" and "Not a newsletter". While it's open the page's keys stand down (`menuOpen`), as everywhere.

**What it does, at once, with no model and no check:**

1. Every row on the page from that sender leaves the page and the Archive batch (the count and the button follow), and the digest's way in (its count and who they're from). Keys go to the next row still there, else the title, as after Archive.
2. The sender goes on a local list, `today:notNewsletters` in `store.settings` (both stores): `{ key, email, name, at }[]`, `key` = `addressKey(email)`, at most 500 (the oldest drops). It isn't `AppSettings`, so it isn't sent with every settings event or in an export, and isn't logged.
3. The snack: "{sender} won't be in your digest" with **Undo** (and `z`), which takes the sender off the list only if this added it, so the rows come back in their places with their ticks as they were.

**Where the list applies,** all local and before any model call:

- **The candidate scan** (`candidates`): a fact whose sender is on the list is skipped and takes no place among the 40. That's the digest and Automated mail both.
- **A run underway** (`run`): pending items from a listed sender are dropped before the batch is sent, so no tokens go on them.
- **What's shown** (`digestRow`): a stored digest's items from a listed sender are left out at read, so the list and the page agree after a refresh, and Undo brings them back.

**The sender's address:** `DigestFact` and `DigestItem` gain `fromEmail` (the message's `from_email`, both stores). A digest stored before this has none: `digestRow` fills it from the thread's summary (`threads.summaries`, its last sender, which for a listed newsletter is the newsletter: the row is shown only while the thread is as listed).

**Settings → AI → Newsletter digest** gains, when the list has anyone, a row "Not newsletters" ("Kept out of the digest. Remove one to let it back in.") with each sender (name, address quiet) and a `CloseButton` "Remove {sender}". Removing has a snack with Undo that puts it back where it was (`at` kept). It shows whether the digest is on or off, since the list also keeps those senders out of Automated mail.

**RPCs** (renderer only, not on `MCP_ALLOWED`):

- `today.notNewsletter { email, name, at? }` → `{ added: boolean }`
- `today.newsletterAgain { email }` → `{ removed: { email, name, at } | null }`
- `today.notNewsletters` → `{ senders: { email, name, at }[] }`, newest first

Each change forgets the cached Automated scan and emits `todayDigest`, so the page, Today's header and Settings re-read.

**Clear AI data** leaves the list: it's the user's correction, not something a model made. Removing an account leaves it too: a sender isn't an account's.

### 3. Copy (en and es together)

- `today.group.yourTurn`: "Your turn" / "Te toca"
- `today.group.waitingForYou`: "Waiting for your reply" / "Esperan tu respuesta"
- `today.digest.notNewsletter`: "Not a newsletter" / "No es un boletín"
- `today.digest.notNewsletterDone`: "{sender} won't be in your digest" / "{sender} no estará en tu resumen"
- `today.digest.notNewsletterUndo`: "Undo: put it back in the digest"
- `today.digest.open`: "Open"
- `today.digest.excluded.title`, `.hint`, `.remove`, `.removed`

`today.why.yourTurn` and `today.why.newFrom` are no longer used and go.

## Tests

- **core:** `needsGroup` for each reason.
- **state/today.test:** `flattenToday` makes the two groups in order, stable inside each, with no heading for an empty one; held rows shift them; no reasons any more; a promise keeps "You said".
- **Backend `today.test`:** the scan skips a listed sender (the cap counts only what's left); `digestRow` leaves a stored item out and Undo (`newsletterAgain`) brings it back; a pending run drops a listed sender before the model is asked (the fake records what it was sent); an item stored without `fromEmail` is filled from its thread; the list's cap, order and `added`.
- **Conformance (both stores):** `digestFacts` gives the message's own address.
- **digest-page.test:** the control and the menu remove the sender's rows from the page and from the batch at once; Undo brings them back with their ticks; not on Automated mail.
- **e2e `today.spec`:** the two headings in order, the first rows' accessible names, no reason prefix; the digest row's hover control and menu, the snack's Undo; Settings' list and Remove. `design-axe` holds the page.
- **Perf:** `measureToday` (`workloads.perf.test.ts`) and `today-perf` conformance unchanged and passing; the list's render counts.

## Out of scope

Excluding by list or domain rather than sender. A "this is a newsletter" for Automated mail. Changing which 12 Needs you picks.

## Revisions after the Codex review

Codex (read-only, `/tmp/terno-scratch/p164/today/critique.out`) raised 11 points. Ten are taken and replace what the sections above say; one isn't.

1. **A stored item's sender comes from its own message, not the thread's last sender.** A stored item outlives a thread that moved on (only its message has to be there). `TodayStore.senders(messageIds)` (both stores, conformance) reads `from_email` by message id, batched; it fills items stored without `fromEmail`, pending ones too, before any exclusion check or model call.
2. **The check before a request leaves sees the list.** `stillListed` (which `holdingUp` runs as any digest request leaves, repairs included) drops a listed sender, so a request queued behind the limiter is stopped and the rest asked about without it.
3. **Archive skips a listed sender.** The page sends each item's `fromEmail` with Archive, and `narrow` leaves out a listed sender at the moment each chunk runs: neither archived nor counted as changed.
4. **Undo is exact at the cap.** Adding to a full list returns the entry it dropped; Undo takes off what it added and puts the dropped one back.
5. **One unit for every change.** Additions, removals, the cap's drop and Undo all go through `settings.update`. Undo takes the sender off only if the entry is still the one this action added (its `at`), so an old Undo can't remove a sender added again since.
6. **The page keeps a hidden row's tick.** Tick all / Untick all change only the rows shown; a left-out row's tick is kept, so Undo brings it back as it was.
7. **A scan underway can't bring a sender back.** A change bumps a generation; a scan that began before it isn't kept. `digestRow` also filters at read, both modes.
8. **"At once" doesn't wait for a read.** The renderer keeps the senders it has just left out (`useToday.notNewsletters`), and every view of the digest (the page, Today's header) filters by it until Undo. The page applies only the newest of its own reads.
9. **The control isn't inside the open button.** The row's first line is laid out with Open and the control as siblings; the control's click neither opens nor marks read (tested).
10. **Not taken: holding a live row's group.** A row still in Needs you that changes group while open (a due promise on a waiting thread) moves, as a live row already moves when its order changes (a newer message); revision 9 holds rows that leave. Rare, and holding it would put a row under a heading that no longer says why it's there.
11. **Perf:** the list is read once per scan and checked with a set. The new `senders` read is in the `today-perf` conformance gate at 50k in both stores.

## What building it changed

- **No `today.perf.test.ts` exists:** Today's gate is `measureToday` in both stores' `workloads.perf.test.ts` (plan 145). It holds: at 50k, waitingPage p95 5.9 ms (SQL) and 3.8 ms (IDB); `senders` 0.04 and 0.01 ms.
- **A held row stays in its own group.** A row left at a group's first place sat under the next group's heading; one whose group emptied had none. `flattenToday` places it inside its group's range, and gives a gone group its heading back for it (`today.test`).
- **Automated mail isn't emptied for a moment by a change:** its cached scan stays, filtered at read, and is marked stale (found by the backend test: the row vanished until the rescan).
- **The row's menu** is a `ContextMenu` per row (`data-context-menu`, so ⇧F10 on the row opens it). Its "Not a newsletter" removes the row and the menu with it, so it gives the page's keys back itself (`menuOpen`), and "Open" has the envelope beside it so the two labels share a column (seen in the shots).
- **The control** sits over the date's place at the chevron's inset (`top-1.5 right-8`), the date `invisible` while it shows; the row keeps its hover fill while the pointer is on the control.
- **Settings:** the list is a stacked row in the Newsletter digest group, each sender a name, its address quiet, and a `CloseButton`.
- **Strings:** `today.needsYou`, `today.why.yourTurn` and `today.why.newFrom` went (unused); `today.group.*`, `today.digest.notNewsletter*` and `today.digest.excluded.*` came, en and es.
- **Shots** on real models (Lumen and macOS, light and dark): `/tmp/terno-scratch/p164/today/shots/`, with `index.md`.

## What the code review changed

Codex (read-only, `git diff 023d22b61..HEAD`, `/tmp/terno-scratch/p164/today/review-1.out`): 5 points, all fixed, each with a test that fails without it.

1. **Undo at the cap wasn't one unit.** Two calls (take off, put back) let another window fill the freed slot between them, and the restored entry was dropped again. `today.notNewslettersUndo` does both in one `settings.update`; putting back may go past the cap by what it restores, and the next addition trims back, oldest first (`today.test`, the interleaving).
2. **A sender the cap dropped stayed hidden in the renderer.** The page lets it back in (`letBackIn`) when the backend says it was dropped, and its Undo hides it again (`digest-page.test`).
3. **An entry's time isn't its identity.** Removed and said again in the same millisecond, an old Undo took off the new entry. Each entry has an `id` (a UUID); Undo and Remove name it (`today.test`).
4. **A name past 200 characters was refused,** so the control failed on it. The page sends the first 200, and the RPC takes up to 2,000 and keeps 200 (`today.test`, `digest-page.test`).
5. **Removing the last sender lost the keys** to the dialog. They go to the digest's switch above (`today.spec`, by keyboard).

Round two, on those fixes (`review-2.out`, 3 points, all fixed, in one `today.test` that fails without each):

6. **An entry stored without an `id`** (none should exist: the list is new in this series) is named by its address at every read and change (`key:<address>`), so Remove and its Undo take it.
7. **The list's order is monotonic again:** a new entry's time is after every other's, so two in one millisecond keep their order through an Undo, and a clock set back can't make the cap drop the one just said.
8. **Undos can't grow the list without bound:** racing windows could leave it one over the cap per cycle until an addition dropped more than an Undo accepts. Putting back stops at `NOT_NEWSLETTERS_OVER` (10) past the cap, and the Undo accepts that many plus one.

Two rounds, as the owner's cap on review rounds asks; nothing left open from them.
