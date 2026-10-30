# Release 5 exclusive move gap

## Request

Own the exclusive 5,000-thread × 20-category move/Undo load failure. Distinguish synchronous work, command ownership and native/timer overhead using exact gap windows and command spans. Preserve the original workload, gate, state/Undo semantics, deadlines and adaptive controller. Do not infer external noise from low CPU or excuse unexplained gaps. Implement only a demonstrated causal correction, fail-first; one sol/high read-only plan critique and exactly one production Standards+Spec review after implementation and focused green. No children, broad backend searches, protected cooldown fixture, IDB readers, frontend, builds or broad gates.

## Existing evidence and source

Base a4f629c0d2a401d0832edae10e5975b28b39e593. Read AGENTS, Plans 06/58, Plan02 move contract and release2 adaptive-load history. Plan58 is a separate IDB write-locality boundary. Plans64–68 remain read-only. Archived milestone5 `07-perf.log:1598` rejects a 51.974ms active gap (wall52/cpu6), no descheduled allowance. Archived load.json says only trainMoveSlice(4),14ms/cpu2.1 overlapped; max command22ms, GC2ms. Raw gap start/end and command spans are NOT retained in that report. Low CPU is not attribution.

SQL categories in categorize.ts journal membership slices then training, exact reverse restore. handlers.ts records beginMove then core.ts finishMove runs phase/pending reads, runBudgeted callback, store command, model deltas, notifications, yieldTurn and settle. Existing slowDown records only selected store commands; it does not cover model application, callbacks, phase reads or native scheduling. The controller measures the entire work callback, not just the store command. No causal defect is yet demonstrated.

## Design and verification

First run a separate bounded diagnostic of the original exclusive case with exact raw gap/command spans plus callback/model/yield/SQL boundaries and before/after state. Instrumentation must not grant an excuse or alter injected costs, workload or gates. Remove diagnostic wrappers before qualification. A source-supported deterministic regression at the actual work/measurement seam must fail ordinarily before a minimal correction. If no defect is proven, preserve concrete missing evidence and hand off rather than invent SQL work or gate relaxations. Retain all five original load tests. Only exclusive case after a real correction; whole file only if shared slicer changes. Direct native/WASM SQL tests only if SQL changes, scoped types/lint. Append inherited NODE_OPTIONS network guard to every test; synthetic providers/temp profiles only. No UI changes expected.

## Limits

No performance clearance from an instrumented run. No second review/model fallback. No review consumed on investigation. No full suite/build, fetch/push/landing, main/worklist or other owner edits. No workload/oracle/budget/timing/deadline changes or unchanged retries for green. Owned subprocess PID/birth/argv and finite native deadlines, identity-checked signals and reap.

## Revisions after the Codex review

One native `gpt-6.1-sol`/high read-only plan critique completed normally, 93.51s, 11 points. Verdict: **no causal defect established; acceptance/evidence needs refinement**. Full result `/tmp/terno-exclusive-move-evidence/plan-review.md`. The reviewer saw the diagnostic snapshot change during its reads; it correctly treated those wrappers as scaffolding, not implementation. No production Standards+Spec review has been consumed.

Accepted requirements (all eleven points): tracing overhead enters both the multiplied store CPU and controller measurements, so diagnostic timings cannot qualify performance. Parent/phase/chunk IDs and separate original-command/injection/callback boundaries would be necessary for a further causal trace. Flat nested spans must not be added together; aggregate active time does not locate native blocking or descheduling within a gap. Timing notifyChanged only measures scheduling, not its deferred callback. Further tracing must include deferred events, both yield resumptions, settle and phase/outcome reads before claiming completeness. A failing move assertion must remain recorded even if a separate diagnostic continues to Undo. Exact row/model snapshots, including metadata/features/decision outcomes and queued operations, are prerequisites to any semantic correction; the old count assertions do not establish those. Preserve commit-before-model/rebuild-replay ordering. Require an ordinary unchanged-source behavioral assertion RED at the proven seam before any fix. Freeze the executable matcher (which does not actually require n=1), busy-machine classification, list adjustments and all timing inputs. Any shared yielding/model change requires affected callers' gates even if slicer.ts is untouched; remove all diagnostic wrappers before qualification. Bound attempts and explicitly distinguish filtered, instrumented observation from the original full-file ordering.

