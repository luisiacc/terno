# Plan 228: names people give themselves

## Request (verbatim)

> Bug 2: autocomplete suggests your own address under someone else's name
>
> **Repro:** a received email addressed the user's own address with a different display name, e.g. `To: "Dianela Mompie" <lccpacc@gmail.com>`. Composing to lccpacc@gmail.com and pressing Enter takes the top suggestion, so the sent header becomes "Dianela Mompie <lccpacc@gmail.com>". The reader then shows "To: Dianela Mompie" and "Reply to Dianela" on mail to yourself.
>
> Expected:
> - The user's own addresses (every connected account and its aliases) are always named by the account's own display name, never by names other people typed.
> - More generally, the name someone uses in their own From is stronger evidence than a name others put on them in To/Cc. Decide how far to take this without breaking existing name quality, and record the reasoning in the plan.
> - Existing contacts that already carry a wrong name for an own address must be corrected. Use the backend's background slices if data work is needed (plan 112: a migration changes shape only).
> - Both stores (SQLite `packages/db` and IndexedDB `packages/idb`) behave the same.

## What exists (verified)

- The recipient index (`packages/store/src/autocomplete/contacts.ts`, plan 18) is one in-memory model for both stores, built in slices from the store's messages and saved as a snapshot file; both stores feed it through `AutocompleteSource`. No table holds contacts.
- `touch` credits every display name in the To/Cc of received mail to that address (`addName`), at the full weight of the message; the most-used name is shown, two others stay searchable. The user's own addresses are no exception.
- A sent message's From marks its address as yours (`OWN`, an alias or an old address), and its name counts only when the contact is created by it; an account's address seen first in someone's To keeps their name.
- `setOwn` gets only the accounts' addresses. An own address is suggested only when typed in full (then with the stored name), so a full address and Enter took "Dianela Mompie".

## Design

### How far: names people give themselves win

Evidence ranks in two tiers:
1. **Self-named.** The name in a message's From is the one its sender chose (their client, their account). For your own addresses, your account's sender name (the From Terno writes, `Account.senderName`), else the From name of mail you sent from it.
2. **Named by others.** Names in To and Cc, received or sent. Sent ones are no better: reply-all copies other people's To/Cc names, and the rest came from this index's own suggestion.

A shown name from tier 1 is never replaced by one from tier 2; within a tier the most used wins, as before. A tier 2 name is still shown for someone who never wrote to you (all the index knows), and kept searchable beside a tier 1 one (finding Bob by "Finance" still works).

Why not further: weighting by recency inside a tier, or preferring names the user typed, would change rankings people are used to with no bug behind it. A From name can be poor ("BOB", "Bob at Acme"), but it's the one that person's own mail shows in the list and the reader, so the composer agrees with what the user sees.

### Your own addresses

- `setOwn` takes the accounts' addresses with their sender names (`{ email, name }`; the core passes `senderName`). The index keeps them beside its `own` set.
- What an own address is called (`hit`) is read at answer time: its account's sender name; else the self-named one (the From you sent from it: an alias); else none (the bare address). Never a tier 2 name. An edited sender name applies at once (the core sends accounts again, as now).
- Read at answer time, an existing snapshot's own addresses are correct as soon as it's restored: no rebuild needed for the bug itself.

### Data

- A contact flag `NAMED` (bit 32 of the existing `flags` byte): the shown name is self-named. Alternates carry `self` (a new `altSelf` snapshot section, a byte each).
- `addName(id, name, w, self)`: a self-named name ranks above any other name. Up to two alternates of each tier are kept (see the revisions), so a self name always finds room and nothing is replaced.
- Older snapshots can't tell the tiers apart, so the snapshot format moves to 6 and older ones rebuild once, in the background slices the service already builds in (as formats 4 and 5 did). Nothing in either database changes; no migration.

## Tests

