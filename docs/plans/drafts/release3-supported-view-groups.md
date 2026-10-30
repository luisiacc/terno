# Release3: supported view sibling groups

Base: 2240ecf4. Branch: t3/supported-huge-editor-groups.

## Request (verbatim)

“ROOT AUTHORIZES the precise new interface needed to finish main release-green: a supported, opt-in ProseMirror VIEW-LEVEL sibling grouping extension plus its huge-editor integration.”
“Extend PM view reconciliation+position/selection/observer ownership together instead of out-of-band wrappers.”
“PM DOCUMENT NODE TREE, schema and serialized plain text/HTML/wire must remain exact. No new group nodes in stored model.”

The complete task in the implementation thread is authoritative, including its single original gate and single production review caps. This document quotes the production request; it does not relax any qualification requirements.

## Existing behavior and causal evidence

Plan16 applies content-visibility per paragraph above 2,000 root blocks. The original 27,028-paragraph / 2 MB gate remains RED. Native diagnostic grouping128 reduced visibility ancestors to212 and intersection/layout/event time, but is not an application gate. Out-of-band wrappers preserve serialization yet break domAtPos(7) → posAtDOM to0. Root nodeViews.doc is not invoked. Parked position-bound candidates are excluded. Plan76 image views/drop remain intact; Plans43/54 govern focus.

## Design and invariants

Add a typed opt-in EditorProps.siblingGroups(state) returning a positive target sibling count or null. Default absent is unchanged. Root-only groups own div.ProseMirror-sibling-group with one contenteditable ancestor (the original root), no role/tabstop/hidden/clip/fixed height. Groups are ViewDesc, never model nodes; size is sum of direct child description sizes, border0, parseRule skip:true. Widgets have size0 and stay in decoration order and side semantics. Block marks remain their native description subtrees.

Root reconciliation temporarily flattens only the description array, without DOM movement; existing node updater remains authoritative for reuse, destruction, marks, images and composition. Restore transparent groups before rendering or public lookup. Reuse contiguous previous groups, split locally when oversized, and combine undersized runs so storage is bounded by sibling count. No persistent timers or idle work. Ordinary edits retain group and untouched block DOM; no moving every block per key. Group counts/sizes refresh after reconciliation, including insert/remove/reorder. Threshold changes use the same ownership path. Composition must retain its ancestor; defer topology changes that would move the active composing block.

Public domAtPos/posAtDOM round trips hold for all positions/biases, group edges, empty blocks, atoms, marks and widgets. coordsAtPos/posAtCoords and nodeDOM must retain public meaning. Boundary tests compare default ungrouped behavior, allowing equivalent DOM representations. Root selection, backward/cross-group selection and SelectAll use the existing selection engine through zero-border descriptions. Mutation observation sees the real group owner, propagates dirty ranges and parses groups transparently, including cross-group deletion/paste. DOM parsing must descend within a group when possible rather than parse the whole editor per key.

Native editing/Undo, split/join/indent/list/quote, atom images, internal/external drag/drop, paste, composition lifecycle, native find and accessibility retain all content. No schema/storage/serializer or copy-wire changes. Containment moves to group ancestors only for huge documents; small documents retain original topology. Group intrinsic estimate follows block count, not clipping. Native find can reveal skipped content.

## Tests and performance

First turn the actual7→0 witness into a positive safety assertion that fails for unsupported wrappers. Dependency ESM/CJS public entry parity and full boundary matrices; exact PM doc, DOM text and serialized plain text/HTML; state/history and mutations; group topology and bounded DOM work; threshold/group-size transitions and destruction; decorations, marks, lists, quotes, atoms, composition. Direct editor tests, web types, strict owned lint and frozen offline installation. Preserve unrelated patches byte-for-byte.

Real Chromium uses actual createEditor plus actual application: full-size light/dark trusted typing, exact PM/DOM/saved values, start/middle/end caret/scroll, backward range, Undo/Redo, paste/composition where supported, native find/accessibility/keyboard, long wrapped/mixed/image/drop content. Inspect screenshots and scoped axe. Original perf.spec.ts:1164 once after causal implementation, unchanged fixture/thresholds/workload/assertions; retain any RED. No build/full suites. Every test inherits NODE_OPTIONS and appends /tmp/terno-network-guard.cjs; E2E_PORT57350 WEB_PORT57360/57361. External browser network blocked, synthetic providers only.

## Review and scope

One native gpt-6.1-sol/high read-only plan critique (≤12 points) before code. One completed native Standards+Spec production review only after actual implementation and focused green candidate. Fix findings fail-first; no second review. Post-cap lower findings backlog, high correctness/data-loss fixes verified explicitly without independent review.

No backend/store/db/idb/mail/core/schema/storage changes; no other patch/fetch/update, no old candidate import, no real profiles/secrets, no push/landing, no children. Full production build qualification belongs to Root. Process owners captured and reaped; no name/port kills. Original evidence remains archived.

