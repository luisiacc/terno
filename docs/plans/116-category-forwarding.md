# 116: Forward what lands in a category

## Status

- Built and committed: storage (SQL v44, IDB 24), the backend queue (`packages/backend/src/forwarding.ts`), RPCs, conformance (`packages/store/src/conformance/forwards.ts`) and backend tests (`forwarding.test.ts`).
- Next: the UI (category menu panel, sidebar icon, notice with Cancel, reader line, the cap's question, the builder's "Forward to", Settings → Filters group), e2e, then the Codex code review.
- Deviations from the design, decided while building:
  - A forward is decided after each commit from persisted state (`forwards.plan`, called by ingest, a body's arrival, a single filing, and a sweep at start), not inside every store transaction: the claim at 10 s re-checks everything in one transaction, so a crash between can only miss a forward, never send a wrong one, and the start's sweep finds what a crash missed.
  - "Bulk vs single" is the caller's: the handlers plan only a single hand filing (`filed`), a suggestion, an agent's (when agents may send); memberships made after the mail arrived by `user` or `bulk` count only through `filed`.
  - A filter's match counts when it came within 10 minutes of the mail's arrival (`FORWARD_FILTER_LAG_MS`): applying a filter later never forwards.
  - Loops: no `X-Terno-Forward` header. Mail from any of the user's addresses never becomes eligible, a forward never goes to its own sender or to the user, each (message, address) goes once, and the daily cap stops anything that still runs away.
  - Forwards are text, like the composer's Forward (whose HTML is that text's rendering); the original's HTML isn't forwarded.
  - A restart sends what was due at once (no fresh 10 s); a half-sent forward finishes, each send fenced.

## Request (verbatim)

> have triggers on categories to forward to a certain email when it lands on a category

