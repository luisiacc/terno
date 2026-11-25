# Plan 278: who is a person, corrected

- **Status:** planned.
- **Builds on:** plan 17 (People, waiting for your reply), plan 240 (a sender rule in the sender's menu, exact Undo).

## The request

The owner, looking at the People filter on their own mailbox (IusPro, Tilopay, BN Contacto Digital, Apple Support listed as people):

> not sure if this is accurate because i'm seeing here things that are not people

Three fixes were proposed: (1) recognise mail sent through bulk-sending services by its Message-ID, (2) catch role words glued to a prefix (`bncontacto`), (3) a per-sender "Not a person" / "Is a person" in the menu. The owner: "lets do fixes 1 and 3, we won't do 2."

No sending service documents its Message-ID format (SES says only that it replaces the Message-ID with its own value). Asked whether that breaks the rule against building on undocumented provider behaviour, the owner chose **"Message-ID, as a heuristic"**: the same kind of observed convention as plan 17's role words and sending subdomains. If a service changes its format, the guess stops catching its mail and nothing breaks.

## What exists

- **Who is a person** (`packages/core/src/people.ts`): `automatedLevel(m)` is 2 (never a person: spam, a list, bulk headers, Promotions/Social/Forums, no-reply), 1 (a person only if you've written to them: Gmail's Updates, a role word, an automated domain, a sending subdomain) or 0. `senderIsPerson(m, ctx)` applies it. `decide` sets a thread's `person` from its newest inbound visible message, and `waitingSince` only for a person (or a shown sender, plan 240).
- **Its readers:** the People filter (`threads.person`), the "to reply to" count and filter and Needs you (`waiting_since`), the dated reader's and AI summaries' `person` flag per message (`datedSource`, `ai-summaries`, both stores).
- **What the owner's mailbox shows** (a copy, counts only): 939 conversations judged a person. 371 of them have a newest inbound message whose Message-ID is Amazon SES's (`…@email.amazonses.com`, 157) or SendGrid's (`…@geopod-ismtpd-54`, 213), plus one Postmark. Every one of them is an app, a bank or a government service: IusPro (124), Tilopay (204), Acubliss, BNCR, Hacienda, Disney+. Several have role addresses you've written to (`hello@iuspro.com`, `sac@tilopay.com`), which plan 17's "written to" rule turns into people. The 568 left are mostly people (gmail.com, law firms, clients), plus BNCR's own server (54) and a few more: the cases the rule can't see.
- **The model for a sender rule:** plan 240's `shown_senders` (both stores, `addressKey` primary key, an `id` for exact Undo, `requeueSender` recomputing that sender's threads inline or as a background job), its RPC, its client store, its menu item in `SenderItems` and its Settings list.

## Design

### 1. Sent by a service (heuristic)

`sentByService(rfcMessageId)` in `people.ts`: the Message-ID's domain, lower-cased, is one a sending service puts there:

| Service | The Message-ID's domain |
|---|---|
| Amazon SES | ends in `amazonses.com` |
| SendGrid | starts with `ismtpd` or `geopod-ismtpd` |
| Postmark | ends in `mtasv.net` |
| SparkPost | ends in `.sparkpost` or `sparkpostmail.com` |

That's a short, checked list from what the mailbox shows. Marketing services (Mailchimp, Klaviyo…) are left out: their mail always has bulk headers already.

`automatedLevel` returns **2** for it: never a person, even when you've written to the address. A person writing to you doesn't send through these services; an app does, from whatever address it likes (`hello@`, `sac@`). Writing to that address once (to support) shouldn't turn the app's receipts into people. The per-sender rule (§2) is the way back for anyone the guess gets wrong.

`SenderSignals` gains `rfc_message_id: string | null`, **required**, so every caller that judges a message passes it, and one that judges only an address (`weakAddress`, `noteSentMail`'s requeue, follow-ups, dated mutes) passes `null` as it passes `list_id: null`. SQLite's `FACT_COLUMNS` reads `rfc_message_id` (a short column of a row it already reads); IndexedDB's rows have it. `datedSource` and the AI summaries' rows select it too.

**Mail already stored:** the rules carry a version, `PEOPLE_RULES_V` (core, now 2). Each store keeps the version its facts were computed with (`settings.facts_rules`, absent = 1). The facts' backfill slice compares them first: when they differ it starts a rescan (`startRescan`, plan 17's bounded slices) and writes the new version in the same transaction. A database that hasn't computed anything yet (`senders`) only writes it. A later change to the rules bumps the number.

