# Plan 240: "Show mail from … in What matters"

- **Status:** built. "Revisions after the Codex review" override the sections before them.
- **Builds on:** plan 17 (who is a person, what's waiting), plan 145/166 (Needs you, the digest, "Not a newsletter"), plan 204/210 (What matters, its mutes), plan 211 (the account switches), plan 239 (the reader's order).

## The request

After the investigation in plan 239 (an ESOF reminder, from a sender never written to, missing from What matters), the owner asked:

> shoud we consider having a setting on the right click menu when they have a iactive so they can do something like 'Show emails like this in 'what matters'

The recommendation was a sender rule, not "like this" (which would need an AI judgment of similarity, not reliable enough to promise): "Always show mail from ESOF in What matters". The owner: "for the 'show in what matters' yes lets do that".

## What exists

- **Needs you's conversations** (`store.today.waitingPage` → `needsYou`, `packages/store/src/today.ts`): threads with `waiting_since` (plan 17: the newest visible message is inbound **from a person**, you aren't only on Cc, nothing of yours answers it), then the rule: a conversation you've written in, or the **single** unanswered conversation from someone you've **written to**. Then `stillWaiting` (SQLite `packages/db/src/today.ts`, IndexedDB alike) drops one the dated reader read with nothing asked, one a current summary gives no action, an acknowledgment, one whose latest item was handled; muted senders (`dated_mutes`) are dropped.
- **Plan 17's facts** (`threadFacts`, `packages/core/src/people.ts`, both stores through `factContext`): `person` from `automatedLevel` (2 never: bulk headers, a list, Promotions/Social/Forums, no-reply; 1 only if written to; 0 a person) and `waitingSince` only for a person. `requeueSender(key)` (both stores) recomputes the facts of one sender's threads, inline when they're few, else as a background sender job: what writing to someone new already uses.
- **The dated reader** (plan 239): drops a Promotions or Social message unless it relays a person's ask, an automated one without a time cue, and an untrusted sender's (named like a security desk, never written to).
- **The digest / Automated mail:** a sender on "Not a newsletter" (`today:notNewsletters`) is kept out of it.
- **Mutes** (`dated.mutes`, `lib/dated-mutes.ts`): offered by Remove's snack, listed in What matters' settings (`settings/today-settings.tsx`, `what-matters/options.tsx`), with Undo. A sender you've written to can't be muted (`errors.dated.muteWritten`).
- **The sender's menu items** (`SenderItems`, `components/sender-menu-items.tsx`): in a row's right-click menu (More ▸ From {name}) and the reader's sender menu (`person-menu.tsx`): File always, Create filter.

## Design

### 1. The rule

A sender you choose is **shown**: each conversation whose newest message is theirs and unanswered is in Needs you, whatever their mail looks like (a list, a notification, Promotions), until you answer it, Done it, archive it, or stop showing them. It's your word, so it outranks the guesses:

- **Facts:** `FactContext.shown(key)`; in `decide`, a newest inbound message from a shown sender **waits** as a person's does (`waitingSince` set, `waitingMessageId` its id). `person` is unchanged: a shown sender isn't a person (the People filter and the reader's "a person asks" stay plan 17's), so `waitingSince` no longer implies `person = 1`. Spam never: the inbound pool already leaves it out.
- **Needs you** (`needsYou`): the `known(key)` lookup also says `shown`; a shown sender's waiting conversations are all in, not only a single one. `stillWaiting`'s readings by the AI (nothing asked, a summary with no action, an acknowledgment) don't drop a shown sender's: you asked to see their mail; a handled item (Done, Later, Remove on its line) still does.
- **The digest / Automated mail:** a shown sender's mail is kept out, as "Not a newsletter" does (it's in Needs you instead, one line a conversation).
- **The dated reader:** a shown sender is read in full: not dropped for Promotions/Social, nor by the automated cost filter, and trusted as someone you've written to (the security-desk guard). What it finds gives the line its sentence and day, as for anyone.
- **Mutes:** showing a sender removes its sender mute (and its pairs); muting a shown sender removes the show. One sender is never both.
- **Account switches:** Needs you follows the account's What matters switch (`local`), as now; the reader's part follows `reads`.

The "to reply to" count is the waiting conversations in the Inbox: a shown sender's unanswered mail counts there too, which is what showing them means.

### 2. Data