Agreed while grooming (the user's answers to the open decisions):

> 1. ai filings in the future, should forward
> 2. have 10 seconds, not configurable
> 3. can be more than 1, no limit
> 4. both
> 5. free

So: mail the engine or the AI files into a category from now on is forwarded; every forward waits 10 s and can be cancelled; a trigger has any number of addresses; it is a category setting *and* a filter action ("Forward to"); it is in Free.

## What exists

- **Categories are Terno's own.** They are not Gmail labels or IMAP folders, so the mail server can't forward on them. Gmail's server-side forwarding also needs each address confirmed by its owner and the restricted `gmail.settings.sharing` scope. Forwarding has to run in Terno, while it runs.
- **How a thread joined a category** is recorded: `thread_categories.added_by` is `user | filter | agent | suggestion | auto | bulk` (SQL migration, the same values in IDB).
- **Ingest** (`Core.ingestSliced`) commits messages, filter claims and actions, and the categorizer's decisions in one store command per slice. Its result has `auto: Map<categoryId, threadIds>` (engine auto-adds, plan 02), `backfill` (old threads that arrived), `uncertain` (handed to the optional AI assist, `ai-assist.ts`, which may add a category after commit).
- **Filters** (`rules/schema.ts`): actions are `archive | trash | spam | markRead | star | addCategory`; at most one location action. `filters.apply` runs a filter over existing mail in background windows (plan 89). Filters made for you are `auto: true` (plan 90).
- **Forward** is built in the renderer: `quoteFor("forward")` (`compose-fields.ts`) writes `compose.quote.forwarded` (From, Date, Subject, To) and the original's text; `replyFields` adds the original's stored files (`storedRefs`, an `assetId` per part). `compose.send` takes `forwardOfMessageId` and `attachments`. The HTML alternative is the composer's text rendered (plan 16); the original's own HTML is not forwarded today.
- **Sending** goes through `store.compose.queueSend`: the local Sent copy, the `send` op and its receipt (plan 65, at most 128 reserved).
- **Scheduled sends** (plan 94, `scheduled.ts`): one backend timer for the soonest row, none when there are none; a snapshot event to the windows; permanent vs retryable failures, failures kept until seen. The 10 s wait follows this pattern.
- **Files may not be captured yet** when a message is ingested (`attachmentState: pending`). Plan 60 forwards regardless and adds files as they arrive.

## Design

### 1. The model

A **forward rule** says "send new mail matching X to these addresses". It has two sources:

- **A category trigger**: `category_forwards (category_id PK → categories ON DELETE CASCADE, addresses_json, enabled, enabled_at, created_at)`. One per category; any number of addresses (validated with the existing address parser, deduplicated case-insensitively).
- **A filter action**: `actionSchema` gains `{ type: "forward", to: Address[] (min 1) }`. It can sit beside any other action, including a location ("Forward to accountant and archive"). `sameRule` and the dedupe check compare it by its sorted lowercased addresses.

No limit on addresses in Terno. A send carries at most `MAX_RECIPIENTS` (1000); a longer list goes as several sends. The provider's own limits apply and their errors are shown as they are.

### 2. When a forward fires

Only **new mail**, and only **forward once**:

- **New** means the message was ingested by live sync (not the first sync, a window backfill, an import or the demo), its date is not older than 3 days at ingest, and it arrived after the rule was enabled (`enabled_at`; a filter's `updated_at` when its forward action was added or turned on). Turning a trigger on never forwards what is already there.
- **Category trigger** fires when a new message's thread is in the category by `filter`, `auto`, `agent` (AI assist), `suggestion` or `user`, at ingest or within 24 h after it (the AI assist and a hand-filing come later). `bulk` never fires it: a sweep, a multi-thread drag or an undo never forwards.
  - A reply arriving later in a thread that is already in the category is a new message in the category: it is forwarded too.
  - A single-thread hand-filing (drag, menu, `user`) of a new message fires it. Filing old mail by hand doesn't (it isn't new).
- **Filter action** fires only at ingest. `filters.apply` over existing mail never forwards (the apply skips the action and the dialog says so).
- **Never:**
  - mail in Spam or Trash, or mail a filter sends there in the same slice;
  - mail Terno itself forwarded (`X-Terno-Forward: 1` on every forward we send) or that came from an account in Terno;
  - to the message's own sender;
  - a message already forwarded to that address by any rule (the ledger below).

### 3. The ledger and the 10 s wait

`forwards (id, message_id → messages ON DELETE CASCADE, account_id, rule_kind 'category'|'filter', rule_id, addresses_json, due_at, state 'waiting'|'sending'|'sent'|'cancelled'|'failed', error, at)`, `UNIQUE (message_id, rule_kind, rule_id)`, an index on `(state, due_at)`.

- **Enqueue** happens in the same store command that decides the trigger: the ingest slice (filter action, `filter`/`auto` category adds, new messages in filed threads) or the category add itself (`agent`, `suggestion`, `user`). `due_at = now + 10 s`.
- **One timer** (`ForwardQueue`, beside `ScheduledSends`) for the soonest `waiting` row; none when there are none.
- **Cancel** while waiting:
  - "Cancel" on the notice (§5);
  - the thread leaves the category (any removal), or the message goes to Spam or Trash;
  - the trigger is turned off or deleted, or the filter loses its forward action.

  Each of these turns the row `cancelled` in its own command, so the timer finds nothing to send.
- **At `due_at`**: the backend re-checks in one command that the row is still `waiting`, the thread is still in the category (category rules) and the message isn't in Spam or Trash, marks it `sending`, and queues the send through `store.compose.queueSend` (no draft) with `forwardOfMessageId`. A full receipt budget leaves it `waiting` with a later `due_at` (retry as plan 94's `retryDelay`).
- **Restart**: `sending` rows whose op exists are left to the op; `waiting` rows with a past `due_at` get `now + 10 s` (the user gets their 10 s to see it). Rows of `sent`/`cancelled`/`failed` are pruned after 30 days, at most 5,000 kept.

### 4. What is sent

The same message as pressing Forward, built on the backend:

- `quoteFor("forward")` and `subjectFor("forward")` move from `apps/web` to `@terno/core` (they only need i18n `t`, which the backend has as `L()`), so both paths write the same header. The text is written in the app's language at that moment.
- From: the account that received it, its default identity and signature (as a forward from the composer would).
- To: the rule's addresses. Body: no note, the forward header and the original's text (snippet if no body).
- Files: the original's stored parts. If capture is `pending` at `due_at`, the send waits for it up to 5 minutes (an event, the capture's completion, not a poll); then it goes with what is there and the Sent copy's body ends with "N files couldn't be included" (plan 60: forward regardless).
- The Sent copy is a normal Sent message, so it shows in the conversation like any forward.

### 5. What the user sees

- **A notice for 10 s** at the bottom, one per burst, not one per message: "Forwarding 3 messages from Facturas to ana@… · Cancel" (`forward.notice`). Cancel cancels the whole burst. Built on the snackbar; hidden when the window isn't visible (the forwards still go).
- **In the reader**, under the message: "Forwarded to ana@…, luis@… · 10:02", or "Forwarding in 8 s · Cancel" while waiting, or the failure with Retry (`forward.sent`, `forward.waiting`, `forward.failed`).
- **The category's menu** gains "Forward new mail…" (`menu-category-forward`). It opens an inline panel under the category row (no modal): an address field that takes several (chips, the composer's recipient field), the switch, and one line of help: "New mail filed here is sent on 10 seconds later, while Terno is open. Terno's own filing counts." Removing every address turns it off.
- **Sidebar**: a category with an enabled trigger shows a quiet forward icon (muted, `1.15em`, `@terno/ui/icons`) after its name.
- **Settings → Filters**: the filter builder gains the "Forward to" action with the same address field. A third group, "Category forwarding", lists the triggers (category, addresses, switch, edit opens the category panel).
- **Failures** follow plan 94's: a permanent one (a gone account, an address the server refuses) is `failed` and kept until seen; the notice says what happened and offers Retry.

