# Provider reliability: third release milestone

Clean unchanged main `5deb9ed9e0f05a7c9a94e03f2a8adbc4e045fd88`. Every required gate ran once, no external termination or retry seeking green. **Not release-green.** Full report/logs/lifecycle/traces/fresh binary and restoration records: `/tmp/terno-release-milestone3-p8jfaol3/report.md`.

| Gate | Result | Counts |
|---|---|---|
| Typecheck | PASS | exit0 |
| Lint | PASS | exit0 |
| Unit | PASS |11,799pass/3skip |
| WASM (normal test chain) | PASS |1,830pass/2skip |
| E2E | FAIL |1,518pass/1fail/7skip |
| Web | PASS |49pass |
| UI perf | FAIL |41pass/1fail/20not-run |
| Backend perf | FAIL |272pass/4fail/1skip |
| macOS package | PASS |ad-hoc; no notarization/update clearance |
| Default fresh smoke | PASS |64pass/7skip |

Existing skips and20serial successors not run are not passes. Backend perf finished normally in2,041s. Default fresh smoke had no native trace or dev override. Main stayed clean, generated outputs restored and no captured owned process remained. Fresh executable SHA256308048edf4f58caf7c701bfcad0430161b04b44dee590534b80a40c1d8b4ed7b; asarc6f3d454abed81fc557e1480f9cf545ae318a83e999428eb3c919238f9102054. Archived under the evidence directory's artifacts/final/apps/desktop/release.

## Isolated repair ownership

1. Frontend: rapid Reply/Escape collapse correctness and the2MBdraft typing gate. Preserve native input, user intent, exact work/Undo and original frame/serialization limits. Held stored-open P2 remains untouched.
2. SQL lifecycle:100kmailbox reset136.58ms/16 and50kexpunge48.49ms/16, with bounded access and transaction/identity/intent evidence. Then SQL People/Waiting count5.064ms/5 in the same owner to keep hot files serial.
3. Mail adoption index:25klater candidates merging with25kwaiting,12.575ms/10. Preserve exact order/identity/matching and actual yielding; no size/window/budget change.

All repairs remain fail-first, isolated worktrees, targeted checks and at most one completed code-review round per coherent series. No new full release cycle until meaningful corrections are ready. No report scenario or held-backlog disposition changes from these gate results.

## Exact failures

### 04-e2e.log

```text
  1) [e2e-atelier] › e2e/composer.spec.ts:651:3 › drafts keep their formatting › a key pressed while focus is still moving to the draft goes to the draft (r then Esc, r then typing at once) @design 

    Error: expect(locator).toBeVisible() failed

    Locator: getByTestId('draft-collapsed')
    Expected: visible
    Timeout: 8000ms
    Error: element(s) not found
```

### 06-ui-perf.log

```text
  1) [perf] › e2e/perf.spec.ts:1164:1 › a 2 MB draft of short lines: typing stays within a frame; no serialization per keystroke, one bounded one per save; the toolbar follows a selection fast 

    Error: expect(received).toBeLessThanOrEqual(expected)

    Expected: <= 50
    Received:    101.5

      1146 |   const frame = stat(`${name}: keystroke → next frame (p50 gated)`, 0, r.frame);
```

### 07-perf.log

