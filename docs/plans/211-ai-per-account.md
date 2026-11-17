# Plan 211: AI without asking, and per account

- **Status:** plan.
- **Builds on:**
  - plan 204, What matters' dated reader and its one-time check of mail already here;
  - plan 142, Follow-ups and its per-account switch, the pattern this copies;
  - plans 147 and 150, the one AI gate;
  - plan 157, summaries on wherever AI runs;
  - plan 210, the feed.
- **Reverses** two of plan 204's decisions from 2026-11-13: What matters is no longer "off by default", and mail already here no longer waits for "the offer … nothing sent without a yes".

## The request

> what happens when the ai features are active and a new account is added, is that account processed for things to add to the feed?

The answer was no. The one-time check of mail already here runs once for the whole app (`dated.scanAnswered`, `followups.scanAnswered`). A first sync's mail is never "live", so no worker marks it. An account added later only gets its new mail read.

> yes do this.
>
> also lets not have amy prompts asking them id they want that email processed with ai, thats just bad, lets just activate it automatically and let them disable ai for a particular account in settings

> lets also add the ability to exclude accounts from putting anything into the feed, that account would be excluded from the feed

The owner's answers, 2026-11-17:
- **"Automatic" covers both:**
  1. The check of mail already here runs without an offer.
  2. What matters and Follow-ups are on by default wherever AI runs, with no "Turn on" offer.
- **An account's AI switch covers everything AI:** none of its mail reaches the provider. That means no summaries, AI categories, Reply ready, drafts, Ask, AI actions, digest, What matters or Follow-ups. Its mail still syncs, and local rules and the local categorizer still run.

## Design

### 1. Two switches per account

