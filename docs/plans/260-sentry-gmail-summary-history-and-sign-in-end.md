# Plan 260: a Gmail history record without a change type is read by ID, and a sign-in left unfinished is no bug

- **Status:** shipped.
- **Builds on:** plan 26 (provider reliability, the bounded history work of 7530f1bec), plan 41 (live mail), plan 78 (error reports), plan 104 (window reconciliation), plan 231 (Sentry triage).
- **Request (verbatim):** "we have these 2 bugs on sentry , lets fix them" (a screenshot of TERNO-6 `ProviderError: sync.failed` and TERNO-7 `ProviderError: rpc.handler_threw`).

## 1. The two reports

Neither report has source maps (the nightly's and 0.1.2's maps never reached Sentry), and reports never carry the message. I rebuilt the nightly's commit `e1d4005805` with its version and SHA (`TERNO_RELEASE=1 TERNO_VERSION=0.1.7-nightly.202611240655 TERNO_BUILD_SHA=e1d4005805 TERNO_BUILD_OUT=<scratch>`). The reported frames land on the same names (`BPe`, `j`, `Object.sync`), so the bundle matches, and I mapped them with Node's `SourceMap`.

### TERNO-6 `ProviderError: sync.failed` (9 events, 2 people, 0.1.2 and the 0.1.7 nightly)

```
2093:18893 BPe  → packages/mail/src/gmail-api.ts:302  readHistory: if (h.messages.length && !typed) throw new HistoryOverflow()
2093:43171 j    → gmail-api.ts:1355  incremental → readHistory
2093:48521 sync → gmail-api.ts:1575  the catch-up after a reconciliation: try { await incremental(sink, reconciled) }
2826:142277     → backend core.ts:2349  provider.sync
```

The 0.1.2 events have the same shape (`INe ← $ ← Object.sync`). The second person hit it in every session, about two minutes after launch.

Gmail sent a history record with `messages` but none of the four typed fields (`messagesAdded`, `messagesDeleted`, `labelsAdded`, `labelsRemoved`). `readHistory` treats such a record as `HistoryOverflow`, which:

1. on the ordinary pass, sends the account into a **full reconciliation of its window** (`fullSync`). That's minutes of listing and Gmail quota for one record, and very likely the ~70 s `sync.done` passes in the owner's breadcrumbs;
2. when another such record turns up in the catch-up that follows the reconciliation, **fails the sync** by design (plan 26: "overflow during catch-up persists restart and refuses this invocation"). The error is non-retryable and its text is `errors.gmail.invalidResponse`, so the account shows "Gmail sent an invalid response", and Sentry gets a bug report. The next pass starts the reconciliation again. On a mailbox where these records keep coming, the account never settles.

What Google's documentation says (users.history.list, the sync guide):

- `messages[]`: "The fields for specific change types, such as `messagesAdded` may duplicate messages in this field. We recommend using the specific change-type fields instead of this." Nothing says a record can't carry `messages` alone, and nothing says what such a record means.
- The sync guide, partial sync: "use `format=minimal` to reduce the size of the response as only the `labelIds` might change." A message's ID is "The immutable ID of the message."

So a summary-only record tells us which messages changed, but not how. By the guide, the only things that can change about a message we hold are its labels and whether it still exists, and both can be read by ID. Reading the message's current state is exact whatever the record's type was. This needs no guess about undocumented record types: the decision rests on what the message is now.

### TERNO-7 `ProviderError: rpc.handler_threw` (1 report; 2 in the owner's log, 33 s apart)

```
2093:51442 Timeout.<anonymous> → packages/mail/src/gmail-web.ts:20  withGoogleSignIn's deadline: abort(new ProviderError(L("errors.google.timedOut"), false))
```

The owner's `backend.jsonl` gives the method: `accounts.connectGmail`. The desktop's consent flow (`connectGmail` in `gmail.ts`) waits up to **five minutes** for the browser to come back to the loopback callback. Two flows started at about 07:09:00 and 07:09:31 and both ran out at 07:13:58 and 07:14:31. Nothing came back: no callback, no Google error redirect.