```text
 FAIL  |perf| packages/backend/src/mailbox-read.perf.test.ts > a mailbox of 100,000 locations read for a reset: the longest stall within a frame
AssertionError: expected 136.58091705036168 to be less than 16
 ❯ packages/backend/src/mailbox-read.perf.test.ts:44:19
     42|     console.log(`reset a mailbox of 100,000: longest stall ${reset.toF…
     43|     expect(new Set(gone).size).toBe(100_000);
     44|     expect(reset).toBeLessThan(16 * MULT);
       |                   ^
     45|   } finally {
```

```text
 FAIL  |perf| packages/db/src/expunge.perf.test.ts > Codex R35: expunging a folder of 50,000 one-message conversations: the longest stall within a frame
AssertionError: expected 48.4883750885092 to be less than 16
 ❯ packages/db/src/expunge.perf.test.ts:67:19
     65|     console.log(`expunge 50,000 short conversations: ${total.toFixed(0…
     66|     expect(db.get<{ c: number }>("SELECT count(*) AS c FROM thread_fol…
     67|     expect(worst).toBeLessThan(16 * MULT);
       |                   ^
     68|   } finally {
```

```text
 FAIL  |perf| packages/db/src/perf.perf.test.ts > the quick filters (plan 15): with attachments and starred > hold at 50k+ threads for People and Waiting: as computed, twenty far from every view, everyone, no one
AssertionError: 50k everyone: counts with the waiting count p95 5.06ms > 5ms: expected 5.064208000010694 to be less than or equal to 5
 ❯ gate packages/db/src/perf.perf.test.ts:57:70
     55|   const s = measure(name, budgetMs, fn, iterations);
     56|   stats.push(s);
     57|   expect(s.p95, `${name} p95 ${s.p95.toFixed(2)}ms > ${budgetMs}ms`).t…
       |                                                                      ^
     58| }
```

```text
 FAIL  |perf| packages/mail/src/adopt.perf.test.ts > Codex R13: 25,000 candidates added later, older than 25,000 waiting in the same bucket, merge in linear time
AssertionError: expected 12.574916999999914 to be less than 10
 ❯ packages/mail/src/adopt.perf.test.ts:76:17
     74|   clearInterval(tick);
     75|   expect(total).toBeLessThan(200);
     76|   expect(worst).toBeLessThan(10);
       |                 ^
     77|   // oldest first: the late ones in their places among those still wai…
```


## Landed repair: adoption ordered-input work

`7985fd4d` bypasses redundant sorting/merge allocation for already ordered IDs, retaining owned copy, original yields and unsorted fallback. Root9unit+6unchanged perf cases/types/lint pass. One review0findings. Historical12.575msfailure is unreproduced and causally unproven; budgets/workloads unchanged. [Source evidence and limits](../plans/drafts/release3-mail-adoption.md). Other milestone failures remain open.


## Landed repair: published-reply Escape ownership

`1005ef7c` hands early Escape to a ready published reply while retaining pre-admission cancellation and later-focus supersession. Root61unit+13scoped browser cases/types/lint pass, including the original Atelier failure; light/dark captures inspected. One review0findings. [Evidence and limits](../plans/drafts/release3-compose-editor.md). The separate2MBeditor failure remains OPEN55.9ms/50ms in the worker's final unchanged run; no editor performance correction or release-wide clearance is claimed.


## Landed repair: WAL settlement for reset and expunge

`403ebe94` brings bounded SQL location and membership removals into the owning store's existing settlement policy, preserving committed identity fences and cleaning temporary watches before rejection. Root321native+321WASM tests, types/lint and all38cases in the three unchanged affected perf files pass. Everyone counts p95is4.536458ms/5ms; its query is unchanged. The single review's two findings were regression-fixed; no second review. [Evidence and limits](../plans/drafts/release3-sql-lifecycle.md). Historical timing failures remain unreproduced; no universal resource ceiling or release-wide clearance is claimed. The large-editor gate remains open.


## Landed repair: supported view grouping

`aebe27a9..fb016e9a` adds opt-in transparent view groups and huge-composer containment without changing the document or serializer. Root90unit/1inherited skip,2extended light/dark browser cases, types/lint and original2MBgate pass: frame20.4ms/50ms, transaction11.4ms/30ms, serialization29.5ms/150ms, toolbar1.3ms/16ms, indent1406.1ms/1500ms. All original content/save/Enter/focus assertions reached. The single review's four findings were regression-fixed without rereview; coverage gaps and retained autolink timing failure are in the worklist. [Spec/evidence](../plans/drafts/release3-supported-view-groups.md). Fourth full milestone is next; no release-wide clearance yet.
