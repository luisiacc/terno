/**
 * What of the MailStore contract runs on real OPFS. db-wasm runs all of it on the same SQL, but over whole images
 * exported at close (wasm-setup.ts); here files live in sync access handles with a rollback journal (wasm-driver.ts),
 * so this keeps what depends on bytes reaching those files and coming back: reopen, send recovery, attachment bytes,
 * refused commands and freed pages. `opfs-lifecycle.ts` adds open, migrate, take over and the journal itself.
 * Matched on a test's whole name; the spec fails when an entry matches nothing, so a renamed test can't drop out.
 */
export const OPFS_CONTRACT = [
  // send recovery, all of it
  "draft recovery: SqlMailStore (wasm-opfs) > ",
  "ops state machine > crash recovery: running sends become unknown (never resent), other running ops requeue, across a reopen",
  // reopen
  "durability and migrations > what a command committed survives a reopen",
  // attachment bytes, and multi-table refusals that must leave them as they were
  "attachment conformance: SqlMailStore (wasm-opfs) > retains exact binary and legitimate empty assets across restart; never crosses accounts",
  "attachment conformance: SqlMailStore (wasm-opfs) > refuses incomplete or foreign assets atomically, retaining the original draft",
  "attachment conformance: SqlMailStore (wasm-opfs) > persists parsed incoming bytes/CID at ingestion and body completion without duplicate parts",
  "attachment conformance: SqlMailStore (wasm-opfs) > retains verified parts at quota when another part cannot be captured, through restart",
  "attachment conformance: SqlMailStore (wasm-opfs) > accounts reservations exactly through failed cleanup, discard, account cascade and reopen",
  "attachment conformance: SqlMailStore (wasm-opfs) > bounds chunk ordering, reserved bytes and actual encoded message overhead",
  // the file itself: auto_vacuum on the pool's own files
  "storage (plan 69): SqlMailStore (wasm-opfs) > is durable, and frees the attachments only it pinned (a draft's stay)",
  "storage (plan 69): SqlMailStore (wasm-opfs) > measures itself and gives freed pages back (now, or on the next open where only that can)",
] as const;
