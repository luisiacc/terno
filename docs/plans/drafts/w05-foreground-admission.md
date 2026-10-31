# W05 foreground admission: S26 investigation and action dependency

## Request

“S26 request: while large backfill runs, explicit Send/open gets bounded local admission/response opportunities through SAME actual physical pool.” “Prove actual starvation/reserve gap before implementation with deterministic held native bodies, actual managed dispatch and public worker/RPC; do not just benchmark mock functions.” “If a necessary source binding/action boundary isn't owned here, provide exact dependency and minimal interface to Root, no unwired helper.”

## Existing and actual base

Actual clean base `41e7fd760f0dc8d1fa48ab12661be5e1dd0ce493`, matching expected main41e7fd76. Read AGENTS, report T04/A09/A10, baseline S26, worklist current limits, Plan26 relevant admission/refresh history, Plan62 admission/physical ownership, landed W05 policy/initial plans and current Plan87 schema/reminders. Held99836679 is not used.

`net-policy.ts` holds a shared64 native-response pool through actual EOF/terminal evidence; cancellation cannot reclaim it. `google-requests.ts` and core operation eligibility check64. Gmail backfill additionally acquires the Backend IncomingPipeline's six read slots; its separate promotion slot is one, not a seventh HTTP slot. A large list alone does not prove64 held native bodies. `gmail-api.ts` Send uses execute/api and shares OAuth/proof/quota admission; request purpose currently says mail. `threads.get` in handlers reads cached store detail only. Reader loadThread calls that RPC. Missing bodies are captured by account sync after history/backfill, not by explicit open. Attachments retry also requests whole account sync.

## Design

First qualify actual managed native dispatch under concurrent multi-account backfill with held native bodies, before selecting a reserve. Dedicated SQL/public RPC tests use the real Gmail provider, actual worker, synthetic intercepted NativeRequest transport installed before Backend. Exact route allowlist, native EOF counters and public operation outcomes are the oracles. Observe Send with six held backfill responses, then desired header-only open hydration. No speculative pool partition or generic foreground flag is introduced without demonstrated need and a wired action boundary.

If open cannot issue a read, queue the exact cross-surface seam to Root: handlers threads.get (or a dedicated renderer-only message-body RPC), BackendCore lifetime/credential-bound bounded hydration, MailProvider explicit keyed read and existing incoming admission. An explicit keyed read must not call full account sync, bypass identity/quota/auth, reorder immutable send attempts or preempt unresolved physical bodies. This interface is a proposal, not an unused implementation. No handler/UI edits in this exclusive transport slice.

## Tests and performance

Exact new file plus original physical transport controls and directly relevant saved policy controls. All tests append inherited NODE_OPTIONS --require=/tmp/terno-network-guard.cjs. Exact-include temporary Vitest configuration prevents broad backend discovery. Full Backend normal+lifecycle types and exact-file lint. No production hot path changes means no perf run. Normal incoming-worker prep only; restore initial absence after all commands join. Ordinary desired behavior failures remain failures, never .fails/skip or relaxed timeouts. No arbitrary latency deadline supplies a pass: count admission while background remains physically held.

## Out of scope

All full/release/build gates, editor/list, held round-two findings, W10, W03 refresh changes, storage/reminders/schema, provider quota guesses and fleet guarantees. Root owns interface coordination, serial rebase/retest/landing/worklist. Hosted project quotas alone are N-A; local admission/open is applicable and remains open until qualified. No universal wall latency can be guaranteed with stuck foreground bodies, OAuth, real cooldown, unavailable storage or exhausted physical ownership.

## Revisions after the Codex review

One actual native `codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -s read-only` critique completed naturally, exit0, nine points, `/tmp/terno-w05-foreground/critique-{prompt,final}.txt` and `critique.log`. Accepted all: six raw bodies cannot saturate64; added actual cached-refresh saturation (11 accounts × six existing identities; real minimal reads bypass incoming acquisition). Added independent incoming/read/open dependency and renderer-origin/cached-open requirements below. Send requires native POST plus consumed valid response and durable succeeded op, not enqueue alone. Cold real refresh/proof is exercised, no token prewarm. Distinguish source close from managed physical EOF; first control releases native bodies, joins complete sync and checks physical0. Event-driven wake after saturation remains unqualified because this dependency fixture deliberately runs autoSync false; it makes no automatic wake claim.