### 6. Exports, demo, MCP

- `app.export` and the import carry triggers (categories remapped by name) and the new filter action.
- The demo has no triggers and its ingest never forwards.
- MCP agents can't create or change triggers (a new way to send mail elsewhere); they see them read-only in categories.

### 7. Strings

`en` and `es` together: `category.forward.*` (menu item, panel, help, placeholder), `filters.action.forward`, `filters.group.categoryForwards`, `filters.apply.noForward`, `forward.notice`, `forward.waiting`, `forward.sent`, `forward.failed`, `forward.filesMissing`, `errors.forwardAddress`.

## Tests

- **Core**: schema accepts `forward` with ≥ 1 address and beside a location action, refuses an empty or invalid list; `sameRule` treats address order and case as equal; `quoteFor`/`subjectFor` unchanged after the move (existing tests move with them).
- **Store conformance (SQLite and IDB)**: enqueue in the ingest command; `UNIQUE` once per (message, rule); cancel on category removal, Spam, Trash, trigger off/delete; the `due_at` check is fenced; pruning bounds.
- **Backend**:
  - live-sync mail into a triggered category by filter, by auto and by AI assist is forwarded once after 10 s, with the header, the files and `X-Terno-Forward`;
  - first sync, backfill, import, `filters.apply`, a bulk sweep and an undo never forward;
  - a reply in a filed thread is forwarded; old mail filed by hand isn't;
  - removing the thread within 10 s, Cancel, Spam and Trash stop it;
  - a forwarded copy coming back (a self address, the header) is never forwarded again;
  - 1,500 addresses go as two sends;
  - a full receipt budget waits and retries; a restart re-arms with 10 s; no timer when nothing waits.
- **Web unit**: the burst notice groups and cancels; the reader line's three states.
- **e2e** (`category-forwarding.spec.ts`, `@design`): set up a trigger from the category menu, a mock new message lands, the notice and Cancel, a second one goes and the reader shows "Forwarded to"; the filter builder's "Forward to"; keyboard-only setup; axe light and dark.

## Perf

- Ingest adds one indexed lookup per slice: the enabled triggers (a handful, cached in memory and invalidated on change) against the slice's category adds. No work when no trigger is enabled.
- The ledger is bounded (30 days, 5,000 rows); its timer exists only while a row waits.
- `load.perf.test.ts` and `pnpm test:perf` with a trigger on a category that 20% of 50k ingested threads land in (all backfill: no forwards, no measurable cost).

## Out of scope

- Forwarding while Terno is closed, or by the mail server (Gmail forwarding addresses).
- Forwarding the original's HTML as it was (the composer's Forward doesn't either; a follow-up for both).
- A note added to the forward, conditions inside a trigger (use a filter that adds to the category), redirect/bounce keeping the original sender.
- Syncing triggers between devices (plan 50). Two devices with the same trigger would both forward.

## Revisions after the Codex review

The read-only critique (12 points) found the first draft too optimistic about where a forward is decided and how it is sent. Each point and what changes; where this section differs from the design above, this section wins.