A sign-in that runs past its deadline, or that the caller cancels (`errors.google.cancelled`: the backend stopping, a newer sign-in for the account), is an outcome of the flow, not our bug. The person closed the tab, or never picked an account, or Google kept them on an error page that doesn't redirect. It's shown to the person ("Google sign-in timed out.") and logged at warn. `ProviderError.expected` is `retryable || ambiguous`, and both are false here, so the RPC server reports it as `rpc.handler_threw`. `beginGmailRenewal` already makes its own `errors.google.timedOut` retryable for the same reason. The same deadline in `inspectGmailToken` (the web's 30 s check of a token) is Google not answering in time: also not ours.

I can't tell from the logs whether the owner abandoned both consents or whether Google showed a page that never redirected. If it was the latter, that's a separate problem to look at with the owner, and this plan doesn't hide it: the error still shows and is still logged.

## 2. Design

### TERNO-6: summary-only records are re-read by ID (`packages/mail/src/gmail-api.ts`)

- `readHistory` no longer throws for a record whose `messages` carry no typed change. It still validates the array and each reference (`messageRef`), and still counts each reference toward `HISTORY_PAGE_REFS` and `HISTORY_TOTAL_REFS` (via `historyReferences`). Real overflow is unchanged.
- `untyped(h)`: the IDs a record names in `messages` that **none of its typed fields name** (Google's typed fields "may duplicate" `messages`, so an ID a typed field names is that field's). This is per ID, not per record, so a typed record that also names another message doesn't hide it.
- `incremental` collects those IDs into `summary`. After the page loop:
  - **deleted** ones (a typed `messagesDeleted` anywhere in the traversal) are skipped: the deletion wins.
  - **held IDs** (a stored message, including one a typed addition just brought in) join `changed`. `relabel` reads each one with `format=minimal` and stores its labels, and a 404 on that resource marks it deleted (plan 33's rule: only the message resource's own 404 authorizes removal). This is exactly what a label change does today.
  - **unheld IDs** (no stored message, and not a typed addition, which already tried to fetch it) are fetched in full (`fetchFull`) and ingested **only within the account's window** (`date`, Gmail's `internalDate`, at or after `windowStart`), as the reconciliation's `after:` listing would have. They come in **not as live mail**: plan 41 makes only typed history additions live, and the reconciliation that handled these records until now ingested the message that caused it as non-live too. A message that's gone by then is simply absent.
- `peekArrivals` (the look at new mail during a long reconciliation) keeps the old conservative path for these records. A page with an untyped reference goes `lost()` as before: the look starts again from now with `gap`, so the catch-up starts at the reconciliation's baseline and `incremental` reads the reference by ID there. Without this, the look would move the refresh's cut (`refreshFrom`) past an arrival it can't place.
- Nothing else moves: the cursor still advances only after all effects, and a failure midway leaves the old cursor, so the pass replays (the replay finds an arrival it already took as held and only relabels it).

### TERNO-7: the sign-in's own end is expected (`packages/mail/src/gmail-web.ts`)

- `withGoogleSignIn`'s deadline and cancel errors become a `ProviderError` subclass (`GoogleSignInEnded`) whose `expected` is true, with `retryable` still false, so no caller's retry or classification changes. `isExpected` reads it, `toErrorPayload` marks the payload expected, and `RpcServer` skips `onError`, so nothing is reported. The person still sees the same message. Like every other expected RPC error (a wrong password, a refused consent once it is one), it leaves no log line: `onError` owns that line, and it's only for bugs.
- Callers: only the **initial desktop consent** (`accounts.connectGmail`) changes. The web's token check (`accounts.connectGmailToken`) already wraps every failure in an expected `BAD_REQUEST`. A reconnect and the owner's re-verification (`connectExistingGoogle`) replace any provider failure with `invalidRenewal`, and the renewal proof does the same. Their outcomes don't change.
- Nothing else in the flow changes: a refused consent, a bad response and a missing scope keep reporting as before.

## 3. Tests

- `packages/backend/src/gmail-catchup.int.test.ts` (real SQLite and IndexedDB stores through the public backend; the existing harness):
  - The `summary` case leaves "reconciles bounded history %s …": a summary-only page **does not** reconcile.
  - New: one incremental pass over the mutated mailbox, where every change arrives as a summary-only record (`archive` relabelled, `read` read, `deleted` gone, `arrival` new). It ends `idle` with no error and the final state (`assertFinal`). There's no `/messages` listing and no `/profile` read (no reconciliation), exactly one minimal read per held message and one raw read for `arrival`, and `arrival` is ingested non-live. A reopen keeps it.
  - New: a typed record that also names the other messages in `messages`, plus old mail outside the window (`internalDate` 1970) named only there. The untyped held ones are relabelled, the deleted one stays deleted, the typed arrival stays live, and the old message is downloaded but not stored.
  - New: replay. The unheld arrival comes in, then a held message's minimal read fails. The cursor stays at the old one. After a reopen, the pass relabels the arrival (no second raw read, no second insertion, same row id) and reaches the final state.
  - The `catchup` case of "refuses deterministic %s overflow …" used a summary-only page to force a catch-up overflow. It now forces one with a real reference overflow (2,001 refs), so the plan-26 refusal stays covered.
