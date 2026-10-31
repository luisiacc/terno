# W08 S47: finite attachment admission and lifetime composition

Actual base: `2d19f82c54eca7faa5c1ccd41cd4b2beb5ddd95a` (matches expected main2d19f82c). Dedicated isolated implementation; Root owns integration and worklist disposition.

## Request (verbatim scope)

“Coherent W08 remaining row S47: 'Attachments cross direct/upload-session boundaries, expire midway, exceed provider/mailbox limits and lose network; recover without duplicate attachment records.'” “Remainder is joining aggregate/part/account limits and relevant provider/admission combinations.” “Existing S47 R2 P2 oracle backlog (per SMTP chunk after final reopen, extra Gmail Cc/attachment exclusion) remains HELD.”

## Existing and design

Read report/worklist/baseline S47 and Plans29,60,65,62,33. Constants in core attachments and store admission define local18MiB aggregate/per-asset,100parts,256MiB account reservations (size+1024/asset plus Sent-copy reservation), conservative25MiB encoded budget. These are not provider quota numbers. Store orphan grace is24hours; age alone never expires a pinned sealed asset. Public append is ordered/idempotent only before seal. Gmail uses a direct raw MIME POST, not upload sessions; Graph remains Outlook-deferred/source-only N-A here.

Add a dedicated backend integration file: public attachment create/append/seal, draft save and compose admission with real SQL persistence and managed Google transport intercepted before Backend construction. Exact allowed routes only; unexpected routes fail. Finite cases join oversized per-asset reservation, aggregate overflow,100/101distinct parts, full account reservation and account independence, encoded body+attachment overflow, incomplete/removed/expired staging versus queued pins, graceful reopen and provider refusal/lost response/acceptance fences. Use independent exact draft snapshots, all chunk bytes, durable asset/link/part rows and operation JSON. Capacity remains local, never provider refusal. Test meaningful oracle negative controls by corrupting snapshots/bytes/counts/envelope; never invent product RED where current protection is GREEN.

## Tests and performance

Only exact new/direct-caller test files; backend types and owned-file strict lint. Append inherited NODE_OPTIONS with --require=/tmp/terno-network-guard.cjs to every test. No production change unless an isolated mail validation defect is demonstrated by an ordinary failing regression. No hot path change means no perf run. Native read-only gpt-6.1-sol/high plan critique once, then Standards+Spec code review at most twice; preserve verdicts and all failures. No children. Capture/reap owned CLI PID with finite supervision.

## Out of scope and qualification limits

No core/store/SQL/IDB/contracts/RPC/GmailAPI/netpolicy production edits, held-series edits, UI/dependencies/worklist/main changes or full suites/builds. No remote upload service, live provider, actual OS network/crash/native browser guarantees; graceful close is only graceful reopen. No delivery promise from submission or optional Sent copy. W05 policy/quota, W02 shared-core and held IMAP recovery dependencies remain separate. This slice proposes only its exact finite supported boundary, never whole-S47 or28-row/release clearance.

## Revisions after the Codex review

Native read-only Sol/high critique exit0,10points (`/tmp/terno-w08-limits-0c6b4b26/plan.md`). Accept public-schema versus store distinction, exact cheap incomplete reservations, independent IMAP25MiB reservation rollback, strict24h expiry triggered by create, interrupted append/replay and queued pin separation, separate aggregate/encoded witnesses, preconstruction exact-route managed fetch interception, two new Gmail401/preconnection recovery traces and snapshot-specific negative controls. Freeze this series to tests: any discovered production defect is handed to Root, no exception. Allowed baseline is only docs/research/provider-reliability-baseline.md S47; forbidden backend baseline never accessed. Existing delivery/refusal/lost-response classifications remain historical, not repeated/relabelled as new coverage. The tests below establish only the finite combinations actually executed; unsupported Graph remains deferred.

## Implementation and initial evidence