Both are `AccountPrefs` in `accounts.provider_config`, beside `followups` (plan 142's path, end to end):
- types in `packages/core/src/types.ts`: `Account`, `AccountPatch`, `AccountPrefs`, `accountPrefs()`, `withAccountPrefs()`;
- the stores' field lists: `packages/db/src/repos.ts` `updateAccount` and `packages/idb/src/mail.ts`;
- `accounts.update` in the contract;
- `handlers.ts`.

The two switches:
- **`ai: boolean`** (default true) is "Use AI with this account". When off, no mail of the account goes to an AI provider for any feature.
- **`feed: boolean`** (default true) is "Show in What matters". When off, nothing of the account is in the feed:
  - none of its dated items, follow-ups or Needs you rows, AI-made or local;
  - its mail isn't read for the feed.

  Its other AI features run as before. `ai: false` implies the feed's AI part is off too: the dated reader and follow-ups don't read it. Its local Needs you rows follow `feed` alone.

**One gate, not ten checks.** A backend `AccountGate` (`packages/backend/src/account-gate.ts`) answers `ai(accountId)` and `feed(accountId)` from a cache of the accounts' prefs. The cache is refreshed on `accounts.update`, account add and remove. Each worker asks it at the place where it already knows the account. The places are listed in "Where each worker asks" below.

Turning a switch off acts at once:
- **In-flight work is aborted.** Requests still waiting are refused when they leave, with `holdingUp` / `underPermission` re-checking the gate. This is the shape of `followups.accountOff`.
- **What it already made stops showing:**
  - the feed's projection drops rows whose thread's account is excluded (feed off, or AI off for AI-made rows);
  - a stored summary of the account's threads isn't shown.

  The stored rows stay in the store until "Clear AI data", so turning the switch back on brings them back. Nothing is deleted behind the user's back.

Drafting by hand on an AI-off account (`ai.compose`, Ask scoped to it) answers with a plain error: "AI is off for this account. Turn it on in Settings → Accounts." The UI hides AI entry points for a conversation of that account wherever it already hides them when AI isn't available (`aiAllowed` in `apps/web/src/lib/ai.ts` gains the account).

### 2. No offers: on by default, mail already here read automatically

**What matters and Follow-ups default to `enabled: true`.** The AI gate still decides whether anything runs: no provider, or no Pro outside a dev build, means nothing is sent (plans 147 and 150). A stored `false` (the user turned it off) stays off.

**Removed:**
- Today's header offers in `today-dated-offer.tsx` (Turn on, and the 14-day check);
- Settings' check offers in `settings/ai-summaries.tsx` (`FollowupsGroup`, `DatedGroup`);
- `useDatedScanOffer`, `answerScan` and `scanOfferText` in `apps/web/src/lib/dated.ts`;
- the `dated.scanOffer`, `dated.scan`, `followups.scanOffer` and `followups.scan` RPCs;
- the settings fields `scanAnswered` (both) and `offerDismissed`;
- their i18n keys (en and es together).

The feed's empty state no longer says "turn on". With AI unavailable it says what it says today when AI isn't set up.

**The check of mail already here becomes the backend's, per account.** Each worker keeps `scanned: number[]` in its settings: the ids of the accounts it has checked. An account is checked when all of these hold:
- the feature is active and the AI gate allows it;
- the account's gate allows it (`ai`, plus `feed` for the dated reader);
- the account finished its first sync (`syncState.lastSyncAt !== null`);
- the account isn't in `scanned`.

When the check is queued, the account goes into `scanned`. The check runs again (the bounds stay as they are) at these moments:
- the worker's start;
- the feature turning on;
- AI becoming available (provider or Pro);
- an account's first sync ending: a new hook in `syncAccount`, where `before.syncState.lastSyncAt === null` and the pass ends idle;
- an account's switch turning back on.

The bounds:
- **Per account:** `scanCandidates(since, limit, accountId)` gains the account in both stores. The SQL and IDB queries filter `account_id`.
- **The dated reader:** 14 days, at most 300 messages, the same filter (`scanPicks`).
- **Follow-ups:** 30 days, at most 300 messages.

A message is never read twice by a check, because `queueScan` ignores what's already marked. A message that already gave an item, or was read live, is skipped by `scanPicks` and the follow-ups candidates: the dated reader through its items' and reads' message ids, follow-ups through "not already tracked". So turning an account back on reads only what wasn't read.

**Existing installs** (a settings migration, pure, as the others):
- `scanAnswered: true` becomes `scanned` = every current account. Nothing already declined is read now.
- `false` or absent becomes `scanned: []`.

### Where each worker asks

| Worker | Where |
|---|---|
| Ingest's live marks (`ingestSliced`, core.ts) | `newMail`, `datedMail` and `liveSent` aren't marked for an account whose gate says no. That's one question per slice: the slice has `pass.accountId` |
| Summaries | `consider` and `request` (`SummarySources.accountId`) |
| AI categorize | `AiAssist.consider`, from the thread's account |
| Follow-ups | `accountWanted` also asks the gate (`ai && feed`) |
| What matters | `consider` after `store.dated.source()`, `holdingUp`, and `scanPicks` |
| Reply ready | `notMuted` / `eligible` |
| Digest | `stillListed` / `candidates`, through `actionFacts.accountId` |
| Ask | `ResolvedSearch.excludeAccountIds`, plus `fetchOlder`'s account loop |
| AI actions | `buildGroups` drops facts of AI-off accounts |
| Drafting | `compose` refuses (see above). `voiceChain` never borrows an AI-off account's profile |
| Voice learner | its account filter also asks the gate |

### Settings → Accounts

`AccountEditor` (`settings/accounts-tab.tsx`) gains two switches above the existing per-account AI ones:
- **"Use AI with this account"**, with the hint "Its mail is never sent to the AI provider."
- **"Show in What matters"**, with the hint "Nothing from this account appears in What matters."

When AI is off, the existing switches that depend on it are hidden: Follow-ups, `prepareReplies` and `useSentMail`. Both new switches show only where AI features are available (the same rule the existing ones use). Every string is in en and es.

## Tests

- **Unit, backend:**
  - The gate's answers and its refresh on update.
  - Each worker skips an excluded account at its seam: one test per row of the table, each failing without its check.
  - Ingest marks nothing for an excluded account.
  - The automatic check: a first sync ending queues that account's check once; a second pass doesn't; an AI-off account is never checked, and is checked when it's turned back on; nothing already read is queued again.
  - The settings migration.
  - The feed's projection hides an excluded account's rows.
- **Conformance (both stores):** `scanCandidates` by account, and the `ai` / `feed` prefs round-trip.
- **e2e:**
  - Settings → Accounts: turning both switches off hides the account's rows from the feed, and turning them on brings them back.
  - The Today header no longer offers anything. Update or remove the specs that drove the offers: today.spec's offer tests, followups.spec's Settings offer, and the `scanAnswered` presets in the feed specs.
- **Perf:** the per-account `scanCandidates` holds `dated-perf.ts`'s bound. The gate is a cached map lookup on the ingest path, with no query per message.

## Out of scope

- A per-account choice of AI provider.
- Showing what the automatic check spent. The AI spend shown in Settings → AI already counts it.
- MCP agents' account scoping (they aren't an AI provider).

## Revisions after the Codex review

Codex read the plan against the code and made 12 points. These revisions override the sections above.