No further implementation is proposed on this evidence. No injected cost, controller samples, warmup, workload or acceptance predicate was changed. There was one diagnostic invocation, not an unchanged retry series. Its native deadline was 1,380s (600s setup + 600s case + finite teardown/launch reserve); it exited in 54.16s. The review deadline was 240s. Both launchers were joined/reaped, with no surviving captured descendants at the final audit and no termination signals required.

## Diagnostic result and concrete ownership boundary

Command, from this worktree:

```sh
python3 /tmp/terno-exclusive-move-evidence/run.py /tmp/terno-exclusive-move-evidence/diagnostic 1380 - pnpm exec vitest run --project perf packages/backend/src/load.perf.test.ts -t 'an exclusive move of' --reporter=verbose
```

The supervisor appends inherited NODE_OPTIONS with `--require=/tmp/terno-network-guard.cjs` before launch. The existing demo provider/temp database, 20k seed, actual 5,000×20 move and Undo, two busy workers, ×2 CPU, 2–8ms fixed injection, original deadlines and gates remained. At audit PERF_MACHINE/PERF_BUDGET_MULTIPLIER/LOAD_WORKERS were unset. The run passed the selected case (39.492s case /47.93s Vitest); four other existing cases were filtered by `-t`, with no skip edits. This is **diagnostic only**, not release qualification. SQL wrappers change the CPU that is multiplied; callback wrappers affect measured slice time. Filtered ordering also differs from the full release file. Destination5,000 and source100,000 count assertions passed; exact row/model/operation-state equivalence was not added or established.

Raw evidence `/tmp/terno-exclusive-move-evidence/diagnostic-move.json` and `diagnostic-undo.json` records all command runs, over-budget windows, longest window and >=1ms SQL/model/synchronous notification spans plus each work callback. Instrumented source is preserved as `instrumented-load.ts`; original as `original-load.ts`. This diagnostic did **not** trace deferred notification execution, yield resumptions, settle, native stacks or exact statement identities. It cannot attribute all outside time.

Observed move:21,176ms; no >50ms gap. Longest gap `[25211.355500,25251.284166]`,39.928666ms busy,12.554ms thread CPU. It overlaps trainMoveSlice(4) `[25211.499291,25247.913083]`,36.413792ms, original measured CPU4.206ms; model apply `[25247.932000,25251.164625]`,3.232625ms/2.625ms CPU. Entire work callback `[25211.476333,25251.185208]`,39.708875ms/12.375ms CPU. Thus real post-command work is already measured by the production controller, but lies outside the reported store command.

Observed Undo:17,874ms; six >50ms gaps classified by the **existing** machine-busy/descheduling rule, none by a command excuse. Longest gap `[40843.138833,41013.073291]`,169.934458ms busy,5.281ms CPU. Store restoreMoveSlice(1) `[40869.290833,40979.269791]`,109.978958ms, original CPU1.779ms; model apply `[40979.464583,41011.336625]`,31.872042ms/1.738ms CPU; entire callback `[40869.274166,41011.355125]`,142.080959ms/5.099ms CPU. About27.85ms of this gap is outside that callback; the callback also includes work outside the store command. Nested intervals are not additive ownership evidence. Low CPU does not distinguish native waits from scheduling delays.

This exposes a concrete boundary against an unsafe instrumentation “fix”: the store span covers only64.72% of that Undo window, whereas the entire work callback covers83.61%. Substituting the callback for the command could satisfy the unchanged80% matcher while absorbing separately owned model work and untraced intervals. That would broaden the oracle, not prove omitted work belonged to the store command. No such change was made. The archived52ms/14ms observation cannot be retroactively mapped to these new timestamps or to this different Undo window.

The generic report table prints a cross for raw170ms, while the runner passes using the existing descheduled rule; this is not a new waiver. Conversely the original full-release failure remains RED. The diagnostic's lack of a move failure does not clear it or establish external noise.