### Root edges

Keep the first and final root child descriptions direct. The native root start/end editing boundaries and callers that inspect those elements retain their existing representation. Only interior sibling ranges group. This is the same policy at every enabled size, not fixture conditioning; typing/splitting at either edge moves at most the newly interior edge block. During composition preserve the composing block's existing group/direct parent and defer incompatible size/threshold transitions until a subsequent non-composing update. No timeout is added.

### Initial RED

`view-groups.test.ts` on unmodified1.42.8: supported topology fails (0 groups); default mapping/decoration tests pass. Initial history case additionally hit jsdom's absent geometry; handleScrollToSelection is now explicitly handled in this non-layout suite and endpoints are valid inline positions. Corrected run:1 failure/3 passes, sole failure is missing groups. Raw logs in /tmp/terno-supported-groups retain both.

## Revisions after the Codex review

Native gpt-6.1-sol/high read-only critique completed exit0/DONE (12 points, /tmp/terno-supported-groups/plan-review.log). Accept the explicit invalidation, group dirty/render lifecycle, narrow parsing, logical composition-child lookup, coordinate root termination, group-transparent domAfterPos, and bounded recursive rendering requirements. Widgets at a boundary must remain with the following nonzero description (negative and positive sides in original order), never stranded at the preceding group's tail; root-edge widgets remain direct. Counts refer to nonzero rendered sibling descriptions; spanning block marks remain indivisible and may exceed the model-block target. Groups containing only zero-size widgets are forbidden. Group CSS estimates are based on member block count and active independently of the later rt-huge class toggle. Threshold/size props invalidate same-document updates; incompatible changes during composition defer without new timers. NodeView callbacks retain upstream reconciliation semantics; no new reentrant editor updates are supported. Public lookup during callbacks requires explicit qualification rather than an assumption that the temporary physical/logical discrepancy is safe.

## Implemented candidate and focused qualification

The patch adds typed EditorProps.siblingGroups with defaultoff, zero-border view descriptions, root reconciliation ownership, narrow group parsing, transparent node lookup, root coordinate termination and existing composition-end integration. Root reconciliation has explicit DOM-aware public mapping while its child array is flat; a node-view callback regression failed at15→7 before this correction and passes afterward. No copied selection engine or model/schema nodes were introduced. Zero-size root decorations stay direct and partition ranges, retaining widget-side order without empty groups. Reuse absorbs local insertions up to2×target; adjacent undersized groups coalesce locally. Spanning marked sibling subtrees remain indivisible. Render recursion skips unchanged groups. Composition preserves the active ancestor and existing composition-end work resumes deferred topology. The application enables128 only past2,000 root children. Group CSS is active from construction and estimates height from actual member count. First/final children retain their existing direct representation.

Focused checks (artifacts /tmp/terno-supported-groups):
- `candidate-state.log`:10 grouping tests pass, including ESM/CJS, every numeric position×side×bias, default topology, backward selection/history, same-document size/on/off transitions, decorations, callback mapping, repeated split/join, observed character edits/wrapper removal,4098-block no-childList-write text edits, composition deferral/destruction, nested quote/list/marks/inline-image atom/reorder. Prior source run39autolink+12ghost+4group tests passed55. Expanded59-test run58pass/1autolink timing ratio failure (53.26ms versus51.22ms bound), retained; no variance waiver or rerun seeking green.
- `browser-qualified.log`:2/2 actual full-size app light/dark cases pass. `browser-mixed-settled.log`:extended2/2 pass with rich paste/12KB wrapped paragraph/lists/quotes, CDP Chromium IME text input, Plan76 image drop/Undo/Redo, exact model/text/HTML and saved values, native find, keyboard and scoped axe0. This qualifies Chromium engine input, not OS IME/hardware drag. Initial find test searched a string already edited; next topology expectation assumed exact128 chunks although local undersized merging is supported. Mixed-image test initially matched the asynchronous staging widget instead of the document image. All failed harness logs remain; these are not production RED claims. The actual callback RED remains separately recorded.
- Light/dark screenshots personally inspected: readable intact content, native find highlight, quiet unchanged layout; no group boxes or clipping. Extended mixed screenshots also captured and pending final visual inspection.
- `web-types-stable.log`:main+worker pass. An earlier types invocation overlapped patch installation and reported transient missing Base UI declarations; no Base UI changes. Strict owned lint passes. Dependency source compiles with source-to-source PM paths (`dependency-source-types-fixed.log`); compiling published source against stripped public model declarations first produced upstream private-type errors and exposed two owned narrowing errors, corrected through type-only signatures. Production ESM/CJS behavior is unchanged by that correction.
- Fresh manifests+original patches+lock offline frozen installation passes, zero downloads (`fresh-final.log`). Public package ESM and CJS reproduction both pass complete boundary matrices and topology toggles (`public-repro.log`). Original package.json, exports, version and absence of source maps remain unchanged; existing three patches are byte-identical to2240ecf4.