- `packages/mail/src/gmail-first-sync-arrivals.test.ts`: "history the look can't finish (%s) …" gains a page with an untyped reference. The look ends `gap` at now, as with an overflow.
- `packages/mail/src/gmail-auth.test.ts`: the deadline and the cancel each reject with an error that `isExpected` accepts, with `retryable` false and the same i18n key. Through `toErrorPayload`, it's `expected: true` with no `diag`.

Each new test fails without its fix: the whole change (both catch-up tests, the auth test), the window filter alone, per-ID `untyped` alone (a per-record rule), and the peek fallback alone.

Two tests fail on an unchanged `HEAD` too, here with Node 24.3 (`gmail-history-ownership.test.ts` "keeps one native history reader … (eof)", and `gmail-response.test.ts` "retains an earlier valid page …"). They're unrelated to this plan.

## 4. Perf and resources

The win is the point: a summary-only record costs one minimal GET per held message, or one full GET per unheld one, instead of a full reconciliation of the window. The bounds are those of a label change: at most `HISTORY_TOTAL_REFS` references per traversal, and 50-item flag batches. No new timer or loop. `gmail-history.perf.test.ts` is rerun.

## 5. Sentry

After the fix lands, both issues are resolved in the next release. A real catch-up overflow still reports under TERNO-6's title. That's rare, plan 26 meant it to refuse the pass, and it's out of scope (§6).

## 6. Out of scope

- `HistoryOverflow`'s text (`errors.gmail.invalidResponse`) for a real overflow during the catch-up. It's misleading, but with summary-only records handled it's rare, and changing what the catch-up does after a real overflow is plan 26's design.
- Source maps for nightlies (`release-ci.mjs`): neither the nightly's nor 0.1.2's maps reached Sentry. Worth its own look.
- Starting a second Gmail sign-in while one is already waiting (the owner's two flows 31 s apart).

## 7. Revisions after the Codex review (plan critique)

Codex made twelve points. Taken:

- **(1) Per ID, not per record.** The first design dropped a record's whole `messages` once any typed field had entries. `untyped(h)` now takes each ID no typed field of the record names.
- **(3) The look during a long reconciliation.** `peekArrivals` used to fall back to `gap` on these records through the overflow. Now that they no longer overflow, it would have saved `peek` past an arrival it can't place, and the refresh's cut with it. It keeps the fallback explicitly (§2), with a test.
- **(4) Old mail.** An unheld ID can be mail outside the window (or evicted). The reconciliation lists `after:<window>`, so `incremental` now ingests unheld ones only within the window, with a test.
- **(8) Replay.** A test fails the pass after the unheld arrival is in and before the cursor moves, then reopens and replays.
- **(10) No warn line.** The plan promised a log line that `RpcServer` doesn't write for expected errors. The plan now says so, as for every expected RPC error.
- **(11) Callers.** Only the initial desktop consent changes. The other callers wrap or replace the error (§2).

Not taken:

- **(2) `historyTypes` may hide such records.** The filter predates this plan, and the records we saw came through it. Dropping it would change every history read, so it's out of scope.
- **(5) A blocked capture repair on an unheld message that's since been deleted.** `fetchFull` skips a blocked repair. The listing a reconciliation does wouldn't list a deleted message either, so this isn't new, and it's rare.
- **(6) Live marking.** The reconciliation marks mail received after *it* began as live. The message that triggered it was received before, so it was never live. Non-live keeps that.
- **(7) Fan-out in a quick check.** 10,000 unheld references is the same fan-out 10,000 typed additions already have, under the same reference bounds.
- **(9) The refresh branch of a catch-up overflow.** It's already covered by "a catch-up from a refresh that overflows reads the flags again …" in `gmail-first-sync-arrivals.test.ts`, which doesn't use summary records and still passes.
- **(12) The deadline covers more than the browser wait.** It also covers preparing the callback page, launching the browser, the token exchange and the identity read. A launch that fails is already its own error ("Could not finish Google sign-in"). A local step stalling for five minutes is implausible, and a stalled token exchange or identity read is Google's or the network's, not ours.
