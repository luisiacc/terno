# Plan 191: agents can wait for new mail on one account, and the poll runs every 40 s

## Request (verbatim)

> for the mcp what do you think about adding a 'request_refresh' function for a specific account, not for all, it would be for agents tht are doing something and can request the app for a refresh to see a verification code, also i think the mcp should give the ability to list/search items in the spam folder specifically as well

After my answer (Spam is already reachable since plan 185; a bare refresh invites the agent to loop refresh + search, so a tool that waits is better):

> ok build it.
>
> also change the default polling time from 2 minutes to 40seconds

**Spam.** Plan 185 already gives agents Spam when they name it (`in:spam`, `view: "spam"`, `includeSpamTrash`). The owner didn't choose to widen that, so the rule stands: the wait never reports mail that lands in Spam or Trash (plan 185, and "Spam triggers nothing"). The tool's text tells the agent to say that the mail may be in Spam when nothing arrives.

## What exists

- **The poll.** `BackendCore.options.syncIntervalMs` defaults to `120_000`. `tick()` runs an ordinary pass on every account (and push's heartbeat) on that interval (`core.ts`).
- **Push.** IMAP has `watch` (IDLE on the Inbox), so new Inbox mail arrives within a second or two. Gmail has no push a desktop client can use; it hears of new mail only from the poll.
- **Quick checks (plan 176).** `QuickChecks` (`quick-checks.ts`) owns the timing: for a minute after a Terno window gains focus, `hooks.check()` runs every 5 s. `BackendCore.quickCheck()` then starts a quick pass (`syncAccount(…, { quick: true })`: only `/history` since the cursor, nothing written when nothing is new) on every account whose provider has `quickChecks` (Gmail) and is synced and healthy (`quickHealthy`). `quickAdmitted(accountId)` gates the pass on `quickChecks.running`. An agent in a terminal doesn't focus Terno, so it gets none of this: a code can take up to 2 minutes to show.
- **Arrivals.** In `syncAccount`, the sink's `ingest(messages, { live })` passes the ids of messages it **inserted** as live mail to `attention.beginPass(accountId).add(ids)` (plan 41). `store.sync.arrivals(ids)` reads them back as `ArrivalRow` (`threadId`, `accountId`, `date`, `isSpam`, `isTrash`, `isSent`, `isDraft`…). Attention's collector only runs while notifications are on, so it can't be reused as is.
- **Agents.** The sidecar (`packages/mcp/src/server.ts`) calls the backend over the agent socket. `AGENT_METHODS` (`packages/core/src/agents.ts`) lists what an agent may call and at which level. An agent's `threads.search` gets `place: "all"` (no Spam or Trash unless named, plan 185). `onDisconnect` hears when an agent's connection goes (agents turned off, the token rotated, the agent quit).
- **Clients' tool timeouts.** Codex documents `tool_timeout_sec`, default 60 s. Claude Code's `MCP_TOOL_TIMEOUT` is long by default. A tool call that blocks must end well within 60 s.

## Design

### 1. The poll every 40 s

`syncIntervalMs` defaults to `40_000`. Comments that say "2-minute poll" or "every two minutes" say 40 s. Nothing else ties to the number: Gmail's `/labels` refresh is by age, and the IMAP heartbeat is gated by its own `quietMs`.

Cost, accepted by the owner: three times the ordinary passes. A Gmail pass with nothing new is one `/history` read (2 of the 6,000 quota units a minute) plus the maintenance a pass does. An IMAP pass reads the folders IDLE doesn't watch. No new timer: the same `setInterval`, shorter.

### 2. `wait_for_new_mail`: one tool, not a bare refresh

```
wait_for_new_mail({ accountId, from?, subject?, waitSeconds = 30 })   // waitSeconds 5 to 45
```

(The first draft took a search `query`; the Codex review changed it to `from` and `subject`. See the revisions below.)

It returns as soon as a new message arrives in that account whose sender and subject contain `from` and `subject` (any new mail when neither is given), with its conversation as `search_emails` gives it. When the time is up with nothing new, it says so. While it waits, a Gmail account is checked every 5 s, exactly as a focused window would. An IMAP account already hears of new Inbox mail by IDLE, and the rest by the 40 s poll.

Why waiting rather than a refresh: with "refresh", an agent must loop (refresh, search, nothing, refresh…). That is polling moved into the agent: more Gmail quota, more tokens, and a fragile loop. With a wait, the backend does the one thing it already knows how to do (quick checks) and tells the agent at the moment the mail lands.

- **45 s at most** keeps the call under Codex's documented 60 s default with room to spare. The default is 30 s.
- **Read level** (`readOnlyHint: true`): it changes no mail and reaches only the user's own mail server, as the poll does.
- **Spam and Trash.** A message inserted into Spam or Trash, or into a conversation there, is never reported (not even as a count). The search runs with `place: "all"`, as an agent's search does.

### 3. Where it lives

**`QuickChecks` gains per-account watches.** All quick-check timing stays in one module, and a focus and an agent's wait share one 5 s cadence (never twice the requests):
- `watch(key, accountId, forMs)` adds a watch until `now + forMs`, and schedules a check as `focus` does (at once, or 5 s after the last one). `unwatch(key)` removes it.
- `covers(accountId)` replaces `running`: a window has focus within its minute, or a live watch names that account.
- `run()` goes on while either holds, and leaves no timer when neither does.
- The core's `quickAdmitted(accountId)` asks `covers(accountId)`, so `quickCheck()` checks every account a focus covers, and only the watched one for an agent. `windowFocus` and the focus semantics are unchanged.

**`AgentMailWaits`** (`packages/backend/src/agent-mail-waits.ts`): the waits themselves, with injected hooks (like `QuickChecks`), tested without a backend.
- `wait({ clientId, accountId, query, waitMs })`: registers a waiter, starts a watch (`agent-wait:<n>`), and sets one deadline timer. It resolves with the matching conversations, or with none at the deadline. It always ends by removing its watch and timer.
- `arrived(accountId, messageIds)`: called by the core with each live insert. With no waiter on that account it returns at once (the hot path costs one map lookup). Otherwise the ids are queued on each waiter and evaluated off the ingest path (one evaluation at a time per waiter, later ids coalesced):
  1. `store.sync.arrivals(ids)` → keep the rows of that account that aren't Spam, Trash, sent or a draft, dated no earlier than 15 minutes before the wait started (a first sync's or a backfill's live inserts of old mail aren't "new");
  2. their thread ids. With no query: `store.threads.summaries(ids)`, without conversations in Spam or Trash. With a query: `searchText({ query, accountId, place: "all", limit: 100 })`, keeping the results among those thread ids, in its order. New mail is the newest, so it is on that page. A search after the commit is exact: the instant index answers only when it is at the store's revision, and FTS5 otherwise;
  3. any left: the wait resolves with them.