- `contacts.test.ts` (each fails without the fix): an own address named in someone's To keeps the account's name (and is shown with no name when the account has none, never theirs); the account's name changes when `setOwn` says so; an alias you sent from is named by your From; someone's own From name beats a heavier To/Cc name, and stays searchable by the other; a To/Cc-only contact still gets the To name; a self name finds room when the alternates are full; the snapshot keeps the tiers (restore then a heavier To name doesn't replace the From name); a format-5 snapshot is refused (rebuild).
- `conformance/autocomplete.ts` (SQLite and IndexedDB): the repro through each store and the service: received mail `To: "Dianela Mompie" <me0@…>`, the account's sender name `Me Zero`, typing `me0@example.com` suggests `Me Zero`.

## Performance

- Per message, one more flag test and, for a sent message, an `addName` for its From (a fold and a compare). The build (`autocomplete.perf.test.ts`, both stores) and the catch-up gate (150 µs a message) stay within budget.
- `hit` adds a flag test, and a map read for own addresses only.
- The snapshot gains a byte per alternate.
- The one rebuild after the update runs in slices like any cold build (the 32 ms stall gate); suggestions answer as soon as it's done.

## Out of scope

- The reader and Reply show what the header says (`message-head.tsx`). Mail already sent with a wrong name keeps it; no new mail gets one.
- Gmail send-as aliases Terno hasn't seen you send from: they're no one's yet (not `OWN`).

## Revisions after the Codex review

Codex read the plan against the code (eight points):

1. **Aliases by the account's name?** The request names aliases with the account's display name. The index doesn't know which account owns an alias (it learns one from a sent From, with no owner), and an alias often carries its own identity ("Terno Support" sent from a personal account), where the account's personal name would be wrong. Decision: an alias is called by the name you sent from it under, which is your own name for it and never one others typed. This is a deliberate reading of the request; the account addresses themselves follow the account's sender name.
2. **A received From for your own alias** counts as your name for it, like a sent From: mail from your address is yours. Kept; noted.
3. **Weights and spelling across tiers.** Once a name is used by the person themselves, only their own uses of it count (others' uses no longer add), and their spelling replaces the other's ("JOSE GARCIA" in To, "José García" in their From: the latter). Test: "José García"; a name others used a hundred times and he once loses to one he used twice.
4. **Replacing an alternate left its tokens indexed** (postings are append-only). No replacement now: alternates hold up to two names of each tier, so nothing is discarded and no stale token exists. At most five names a contact.
5. **Warm-up race**: the core gave the index the accounts only once warmed, and warming reads them before it's warmed, so a sender name edited in between was lost. The core now always passes the accounts (cheap: a list kept until the index exists).
6. **An account never seen in any header** has no contact to suggest; typed in full, the address is taken as typed, with no name. Out of scope: no wrong name results.
7. **Perf fixtures** use one name per address. The added work is one fold compare per name and a filter over at most four alternates; the build and catch-up gates stay as they are. Memory: a boolean per alternate, a map of the accounts' names.
8. **The upgrade path through both stores**: new conformance case (SQLite and IndexedDB): a contacts snapshot of format 5 is rebuilt (not restored), names your address by the account, is saved as format 6 and restored on the next start, and an alias seen after the restore is named by your From.

## Codex code review

Three findings, each fixed with a test that fails without it:

1. **A name others gave that became their own escaped the alternates' bound.** Its promotion freed a place for another of the other kind, so a To then From of a new name each time grew the list without end (and own addresses are never evicted). The alternates now also stop at four in all (`MAX_ALTS`). Test: fifty names given then used, at most four kept.
2. **An account's sender name equal to its address's local part was dropped** ("John" for john@example.com), as a header's placeholder would be. The account's own name only has to be a name, not an address. Test: "John" is kept; the address itself isn't a name.
3. **A name respelled their way could lose its words.** Spellings that fold alike can split into different tokens (O＇Brien with a fullwidth apostrophe is one word, O'Brien another), and only the first spelling was indexed. The tokens the new spelling adds are indexed when it takes over, as the shown name or an alternate. Test: "obrien" finds Sean O'Brien after "Sean O＇Brien" was the name others used.

## Tests run

Typecheck (store, mail, backend, db, idb) and lint on the touched files. Unit: `contacts.test.ts`, `resolve-exact.test.ts`, the rest of `packages/store/src/autocomplete`, `apps/web/src/lib/recipients.test.ts`, `backend/src/autocomplete.test.ts` (the warm-up race, over RPC). Conformance in SQLite and IndexedDB (`autocomplete.conformance.test.ts`). Perf: `autocomplete.perf.test.ts` in both stores (build, cold start, catch-up) pass.
