# Store release repair slice

## Request and scope
Repair the shared definitive-success attachment assertion and inherited IDB historical upgrade/persistence failures from release milestone 2ac77324. Own store/db/idb and the direct draft upgrade fixture only. No renderer changes, backend changes, Plans64–68 edits, held R2 features, full gates, builds, push or landing.

## Spec
An operation success releases its operation attachment ownership. Independently retained receipt/wire and recovery-child ownership survives until its explicit bounded retirement. Tests must prove both ownership and eventual reclamation independently, while preserving accepted-send replay fencing.
Historical fixtures must represent the stores/indexes present at their stated physical version, retaining populated rows, full mailbox tables and upgrade fault activation. Upgrade assertions compare the expected explicit additions and transformations (including IMAP identity holds and cached-provider index), not just table counts. Dirty markers, actual terminal events and rollback images remain asserted.
Early load errors preserve their original identity and close the acquired handle. Delayed restored-index searches must actually suspend physical loading and reject after poison before exposure. Retarget injectors to the current request observer seam; do not weaken admission.

## Evidence and tests
Initial targeted RED: /tmp/terno-store-repair/attachment-red.log (3 failures), upgrade-red.log (21 failures). Exact commands and final outcomes will be recorded alongside logs. Run focused conformance cases then direct adjacency, touched-package types/lint. Native browser adapters only through dev configuration; no app builds. Disk/WASM storage fixture failures will be characterized separately.

## Out of scope / performance
No production hot-path change is planned unless a regression proves it necessary. No broad conformance sweep or perf suite. No UI strings or UI change.

## Revisions after the Codex review
The single native read-only critique completed exit 0; 12 refinements are retained in /tmp/terno-store-repair/plan-review.log. Attachment links and receipt wire are distinct resources; the failure is stale completion on unknown, not receipt retention. Prove stale no-op then explicit unaccepted retry/claim/completion, exact successful state and final asset reclamation. Existing receipt retirement/replay/child conformance remains direct adjacency, unchanged. Historical reconstructed compatibility images retain populated rows but remove future stores/indexes; names must state reconstruction rather than claiming old binaries. Add discriminating IMAP backfill coverage; retain minimal dirty admission sentinels. Delayed observers must activate and hold search pending. Early transaction construction must preserve original errors rather than manufacture marker errors.
