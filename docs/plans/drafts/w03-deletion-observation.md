# W03 A08: deletion observation qualification

## Request (verbatim)

> Coherent slice W03 A08: 'Tombstones and per-message history checkpoints stop stale body caches from resurrecting deletions.' Current row: existing local tombstones/body fencing are stronger than baseline; qualify stale provider observation and partial-thread deletion across restart.

Prepared base: `4b607e93cc2378b2b7622e0bb524ca4110a56cee` (matches expected main4b607e93).

## Existing behavior and ownership

Report A08, baseline A08 and worklist A08 distinguish local search tombstones from provider observation fences. Plan26 owns resource-specific 404 and completed-work cursors; Plan33 owns awaited incoming admission, account lifetime and credential cancellation; Plan38 epochs protect local flag ownership, not arbitrary same-pass remote revision ordering. Gmail incremental collects deleted IDs before reading changed metadata, skips deleted additions/labels, and removes exact local message IDs. Full reconciliation refreshes omitted cached IDs; recent-window omission itself does not delete. Backend serializes account sync and checks lifetime/credentials at store admission. Existing storage tests cover local eviction overlap with scripted ingestion; existing Gmail tests cover basic deletion and resource404 provenance (B13).

## Design and tests

Tests only in a dedicated backend integration file, synthetic managed Google native Request/Response interception installed before Backend construction, unexpected routes fail and are asserted empty. Real temporary SQLite and fake-IndexedDB durable reopen. Use two messages sharing a provider thread, exact distinct MIME bodies and binary attachments. Qualify deletion over older label/add history with huge decimal cursors, preserve sibling identity/body/assets/flags/counts/queued intent across reopen and replay. Hold an old raw or minimal response, retire credentials or remove the account through actual backend ownership, then release it and prove no stale row/body/asset/cursor writes. Qualify omission separately from explicit resource404. Add negative oracle controls by temporarily corrupting test-visible expected state/admission; no manufactured product RED.

## Performance and out of scope

No production hot-path changes expected; no timing gates, app builds or full suites. Run this file and exact relevant caller files with inherited NODE_OPTIONS plus --require=/tmp/terno-network-guard.cjs, backend scoped types and touched-file lint. No shared hot seam edits, generic tombstone service, sync redesign, arbitrary provider stale-post-request guarantee, remote exactly-once, process-crash guarantee from graceful reopen, native browser IDB claim or all-store/all-provider claim. Same Gmail ID reuse is not a supported remote generation contract; replacement account/credential admission is the supported witness. Root owns row/count updates and serialized landing.

## Revisions after the Codex review

One native gpt-6.1-sol/high read-only critique completed exit0 (seven points), evidence /tmp/terno-w03-a08/plan-review.txt. Accepted: distinguish account cursor from per-message checkpoints, fail terminal checkpoint before commit to prove actual replay, separate raw/minimal witnesses, exact surviving queued-target pruning, explicit omission/resource/history404 routes, temporary exact-file test and DOM types configs without worker build. Credential retirement uses the supported Backend dropAccount/signedIn ownership sequence directly (as existing catchup/ownership tests), avoiding reconnect-triggered background scheduling; public accounts.remove is used for removal. No durable per-message history checkpoint is claimed.

## Implementation evidence before code review

Dedicated12 cases pass on unchanged production: six each on native temporary SQLite and fake-IndexedDB reopen. Tests inject the real pure processIncoming implementation behind the IncomingProcessor interface; emitted worker/host execution is deliberately not qualified and no worker build runs. Initial harness attempts failed because multipart requires a processor, the first injected processor omitted whenIdle, Star targets only latest mail, and raw OpRow differs from normalized debug DTO. Those corrections are harness failures, never product RED. The normal backend main config lacks DOM types, so the new integration file follows existing lifecycle include/main-exclude convention with exactly one entry in each config.

Temporary test-only negative controls both fail2/2 selected cases: suppress actual sync.remove leaves the deleted row/body/attachment visible; widening actual removal to the sibling loses its exact surviving row. Both controls are restored byte-for-byte from the owned test backup. Evidence oracle-resurrection.log and oracle-sibling.log under /tmp/terno-w03-a08; neither edited production. The raw retirement case seeds a supported legacy body with a durable pending attachment capture, freezes its real raw response, retires the owner, applies newer deletion through normal history, then releases and joins the old read. Minimal retirement is a separate full-refresh witness. Public accounts.remove covers vanished-account admission. Graceful close/reopen is not process-crash evidence.