- `disconnected(clientId)` and `stop()` end that client's waits (or all of them) with nothing.
- At most **4 waits** at once across all agents. A fifth is refused: "Terno is already waiting for mail for other agents. Try again in a moment."

**The core.**
- `syncAccount`'s live ingest callback also calls `this.agentWaits.arrived(accountId, ids)`.
- `onDisconnect` calls `agentWaits.disconnected`, and `stop()` calls `agentWaits.stop()`.

**RPC** `sync.agentWait({ accountId, query?, waitSeconds })` → `{ items: ThreadSummary[], waitedMs, checks: "quick" | "push" | "poll" }`. It is for agents only (another origin is refused) and in `AGENT_METHODS` at `read`, with `timeoutMs: 60_000`. `checks` says how this account hears of new mail now:
- `quick`: every 5 s during the wait;
- `push`: IDLE on the Inbox, other folders every 40 s;
- `poll`: every 40 s only. This covers an account still in its first sync or backfill, or one whose last pass failed.

Before waiting, the handler refuses what can't bring mail, in agent-facing English:
- an unknown account: "No account {id}. list_accounts gives the ids.";
- an account that needs a sign-in: "This account needs the user to sign in again in Terno. No new mail arrives until they do.";
- an offline account: "Terno is offline, so no new mail can arrive. Ask the user to check their connection."

With `autoSync` off (a dev or test backend), nothing syncs by itself, and the wait only listens.

**The tool** (sidecar) `wait_for_new_mail` calls `sync.agentWait` and answers in one of two ways:
- `{ arrived: summarize(items), waitedSeconds }` when mail came;
- `{ arrived: [], waitedSeconds, note }` when nothing did. The note: "Nothing new arrived. It may have come just before you started waiting: search again. Terno doesn't report mail that lands in Spam; if the user expects it, tell them it may be there."

Its description: "Search first; call this when what you expect (a verification code, a reply) isn't there yet."

The server's `instructions`, `SKILL.md` and `docs/MCP.md` name the tool.

### Clean architecture check

Each piece sits on an existing seam:
- the timing goes in `QuickChecks`, which already owns it;
- the arrivals come from the ingest callback that plan 41 uses;
- the matching uses the store's own search and summaries;
- the agent rules use the origin check and `AGENT_METHODS`.

No refactor is needed. No UI change and no UI strings: the backend's agent messages are agent-facing English (`i18n-ignore`), as plans 183 and 185 do.

## Tests

- `quick-checks.test.ts`:
  - a watch checks every few ms until its time is up, then leaves no timer;
  - `covers` names only the watched account;
  - a focus and a watch together keep one cadence;
  - `unwatch` stops the checks.