## Exact dependency for Root (proposal; no unwired helper)

- Renderer owner: `apps/web/src/components/reader.tsx` selection effect plus `apps/web/src/state/threads.ts:loadThread`. Trigger explicit missing-body admission on selection even if cached detail bypasses threads.get; invalidate/reload only the matching selected identity after completion. Peer-owned surface is not edited here.
- Public action owner: `packages/backend/src/handlers.ts`. Keep ordinary threads.get read-only for MCP; introduce a renderer-origin-only keyed body request, or an explicit renderer-only option validated at the handler boundary. Resolve account/message/current provider identity from the store; never accept caller-supplied provider URLs, tokens or a global foreground boolean. This handler/action boundary is outside the exclusive transport/classification ownership given here.
- Core/provider interface: bounded per-account/message deduplicated request with account lifetime, credential epoch, cancellation and eviction revision captured by BackendCore; MailProvider keyed read returns typed missing/full/partial result to the existing fenced body/ingest writer. Preserve body assets, flag responsibility, categorization and change notification; confirmed message404 has only its exact current identity's semantics. A stale result cannot refill an evicted/removed/rebound message. Cap active explicit reads and waiters before allocating body bytes; no generic queue or automatic retry.
- Admission: classify Send at execute and keyed open at that new action, propagate classification through their actual token/proof dependencies without upgrading unrelated shared refresh owners. Physical64 and incoming6/promoted1 are separate resources. Test incoming headroom explicitly; physical reserve2 alone cannot admit a keyed raw body behind six held raw reads. Proposed two physical foreground slots (one Send + one open) are not adopted policy without wired concurrency evidence. Background minimum sharing and event-driven worker/sync continuation need coherent tests before implementation.

## Observed dependency evidence

First exact run: public Send succeeds with one native POST/one operation attempt while six actual backfill bodies from two accounts remain held. Header-only public open returns null body. Expanded actual cached-refresh run: 11 background accounts reach64 retained native minimal responses through normal provider sync; a new public Send remains queued with attempts0 and native submissions0. This is a real local opportunity gap, not hosted fleet architecture or mocked helper throughput. The desired opportunity test remains an ordinary RED. A reserve must prevent that saturation *before* it occurs; no legitimate promise exists once all64 are already physically unresolved.

No production changes are made: the necessary renderer/handler/keyed-read plus incoming action seam must be coordinated by Root before a coherent Send/open implementation. These tests are a reproducible dependency checkpoint, not a completed S26 implementation or a release-green claim.

### Coherent checkpoint checks before R1

`final-functional.txt`:10 pass /2 ordinary desired-behavior failures (new file1 pass/2 fail plus original google-transport9 pass). Original control now explicitly joins both backfill syncs after release and proves physical pending0; first account native-body barrier removes a fixture race where account2 previously acquired all six before account1. The prior `coherent.txt`3fail/9pass includes that fixture race, not a third product defect. No deadline, workload, safety assertion or retry-for-green change. The saturation test is a baseline reproduction: its64-held barrier must be redesigned around bounded admitted/background-refused witnesses alongside a future reserve implementation, rather than run unchanged against a background cap62.

Full Backend normal+lifecycle types pass (`types.txt`, `final-types.txt`); initial exact-file lint passes. No production hot path changed or perf file executed. No SQL/IDB persistence code changed; evidence fixture uses actual temporary native SQL. No actual worker parser promotion witness or fake-IDB/crash/fleet guarantee is claimed. Native transport and public durable worker/RPC are exercised; small body parsing follows the existing small-message path.

