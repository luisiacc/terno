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
