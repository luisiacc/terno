# Plan 114: follow a message another mail app moved, when that is provably safe

- **Status:** shipped.
- **Builds on:** plan 45 (IMAP identity holds: fail closed), plan 68 (sweeps, resets), plan 107 (folder renames).
- **Request (verbatim):** "yes check it and fix it if they don't , also check if that worktree is even active". It answered: "A message another mail app moves (Inbox → Archive) stays stuck in Terno's Inbox… How should Terno follow these moves?" The chosen answer was "Follow when provably safe (Recommended)": "Treat the new copy as the same message only if it's the single match (same Message-ID, size and arrival date, all of which an IMAP move keeps) and nothing is queued for it. Anything ambiguous, or with a queued action, stays held as today. Categories and cached content are kept, and queued actions are never redirected."

## 1. What existed

- **Found while testing plan 112 §9.** A message another app moves loses its old place at the next sweep and is held (`imap_identity_holds`, no owner). The copy in its new folder is withheld, because its Message-ID names a held message. The conversation stays in the Inbox with no place on the server, indefinitely. The same happened after a UIDVALIDITY reset (plan 107's known edge case) and after a rename by another app.
- **Plan 45 was deliberately strict.** Its contract required a COPYUID mapping from a move of Terno's own. Message-ID, envelope or bytes never rebound a message, so that a queued action could never reach the wrong mail.
- **The other branches don't cover this.** `t3/imap-move-identity-reconciliation`, `t3/imap-move-identity-safety` and `t3/imap-identity-recovery` were inactive: last commits Oct 30–31, nothing running, 277–824 commits behind `main`.
  - The recovery branch only recovers a message that still has another proven copy.
  - Its own notes say external moves "with no trusted survivor stay held".
  - It is parked as not landing-ready, with two open performance findings.

## 2. Design

`ImapLocationStore.adopt(messageId, place, expect)` runs in one transaction in both stores. A held message takes the new place, and its hold goes, only when all of these hold:

1. **A hold of a lost place.** The owner is null, so no command of ours is in flight for it.
2. **No place left anywhere.** A message still placed somewhere is never moved by inference.
3. **The place is free.** No other message has that mailbox, UIDVALIDITY and UID.
4. **The same mail.** The stored Message-ID, size and date equal the copy's. IMAP MOVE and COPY keep all three. Sender and subject are already equal (the provider id lookup checks them).
5. **The only message of the account with that Message-ID.** A duplicate, whether two copies or two different mails, stays held.
6. **Nothing of ours pending for it.** No op targeting it is `queued`, `running` or `unknown`. A finished one doesn't block it.

Otherwise it returns false and writes nothing, and the arrival is withheld as before.

The IMAP read (`syncMailbox`) asks only when the arrival has a Message-ID, its provider id names a held message, and that message is the only candidate. On success the message is touched (its flags and folders reconcile in the same pass) and introduced. Queued actions are never retargeted: one that waits for identity resumes through `resumeResolved` like any other.

**Cost:** one extra indexed lookup for an arrival whose Message-ID is already stored, and nothing on the common path.

## 3. Tests

- **Store conformance** (`packages/store/src/conformance/imap-adopt.ts`, SQLite, IndexedDB and SQLite-WASM): adopted when every rule holds. It refuses a different size, date or Message-ID; a duplicate Message-ID; a message still placed; a message never held; a taken place; an op queued, running or unknown. It adopts once the op finished.
- **Real IMAP** (`imap-move-identity.int.test.ts`, plan 114 block):
  - Inbox → Archive, by the server and by another client's IMAP MOVE: the same message id, body and conversation, now in Archive and out of the Inbox. A later markRead reaches that copy.
  - A different mail with the same Message-ID (another size) stays held.
  - A renumbered mailbox: found again in place.
  - These fail without the change, except the negative control.
- **Tests that encoded the strict rule, updated:** each still checks what it protected (no replayed MOVE, no trust in an invalid COPYUID, never the other folder's message under the same UID, a dropped message stays held, ids, bodies and categories kept). The "held forever" expectation became "found at its own copy":
  - `imap.int.test.ts`: other clients' moves, a reset, a reset during the first sync, an external move and rename, R3, R4, both R9 cases, and STATUS-unchanged.
  - `imap-move-identity.int.test.ts`: the unmapped MOVE and the four invalid-COPYUID cases. Each message is now found at the copy holding its own bytes.
  - `imap-folder-identity`, `imap-old-flags` (both CONDSTORE settings) and `folder-actions` (renames under a new UIDVALIDITY).
- **Plan 112's upgrade-sync test** includes the external move again.

## 4. Limits

- **A rename that changes UIDVALIDITY takes one more pass.** This covers a rename by Terno on a server that gives the folder a new UIDVALIDITY, and a rename by another app. The pass reads the new folder before it retires the old generation's places, so the copy is set aside once and found by the next pass, seconds later.
- **ID-less mail stays held.** An envelope alone never proves identity.
- **Two copies with one Message-ID stay held.** Telling them apart would need the bytes.
- **An action of ours whose outcome is unknown keeps its message held.** It may have reached the server.