- `agent-mail-waits.test.ts` (hooks faked):
  - an arrival resolves the wait with its conversation;
  - a Spam, Trash, sent, draft or old arrival doesn't;
  - another account's arrival doesn't;
  - a query keeps only matching conversations;
  - the deadline resolves with none and removes the watch;
  - `disconnected` and `stop` end the waits;
  - a fifth wait is refused;
  - with no waiter, `arrived` does nothing (no store read).
- `agent-wait-sync.test.ts` (the backend with scripted providers, as in `quick-checks-sync.test.ts`, called with origin `mcp`):
  - a quick provider is checked every few ms only while the wait runs, and only that account;
  - a message its pass inserts as live mail ends the wait with that conversation;
  - mail inserted as spam doesn't;
  - a push account isn't checked and reports `checks: "push"`;
  - a renderer call is refused;
  - a sign-in-required account gets the plain-English refusal.
- `mcp.test.ts`:
  - the tool is listed with `readOnlyHint`;
  - with nothing new, it ends after the wait and gives the note;
  - an unknown account gives the error.
- The default interval: a core test that the poll's interval is 40 s when none is given.
- Typecheck and lint.

## Performance and resources

- Nothing runs until an agent waits. The ingest path pays one map lookup when no wait is running.
- While a wait runs: the quick checks a focus would make, for one account (at most 9 `/history` reads in 45 s), and one store read and one search per batch of arrivals on that account.
- Timers exist only during a wait (the deadline, and the shared 5 s cadence). At most 4 waits.
- The 40 s poll triples the ordinary passes, by the owner's choice.

## Out of scope

- Reporting mail that lands in Spam (the owner's rule, plan 185).
- A refresh of every account, or a wait across accounts (the request is per account).
- Extra passes for IMAP during a wait: IDLE already pushes Inbox mail, and the poll covers the rest.

## Revisions after the Codex review

Codex (read-only, against the code) made 10 points. All were taken; the design above the revisions is the first draft, and this is what was built:

1. **Spam is settled only when the pass ends.** The ingest callback runs per committed slice, and a later flag read or filter in the same pass can still move the mail to Spam. Arrivals are collected per pass and handed to the waits in the pass's `finally`, as plan 41's Attention does. Only a pass of an account that had synced before counts: a first sync's live mail is the mailbox, not news. *Test:* a message inserted clean and flagged spam later in the same pass ends nothing.
2. **Body matches and bodies to come.**
   - Matching no longer reads bodies at all (point 5).
   - A match whose body hasn't come yet, while an enabled filter reads bodies, is held. It goes when `bodyArrived` says its filters have read it, or the wait ends.
3, 4, 5. **No search, match the message.** Codex found three faults with intersecting a search page with the arrivals' conversations:
   - search orders by `last_date`, so the first 100 results can miss the arrival;
   - `in:spam` and `in:anywhere` in a query override `place: "all"`;
   - an older message of the conversation could match while the new one doesn't.

   The tool now takes `from` (a part of the sender's address or name) and `subject` (a part of the subject), matched against the arrival row of each new message, any case. A verification code is found by its sender and subject, and its body is then read with `get_thread`. The store contract is unchanged.
6. **Bounds.**
   - Each wait keeps a deduplicated queue of at most 500 arrivals (the newest win) and holds at most 50.
   - Arrival rows are read 200 at a time, with a yield between reads.
   - A wait answers with at most 10 conversations.
   - At most 4 waits at once.
7. **A disconnect during admission.** Authorization and the account reads await, so the agent can go before the wait registers. `RpcServer.connected(ctx)` is checked synchronously just before `wait()`, which registers without awaiting. *Test:* a call whose connection is gone leaves no wait and no timer (it fails without the check).
8. **Looks after a wait ends.**
   - A look stops reading as soon as its wait is over.
   - One look per wait at a time.
   - `stop()` returns once no look reads the store, and `BackendCore.stop()` awaits that before closing the store. *Test:* stop waits for a gated look, which reads nothing more.
9. **No date cutoff.** The 15-minute cutoff on `ArrivalRow.date` is dropped: on IMAP it is the sender's `Date` header, not receipt time. What counts as new is decided by provenance instead: inserted as live mail, by a pass of an account that had synced before.
10. **A watch only where checks run.** A push account, an account not synced and healthy, or a backend with `autoSync` off isn't watched: no 5 s timer, only the deadline and the arrivals. *Test:* `quick: false` registers no watch.

**Built as well.**
- `SYNC_INTERVAL_MS` (40 s) is exported from `core.ts`.
- `RpcServer.connected` was added.
- `docs/MCP.md` lists `get_attachment` (missing since plan 185) and `wait_for_new_mail`.