### Original gate (exact test, one executed run)

`E2E_PORT=57350 ... playwright test -c playwright.supported-groups.config.ts --project=original-gate perf.spec.ts:1164`:PASS1/1,13.7s. Unchanged27028 paragraphs/2MB fixture, samples/warmups/delays/windows/multiplier/deadlines and all content/Enter/DOM/focus assertions. Open191ms; transaction p95 15.0ms; frame p50 17.6ms (p95 44.9ms); one-save serialization29.8ms; toolbar p95 1.5ms; whole-draft indent1483.6ms versus1500. `original-gate-executed.log` is authoritative. The preceding command used a space after variadic `--project` and selected no tests; its error is retained, not a gate execution. No application/production/dist build or other original perf gate was run. Subsequent cleanup removed duplicate generated helper declarations/unused empty-widget loops only; the source type correction has no production JS effect. No timing retry is claimed.

Production review: not yet consumed. Exactly one read-only gpt-6.1-sol/high Standards+Spec review will assess2240ecf4..candidate after these focused checks.

## Single production review and corrections

The one authorized native `codex exec -m gpt-6.1-sol -c 'model_reasoning_effort="high"' -s read-only` production review completed exit0/DONE against2240ecf4..5380484f. Actual verdict: **Standards FAIL; Spec FAIL**, with2P1+2P2 findings (`code-review.log`). This verdict is preserved, not converted to reviewer approval after fixes. No second review or child occurred.

All four initial findings received failing-before/passing-after regressions (`review-parity-red.log`:4fail/10pass):
1. P1: an outer node decoration could retain description identity while replacing its DOM with a detached wrapper; the group skipped rendering and content disappeared visually. `updateOuterDeco` now invalidates the actual owning group through the reconciliation owner map. No all-block DOM scan was added. Tests add/remove the wrapper and require visible exact text plus full mapping.
2. P1: a new root widget inside the active group consumed its owner for the preceding run, then moved the composing block to a new ancestor. Reserve the old owner for the run containing the composing block and do not split that active run. The regression asserts identical composing ancestor and exact mapping after the widget appears.
3. P2: `endComposition` requested a clean update, but same-target invalidation ignored deferred topology. Non-composing `updateDoc` now includes `groupsDeferred`. Regression deletes preceding root content during composition and requires the active paragraph to become direct after composition ends.
4. P2: published source observer lacked the guards already in both runtime builds. Its invalidation now matches ESM/CJS exactly, checked by a package consistency regression. Source-to-source strict compilation passes.

`review-green.log`:14/14. The three behavioral review regressions additionally run through both public ESM and CJS entries: `review-entries-green.log`17/17. `review-browser.log`:extended actual-app light/dark2/2, including paste/long paragraph/quote/list/CDP IME/drop/Undo/Redo/exact save/native find/axe. Final screenshots personally inspected again. `review-source-types.log`, `handoff-web-types.log`, `handoff-lint.log` pass. New browser test types pass (`browser-test-types.log`); including inherited `playwright.config.ts` additionally reports its existing untyped custom-design project errors, which were not changed. Temporary type config removed, exact input retained outside the repo.

Final patch frozen offline install passes with zero downloads (`review-fresh-offline.log`); fresh public ESM/CJS matrix/toggle reproduction passes (`review-public-repro.log`). Original metadata/exports/version compare byte-exact to the unpatched package; original three patches and perf.spec.ts remain byte-exact to2240ecf4. All tests append the inherited network guard. No production build/full suite/package qualification was run.

### One new original gate after causal review fixes

Authorized new invocation only after changed production code: `review-original-gate.log`PASS1/1,8.3s. Same original test1164, unchanged workload/assertions/budgets. Open127ms; transaction p95 11.5ms; frame p50 18.2ms (p95 38.0ms); serialization28.9ms; toolbar p95 1.3ms; indent1402.7ms. All content/Enter/DOM/focus checks pass. The first implementation gate PASS remains retained separately. No original-gate RED or timing retry occurred; all other harness failures and four regression REDs remain archived.

### Handoff limits and backlog

Fixes after the one completed production review are regression-verified **without independent rereview**, as required by the cap. No further review round is implied. The reviewer’s remaining evidence gaps are backlog: exhaustive native cross-group deletion, comprehensive coords/nodeDOM comparisons, spanning block marks, and internal native drag. Mixed paste/IME/drop verifies resulting model-to-save exactness but does not independently compare every earlier byte after those operations (the preceding trusted-typing phase does compare the complete expected authored text/DOM/saved HTML). CDP engine composition does not qualify an OS IME. The retained autolink timing ratio failure has no waiver. Root owns production-build qualification and integration; no full-main/release-wide GREEN claim is made. No lower-priority follow-up work after the review cap, no old candidates, no fetch/push/landing, no backend/store/schema changes.