1. **Category examples are mail too.** `AiAssist.categoryRows()` (ai-assist.ts:304) loads examples across accounts: senders, domains and subjects (db/categorize.ts:1073). The examples are filtered to accounts the gate allows, in both stores. The example cache is dropped when a switch changes. Test: classify a mail of account A while account B, with AI off, holds the category's only examples.
2. **The dated reader's open items from the same sender** (`openDatedFor`, db/dated.ts:119) can belong to another account, and they go in the request as `input.open` (dated.ts:1333). They're filtered to allowed accounts before the limit. Test: the same sender in two accounts.
3. **Ask:** the planner gets only allowed accounts' names and addresses (ask.ts:196). An earlier turn whose sources include an AI-off account is left out of `earlier` (ask.ts:185); the history itself isn't deleted. `fetchOlder` skips AI-off accounts.
4. **Drafting gates every source account:** the sending account, and the thread's (`ThreadContext.accountId`). This holds at the shared boundary that manual drafting and Reply ready both use (writing.ts:464, :692). Test: an allowed sending account replying in an AI-off account's thread.
5. **The voice:** `mergeYou()` (voice-learner.ts:649) builds the merged "you" only from allowed accounts' profiles, and rebuilds it when a switch changes. Snapshots already assembled for a draft are dropped.
6. **Withdrawal:** a full permission lease is more than this needs. Each worker asks the gate at `consider`, and once more right before the request leaves, where a re-check already exists (`holdingUp`, the limiter's departure). On-demand requests ask at their start, with every source account (point 4). A switch turned off:
   - aborts what's in flight for that account, as `followups.accountOff` does, for every worker;
   - drops the AI actions' built groups (actions.ts:547).

   The gate's cache is updated before the accounts event goes out.
7. and 8. **"Already read" doesn't exist in the stores.** A successful empty reading deletes its mark (db/dated.ts:254), and Follow-ups' candidates exclude only messages with rows. So the plan's "skip what was read" is replaced by time:
   - Each switch turned off records when, in the account's prefs (`aiOffAt` / `feedOffAt`).
   - Turned back on, the account's check covers only what arrived since then, still within 14 days (30 for Follow-ups). What came before was read, or checked, while it was on.
   - An account never checked gets the full window.
   - Write order: the queue first, then `scanned`. A crash between the two queues again, and `queueScan` ignores what's already marked.
   - **Accepted loss:** marks that a switch dropped mid-check aren't re-made.
9. **First sync while connectivity changes:** a first pass can end `offline` with `lastSyncAt` written (core.ts:2222), so "before null, ends idle" can miss it. Instead, after every pass that ends with `lastSyncAt` set, the backend reconciles. It checks any account that is allowed, synced and not yet in `scanned`. That's a set lookup in memory, so it's cheap.
10. **Migration:** the pure settings `migrate()` runs on every read (settings.ts:145, :276), so it can't snapshot accounts. Instead a versioned one-time backend step at startup, before the workers start, writes `scanned` = the current accounts where `scanAnswered` was true, and stamps its version. Test: upgrade, add an account, restart. Only the original accounts count as checked.
11. **IndexedDB scans** walk every message and sort (idb/dated.ts:102, idb/followups.ts:111). The per-account query uses the account and date index, bounded, with no full sort. The perf conformance runs both workers on several accounts, with most of the mail in another account.
12. **The feed's other paths:**
    - The account filter applies to open rows, counts (today.ts:588), history (`historyPage`, today.ts:666), reminders and the digest's inputs.
    - An `accounts.update` that changes `ai` or `feed` tells Today to recompute and announces it (handlers.ts:1388).
    - The tests set `feed=false, ai=true` and `ai=false, feed=true` separately, including local Needs you rows, never both at once.

## Part 1, built

Design §1, "Where each worker asks", Settings → Accounts, and revisions 1–6 and 12. §2 and revisions 7–11 are part 2's; part 1 only records `aiOffAt` / `feedOffAt`.

**What changed:**
- **The switches.** `ai` and `feed` in `AccountPrefs`, on plan 142's path: `Account`, `AccountPatch`, `accountPrefs()`, `withAccountPrefs()`, the contract and the handler. Turning one off records `aiOffAt` / `feedOffAt` (the handler passes `offAt`, a backend-only patch field). The first moment is kept while it stays off, and kept again when it's back on, for part 2. The stores share one test of what a patch keeps in the config, `patchesAccountPrefs()`, so a new preference can't miss one of them.
- **The gate.** `packages/backend/src/account-gate.ts` holds a map of each account's switches. It answers `ai()`, `feed()` and `reads()` (both on), and lists `aiOff` / `readsOff` / `feedOff` for store filters. An account it hasn't heard of is on. It's filled at `init()` (before any worker starts). It's refreshed in `emitAccounts()` before the event goes out, and by `accounts.update` right after the write (`put`). A change is told synchronously to `BackendCore.switchesChanged`, which:
  - AI off: aborts in flight in summaries, Reply ready, Ask, AI actions (`invalidate`) and drafting;
  - AI or feed off: aborts in follow-ups and the dated reader;
  - always: drops the category examples and the voice snapshots, merges "you" again, and recomputes and announces Today and the digest.
- **The seams** are as the table says, plus revisions 1–5. Two of the store reads gained an account filter, in both stores, applied before the limit (conformance in both): `categorize.categoryEvidence({ excludeAccounts })` and `dated.openFor({ excludeAccounts })`. `DigestFact` gained `accountId`. A filter only applies when some account is off, so the usual path reads nothing more.
- **The feed** (revision 12). `TodayService` filters by account only while some account is out, with one batched `actionFacts` read:
  - AI-made rows (dated items, promises, digest lines, history) need `reads()`;
  - local rows (Needs you, your reminders, the automated list) need `feed()`;
  - a waiting row's summary line needs `ai()`.

  The dated rows are filtered inside their generation cache, so the count path stays as it was.
- **UI.** `AccountEditor` shows the two switches (with the plan's copy, en and es) where AI features can run (`aiFeaturesOffered`, Today's rule). With the account's AI off, it hides Follow-ups and the whole `AccountWriting` block (instructions, Reply ready, use general instructions). The settings search index follows the same rules. In `lib/ai.ts`, `aiAllowed`, `summariesOffered`, `followupsOffered` and `repliesOffered` take an optional account. The reader, the thread's items and follow-ups, and the palette's Summarize pass the conversation's account. `canDraft` / `useCanDraft` take the draft's account and its conversation's.

**Decided differently, and why:**
- **`useSentMail`** has no per-account switch in Settings, so there's nothing to hide. What the account's writing settings hold (instructions, Reply ready, use general) is hidden as a block instead.
- **The hint copy** is the plan's as written. Beside an "on" switch it describes what "off" does. The neighbouring Gmail switch says "On: …". This is worth the owner's look.
- **Drafting withdrawal** (Codex code review 3) aborts every drafting request in flight when any account's AI goes off. It doesn't track each request's source accounts. A draft can carry another account's mail through its conversation, a borrowed voice or a contact. The moment is rare, and asked again, the request goes without that account.
- **"You"** (revision 5, code review 4): until the learner has merged it again, a draft leaves out a "you" merged from an AI-off account. It leaves out a "you" judgment whose last study read one, until a study that didn't.
- **Ask's earlier turns** (code review 6) are filtered by what each turn drew on (`AskTurn.accountIds`, from the stored `account_ids_json`), not only by what it cited. The accounts named to the planner are tracked apart (`Asking.named`), so the history's provenance isn't widened by them.
- **The dated reader** (code review 5) aborts a reading that carries any open item when an account goes off. Read again, it goes without that account's items.
- **The follow-ups list** (the sidebar's view, not the feed) still shows an AI-off account's promises. Its notices don't fire, and the reader hides them. Plan 211 names only the feed.

**Codex code review** (11 points, all fixed with a regression test that fails without the fix):
1. `ai.readDraft` takes the draft's account and conversation, and refuses.
2. `resolveIntent` refuses for an AI-off sending or thread account. The contact index's `resolveExact({ excludeAccounts })` leaves out anyone known only through excluded accounts.
3. Drafting in flight stops on any withdrawal.
4. "You" is withheld.
5. A dated reading with another account's open items stops.
6. Ask's provenance.
7. Ask's planner accounts.
8. Follow-ups don't announce a hidden promise.
9. An open digest page hears `todayDigest` on every switch change.
10. Drafting controls follow the draft's accounts.
11. The follow-ups withdrawal test now asserts the abort at the provider, before any answer.

**Tests:**
- Unit, one per seam, in each worker's file. A sample of them was checked to fail with the check removed.
- `account-gate.test.ts`: the gate, the ordering before the event, ingest.
- Conformance in both stores: the prefs round-trip, `openFor` and `categoryEvidence` by account, and `DigestFact.accountId`.
- e2e, one test in `what-matters-feed.spec.ts`: `feed=false` with AI on, and `ai=false` with the feed on, with a local Needs you row.