1. **A draftless send had no duplicate fence.** `compose.queueSend` is fenced by deleting its draft. Forwards get their own store command, `forwards.admit(id, rev)`, which in one transaction re-checks the row and the rule revision, checks eligibility (membership, not Spam or Trash), queues the send op(s), reserves receipts and writes `op_id` on the row. Restart: a row with an `op_id` follows its op; a row without one is still `waiting`.
2. **"Once per address" wasn't enforced.** Per-recipient claims: `forward_recipients (message_id, address, forward_id, op_id)`, `UNIQUE (message_id, address)`. The first rule to claim an address owns it; a cancelled rule releases its claims before admission and another rule waiting on the same message can take them. More than `MAX_RECIPIENTS` addresses means several ops, each linked; only an op that failed before the server accepted it is retried.
3. **Live sync couldn't be told from backfill at the enqueue point.** `ingestSliced` passes the sync's `live` flag into `store.sync.ingest` (both stores). On first insertion only, a live message no older than 3 days gets a row in `forward_eligible (message_id, arrived_at)`; nothing becomes eligible later through a body upsert. Gmail live arrivals during a first sync (plan 102) count; the catch-up after a launch counts (mail that came while Terno was closed). Rows go 24 h after arrival.
4. **Filter and classifier decisions happen in more places than `r.auto`.** Both stores run filters on `inserted` and `bodyCompleted`, and `sync.setBody` runs body filters and classification. A `forwardCheck(messageIds)` step runs inside each of those transactions and the category-add commands, reading persisted eligibility, the final memberships and the final location. A body filter that trashes a header-matched message cancels its forward.
5. **`added_by` doesn't say what the user did, and AI assist doesn't file mail.** Picker and drag are `user` whatever the selection size; undo restores the original `added_by`; `AiAssist.consider` only records a suggestion. Store commands now carry an explicit intent (`ingest | single | bulk | undo`). A category trigger fires on ingest decisions (filter, engine auto-apply), a single-thread filing and an accepted suggestion (the AI's filings, decision 1). Bulk and undo never fire it. A suggestion alone never forwards.
6. **MCP could set up forwarding through `filters.save`.** From MCP, `filters.save` refuses a rule with a `forward` action and refuses edits that touch an existing one. An agent's filing (`agent`) fires a trigger only when agent sending is allowed (`allowAgentSend`).
7. **The loop header existed nowhere.** `X-Terno-Forward` goes through `SendCommand`/`SendPayload`, both MIME writers (`buildRaw`, `buildRawPortable`), the incoming header fetch and parsers, and is stored as a message flag in both stores. A MIME round-trip test covers it. Mail from any of the user's identities (aliases included), and anything in Sent or Drafts, is never forwarded either.
8. **Waiting for files opened a window where Cancel was lost.** A row waiting for capture stays cancellable (`waiting` with a persisted `files_until`, at most 5 min). `forwards.admit` repeats the whole fence. Capture `unavailable` or past the deadline: it goes with the files that are there, and the line says "Some files couldn't be included" (no count; it may be unknown).
9. **Edits and activation had no revision.** Category triggers and filters get `forward_rev` and `forward_since` (both stores). Changing addresses or turning it off cancels its waiting rows (the notice says so); admission compares `rev`. Imported forwarding rules come in turned off.
10. **"Failed → Retry" could send twice.** A forward's state comes from its op and receipts (plan 65): queued, sent, unknown, partly refused, failed before acceptance. Retry is offered only for the last. Unknown says "This may have been sent. Check Sent before trying again", with no Retry.
11. **Retention and perf didn't cover the real work.** Claims are the dedupe and can only matter while a message is eligible (24 h), so they are pruned with eligibility once their op settled; display history is kept 30 days; failed and unknown rows stay until seen. Addresses are stored up to 256 KiB per rule (thousands; no limit in the UI). IDB gets explicit tables and indexes in `schema.ts`. A burst id on rows makes Cancel exact across windows and restarts. The perf test ingests 50k *live* messages with two overlapping rules, and asserts no timer exists when nothing waits.
12. **The forward builder needs extracting, not moving.** A pure `forwardMessage(source, { locale, formatDate, signature })` in core, used by the composer too (parity test), taking the exact source message rather than `answered(detail)`. `Core.queueComposeSend` and `SendCommand` gain the `forwardOfMessageId` they currently drop.

### Coming back online to a backlog

Forwards are ops in the existing queue (`ops`, `runWorker`), so they inherit its offline pause, per-account order, Gmail's cooldown (plan 62), a day of retries for "try later" (plan 100) and no automatic resend of an unknown send (plan 65). After a long gap, every live arrival under 3 days old that lands in a forwarding category gets its 10 s at ingest; the burst shows as one notice ("Forwarding 40 messages from Facturas · Cancel"). Older catch-up mail is not forwarded.

### Safety cap (agreed after the review)

> ye do the safety cap and inform the user so he can say just yes or stop, proceed

- **The cap:** a rule that has forwarded 100 messages in the last 24 h (admitted forwards, counted per rule) holds the next ones instead of sending them: state `held`, not cancelled.
- **The question:** a persistent notice (it survives a restart, like plan 94's failures) asks "Facturas has forwarded 100 messages today. Keep forwarding?" with two buttons:
  - **Keep forwarding**: the held ones get their 10 s and go; the rule isn't asked again for 24 h.
  - **Stop**: the rule is turned off and the held ones are cancelled.
- **Unanswered:** held forwards wait up to 3 days, then they are cancelled; the question goes with them. Nothing is sent without an answer.
- **Tests:** the 101st is held, not sent; Keep forwarding sends the held ones and doesn't ask again that day; Stop cancels them and turns the rule off; a restart keeps the question; held rows expire.
