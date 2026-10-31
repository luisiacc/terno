# Release 6: SMTP auth and receiving readiness

Base: `7bc3b97dc040cae83db648e47e52d69e99a3f272` (clean prepared worktree).

## Request and scope

> Sixth03 unit exact failure S21 '535 parks only sends while IDLE, body reads, flags and foreground receiving work across SQL reopen' at smtp-auth-isolation.int.test.ts330: expected full body 'Exact after-refusal body.\n.Dot line\n' and isReadfalse; actual bodyStatenone/bodyTextnull.

> Determine fixture await/ordering vs production lost hydration; do not assert eventual truth by bypassing public read path, force full sync as workaround, sleep arbitrary delay, add retries, remove body assertion or treat auth isolation as permission for replay.

Own only `packages/backend/src/smtp-auth-isolation.int.test.ts` and this spec unless an ordinary counterexample demonstrates a production seam requiring coordination. Plans 25, 26 and 31 govern send-only authentication and receiving lifetime; plans 64–68 remain read-only. Preserve acceptance/recipient/UID fences and parked send wire images. No UI or production changes without demonstrated defect.

## Evidence and design

Exact original targeted invocation passed once on current source (1 passed, 12 unselected); historical snapshot RED remains unwaived. `threads.get` (handlers.ts) is a snapshot read, not a body download request. IMAP sync ingests header records with bodyState none, then syncBodies fetches source and calls the backend-owned sink.setBody. Header discovery alone is therefore insufficient readiness.

Use a test-local one-shot gate at the existing store.sync.setBody boundary. Observe the held body through public threads.get, including exact incomplete state and unread flag. Prove the existing immediate-full oracle fails there before correction. Release the gate, await its owned durable body completion, then read through the public path and preserve exact body/UID/remote bytes assertions. Use the same readiness ownership for foreground receiving after reopen; remove the extra explicit sync used there as a readiness workaround. Capture per-command data/session witnesses so source FETCH and flag mutation target the right UID and remain separate from IDLE. A dropped body write must fail the final full-body assertion, even if completion resolves.

## Verification and limits

Every test inherits NODE_OPTIONS with `/tmp/terno-network-guard.cjs`. Synthetic loopback servers use ephemeral free ports and temporary SQL only. Run original S21 once; controlled fail-first readiness experiment; dropped-write negative control; full owned auth file and direct IMAP receiving/re-sign-in controls; backend types and strict owned lint. Finite owned process deadlines and PID/birth/argv evidence under `/tmp/terno-release6-smtp/`. No original perf oracle changes, production hot path, app builds, full suites, UI/e2e or release clearance. Exactly one native gpt-6.1-sol/high read-only Standards+Spec review after focused green; fix findings fail-first, no second review. Root owns serialized landing and full release qualification.

## Revisions after the Codex review

Native gpt-6.1-sol/high read-only plan critique completed, exit 0, eight points (`/tmp/terno-release6-smtp/plan-review.txt`). Accept gate identity matching, original write/result propagation, public state as oracle rather than completion alone, immediate persisted body read after reopen, current server-positive IDLE, removing only the extra foreground hydration sync, command data/session/locator evidence, and explicit release/join cleanup. Scope UID claims to the exact captured locator; this slice does not newly qualify UID/sequence divergence (existing identity controls remain unchanged). Foreground trigger ownership must exclude live INBOX push, rather than claim sync.now owns an arrival that IDLE can also discover.

## Implementation and fail-first evidence

Only the owned test changes. Gate the exact synthetic body's original durable write, match its message ID through public threads.get, observe none/null/unread while held, release and await that write, then assert full exact text/unread through the same RPC. This is eager sync hydration readiness, not a new public body-download demand. Original production remains unchanged. Capture bounded wire commands with session/mailbox/UID selectors; assert exact source fetch, separate IDLE connection, locator UIDVALIDITY, remote bytes and Seen mutation. Read the first body immediately after SQL reopen, before any receiving restart. Foreground mail arrives in Archive outside INBOX watch, through public sync.now, with the same held/incomplete/completed/full witnesses and no extra sync workaround. All send parking, reconnection, exact wire/recipient/Sent and no-replay assertions remain.

Evidence under `/tmp/terno-release6-smtp/`:

- `baseline.log`: unchanged current-source exact S21 passed once; no claim that historical RED disappeared or was noise.
- `readiness-red.log`: armed held-write fixture with the original immediate-full assertion fails with the exact reported none/null/unread mismatch. Remaining assertions were unreached, not passes.
- `focused-green.log`: corrected readiness passes S21.
- `dropped-write-red.log` and `final-dropped-write-red.log`: temporary no-op body commit returns valid empty bookkeeping, resolves owned completion, and still fails the exact public full-body assertion. The final helper uses an ordinary promise; the original bound write is restored. Later foreground/reconnect assertions are unreached in these negative controls. `dropped-write.patch` preserves the final negative experiment. No experiment is committed.
- `scoped-green.log`: 33/33 across full auth isolation, installed IMAP IDLE/foreground controls and re-sign-in controls.
- `types.log`: initial helper failed package types because Promise.withResolvers is outside the configured lib; replaced locally with ordinary Promise constructors, without config changes. `final-types.log` passes both backend type configurations; `final-lint.log` passes strict owned-file lint.
- `final-scoped.log`: 33/33, but its execution overlapped the final temporary negative-control mutation; it is not the final qualification. A fresh serial `qualification.log` runs only after restoration and completion of that experiment.

Exact commands (each invoked through `python3 /tmp/terno-release6-smtp/run.py <label>`, which appends inherited NODE_OPTIONS with `--require=/tmp/terno-network-guard.cjs`, captures PID/start/argv, waits/reaps under a 600-second outer deadline):

```
pnpm exec vitest run --project unit packages/backend/src/smtp-auth-isolation.int.test.ts -t '535 parks only sends'
pnpm exec vitest run --project unit packages/backend/src/smtp-auth-isolation.int.test.ts packages/backend/src/imap-idle-foreground.int.test.ts packages/backend/src/resign-in.test.ts
pnpm --filter @terno/backend typecheck
pnpm exec oxlint --deny-warnings packages/backend/src/smtp-auth-isolation.int.test.ts
```

No perf oracle, workload, delay, timeout, threshold, retry or skip changes; unselected tests in focused probes are selection, not new skips. No UI/copy changes, screenshots, app build, full suite, global release/perf gate or packaged smoke. Existing network guard blocks external test traffic; servers bind loopback port 0 and OS allocation establishes available ports. All test/review processes have owned identity/exit records and are joined naturally; no signals used. Full-release milestone evidence remains RED and Root owns subsequent integration/gates. Initial pnpm invocation automatically materialized the prepared worktree's offline-cached dependencies and Electron postinstall; no app production build was requested.

## Final qualification and single code review

`qualification.log` completed naturally: 3 files, 33/33 passed, no skips in the complete scoped run. `final-types.log` and `final-lint.log` passed. No production code or perf oracle changed.

Exactly ONE native Codex gpt-6.1-sol/high read-only Standards+Spec implementation review completed naturally, exit 0: **Standards PASS, Spec PASS, zero actionable findings**. Full verdict: `/tmp/terno-release6-smtp/code-review.txt`; transcript: `code-review.log`. It checked gate forwarding/cleanup, public body truth and immediate SQL reopen durability, Archive foreground ownership, preserved send replay fences, and the supplied RED/GREEN evidence. No finding required a correction; no second review or fallback, no post-review code changes, and no lower-priority backlog finding. UID/sequence divergence remains outside this slice's new claims. This is scoped approval, never whole-gate clearance.

Both native invocations used:

```
codex exec -m gpt-6.1-sol -c 'model_reasoning_effort="high"' -s read-only -C /Users/Luis/.t3/worktrees/emailclient/t3-9e052750 -o /tmp/terno-release6-smtp/<plan-review|code-review>.txt - < /tmp/terno-release6-smtp/<plan-prompt|code-prompt>.txt
```

They were also wrapped by the same inherited-guard, finite-deadline owned runner. The configured CLI emitted optional connector/marketplace startup warnings; both actual OpenAI native review sessions completed with the requested model/effort/sandbox and exit 0. No alternate review provider or fallback was used. Root should preserve the original milestone RED, serially integrate this atomic fixture correction and run its separately authorized release gates. No fetch, push, landing, main/worklist change, renderer/store/schema/network/incoming-transport edit or live-main copying occurred.