### 2. Your word on a sender

A table of its own, `person_rules` (both stores): `key` (an `addressKey`, primary), `id` (for exact Undo), `email`, `name`, `person` (1: a person, 0: not; a boolean, so a CHECK), `created_at`. At most 2,000 (`PERSON_RULES_MAX`); past it, a plain error, as plan 240's. SQLite: a create-only migration; IndexedDB: a new store and a version bump.

- **Facts:** `FactContext.rule(key): boolean | undefined` (one primary-key lookup; SQLite asks only once a context knows the table has rows, as `shown` does). `senderIsPerson`: spam is never a person; then your rule decides; then the levels as before. So "Not a person" takes a sender out of People and out of "to reply to"; "Is a person" puts a list or a service sender in both. Plan 240's "always show" is unchanged and separate.
- **Everywhere `senderIsPerson` is asked:** the dated reader's and the AI summaries' rows read the rule too, so one sender is judged one way.
- **Store:** `store.people.rules`: `list()` (newest first), `set({ email, name, person, id, at })` → `{ set, prior, threadIds }` (`prior`: the rule it replaced, for Undo), `remove(key, id?)` → `{ removed, threadIds }` (only that `id`'s, when named). Each is one command that requeues the sender's threads (`requeueSender`).
- **RPC:** `people.setRule`, `people.removeRule`, `people.rules`; a `personRules` event every window hears; the threads recomputed inline go through `notifyChanged` (lists, counts, What matters), as plan 240's do.

### 3. UI

- **The menu** (`SenderItems`: a row's right-click More ▸ From {name}, and the reader's sender menu): one item, the opposite of what the sender is now:
  - a person now → **"Not a person"** (es "No es una persona")
  - not a person now → **"Is a person"** (es "Es una persona")

  "Now" is your rule when there is one (a client store, like `state/shown-senders.ts`: read once, kept by the event, read again on reconnect). Without a rule, it's the judgment the caller already has: the row menu's rows (`person`, when every row shares the sender), the reader's `thread.person` when the menu's person is the conversation's newest inbound sender. Where neither is known (the reader menu of someone further up the thread, with no rule), the item isn't offered. Never a request per menu.
- **The snack:** "{sender} won't count as a person" / "{sender} counts as a person now" (es "{sender} ya no cuenta como persona" / "{sender} cuenta como persona"), with Undo and `z`: it puts back the rule that was there before (`prior`), or removes the new one (only that `id`).
- **Settings → General → People:** the rules, newest first: name, address (muted), "Not a person" or "A person", and a remove × ("Back to automatic", with Undo). Not drawn when empty. `settings.find.words`: "person, people, sender, not a person".
- **The People chip's tooltip** stays as it is.

Copy in en and es together.

## Tests

- **core** (`people.test.ts`): each service's Message-ID is level 2, written to or not, any case; a person's Gmail or Outlook Message-ID isn't; a rule overrides every level, both ways; spam stays not a person with a "person" rule; the newest-first walk equals `threadFacts` (the property test, with service Message-IDs and rules).
- **conformance** (both stores): `people.rules` set, replace (prior returned), remove by `id` only, the cap; set and remove requeue the sender's threads (a service sender's thread leaves People and "to reply to", "Is a person" brings it back); a stored mailbox computed with version 1 is rescanned once to version 2 (an SES thread from someone you've written to stops being a person), and a second open does nothing.
- **backend:** set and remove send `personRules` and refresh the counts; Undo puts back the prior rule exactly.
- **web units:** the item's label by rule, by row judgment and hidden when unknown; the snack copy (en, es).
- **e2e** (one `scenario`, in the people spec): People on → right-click a row from a service-like sender with no rule → "Not a person" → the row leaves → `z` brings it back → do it again → Settings → General lists it → remove → back to automatic; axe light and dark on the menu and the list.

## Performance

- The facts read one more short column per message (SQLite), and one primary-key lookup per newest inbound message once any rule exists (most mailboxes: none, one cached probe a context).
- The rescan after the version bump is plan 17's existing bounded, sliced rescan, once per mailbox. The existing facts perf gates (`facts.perf`, both stores) cover its slices; they run after the change.
- The rules table holds at most 2,000 rows; the menu reads a client set.

## Out of scope

- Role words glued to a prefix (`bncontacto`): fix 2, not wanted.
- Notifications' importance (`attention.ts`): judges a message with its own rule; it passes `null` and stays as it is.
- A domain-wide rule (`*@bncr.fi.cr`), "people like this", AI.

## Revisions after the Codex review

Codex (read-only) raised 12 points. All are taken, some by narrowing. These override the sections above.

1. **The version check never ran on an idle mailbox.** The facts runner stops when `facts.idle()` is true. Taken: a stale rules version on a mailbox with threads makes the facts not ready (`factsReady`, both stores), so the runner starts. Its first slice writes the version and schedules the rescan in one transaction. A fresh database with no thread writes the version without a rescan. Tests run the real runner over an idle version 1 mailbox, interrupt it after the first commit, and reopen it.
2. **`startRescan` also restarts the Gmail and Outlook tab walk.** Who is a person decides no tab. Taken: `scheduleRescan` (facts only) is split out; `startRescan` stays it plus the tab refresh for a change to your addresses.
3. **The Message-ID in `FACT_COLUMNS` widened every ingest row.** Taken: `FACT_COLUMNS` stays narrow. `decide` reads the inbound message's Message-ID through `details` when the row left it out (one primary-key read a thread, SQLite), reusing it for the waiting check when that message is also the newest. `FactRow.rfc_message_id` is optional again: undefined means not read. `SenderSignals` keeps it required. `ingest.perf` runs too.
4. **Undo had a race.** Taken: one conditional store command, `rules.restore(key, expect, to)`. It puts back `to` (or no rule) only when the sender's rule is still `expect` (an `id`, or none), so a later change from another window stays. The restore goes past the cap if it must, as an exact Undo does. At the cap, changing an existing sender's rule is allowed; only a new sender is refused, with a plain error (`errors.personRules.full`).
5. **A large sender's requeue changed nothing visible.** Taken: every successful change calls `threadsChanged` (`notifyChanged`), even with no thread recomputed inline, which also wakes the facts' sender job. Conformance covers a sender past `INLINE_REQUEUE` whose threads flip once the job drains.
6. **Guessing the menu's label could act on the wrong address.** The row's sender (`last_from`) isn't always the message the facts judged, and several selected rows can disagree. Taken, by changing the design: the menu no longer guesses. It's a submenu **"Counts as a person"** (es "Cuenta como persona") with three radio items: **Automatically** (no rule), **Always** (a person), **Never** (not a person), checked by the rule alone (the client store). It acts on the sender the menu names, and is disabled until the rules are read.
7. **The dated reader would half-honour the rule.** Its role-address check and automated time-cue gate decide apart from `person`. Narrowed: your rule decides plan 17's facts (People, "to reply to", Needs you). The dated reader and AI summaries take the Message-ID signal (it's part of `automatedLevel`) but not the rule. That's listed under Out of scope.
8. **What a rule does and doesn't change.** Stated: "Never" takes a sender out of People and out of waiting as a person, but an "always show in What matters" sender (plan 240) still waits there, by its own rule. "Always" makes a sender a person; the usual reply checks (answered, Cc only, the 30 days) still apply, and Needs you keeps its own criteria. Tested: Never plus Always show. The People chip's tooltip stays. It describes the filter's usual rule, and an explicit choice is the user's own.
9. **Settings needs search and focus.** Taken: the list gets a search-index entry (`general.personRules`) and a `find` target on its group, which is shown only when rules exist. Removing a rule moves focus to the next rule, else the previous one, else the group's heading control (the list's pattern from `ShownList`). The remove button is the list's link-style button with the sender's name as its description.
10. **The e2e started from a row the filter had already hidden.** Taken: "Never" on an automatically included sender (it leaves People, `z` brings it back, then Settings removes the rule), and "Always" on a service sender from All (it appears in People).
11. **Gates.** Taken: a version 1 → 2 rescan case in both stores' facts perf gates (a populated mailbox, rules present), the SQLite migration and the IndexedDB upgrade tested on stored data, and `pnpm test:all` (a schema change). UI rating: the change adds a submenu and a Settings list, not a main screen's look, so `ui:rate` doesn't apply. Screenshots of both, in light and dark.
12. **The Message-ID match was loose.** Taken: exact domains or their subdomains (`amazonses.com`, `mtasv.net`, `sparkpostmail.com`, `sendgrid.net`), and SendGrid's bare host only as `ismtpd` or `geopod-ismtpd` followed by digits and dashes (no dot). Tests cover near misses (`notamazonses.com`, `ismtpd.example.org`), brackets, case, malformed IDs and null.