A table of its own, `shown_senders` (both stores): `key` (an `addressKey`, primary), `email`, `name`, `created_at`. At most 500 (`SHOWN_SENDERS_MAX`; adding past it refuses with a plain error, as mutes do). Not `correspondents` (derived from sent mail, rebuilt by the facts' backfill) nor `AppSettings` (sent with every settings event). SQLite: a create-only migration; IndexedDB: a new store and a version bump. Cleared by nothing but the user (not Clear AI data: it isn't AI's).

`store.today.shown`: `list()` (newest first), `add({ email, name, at })` → whether added, `remove(key)` → the row removed or null, `has(key)`. `add` and `remove` requeue the sender's threads' facts (`requeueSender`, which runs inline for a few threads and as the background sender job past `INLINE_REQUEUE`), and `factContext` reads the table (one primary-key lookup, cached per context like `written`).

### 3. RPC and backend

`today.showSender({ email, name })` → `{ added, unmuted: DatedMute[] }`; `today.unshowSender({ email })` → `{ removed }`; `today.shownSenders()` → the list. Each sends `todayChanged` (and the counts), and a facts requeue's own events. The backend removes the sender's mutes in the same call (the dated mutes' store) and returns them, so Undo restores them exactly. `today.muteSender`'s path removes a show.

### 4. UI

- **The menu:** in `SenderItems`, "Show in “What matters”" (es "Mostrar en «Lo importante»"), an `Eye`-style icon from the catalog; when shown, "Stop showing in “What matters”" ("Dejar de mostrar en «Lo importante»"). Offered when What matters is (`todayOffered`) and the sender's account has it on (`feed`); the state is read from a small client store of shown keys (loaded once with What matters' settings, kept by the RPC's answers), never a request per menu.
- **The snack:** "Mail from {sender} will show in “What matters”" / "Mail from {sender} won't show in “What matters” any more", with Undo (and `z`) putting back exactly what was (the show, and any mute it removed).
- **Settings → What matters:** "Shown in “What matters”" above "Hidden from “What matters”", the same list look (name, address muted, a remove ×, Undo snack), empty → not drawn.
- **Tip:** none (the menu says it).

Copy in en and es together; `settings.find.words` gets "show, always, sender, important".

## Tests

- **core** (`people.test.ts`): a shown sender's newest unanswered message waits at every automated level but spam; Cc only, answered, cleared still don't; `person` unchanged; the newest-first walk equals `threadFacts` (the property test with `shown`).
- **store** (`today.test.ts`): `needsYou` takes all of a shown sender's conversations.
- **conformance** (both stores): `shown` add/list/remove/has, the cap, idempotent add; adding requeues the sender's threads (a bulk sender's thread gets `waiting_since`), removing clears it; `waitingPage` keeps a shown sender's conversation the AI read with nothing asked, drops one Done; a merge keeps it.
- **backend**: show removes the sender's mutes and Undo restores both; mute removes the show; the digest candidates leave a shown sender out; the reader reads a shown Promotions sender's mail and trusts a security-desk-named one.
- **web units**: the menu item's label by state; the snack's copy (en, es).
- **e2e** (`what-matters` spec, one `scenario`): right-click a bulk sender's row → Show in What matters → its conversation in Needs you → Undo → gone; the Settings list removes it; axe light and dark on the menu and the list.

## Performance

The facts read one primary-key lookup more for a newest inbound message (cached per context); `needsYou` one more field of the same lookup. Toggling requeues one sender's threads through the existing bounded path. The table holds at most 500 rows. No new reads on the list's hot path; the menu reads a client set.

## Out of scope

- "Mail like this" by similarity; a domain-wide rule (`*@tacsecurity.io`); showing a sender's mail outside Needs you (its own group).
- Changing who is a person (plan 17), the People filter, or the dated reader's prompt.

## Revisions after the Codex review

Codex (read-only) raised 12 points; all are taken, some by narrowing.

1. **The Inbox's hiding came first.** A shown sender's conversation in a Gmail tab its account keeps apart, or in a category hidden from the Inbox, was left out before the rule ran. Taken: Show outranks it in What matters (your word for this sender), in both stores' walks. SQLite reads it through an `addressKey` SQL function (`terno_address_key`, registered with the rule functions), so both stores compare the same key.
2. **The 30-day window stays.** A shown sender's conversation waiting longer than 30 days leaves Needs you, as everyone's does (`WAITING_WINDOW_MS`); "until you answer, Done, archive…" holds within it. Tested: an old conversation isn't brought back by Show.
3. **A prolific shown sender in the 2,000-conversation walk.** Taken as a bound, not a change: the walk is the newest 2,000 waiting conversations of the last 30 days; a sender would have to leave about 65 unanswered conversations a day to push others out. Show is one sender at a time, by hand. The perf gate's mailbox gets a prolific shown sender to hold the walk's cost.
4. **A requeue wakes nothing.** Taken: the backend's Show and Stop send the threads the store recomputed inline through the mailbox's own change path (`notifyChanged`: lists, counts, `todayChanged`), which also wakes the facts worker for a sender past `INLINE_REQUEUE`.
5. **Exact Undo.** Taken, as "Not a newsletter" does it: each entry has an `id`; Stop's Undo puts back the same entry (its `id`, its moment, so its place in the list); Show's Undo removes the entry only if it's still that `id`, and puts back the sender mute Show removed.
6. **Atomic Show and mute.** Taken: one store command each, in both stores. `shown.add` inserts and removes the sender's own mute (not its pair mutes: a pair hides one kind of item, Needs you's line stays). A sender mute added (`dated.mutes.add`) removes a Show. Remove's snack never offers to mute a shown sender (`DatedMutes.offer`), so the mute that removes a Show is only an Unmute's Undo.
7. **Mail already read isn't read again.** Narrowed: Show puts the sender's waiting conversations in Needs you through the facts, which need no AI. The dated reader reads their mail from then on in full. Reading older mail again is out of scope; its line says what the conversation says (subject, snippet) until their next message.
8. **Trust in one place.** Taken: `dated.trusted(keys)` (written to, or shown), both stores, replaces `dated.written` wherever the security-desk guard decides (the reader, `datedRows`, `ofThread`, the history); `dated.written` stays for the mute's "you've written to them". Show and Stop clear the dated rows' cache (`changed`).
9. **The menu's state.** Taken: a small client store (`state/shown-senders.ts`), read once when What matters is offered (not when Settings opens) and kept by a `shownSenders` event every window hears.
10. **The copy.** Taken: "Always show in “What matters”" / "Stop always showing in “What matters”" ("Mostrar siempre en «Lo importante»" / "Dejar de mostrar siempre en «Lo importante»"). The snacks say "“What matters” will always show mail from {sender}" and "“What matters” is back to its usual rules for {sender}".
11. **One line a conversation.** Narrowed: the projection's placement stays authoritative. A shown conversation with dated items shows them as anyone's do (an invoice with two days, two lines), and Needs you's line is its waiting conversation when no item represents it.
12. **IndexedDB read acknowledgments' bodies for nothing.** Taken: a shown sender's conversation skips the acknowledgment's body read ahead, as it skips the check.