## Disposition and next causal evidence needed

**Unresolved release blocker; evidence-only handoff, no safe production correction demonstrated.** There is no ordinary deterministic RED proving a production or instrumentation ownership defect, so no fabricated regression or speculative SQL rewrite was committed. One plan critique completed; **zero production reviews**, preserving the single review for actual implementation plus focused green. No qualification invocation after a correction exists because there is no correction.

The necessary next evidence is an actual failing window with correlated phase/chunk/parent spans covering store SQL/injection, committed model application, deferred notification execution, yield resumptions and loop sampling, plus native-thread evidence if time remains outside JS. The current archive has discarded those raw windows; this diagnostic supplies concrete spans but leaves deferred/native ownership open. A same-scope SQL fix is unsupported by either observation. Any future shared scheduling/model correction needs a concrete causal handoff and ordering/state regressions first. Do not replace the narrow command excuse with callback ownership or reclassify low-CPU gaps wholesale. Further instrumented runs would be diagnosis, never unchanged retries for qualification.

Restored load file SHA256 `e18633b7a7516de7dbef4ada469b087e275cb8dd792eb627ee859c4266f2c90c` equals its original bytes; all five tests remain. No production, test, slicer, SQL, IDB reader, shared schema/RPC/core or frontend change remains. No protected cooldown fixture was manually read, searched, copied, edited or staged. Only this draft is committed. Scoped types/lint/tests of unchanged modules and all broad gates/builds/smoke were not run. `git diff --check` passed. No real profiles/secrets, browser, push, fetch/landing or main/worklist edits.

Process evidence: `diagnostic.json`, `plan-review.json` retain owned PID/birth/argv, limits, exits and empty remaining-process audits; `restoration.json` retains source hashes/environment audit. Test launcher45035 born16:34:28; Vitest45118, worker45207; review44298 born16:34:13. The native CLI's startup automatically ran plugin-metadata `git ls-remote` for the AWS toolkit, captured by the supervisor; this was not an authored repository fetch or mail traffic, but the Node test guard does not sandbox native executables. pnpm automatically materialized cached dependencies and ran its existing Electron ensure script before Vitest; no production/dist build command was requested. These startup side effects and the incomplete trace limit the evidence; none is a production finding or a reason to consume the reserved review.

Exact completed plan-critique command (exit0; no fallback or second critique):

```sh
python3 /tmp/terno-exclusive-move-evidence/run.py /tmp/terno-exclusive-move-evidence/plan-review 240 /tmp/terno-exclusive-move-evidence/plan-prompt.txt codex exec -m gpt-6.1-sol -c 'model_reasoning_effort="high"' -s read-only -C /Users/Luis/.t3/worktrees/emailclient/t3-14dc59c4 -o /tmp/terno-exclusive-move-evidence/plan-review.md -
```

## Continued investigation: reporting improvement

Root authorized the missing correlated trace and one diagnostic in original full-file order; no additional plan critique. Separate reporting change: `load-failure-detail.ts` retains the first16 over-budget intervals and first16 overlapping store commands per interval, stable stage-local array indices, exact numeric timing fields, descheduled membership, and explicit omitted counts. Names are capped64 characters; arbitrary properties are excluded. It executes after measure/loop.stop, is serialized only into the existing bounded per-stage report note, and never enters excusedBy/classification/list adjustments. Both ordinary underLoad stages and the adaptive stage retain it; no additional report file or hot-path collection is added.

Fail-first: `/tmp/terno-exclusive-correlated/retention-red.log` has2 ordinary assertion failures on an empty-retention implementation (missing exact intervals and missing bound/truncation evidence). Implemented retention; identical2 tests passed in `retention-green.log`. Exact-file `oxlint --deny-warnings` on helper/test/load and `tsc -p packages/backend/tsconfig.json` passed; each command ran via the owned-PID supervisor with the appended network guard, native120s cap, natural exit and empty survivor audit. This is test observability only, no runtime correction or release-green claim. Production review remains unused, per Root's instruction against consuming it on unfinished diagnosis.