Commands (each functional/type/lint command uses inherited NODE_OPTIONS appended with `--require=/tmp/terno-network-guard.cjs`):
- `pnpm exec vitest run --config .w05-foreground-vitest.config.ts packages/backend/src/foreground-admission.int.test.ts` (initial, then expanded saturation; respectively1pass/1RED and1pass/2RED).
- `pnpm exec vitest run --config .w05-foreground-vitest.config.ts` (coherent fixture race3fail/9pass; corrected final10pass/2RED).
- `pnpm --filter @terno/backend typecheck` (two executed checks, normal+lifecycle each).
- `pnpm exec oxlint --deny-warnings packages/backend/src/foreground-admission.int.test.ts`.
- `git diff --check`.

Procedure deviation: one investigative rg accidentally used a broad backend source glob with test exclusions, contrary to the requested no-broad-glob rule. It was not repeated. The prohibited stage2-baseline test was never manually opened, copied, edited or staged; its name appears only in normal compiler configuration routing. No content from that file is used as evidence.

### Direct safety controls and finite row recommendations

`NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" pnpm exec vitest run --config .w05-foreground-vitest.config.ts packages/backend/src/gmail-policy-admission.int.test.ts packages/mail/src/gmail-net.test.ts packages/mail/src/gmail-outcomes.test.ts` passed120/120, three files, once (`direct-controls.txt`). These are unchanged real policy/auth/accepted-unknown send controls, including the existing SQL/fake-IDB saved-policy fixture; they do not implement or qualify a new priority lane. The temporary exact-include config lists only five explicit files, is archived externally and removed before handoff. A final post-fixture Backend normal+lifecycle typecheck and exact-file lint pass (`review-types.txt`, `final-lint.txt`). All checks are scoped; no full repo gate or app/Vite/package build was run.

Root recommendations:
- **S26: needs work, action dependency queued.** Actual64-response backfill-refresh starvation and missing open/hydration action are reproduced. Six raw bodies alone leave Send capacity; that finite control passes. No bounded latency/fairness completion claim.
- **A09: needs work.** Mailbox/service/physical cap protections remain. Foreground and incoming headroom, finite foreground/background sharing and event-driven recovery require a coherent implementation with Root's renderer/handler coordination; peers own host retirement. Hosted fleet/project quotas alone are N-A.
- **A10: needs work overall; existing no-attempt deferral protected.** At real saturation public Send remains queued with0attempts/0submissions. Existing quota/Retry-After/auth/unknown-send controls120pass. No replay or provider charge policy changes.
- **T04: needs work overall.** This candidate proves an additional local admission gap, without reopening the held saved-sync display or B41 deadline P2s. Existing classification/quota policy remains unchanged.

No worklist disposition is edited here. This checkpoint must not be landed as an implemented feature: it deliberately contains two ordinary failing desired-behavior cases. The full task remains open pending the exact dependency release; no request for approval or invented clean review substitutes for implementation.

## Actual native source review and handoff

R1 completed naturally, exit0, actual native `gpt-6.1-sol`/high/read-only (`r1-prompt.txt`, `r1.log`, `r1-final.txt` under `/tmp/terno-w05-foreground/`). **Standards PASS, zero findings; Spec PASS for dependency checkpoint only, zero findings.** No production implementation verdict is claimed. Exactly one source-review round used; R2 unused. The earlier nine-point critique is separate and is not counted as a source review. No findings required repair or extra regression run.

Branch `t3/w05-foreground-admission`, actual base41e7fd760f0dc8d1fa48ab12661be5e1dd0ce493. One atomic checkpoint commit owns this plan, the three-case fixture and its two exact Backend compiler-routing entries. No production runtime, host, renderer, store schema, held candidate, worklist or user WIP edit. All owned shell/test/type/lint/Codex sessions completed and were joined; no signals, process kills, app servers or ports used. Every executed test appended the inherited network guard. Native temporary SQL directories are removed by unconditional fixture cleanup.

Initial incoming.worker.cjs absence was observed before the first test; preparation created it at first-run epoch1793436509. Archived generated bytes and temporary exact-include config to the evidence directory, then removed the generated file/empty dist directory and config, restoring original artifact absence. No report artifact was overwritten. Final whitespace passes. Final current-source counts:130pass/2ordinaryRED (10pass/2RED checkpoint+transport,120direct controls), with historical fixture race and initial/expanded run results retained separately above. This is finite functional evidence, no timing/performance/release clearance.
