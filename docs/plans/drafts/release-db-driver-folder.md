# Release database driver and account-folder qualification

Request: safely complete the three disk storage driver failures and the first account-own-folders navigation milestone described in the implementation assignment; preserve every native lifecycle, physical-byte, free-disk and failed-VACUUM assertion and all 5,000-location timing/control assertions. No identity fence relaxation, production builds or full gates.

Existing behavior: storage.test.ts opens live native files, whereas db-wasm swaps openDatabase for whole images persisted on close and disables desktop compactOnOpen. Plan69 explicitly limits restart VACUUM to Node; legacy WASM databases retain reusable free pages. New WASM databases use incremental vacuum. The navigation fixture resets Big, which holds message identities; upsert intentionally refuses held identities. Reusing those messages manufactures an invalid recovery fixture.

Design: bind the native physical-file tests explicitly to the native driver without dropping project discovery, add discovery/driver regression and explicit WASM image tests covering new-file shrink after close/reopen and legacy free pages/pending state without automatic VACUUM. Preserve native faults. Create fresh conversation source identities via supported ingest before the measured upserts; assert exact 5,000 count, resolved identity and successful dispatch before timing. Retain legacy/reset hold controls. Do not change production unless a behavioral regression is proven.

Validation: guarded ordinary storage tests in unit/db-wasm and affected fixture tests, scoped db typecheck/lint, only the account-own-folders perf case with original workload/limits. Native read-only plan critique (at most twelve points), atomic commits, exactly one completed native Standards+Spec code review. Fix serious findings fail-first; lower subsequent issues recorded. No OPFS qualification, throughput, app tests, UI or backend scope.

RED: /tmp/terno-db-driver-folder/storage-red.log records native 3/3 pass, WASM 3/3 fail (unable to open file, onRestart and noRoom). Perf reproduction pending.

## Revisions after the Codex review

One completed native read-only plan critique returned seven points; all accepted (`/tmp/terno-db-driver-folder/plan-review.txt`, exit 0). Route the physical-file suite to unit with actual Vitest project-discovery regression rather than bypassing openDatabase's startup hook. Complement it with explicit WASM images using the shipped openDatabase hook under a temporarily selected driver restored synchronously. Compare populated and compacted persisted images, distinguish absent/persisted pending requests, create unique fresh provider/message/conversation identities in a separate source mailbox after Big measurements, preflight complete-source dispatch without fencing, retain reset holds and assert all target locations before/after relist/removal.

Ordinary source/project regression first failed on the old configuration (`discovery-red.log`, exit 1). Original perf case also failed exactly at zero-vs-one Convo membership (`perf-red.log`, exit 1). A second fail-first oracle run substitutes the old held rows at the new preflight; it must fail unresolved-identity validation before measured upserts. No production change or blanket legacy trust.

## Qualification before code review

Storage GREEN: unit + db-wasm scoped storage/project/image run passes **9/9** (`storage-green.log`); discovery excludes only native live-file tests and collects image tests on both projects. All native physical-size, startup state, freeDisk and failed-VACUUM assertions remain. Whole-image tests use real exported/persisted files, compare populated vs compacted images and reopen exact page counts, check removed mail absent, and retain legacy free pages with no new restart request while preserving an existing pending request. This is the non-OPFS image adapter contract, not OPFS qualification.

Perf RED→GREEN: original fails Convo 0 vs 1; old held-row fixture at the new preflight also fails unresolved identity (`fixture-oracle-red.log`, exit 1). Fresh ingestion through ingestMessages creates all 5,000 provider IDs in one provider conversation with trusted source locations; full-source dispatch succeeds without fencing, old reset identities stay held, Convo is absent before timing. Original scoped perf passes **1/1** (`perf-green.log`, 33 other tests unselected); no workload, timing window or limit change. Exact destination UID/epoch mappings are additionally asserted outside timing. All reset/relist/rebuild/scopes/removal controls remain.

Direct callers pass **82/82** (unit/db-wasm IMAP identity plus storage/folder conformance; 534 unrelated cases unselected, `callers.log`). db typecheck and scoped oxlint pass (`types.log`, `lint.log`). Every test process inherits NODE_OPTIONS with --require=/tmp/terno-network-guard.cjs, including discovery subprocesses. Temporary synthetic files only. No production files changed; no broader interface dependency. No builds/full suites, throughput or unrelated perf runs.

Final commands (prefix every test launch with `NODE_OPTIONS="${NODE_OPTIONS:-} --require=/tmp/terno-network-guard.cjs"`):

```sh
pnpm exec vitest run --project unit --project db-wasm packages/db/src/storage.test.ts packages/db/src/storage-images.test.ts packages/db/src/storage-project.test.ts
pnpm exec vitest run --project unit --project db-wasm packages/db/src/imap-identity.test.ts packages/db/src/store.conformance.test.ts -t 'identity:|identity review:|storage|folders'
pnpm exec vitest run --project perf packages/db/src/perf.perf.test.ts -t "lists an account's own folders"
pnpm --filter @terno/db typecheck
pnpm exec oxlint --deny-warnings packages/db/src/storage.test.ts packages/db/src/storage-images.test.ts packages/db/src/storage-project.test.ts packages/db/src/test/storage.ts packages/db/src/perf.perf.test.ts vitest.config.ts
git diff --check
```

The final perf run after adding exact UID/epoch witnesses passes (`perf-final.log`; report copied to `perf-final.json`, multiplier 1). Final db typecheck and lint exit 0 (`types-final.log`, `lint-final.log`). The first pnpm test invocation materialized the offline cached workspace dependencies and ran the repository's normal postinstall; no app/package build command was run. Synthetic images, no real profiles, providers or secrets. No pushes, landing, other children, worktrees, worklist/main or Plans64–68 edits. No review-driven source changes yet; final code review disposition follows.

## Final native Standards + Spec review

Exactly **one** completed native code review, separate from the single plan critique: `codex exec -s read-only -C "$PWD" --ephemeral -o /tmp/terno-db-driver-folder/code-review.txt -`, reviewing `dadc7f46b8b9a94aeff2b34a9259ce3309d07cde..0304f95b`. Actual exit 0. **Standards PASS, Spec PASS, zero actionable findings** (`code-review.txt`, full transcript `code-review.log`). No findings to fix or backlog from this round; no second review. No source change after review. Final evidence/documentation only is committed afterward.

Final result: both failures were fixture/driver-contract mismatches, corrected without production edits or weaker identity trust. Storage new-image reclamation and legacy reusable-space behavior are qualified; native restart compaction/fault coverage is preserved. OPFS remains unverified separately. Full release gates, other perf cases and throughput were deliberately not run under this assignment. Root owns integration/landing and inventory updates.