Dedicated10cases, unchanged production. Public >18MiB create/101part refusal is schema evidence; aggregate18MiB+2 and encoded18MiB+1MiBbody refuse compose before consumption.100distinct sealed empty parts actually submit through managed Gmail. Account reservations reach exactly256MiB using legal incomplete assets, refusing another asset while a second account stages bytes; discard recovers capacity. IMAP-kind admission one byte beyond recovery-wire capacity rolls back messages/ops/links/copy rows even with appendToSent false; freeing a reservation admits (no SMTP dispatch claimed).

Chunk-crossing staging survives graceful reopen/idempotent replay; changed/out-of-order replay and incomplete/removed/collected refs refuse against an intact draft. Strict24h equality survives create; +1ms collects. A SQL test-only delete trigger interrupts reclamation after the first8chunks commit; reopen retains the unownable claim, removal of the trigger resumes cleanup without touching queued sibling bytes/identity. This is transaction fault injection, not OS crash evidence. Managed Gmail401→refresh→success reuses exact request bytes; preconnection ECONNREFUSED parks then uses the existing store resumeNetwork seam and succeeds with the same semantic content/message identity. The latter may rebuild MIME boundaries: no sealed Gmail wire equality or public reconnect/optimistic-cache coverage is claimed. Every attempt preserves queued refs/operation JSON; success releases op pins while message pins retain assets. Reopen and worker rerun never resubmit accepted sends. All routes are exact intercepted Request method/URL pairs installed before Backend construction, including reopen, and unexpected routes are asserted empty.

First run7pass/2fixture failures (wrong app.retryNow RPC and expected op-pin retention). Corrected9case run exposed an overstrong Gmail preconnection raw-boundary equality assumption; expanded10case run46pass/1fixture failure. Those are fixture failures, not product RED. Corrected final four-file run47/47GREEN (`qualified.log`). Existing direct controls comprise attachments.test, send-attachments.int.test and mail/compose-wire.test; no held delivery file was edited or rerun. Source-only temporary Vitest config lists those four exact files and omits global worker build; no generated artifacts to restore. Offline frozen ignore-scripts install changes no tracked dependencies.

Backend main+lifecycle types and owned oxlint pass. Full chunk readback was then added to stage, warranting final targeted verification. Copied snapshot negative controls detect duplicate assets/parts/links, corrupted chunk bytes and rebound operation payload with assertion-specific errors. No product RED/fix claimed. Evidence and critique supervisor PID/birth/argv/exit files: `/tmp/terno-w08-limits-0c6b4b26`. All commands joined naturally. Tests inherit NODE_OPTIONS and append the required network guard. No production change, so no perf gate applies.

Finite disposition proposed to Root: these local SQL/publicRPC admission/lifetime combinations are already protected, with the two managed Gmail recovery compositions qualified. S47 remains partial: held R2 SMTP chunk/Gmail exclusion oracles unchanged; no live mailbox/provider numeric quotas, Graph direct/session expiry (Outlook-deferred), actual SMTP SIZE plus these same boundary fixtures,401/reopen/IDB Cartesian matrix, public Web reconnect, remote upload URL logging, physical crash/OS/native-browser guarantee or all-provider certification. Existing SMTP/refusal/lost-response/acceptance evidence is not reclassified. No shared-core dependency found. Worklist/report/counts unchanged; full release/editor milestones parked.

Final expanded types caught the new retry identity assertion using nonexistent ParsedMessage.messageId (both undefined at runtime). Corrected to required nonempty rfcMessageId plus equality; this was a test typing/oracle defect, not product behavior. Dedicated10case/types/lint checks after correction are recorded in identity-{targeted,types,lint}.log. Earlier final-types failure retained. Native code review follows against the complete committed series.

## Code review R1 and corrections

Actual native read-only Sol/high R1 exit0: Standards PASS, Spec REQUEST CHANGES,3P2assertion gaps (`code-r1.md`). Staging captured its baseline after reopen/replay; parked network ownership was not observed; MIME IDs were compared only to each other. All three received ordinary fail-first negative controls: same-length chunk corruption, prematurely removed parked op pin and wrong queued identity each escaped the old predicates (3failed/10unselected, `r1-oracle-red.log`). No skip/.fails declarations, production RED or product fix. The predicates now compare the pre-reopen snapshot at reopen and replay, read both completed chunks against independent original bytes, inspect all assets/chunks/parts/links/op payloads while parked, and compare both parsed IDs to the nonempty queued payload identity. Empty ID is rejected independently. These controls call the same predicates at the real observation points. Corrected four-file run50/50GREEN, backend main+lifecycle types and strict owned lint pass (`r1-fixed-{targeted,types,lint}.log`). The original held S47 findings remain unchanged.

R1 runtime validation was unavailable in the read-only sandbox: Vitest tried writing a temporary transpiled config and received EPERM. Its source review, lint and whitespace completed; no reviewer runtime pass is invented. Final native R2 will inspect these corrections, with no third round and only high correctness/data-loss fixes afterward.

## Final R2 verdict and handoff

Actual native read-only gpt-6.1-sol/high R2 exit0 reviewed2d19f82c..c08ccb4b: **Standards PASS/Spec PASS for this finite qualification,0new findings**, all3R1P2closed (`code-r2.md`). Exactly one plan critique and two code reviews; no third round, reset or outstanding new finding. Reviewer native-config runtime attempt reached fixtures but read-only sandbox denied mkdtemp (13fixture failures before assertions); this is not a product RED and no independent reviewer runtime pass is claimed. Worker-run50/50and backend types/lint remain the executed qualification. Both review subprocesses were supervised with600s+30s bounds, captured owned PID/birth/argv, exited0 and were reaped; no signals were required. No production files changed after review, only this evidence append.

Exact final checks from this worktree (all exited0):

```sh
NODE_OPTIONS="${NODE_OPTIONS:-} --require=/tmp/terno-network-guard.cjs" pnpm exec vitest run --config /tmp/terno-w08-limits-0c6b4b26/vitest.config.mjs packages/backend/src/attachment-limits-interruption.int.test.ts packages/backend/src/attachments.test.ts packages/backend/src/send-attachments.int.test.ts packages/mail/src/compose-wire.test.ts
NODE_OPTIONS="${NODE_OPTIONS:-} --require=/tmp/terno-network-guard.cjs" pnpm --filter @terno/backend typecheck
pnpm exec oxlint --deny-warnings packages/backend/src/attachment-limits-interruption.int.test.ts
git diff --check
```

Temporary config is `export default { test: { include: ['packages/backend/src/attachment-limits-interruption.int.test.ts','packages/backend/src/attachments.test.ts','packages/backend/src/send-attachments.int.test.ts','packages/mail/src/compose-wire.test.ts'], environment: 'node', testTimeout: 20000 } };`. It changes no native timeout/budget and avoids unrelated worker builds/discovery. All tests append the inherited guard; only synthetic temp databases and exact intercepted Google requests are used. No app/Vite/production/package build, broad suite, timing gate, UI, main/worklist or held-series edits, fetch/push/landing. No tracked user/peer artifact was changed; no generated dist existed or was produced. Root must serially rebase, rerun targeted checks/types and ff-only land, then separately disposition the worklist and remove the worktree. This series alone does not close S47 or change28needs-work counts.


## Root integration

Rebased onto current committedmain66228197, including user's3c86e662hiddencategorydefault and66228197shortcutchanges; no conflicts or production edits. Root50/50same four exact testfiles, backend both typeprograms, strict owned lint/whitespace pass. Exact source-onlyconfig and guarded PID/argv/results in `/var/folders/_h/cy6nv52s2lj7n18v_mlcb3y40000gn/T/terno-root-w08-s47-kgdj9nz4`; no worker/appbuild. Processes naturally joined. Fast-forwardlanded afterchecks. Two native reviews, finalPASS0forfinitequalification, no later code/testchanges or furtherreview. S47remains partial per originalheldfindings and explicit limits; Rootupdates evidence, not rowcompletion. No broadreleaseclaim.
