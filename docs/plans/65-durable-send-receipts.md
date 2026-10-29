# Plan65 r3 DRAFT — durable successful SMTP recipient receipts

External source candidate for ROOT read BEFORE sole Sol/high critique. ROOT C1 disposition selects lazy native receipt storage and honest validation, admits A1 and narrow connected UI as plan candidates, and requires confidential cursors/current warning scope. No production/API/schema/perf approval, allocation, runtime seal or critic launch. Prior r1/r2 remain byte-exact. Whole T07 remains OPEN.

## Request (verbatim)

> I want you to go through every item to fix here in this report. For each item that needs fixing you already have, in that report, what needs to be done but for each item you need to:
> 1. Go for that item.
> 2. Spec it out a bit more.
> 3. Do maybe a better investigation on it to see what's truly needed for us.
> 4. Build a test case reproducing that scenario, that potential scenario, or multiple test cases.
> 5. Fix it.
> 6. That will do it.
> 7. Spawn a subagent with Codex doing a code review of that fix, of that code you have just fixed and/or added.
> 8. Fix any findings.
> create atomic commits as you are fixing things.
> That way there is a double check on what you're doing and this can be better. Of course we need to maintain our performance while doing this and follow the directives that we have. You're going to do this for each and every one of the items that you have done here.
> Let's not create a separate branch or anything like that. Let's just do the fixes right here in the main branch. You should not stop until everything in that report is done.


## Scope and existing behavior

First slice: actual compose.send → real SMTP/IMAP → backend accepted latch → SQL/IDB ops.complete → ordinary get/recent/opInfo and used renderer details/persistent settings count-page/Clear. Current SMTP builds raw once, then normalizes rejected strings inside try; IMAP513–528 catches APPEND and returns only recipient-derived warning. Backend accepted=true follows provider return; T01 never resubmits after local completion failure. Stores otherwise discard new result fields/reapply successful completion. Existing boot uses warning to choose partial versus success, so redaction alone regresses it.

No full SendWork/wire/copy scaffolding. Root’s future submission/copy split/private original wire/unknown-copy/three-APPEND policy is not activated. Gmail Sent remains provider managed; Outlook deferred. SMTP acceptance is not final delivery, raw byte equality in one send is not restart wire retention. Current acceptance crash gap/immutable-wire/copy-repair/full recipient UI stays later T07 work.

## Deep module and interface

Keep existing operation commands as the small caller-facing seam. Real SQL/native-IDB receipt adapters hide immutable identity, bounded encoding, atomic publication/quota/retirement. Only that seam can couple receipt to actual op success/IDs/warning/asset unlink. No alternate fake adapter/queue or generic lazy DB/cursor/session framework. Exact types/path ownership are INTERFACES-FIRST; native shapes/keys/plans/facts are LAZY-STORAGE; retirement/table is RETIREMENT; used settings/privacy path is UI-CLEAR/WARNINGS; candidate account guard is REMOVAL-GUARD; cursor primitive is CURSOR.

## Admission, send and successful completion

Queue plans bounded canonical To/Cc/Bcc occurrences/part bytes/digests outside callback. Actual queue transaction checks current account incarnation, draft generation/revision/refs and unchanged account/global quotas BEFORE Sent ingestion/op linkage/draft deletion; reserve only fixed header/history capacity, not all byte parts. Refusal preserves original draft and never falls through to SMTP. Existing queued no-header mail bypasses new receipt admission/index limits and keeps old warning/T01 path, without fabricated evidence; a previously observed admitted header disappearing is closed/error, never legacy fallback.

Materialize admitted private parts in completed bounded commands before unchanged final hold/current/credential checks. SMTP accepted=true is first after sendMail resolves; only then result getters/yields/normalization. New post-success conversion/finally close/IMAP assembly failure returns accepted/incomplete fallback, no retryable new error. Explicit successful arrays only; missing/contradictory outcomes unknown. Preserve valid mixed warning/body/Bcc/raw/APPEND ordering; no provider storage await after SMTP. Backend accepted=true first after provider execute before destructuring/encoding/storage.

Complete coalesces real same-op/generation work; terminal send guard returns inert before result getters/IDs/warning mutation. Private source/outcome digest and owner/incarnation/generation guard each unit. Final actual transaction publishes fixed summary plus original op success/IDs/warning/asset unlink; commit-before-ACK survives reopen/replay. Failed staging remains private/current T01 unknown, no new resend authority or automatic successful writer recovery. User unknown retry remains its explicit authority and increments private writer generation.

## Native storage, resource and lifetime closure

Root selects C1-L: only bounded usage singleton is early receipt state; owner/header/part/byte records stay purpose-specific native cold stores. No all-table hydration/scan or receipt MemDb negative/index cache. Private bounded write plan joins the actual existing marker/persist transaction, including receipt-only empty ordinary commits. Each completed scope releases row/missing/index facts; abort reverts ordinary Memory, uncertain poisons/closes before release. Do not treat existing readLazy request-success or Table.evict row-only behavior as full terminal/fact eviction.

Get/recent preserve ACTUAL limits, including100_000. Default receipt projection uses16-row/<=98-fact units with yields outside serialization and final generation/visibility consistency; bounded drift retry then safe unavailable. No body parse/all-owner map. Existing unfinished app.export uses a real projection=false option, no ignored100_000 receipt lookups or backup expansion. History<=26 compact index keys/<=83 facts, cleanup<=8 units. Native account-incarnation index/BASE-existence/control facts validate summaries; header counts alone are insufficient.

Startup validates layout/version/marker/scalar structure, not every cold record. Point/page/command validates accessed facts; full debug and complete SOURCE/COPIED image admission streams ALL receipts/digests/references/global totals, preserving legitimate retirement prefixes. Bounded ordered merge reuses one thin fact from each existing BASE validation step and one owner accumulator; no per-receipt wide BASE parse/map. Existing op/nonreceipt validators, unsafe-source refusal, source/target locks and physical11 threshold stay authoritative. Future schema maxima/numbers unallocated.

Ceilings unchanged:8192 headers/active owner;32768 global headers/owners;65536 reserved/materialized part slots;256MiB global receipt charge including retired owners; unchanged256MiB combined account attachment+receipt; per receipt3000 occurrences/120 parts/25 entries/64KiB part/8MiB charge plus stated fixed identity bounds. These are ceilings for critique, not allocations, measured capacity or eviction policy. Attachment staging actually funnels through attachments.create, whose final command prefetches matching receipt charge/epoch. No silent zero-budget fallback/limit/MIME change.

Logical retirement fences immediately; cold physical bytes/metadata/charge retire in actual bounded commits. Keep full charge until header/owner deletion and subtract once; global charge includes deleted accounts, never replacement usage. Single event-driven pump/wake flag, actual BULK_SLICE15ms initial1/ceiling8; no new cleanup timer/network/tail. Measure worst callback, native terminal and whole deletion separately, even one unit may fail. Existing base nonreceipt cascade cost is separate, not fixed by A.

## UI, account and cursor candidate seams

Persistent lazy settings page25 count/date rows and sequential selected Clear<=25 provide recovery after a toast expires; no8192 render/bulk clear/poll or body/recipient/copy-history framework. Normal warning remains exact until deliberate Forget. Actual IMAP warning is entirely recipient-derived; add only an origin bit/header enum. Forget atomically replaces that warning with fixed localized address-free partial truth and retires receipt; existing unrelated warnings remain unchanged. No warningParts/composite/nested i18n/new copy-warning producer. Future mixed producers need an explicit source-contract change. Existing localized handles the new fixed EN/ES key.

Per-op/page/connection/account epochs invalidate pending and already-visible recipient descriptions before local Clear and on committed retirement event. Late pre-Clear results cannot restore them; failed/unknown ACK stays generic until explicit fresh read. Broad progress carries counts/partial flag, never private receipt addresses/unknown fields. Renderer-only/live-context gates and bounded owners apply; EN+ES/keyboard/focus-visible/light+dark/render-count checks remain required.

A1 remains a plan candidate: private immutable account incarnation supplements old stamp to distinguish same-id/email/clock replacement. Actual queue accountWrite admission/quiescence, guarded synchronous existing settings patch, exact People/Promise/Controller capture and removal-life checks prevent owner drift false refusal or damage to replacement. Final account delete compares incarnation then captures CURRENT owner atomically. Create/upgrade/native index/copy/import/export/bootstrap/log projections are explicit; credentials/OAuth/secret CAS remain unchanged. Existing partial photo-removal failure is not a fake rollback.

CURSOR replaces plaintext HMAC with built-in AES-GCM256, nonextractable per-Backend lazy key, unique96-bit IV prefix+counter and128-bit tag. Closed encrypted binary payload/envelope<=343 characters (<512), no plaintext private identity on RPC, no key export/log/persist/timer. AAD binds actual live connection nonce/account; account/owner/stopped context rechecked after crypto/native awaits. Narrow RpcServer live-context map checks cover connect, disconnect/detach/send-error/replacement; unrelated trusted invoke is untouched. This is a reviewed primitive proposal, not security/perf qualification.

## Atomic implementation slices and future gates

The first behavioral commit must land the coherent used receipt path, native/SQL quota/ownership/publication/Forget/cleanup/validation, persistent settings/cursor/guard and actual projections together; no unused helpers or half-owned receipts. Owned production files are INTERFACES-FIRST. Root first reads r3 changed seams then separately launches the prepared sole Sol/high source critic, fixes findings, and only then considers schema/API/application authority. No critic launched here.

Preserved PUBLIC test+fixture/helper/inverse10 definitions/assertions are byte-exact r2. Conditional predictions remain8behavioral RED/2beforeCommit controls, with exact first/lower oracle attribution and physical teardown uncertainty invalidating qualification. New source recipes cover real reached DATA/APPEND/raw/Bcc/warning, close/reopen, native terminals, actual recent100/100_000 batching, all cold cache facts/empty writes, full validation merge, account guards and AEAD tamper/reconnect. Missing helper/export/compile/setup failure is never RED. No recipe executed.

Future required checks: typecheck/lint/test/e2e/web/ui-perf; hot path perf/load50k+ both stores, startup/callback/whole latency/native IDB separate from fake-indexeddb fixture; packaged macOS build/smoke for real SQL/lifecycle; visual EN/ES/light/dark/accessibility. Verify no new idle timers/network/retained facts and correct resource bounds, rather than treating them as passing limits. Every independent code-review finding must be fixed under later explicit implementation authority. No test/native/perf/API readiness is claimed by this source packet.

## Out of scope and status

Only external r3 file/hash/text preparation. No shared source/Doc/config/import/collection/compiler/test/build/browser/provider/profile/critic/runtime seal/schema number/reservation/staging/commit. W05/F2/Search/Similar source remains untouched/unadopted. Frozen524 and explicitcc800 source assessment stay pinned; no moving-main repin. R1/r2 predictions remain archived intact. C1 validation choice is now selected; native write-plan integration, A1 account compatibility and AES-GCM/live-context details remain candidates for root read/sole critique, not approved implementations. Whole T07 remains OPEN.


<!-- NORMATIVE APPENDIX 1: INTERFACES-FIRST.md; source SHA256 640a07dd255e5e752eec0b76933447c5dd94603572f9a072265122c83383648d -->

## Appendix A — INTERFACES-FIRST.md

### r3 exact first-receipt interface/source contract

Source candidate only. ROOT selects C1-L and admits A1/connected receipt context/persistent UI candidates for sole critique; no shipped API/schema/perf approval. LAZY-STORAGE.md, CURSOR.md, WARNINGS.md, REMOVAL-GUARD.md are normative companions. All r1/r2 artifacts remain intact outside this namespace. No full SendWork/wire/copy API lands.

#### Portable types and actual provider additions

```ts
// core/src/send-receipts.ts, exported via existing index
export type SendRecipientSummary={readonly version:1;readonly submission:"smtp-accepted";
 readonly accepted:number;readonly rejected:number;readonly unknown:number;readonly complete:boolean};
export type RecipientEvidence={readonly ordinal:number;
 readonly outcome:"accepted"|"rejected"|"unknown";readonly responseCode?:number};
export type SuccessRecipientReceipt={readonly version:1;
 readonly token:{readonly opId:string;readonly sourceMessageId:string};
 readonly complete:boolean;readonly recipients:readonly RecipientEvidence[]};
export type ReceiptEnvelopeEntry={readonly ordinal:number;readonly role:"to"|"cc"|"bcc";readonly address:string};
export type SendReceiptSeed={readonly sourceMessageId:string;readonly envelope:readonly ReceiptEnvelopeEntry[]};
export type SendReceiptDetails=
 |{readonly kind:"not-recorded"}
 |{readonly kind:"retired";readonly cleanup:"pending"|"complete";
   readonly warning:string|null;readonly warningI18n?:TextRef}
 |{readonly kind:"available";readonly summary:SendRecipientSummary;
   readonly warning:string|null;readonly warningI18n?:TextRef;
   readonly recipients:readonly (RecipientEvidence&Omit<ReceiptEnvelopeEntry,"ordinal">)[];
   readonly nextOrdinal:number|null};
// mail/src/types.ts existing result, no ProviderOp field change
export type ProviderResult={providerMsgId?:string;providerThreadId?:string;
 warning?:string|Localized;recipientReceipt?:SuccessRecipientReceipt;recipientWarning?:true};
// MailProvider advertises recipientReceipts?:true; actual IMAP true, Gmail/demo absent.
```

SMTP returns raw/rejected plus bounded successful evidence; actual IMAP supplies stable intent token and recipient-only origin flag. Gmail provider-managed Sent is unchanged; Outlook deferred. No warningParts/composite/nested i18n/copy-warning type. TextRef is the existing core localized reference, not a duplicate warning codec. responseCode only an observed rejected RCPT400..599, never free response text. Explicit successful arrays only; no inferred acceptance from rejected omission. Unknown evidence is unknown, SMTP acceptance is not final delivery.

#### Store/RPC exact additions

```ts
// Private trusted store write fence, never RPC/progress/diagnostic
export type SendReceiptWriteToken={ownerId:string;opId:string;sourceMessageId:string;generation:number};
// OpRow adds address-free summary plus PRIVATE reservation projection:
// sendRecipients?:SendRecipientSummary;
// sendReceiptPreparation?:{ownerId:string;generation:number};
prepareSendReceipt(id:string,seed:SendReceiptSeed,now:number,
 expected:{ownerId:string;generation:number}):Promise<
 {kind:"closed"}|{kind:"ready";token:SendReceiptWriteToken}>;
complete(id:string,result:{providerMsgId?:string;providerThreadId?:string;warning?:string;
 recipientReceipt?:SuccessRecipientReceipt;recipientWarning?:true;
 receiptWriteToken?:SendReceiptWriteToken}|void,now:number):Promise<{touched:number[];deltas:ModelDelta[];receiptCleanup?:"pending"}>;
sendDetails(id:string,afterOrdinal:number,limit:number):Promise<SendReceiptDetails>;
forgetSendDetails(id:string):Promise<{cleanup:"pending"|"complete"}>;
recent(limit:number,options?:{receiptProjection?:false}):Promise<OpRow[]>;
// get unchanged signature; both decorate with bounded private native facts by default.
cleanupSendReceiptSlice(limit:number):Promise<{removedUnits:number;pending:boolean}>;
sendReceiptCleanupStatus():Promise<{state:"idle"|"pending";chargedBytes:number}>;
```

Renderer strict procedures: ops.sendDetails({opId,afterOrdinal?:0..3000,limit?:1..100/default100}); ops.forgetSendDetails({opId}); ops.sendReceiptHistory({accountId,cursor?:string<=512B,limit?:1..25/default25}); ops.receiptCleanup({retry?:boolean}). Return/page/detail structures are UI-CLEAR/CURSOR; no MCP_ALLOWED entries. Max-two receipt calls; settings holds one page/one in-flight sequence of <=25 independently committed per-op clears. All require live connected renderer receipt ctx before/after awaits. OpInfo adds sendRecipients/hasSendWarning only; no private UUIDs/origin metadata in broad progress. Events sendReceiptRetired:{opId} and address-free receiptCleanup state are used by actual mounted/visible UI.

History private store cursor/data shapes remain sendReceiptHistory(accountId,{ownerId,highWater,before}|null,limit)→{incarnation,ownerId,highWater,items:[{opId,savedAt,summary}],nextBefore}. Private fields are encrypted by CURSOR before RPC; never plaintext/base64+HMAC. New account guard/photo/capture signatures are REMOVAL-GUARD; no owner/null comparison as account identity.

#### Required sequence, durability and existing paths

Queue: clone input; bounded canonical envelope/part-size/hash planning and attachment preflight before synchronous final queue transaction. For IMAP, current incarnation/draft generation+revision/refs and native quota snapshot must still match at actual commit. Reserve fixed header/history slot/worst-case metadata under unchanged caps BEFORE optimistic Sent/op/ref linkage/draft deletion; no envelope byte parts in this callback. Refusal preserves original draft. Dispatch checks private header projection BEFORE new seed planning: truly no-header legacy uses old path and ignores new receipt evidence; observed header failure never falls through to legacy. Materialize <=one part/unit under owner/generation then final current/hold/credentials admission.

SMTP first statement after sendMail resolves is accepted=true, before result getters/yields/new conversion. Normalizer/index/close failure after success returns accepted/incomplete fallback; no retryable post-success normalization error. Original buildRaw byte lifetime/SMTP classification remain; best-effort receipt index failure for old oversized legacy envelope does not newly reject it. IMAP keeps caught APPEND before return, normal mixed warning exactly, no storage callback. Backend accepted=true immediately after provider execute before destructuring/encode/storage; existing T01 local recording never retries provider.

Complete: register/coalesce one real same-op/generation completion promise before await. Under each actual bounded native/SQL unit require running send/active owner/current incarnation/generation/source token and immutable digest; stage one bounded part. Terminal/missing send complete returns inert BEFORE accessing result getters, warning/IDs or mutations. Final actual transaction publishes fixed header/counts/actual charge plus original op success/IDs/warning/asset unlink; no new part scan/body parse/native callback yield. No-ACK success persists, replay cannot rewrite; deliberate Forget is the separate explicit warning exception. Private failed/unconfirmed parts are not acceptance authority; startup keeps current T01 running-send unknown policy. Unknown user retry increments private generation, never auto resubmits. Source_digest and full validation limits are LAZY-STORAGE.

Cold receipt IO uses bounded native read scopes/write plans integrated into real schema.persist and command, with existing marker/actual terminal/poison. No new receipt MemDb caches/indexes/negative sets; no claim Table.evict/readLazy suffice. Get/recent chunks16<=98 facts/keys, actual recent(100_000) opt-out for existing unfinished export, history<=26 compact keys/<=83 facts, cleanup<=8 units. Native private merge validators retain one op/header lookahead and one owner accumulator, never all-header/op/body maps. Startup scalar/layout admission is explicitly weaker than full debug/image qualification. Threshold11/BASE/C/T/E unchanged, future physical/logical numbers unallocated.

#### Exact intended production ownership

| Paths | Used first-slice responsibility |
| --- | --- |
| core/send-receipts.ts,index.ts; mail/types.ts,portable reexport | Closed data types, actual provider/result interface; no unused composite warning codec. |
| mail/smtp.ts,imap.ts | Accepted latch/normalization/finally/assembly closure, explicit receipt/recipient warning origin; unchanged raw/APPEND/errors/warning normal bytes. |
| store/types.ts,mail-store.ts,send-receipts.ts,index.ts | Actual projection/methods, bounded portable envelope/part codec/errors; no in-memory fake adapter. |
| db/send-receipts.ts,sql-store.ts,migrations.ts,attachments.ts | Real indexed reservation/staging/publication/read/retirement/combined quota; terminal guard; five tables/counters/indexes. |
| idb/send-receipts.ts,receipt-storage.ts,store.ts,schema.ts,attachments.ts | Purpose-specific native cold layout/scopes/plans; actual persist/empty-commit integration; scalar-only early load; asset final admission; no MemDb cache-framework change. |
| idb/op-storage.ts | Max-readable ceiling separation, bounded thin fact return/merge full receipt validation within existing BASE pass; no payload reparse/physical op format change. |
| db/repos.ts,idb/mail.ts + account create/upgrade validators | New private incarnation creation only; direct send op deletion remains account cascade with owner fence; no dead generic op-delete helper. |
| backend/core.ts,handlers.ts,import.ts | Actual preparation/complete/projection/retirement pump/details/history/cursor/context; queue accountWrite/removal-life; export's used projection opt-out. |
| backend/settings.ts,icons/service.ts | Pure guarded existing settings patch and reference-scoped People/Promise/Controller capture; no duplicate settings parser or broad account async removal. |
| core/rpc/contract.ts,server.ts,client.ts | Receipt methods/events, nonce/live ctx narrow checks/fixed errors, connectionVersion; unrelated trusted invoke unchanged. |
| backend/receipt-history.ts (private new) | Actual AES-GCM cursor codec used by history handler, no generic session/key/cursor framework. |
| web/lib/boot.ts,components/settings/accounts-tab.tsx; i18n en/es | Existing warning enrichment plus persistent lazy summary/clear/status UI, invalidation, new fixed partial-clear copy. Existing lib/i18n/core localized codec unchanged. |

Preservation/control paths: mail/compose,attachment-payload,gmail; store attachment staging/repo, IDB asset-accounting; backend export projection, account/secret lifetimes; web legacy-storage native copy. Only explicitly needed copy caller changes (full SOURCE/COPIED validator) land; no generic new journal/locks. No owner/private fields in bootstrap/export/diagnostics. Real tests are the preserved10 PUBLIC images, native/store/retirement/cursor/guard recipes and existing mixed/T01 controls. Source plans do not allocate schemas or approve APIs.


<!-- NORMATIVE APPENDIX 2: LAZY-STORAGE.md; source SHA256 7438da284cac6c73bd9e2d5c4306c52ae47310848d482cfadf582ba487c32e1b -->

## Appendix B — LAZY-STORAGE.md

### r3 C1-L exact native storage, batches and validation

ROOT selects C1-L and its honest validation contract. No eager receipt owner/header/part/byte hydration/index construction at startup or late load. Only fixed scalar usage is early receipt state. Five native stores, unchanged ceilings. Source proposal only; exact private integration below is a candidate for root/sole critique, not shipped API/schema/performance approval.

#### Native schema/index definitions (numbers unallocated)

| Store/key | Closed logical fields | Native indexes / SQL counterpart |
| --- | --- | --- |
| send_receipt_usage / singleton id=1 | charged_bytes, owner_slots, header_slots, part_slots, next_history_seq, command_epoch, visibility_epoch; fixed integer bounds | no secondary; one SQL singleton row |
| send_receipt_owners / id UUID | account_id, account_incarnation, email, account_created_at, phase, charge_bytes, header_slots, part_slots, visibility_epoch, created_at; active_key only for active | active_key UNIQUE (incarnation), retiring=[phase,id]; SQL unique active incarnation partial index + phase/id |
| send_receipts / op_id | owner_id, source_message_id, envelope_digest, source_digest|null, generation, phase, envelope_ready, seed_part_count, outcome_part_count, part_count, recipient_count, accepted/rejected/unknown counts, complete0/1, outcome_digest|null, reserved/stored/charge bytes, history_seq, published_at|null, view_revision, warning_kind, cleanup_reason|null, cleanup_next_position; history_key only for published | by_owner=[owner_id,history_seq] UNIQUE; retiring=[phase,op_id]; history_key covering index described below; SQL owner/history, phase/op and covering published index |
| send_receipt_parts / id=opId:position | receipt_id,position,first_ordinal,recipient_count,byte_size,generation,content_digest | by_receipt=[receipt_id,position] UNIQUE; SQL same unique index/FK RESTRICT |
| send_receipt_bytes / part_id | data_json bounded<=64KiB UTF8 | no secondary; SQL single-key child FK CASCADE |

All names/field bounds are closed. Active native owner has active_key=its incarnation; retiring owner omits it, never a stale active entry. Active account incarnations are private immutable tokens (A1). Native unique index and final guarded command enforce one current owner/incarnation. SQL RESTRICT versus native checked parent/child-exists guards remains; never invent MemDb RESTRICT. Complete/phase fields used as index keys are numeric0/1 or strings, not booleans/null. Published history_key exactly equals `[owner_id,"published",history_seq,published_at,accepted_count,rejected_count,unknown_count,complete]`; other phases omit it. op_id comes from cursor.primaryKey. It contains no warning/address/source JSON.

Native history uses openKeyCursor, descending within owner/published prefix, <=26 keys. SQL selects the same covering fields LIMIT26. Upper exclusive tuple is `[owner,"published",before]`; first-page boundary uses highWater+1 (at most2^53, an exactly representable private bound), token sequence values themselves remain positive safe integers. No offset scan or8192-row MemDb.by. Header parent/child queries use indexed getKey/one-key cursor; retiring-part slices<=8 and owner/header selectors return one eligible key.

#### Purpose-specific native integration, no receipt MemDb cache

Current Table.evict only deletes rows; it does not unindex or clear absent. Current readLazy resolves request success, not actual terminal. Do NOT reuse either as if complete. The narrow proposal avoids creating receipt MemDb row/index/negative facts at all: the four cold stores are declared/queried by private receipt-storage.ts, excluded from TABLES/loadAll/late hydration. Only the fixed usage singleton is read at early admission; retain only its bounded admission result, not an authoritative runtime quota cache. No nativeOnly/lazy framework flag or generic database rewrite is introduced. Complete image copier enumerates native stores as today; debug/image validators explicitly stream the four private stores.

Private ReceiptReadScope owns <=100 fresh native key/fact results plus bounded index rows, including explicit missing-key observations. No cross-call cache. Completed readonly requests cover meta uncertainty guard, usage epoch, selected owners/headers/parts and required account/op-control guards. All requests/cursor continues are enqueued synchronously from callbacks; no application await/yield in active callbacks. Await actual complete/abort, not request success. Layout/version/marker errors are fixed safe errors. No result/fact escapes before terminal. Remove request listeners and release scoped row references, missing-key sets, index result arrays and buffers in finally at actual terminal, including abort and uncertain completion. Returned public bounded projection/page is an intentional owned copy, not a cache view. No negative/index facts survive to poison the next call.

Receipt writes are private bounded ReceiptWritePlan data, applied INSIDE the SAME existing schema.writeTransaction/persist as ordinary op/draft/asset changes. store.command gains a receipt-only plan option and persists even when ordinary MemDb commit is empty (seed/cleanup units). It is not a second transaction or provider callback. Plan contains expected command_epoch, exact selected owner/header/generation/account/op-control guards and bounded native puts/deletes; receipt-storage.ts applies it with the existing tracked-request sink after marker admission and guard success. Compare native usage.command_epoch to expected and abort on drift before any child mutation, then increment once with the owning unit. Shared uncertainty.ts supplies the same error/marker types; receipt-storage imports neither schema nor op-storage, avoiding circular runtime modules. Existing Plan58 op write format remains unchanged.

This actual integration extends schema.persist/store.command plus private receipt-storage/send-receipts, not generic MemDb. Ordinary op Memory mutations use existing confirm/revert; there are no cold receipt undo/index facts to retain. Actual abort discards the plan/scope and reverts ordinary Memory. Uncertain/partial completion poisons/closes before command admission releases; scope/plan buffers are invalidated and dropped without pretending rollback. Startup scalar evidence and all active receipt scopes are invalidated with the adapter; later reopened admission reads actual native usage. After clean drift abort, re-read fresh native scope and rebuild the unit once; repeat drift is content-free unavailable, never partial success or a no-header fallback. No command/account/scope lock is held across a macrotask yield. A bounded store unit retains only existing serialization while awaiting its own native terminal.

Native parent/empty-child guards: insertion requires selected current owner+account incarnation and same header generation; part requires its header active and admitted slot; byte requires its selected metadata. Cleanup may delete header only after indexed part getKey reports empty and retiring fence prevents new children. Owner delete requires indexed header getKey empty. Deletes are explicit byte+metadata pairs, <=8 units; no native/MemDb account/op cascade touches cold receipt tables. Charge/slot subtraction happens only with final owning header/owner deletion, as before. No capacity released from mere logical retirement or an optimistic delete.

#### Actual get/recent limits, bounded facts and consistency

Current ops.list calls recent(100); import.ts104 calls recent(100_000). SQL repos.listRecentOps defaults100 but accepts supplied limit; IDB mail.ts1439–1446 sorts/slices existing ops with supplied limit. Neither is a hard100-key receipt limit. Preserve existing row selection/order/limit behavior; do not truncate public recent to100 or fetch all receipt owners.

New default decoration processes <=16 returned op rows per unit. For each send, at most one header, owner, account-incarnation guard, BASE existence key and effective control key; reserve a sixth fact slot if needed. With usage epoch and marker guard, worst-case6*16+2=98<=100 new native keys/facts. Deduplicate shared keys, but do not rely on deduplication to meet the bound. Existing effective op row/control facts supply immutable id/account/kind and state; no additional payload/target/body JSON parse. A missing control fact uses the already-admitted BASE state under current Plan58 semantics, never assumes succeeded; BASE existence is checked by key. If those effective facts are not ready, wait existing op admission or return safe unavailable, never invent counts. Published header must match a succeeded send/current account incarnation; inconsistent active metadata is integrity refusal, not no-recorded. No-header legacy is allowed only when absence was actually read and no admitted header/token was previously observed.

Each unit enters existing bounded store serialization, finishes native terminal, computes owned compact projections, clears all private facts and releases before platform.yield. No long exclusive tail across all recent rows. Capture receipt visibility_epoch with the ordinary op-row snapshot; compare before/after each batch and once before releasing the result. Publication, Forget, account retirement/replacement, source/generation change or physical header removal advances it in the owning transaction. State/control mismatch or epoch drift discards partial decorations and re-reads the ordinary op snapshot once; second drift fails content-free unavailable. No partial old warning/summary escapes after Forget. Do not reparse wide BASE per receipt or build an all-owner map. Added scratch remains <=100 facts, independent of supplied recent limit; existing large ordinary OpRow array/query allocation is unchanged and is an explicit performance gate, not newly certified bounded latency.

Exact used opt-out: MailStore.ops.recent(limit, options?:{receiptProjection?:false}) preserves default projection; app.export’s existing recent(100_000) call passes false because it explicitly omits completed receipts and serializes only unfinished-work fields. It gets current baseline rows, not private receipt tokens/counts, and incurs no pointless100_000 receipt lookups. This is a real existing caller, not a speculative export API. Tests still exercise default recent(100_000) chunking/consistency directly. No mailbox backup scope/version change.

History validation budget: <=26 covering index keys + <=52 BASE-existence/control facts + owner/account/usage/marker shared guards (<=5) =<=83 facts. Account incarnation is checked with a new private UNIQUE native accounts.incarnation index getKey(expectedIncarnation), comparing returned id; do not read/parse provider_config to validate a count page. Existing ready ops supply only copied {id,accountId,kind,effectiveState}; no body/target/error payload is retained as a new fact. History rows cannot be released from header counts alone. Each page's final owner visibility/account/connection check is another bounded terminal scope.

Combined attachment quota is not a missing-owner=zero shortcut. Actual IDB stageAttachments routes creation through store.attachments.create; replaceAttachments only validates/links refs. In store.ts1112–1120 the final createAsset command (AFTER current cleanup units/yields) prefetches account/current-owner charge and usage epoch, then passes a mandatory ReceiptBudgetView to idbAssets.used for that command. A used() call without matching budget/account view is a fixed error, not0. Other asset operations never call used/createAsset. Incoming ingestion/setBody still stage via the same create path; no multi-account receipt-owner prefetch of an entire ingest batch. SQL sqlAssets.used uses its current indexed owner query in the existing transaction. Account attachment+receipt remains256MiB; attachment limits/MIME/ref API do not change. Native guard-only plan couples final asset admission and usage epoch with its real asset write. This does not broaden the existing store writer/source-lock model into arbitrary concurrent stale MemDb writers; marker/CAS is not a substitute for that model.

#### Startup versus point versus full validation (selected contract)

Startup: verify native layout/indexes/version, existing nonreceipt/op format/unsafe marker admission and bounded usage singleton field/range arithmetic. No cold owner/header/part enumeration and no claim of complete cold certification. Normal budgets trust atomic ledger updates; corrupted accessed counters/negative/overflow fail closed. Arbitrary untouched cold corruption is not claimed detected. Point/page/command validates closed shapes/limits/identity/parent/generation for every accessed record and its required op/account facts; absence of an observed admitted header cannot become a legacy fallback. Details validate addressed part JSON/hash/coverage before release; summary page does not assert unread bytes were verified.

Full debug/whole-image SOURCE/COPIED admission streams ALL receipts/bytes, legitimate retirement prefixes and owner/global sums. Proposed bounded join: extend existing private readCompleteOpStep to return at most one thin effective BASE fact alongside key after its actual terminal, before releasing wide BASE/parts references. Reuse checkParts/effective state overlay; no second BASE read or body JSON parse per receipt. During the existing ascending BASE pass, merge ascending header.op_id with that one fact: active header requires send/same account/effective valid state; missing op is allowed only under legitimate retiring ownership. Keep one header lookahead/fact, not a32768-op map. Existing C/T/E orphan passes remain intact.

Then receipt-only passes stream by_owner to recompute one owner's totals at a time plus scalar global totals; no all-owner accumulator map. Header/part coverage/digest uses <=one part64KiB and <=120 fixed digests; verify byte/part orphan closure with ordered key merges/one-key lookups. Existing source/target locks/lease and marker remain; capture command_epoch before/after and refuse a changing image, never certify a mixed pass. COPY disposable-owned prefix exception stays distinct from complete SOURCE/COPIED. Schema threshold11 remains historical while future max-readable version changes; no number reserved.

Source identity: prepare already checks header.source_message_id against captured immutable SendPayload before SMTP. After complete seed preparation, source_digest hashes bounded {opId,owner/incarnation,sourceMessageId,envelopeDigest}; full receipt validation recomputes that with receipt-owned metadata/part root. Unready reservation may have null digest and must pass prepare before dispatch. Full receipt validation does not parse message/body payload to claim an identical-wire proof or cryptographic attestation of arbitrary mailbox edits; existing op-format validation stays authoritative. This first slice retains no original wire. Normal submit checks remain the authority for matching the queued source.

R3 therefore does not claim all-record startup validation, per-record wide BASE reparsing, a clean marker as cryptographic integrity, measured throughput at any ceiling, or a generic lazy DB framework. Actual native-plan/read integration, batch retry behavior, empty-commit persistence, scalar rehydration and release-on-poison need sole source critique then real SQL/IDB/perf/native tests under separate authority.

Runtime usage is always the freshly completed native scalar read, never a potentially stale MemDb singleton used() cache. After committed receipt plan no fallible scalar persistence/load callback is needed: the native plan updated usage in its owning transaction; any held admission view is dropped. Status/quota next call re-reads it. This avoids commit-before-ACK losing authority or a cached usage row falsely granting capacity. All five stores are privately created/validated as native stores; usage alone is admitted early, and the four cold stores never enter generic loadAll/late TABLES hydration. No generic MemDb schema flag/index eviction method is added.

Exact private persistence candidate: `persist(idb, ordinary:Committed|null, durability, host, receiptPlan?:ReceiptWritePlan)`; plan is a closed receipt-only union of guards, <=bounded native puts/deletes and nextUsage, not an arbitrary SQL/DB callback. Existing callers pass ordinary and no plan. `command`'s receipt-only option supplies a pure already-built plan after bounded prefetch; if ordinary===null && plan exists it still executes actual writeTransaction. Include meta/usage and required account/op/receipt guard stores in that single readwrite transaction, enqueue guards/mutations through tracked callbacks, and await only its actual terminal externally. No crypto/JSON encoding/yield inside callbacks; bounded codec work is prepared outside the native transaction.

Expand command error enclosure explicitly: prefetch failure leaves Memory untouched; fn failure uses existing MemDb.tx rollback; any plan/takeCommit failure after fn but BEFORE native start reverts its unconfirmed ordinary commit; confirmed abort reverts; partial/uncertain actual completion poisons/closes without fake rollback. Every case releases scope hits/misses/index results/plan-owned buffers at actual terminal or known pre-start failure. Actual success confirms ordinary Memory then returns; no extra scalar storage-await/callback may erase accepted authority. This is necessary private source integration to critique, not approval of a new public database framework.

State-transition integration is finite: actual send ops.fail prefetches only its one possible header and retires it iff resulting state is failed, in the same transaction; resolveUnknown markSent/discard retires that one private header, retry advances generation. Legacy absence is an actual point read; non-send flags do not acquire a receipt framework. markUnknown/recover retain private non-acceptance preparation and existing conservative state; startup recovery never scans cold headers. Every acting command rechecks effective control/account guards. Native-only units confirm/revert ordinary Memory only when an ordinary commit exists; an empty ordinary commit is not permission to skip receipt persistence. Terminal send complete's existing-state gate precedes any result getter or new receipt IO, and concurrent same-generation calls coalesce before awaiting.


<!-- NORMATIVE APPENDIX 3: CURSOR.md; source SHA256 cd78357eeddbd355d1f12f64f0c2eeb89a349ceab2ee043f0615e9afd33a4abd -->

## Appendix C — CURSOR.md

### r3 confidential authenticated stateless history cursor (proposal)

Replace r2 HMAC/base64 plaintext entirely. Built-in Web Crypto AES-GCM supports authenticated encryption, generated AES keys and an extractability flag; this proposal uses256-bit generation and128-bit tags. See [W3C Web Cryptography API, AES-GCM operations](https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/#aes-gcm). The protocol below is our narrow design, not an audited implementation or a new generic cursor library.

#### Actual primitive and private lifetime

Backend's used receipt-history handler owns one lazy Promise<{key:CryptoKey,prefix:Uint8Array,counter:bigint}>. First explicit history open calls:

```ts
crypto.subtle.generateKey({name:"AES-GCM",length:256}, false, ["encrypt","decrypt"])
crypto.getRandomValues(new Uint8Array(4)) // per-key public nonce prefix
crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:aad,tagLength:128}, key, payload)
crypto.subtle.decrypt({name:"AES-GCM",iv,additionalData:aad,tagLength:128}, key, encrypted)
```

If built-in crypto.subtle is unavailable at actual feature use, fail content-free unavailable; never downgrade to plaintext/HMAC. Key is nonextractable; no export/import/persistence/profile/real-user-secret access, logging or worker/key transfer. One key promise coalesces concurrent max-two receipt calls; no key cache list, rotation timer or promise tail. Failure produces a fixed unavailable response. Backend stop drops its reference; in-flight operations may retain their own reference only until settlement and must fail stopped/context/lifetime checks before return. A new Backend gets a fresh key, so old cursors fail authentication. Nonextractable does not claim immediate memory zeroization or protection from privileged code in the same runtime.

IV is12 bytes: the4-byte generated prefix plus a big-endian64-bit counter. Reserve/increment counter synchronously before awaiting encryption, including on failure; concurrent requests cannot reuse it. No wrap: at exhaustion refuse cursor issuance until a new Backend/key, never reset under the same key. No replay server cache. Old cursors may be replayed only in their same live account/connection within ordinary keyset semantics; they grant no mutation authority.

#### Exact bounded wire format and context

Only envelope is base64url(no padding) of `[version1:u8][IV:12][ciphertext||tag128]`. Plaintext is a closed binary record, not JSON/base64 private fields:

- version1:u8; accountId:u64;
- account incarnation: u8 byte length then1..128 UTF-8 bytes;
- owner UUID: u8 length36 then36 canonical ASCII bytes;
- connection nonce: u8 length36 then36 canonical ASCII bytes;
- highWater:u64; before:u64 (both positive safe integers from immutable history_seq).

Maximum plaintext228 bytes; ciphertext+tag244; envelope257; base64url<=343 characters, below the unchanged512-byte RPC ceiling. Numeric/length arithmetic is a source calculation, not runtime qualification. Validate canonical base64url, decoded<=257, known version, exact field lengths/ranges and complete consumption. All private values exist only inside ciphertext on RPC. Public IV/version/length are not private account identity. No warning/body/recipient/subject is encoded.

AAD is fixed ASCII `Terno/T07/receipt-history/v1` plus trusted current connectionNonce bytes and requested accountId:u64, with fixed field boundaries. Authenticate before decoding private fields. After decryption compare accountId/nonce to trusted request context, and incarnation/owner to current store facts. Same error for tamper, unknown format/key, wrong account/connection, restart or stale owner: fixed content-free stale/refresh, never cipher/key/plaintext/exception details. No real provider call.

#### Call order and current connection/invoke compatibility

1. Renderer-only authorize/schema guard, require live connected receipt context, capture current account lifetime. On first page use cursor null; continuation decrypts under trusted context AAD. Each crypto await is followed by stopped/live-context/account-lifetime checks.
2. Query the bounded native/SQL history view with decrypted owner/incarnation/highWater/before. Capture owner visibility_epoch; use actual effective op-control facts, never body parse. A keyset page is not a long-lived snapshot; concurrent older admission completion may appear later, while new sequences above highWater wait for refresh.
3. Issue next cursor only when a further page exists. Allocate IV synchronously, encode the bounded record and await encrypt. Then recheck current owner/incarnation/visibility_epoch and actual connected context/account lifetime via one bounded terminal metadata read. On drift discard entire response and return fixed stale, never send old data/ciphertext. UI connectionVersion/page epoch additionally discards old responses. No account/scope lock or application yield is held through crypto/native awaits.

Current RpcServer.connect captures ctx supplied by its caller; clientId can be reused. Proposed connectionNonce/live WeakSet remains narrow: connect clones ctx, generates/overrides nonce, captures the cloned ctx in dispatch and records it in the existing transport map and a private WeakMap<context,Transport>. Disconnect callback, returned detach function and existing emit-send-error path invalidate that captured context. Map removal is conditional on connections.get(transport)===capturedCtx, so an old detach cannot remove a new context attached to the same transport. Listeners detach as today. CallContext.connectionNonce is optional for source compatibility with existing direct invoke. `connectionActive(ctx)` returns true only if WeakMap resolves its transport AND connections.get(transport)===ctx; even a replaced context is immediately inactive. It is used only by connected receipt history/details/Forget/cleanup handlers; required checks occur before and after awaits. Existing trusted invoke of unrelated methods still accepts its original {clientId,origin}; no global nonce requirement, authorization rewrite or origin change. Direct invoke of these connected receipt calls without a live ctx is explicitly forbidden; tests use real connect. Existing clientId permissions/coalescing semantics remain. Fixed content-free contract errors apply only to the receipt method set.

Recipes: decode returned cursor as bytes and verify no plaintext UUID/incarnation/connection bytes or JSON fields appear; this is a format control, not proof by visual absence alone. Cross-check built-in decrypt only with test-owned key in private codec control, key.extractable=false/export rejection; actual RPC never returns key. Flip version/IV/ciphertext/tag, truncate/extend, wrong account, reused clientId with new connectionNonce, disconnect during decrypt/query/encrypt, stopped/reopened Backend, retired/replaced owner/incarnation and concurrent max-two issuance with distinct counters. Assert fixed errors/no plaintext diagnostics; nonce counter never rewinds after failed encrypt. Boundary payload sizes1/128-byte incarnation produce predicted byte limits; unknown UTF-8/length/trailing data is refused. No recipe executed and no claimed cryptographic audit.

Narrow dispatch closure: for the declared receipt-method set only, dispatch checks connectionActive(capturedCtx) immediately before successful/error response send and sends nothing to a disconnected/replaced transport. Unexpected failures still follow existing safe onError policy; expected stale/closed errors remain fixed. No await between live check and send. Unrelated dispatch/invoke behavior is unchanged. This prevents the new closed-context path from trying to send a second error frame on a known dead receipt transport; it is not a generic transport rewrite.


<!-- NORMATIVE APPENDIX 4: WARNINGS.md; source SHA256 a334c0231e6d44b782e74d8a89232564befc2913f6fa8a391ee268ebc5e0fb91 -->

## Appendix D — WARNINGS.md

### r3 actual warning scope and deliberate Forget

Actual shipped source: imap.ts513–528 returns only errors.smtp.notDeliveredTo from rejected recipients; caught APPEND has no warning result. A finite production-source search of packages/mail/src finds no other `warning:` producer. Existing ProviderResult/store APIs nevertheless permit unrelated warnings; preserve them unchanged. No actual mixed-warning caller was found. Therefore DELETE r2 warningParts/other_warning4096 reservation, composite catalog keys/codecs, recursive/nested references and lib/i18n.ts special handling. A test-only future combined warning is not production justification.

Exact minimal additions:

```ts
// Existing ProviderResult; the entire warning is recipient-derived when true.
recipientWarning?: true;
// Actual IMAP sets true only alongside its own existing rejected-recipient warning.
// Backend complete forwards this origin bit with existing unchanged encodeText(warning).
// Private published header adds warning_kind: "none" | "recipient" | "other".
```

Store derives none when no warning, recipient only from this explicit bit, other for existing unmarked generic warnings. Reject flag without warning or non-true unknown fields content-free. Never infer origin from warning text, an address substring or catalog-key guessing. The bit is metadata under the existing header allowance; no second recipient list or new warning-byte budget. Actual IMAP normal warning/ref/body remains byte-exact. Build/protect this result under the already-required accepted-success/finally/assembly latch; no new post-SMTP storage await.

Separate Forget command, same actual transaction as header retirement/view_revision increment:
- Published terminal recipient-origin header: replace op.last_error with encodeText(L(errors.smtp.partialDetailsCleared)), with no address-bearing params; state/IDs/Sent/body unchanged. Keep partial-send flag after physical header deletion through this fixed known reference. No complete/retry/provider call.
- Existing unrelated warning (other): leave its stored bytes/reference unchanged. None: keep null. No generic blanking or partial->normal-success transition. Legacy/no-header calls do not guess warning provenance or mutate a legacy warning.
- Repeat completion remains inert before reading result fields; repeat Forget is idempotent. No permanent tombstone/header slot is retained just to remember Clear.

The new fixed copy is “Some recipients were not accepted by the mail server. Saved recipient details were cleared.” / “El servidor de correo no aceptó algunos destinatarios. Se borraron los detalles guardados de los destinatarios.” Existing encodeText/decodeText and renderer localized suffice; no new localization framework. A future producer combining recipient and unrelated evidence MUST first propose an explicit source-contract change; do not concatenate and assert recipientWarning=true or silently treat that combined warning as erasable. R3 neither implements composition nor invents a copy-warning/repair policy.

Used persistent settings clear, per-op/page epoch invalidation, retirement event, generic partial replacement and connectionVersion/account fences remain UI-CLEAR. Before local Clear, invalidate pending enrichment and remove any visible recipient description; committed event does so in all renderers. Old detail responses cannot restore it. Fresh explicit detail on a cleared-recipient op may return its fixed address-free warning; after cold cleanup the known fixed reference is sufficient, not a fabricated zero-count receipt. Unknown legacy/no-record remains distinct. All diagnostics/progress stay address-free.

Controls retained: normal mixed warning unchanged until deliberate Forget; deliberate recipient Clear updates only allowed warning/receipt fields and persists through reopen; existing unmarked unrelated warning bytes/ref survive Clear and replay; pending/already-visible local/other-renderer/reconnect detail ordering never restores cleared addresses. Remove r2 hypothetical mixed-producer composition image as unshipped scope, not as an executed passing control. Keep all original10 PUBLIC definitions/assertions and r2 fixture files byte-exact.


<!-- NORMATIVE APPENDIX 5: UI-CLEAR.md; source SHA256 f96f7c0be07eaac7b59fd02c6dd831ec6e295f1eec3af8e61242f080438cef1c -->

## Appendix E — UI-CLEAR.md

### r3 persistent settings recovery, warning privacy and connected UI

ROOT admits this bounded UI as a plan candidate, not production/copy approval. Persistent recovery is required; a12s toast alone cannot recover later row/byte capacity. Actual used caller is existing settings/accounts-tab.tsx lazy account disclosure “Saved send details” / “Detalles guardados de envío”. It opens25 count/date rows, no subject/body/names/addresses. No work until opened, no polls. One page/request/selection<=25; closing discards rows, cursor, requests' presentation ownership and subscription. No all8192 hydration or unbounded bulk clear.

```ts
// renderer-only strict, max-two receipt requests/backend
"ops.sendReceiptHistory": ({accountId:number,cursor?:string,limit?:number}) => Promise<{
 items:readonly {opId:string;savedAt:number;summary:SendRecipientSummary}[];
 nextCursor:string|null;
}>; // cursor<=512B, limit1..25/default25
```

LAZY-STORAGE defines actual<=26 native covering keys, effective op-control/account guards and bounded facts; CURSOR defines authenticated ENCRYPTION, not plaintext HMAC. SQL indexed view matches native. Cursor is keyset, not a frozen multi-call snapshot: newer sequences wait for refresh; older queued admission completing meanwhile may appear on a later page. Existing rows do not offset-shift/repeat. Owner/incarnation/context/reconnect drift is stale/refresh, never a guessed empty receipt. No stored private fields leave outside ciphertext.

“Clear selected recipient details” / “Borrar los detalles de destinatarios seleccionados” confirms “Clear saved recipient acceptance details? Sent mail and its original recipients stay in place.” / “¿Borrar los detalles guardados de aceptación de destinatarios? El correo enviado y sus destinatarios originales se conservan.” Issue per-op Forget sequentially, <=25 separately committed actions, explicit per-row success/failure/pending. Disable only current clear controls; no account lock across awaits. Partial progress remains truthful; capacity released only at physical owning cleanup commit. A newly full draft stays intact until sufficient actual cleanup then retry same draft. Toast shortcut, if retained, is secondary to this persistent path.

Normal mixed warning text/ref/duration/body stays exact until deliberate Forget. WARNINGS.md supplies only actual recipient provenance and address-free replacement; current IMAP APPEND emits no warning. Do not add composite i18n/copy-history framework. Existing unrelated warnings stay byte-exact; partial does not become success. Existing localized/encodeText/decodeText suffice. Status remains the lazy settings pending/blocked/idle line and explicit Retry using address-free receiptCleanup event/RPC. No full recipient/copy-history screen or animation/framework. EN+ES/light+dark/keyboard/focus-visible/render-count gates apply later.

#### Actual toast/enrichment lifetime

Core announceOp emits count summary/hasSendWarning with stored address-bearing warning/ref redacted; ordinary ops.list/details preserve normal warning until Clear. boot branches on flag before normal success: show generic partial immediately, then max-two actual renderer details calls may enrich the same stable toast ID with exact existing warning. Unavailable/not-recorded remains generic partial, never success. A cleared-recipient op can return its fixed safe warning after physical header deletion; no fabricated zero-count receipt.

Shared renderer ownership retains per-op generation only for pending<=2 or currently visible toast/page rows, never all history. Capture op generation + RpcClient.connectionVersion + accounts-event epoch before details await. Local Clear invalidates generation BEFORE RPC, immediately clears any visible recipient description to generic partial; committed sendReceiptRetired:{opId} does so in every connected renderer. A page epoch prevents old history response reinstalling a cleared row/selection. Discard/refetch page1 on stale; no polling. Already-rendered pre-Clear descriptions are removed when retirement event arrives; a late old promise cannot enrich afterward. A failed/lost-ACK Clear keeps generic display until an explicit fresh read, not automatic resurrection. Unmount/toast expiry/reconnect release bounded maps/refs. No detail object reaches captureUi/diagnostics.

AccountRead/write and target owner/incarnation/generation validate before/after actual native reads. Connected receipt ctx checks are CURSOR: fresh nonce and actual transport-map identity, including disconnect/detach/send-error/replacement. Current trusted internal RpcServer.invoke remains unchanged for unrelated methods. Receipt method schema failures become fixed safe BAD_REQUEST, no unknown key/value/issues/cursor echo. If a committed Forget loses connection before ACK, it remains committed/idempotent; unavailable ACK is not a rollback claim. No provider/profile call from any settings/details/cleanup procedure.


<!-- NORMATIVE APPENDIX 6: REMOVAL-GUARD.md; source SHA256 f4c86cc0906e471dab809ecd3ec0ba26fa4610da49b6f10411cc0af8680c373a -->

## Appendix F — REMOVAL-GUARD.md

R3: ROOT admits A1 as PLAN CANDIDATE only. C1-L native metadata/plan integration is LAZY-STORAGE; no production/API/schema approval.

### r2 account removal: immutable account identity, mutable receipt owner

#### Actual schedule and required distinction

Current handlers.ts:722–737 awaits dropAccount, setGooglePhotoState and icons.dropPhotos before accounts.remove. dropAccount synchronously aborts its captured life/removes provider, then awaits life.pending; it does not freeze receipt owner identity. Current compose.send calls queueSend directly, outside accountWrite. Cleanup may remove an empty active owner; an already-admitted queue command may create one. Therefore an owner UUID/null captured before awaited work is not an immutable account identity. Refusing final removal on owner-only drift can leave a deliberately fenced live account after photo changes. This is a source schedule, not a claim that a product defect was reproduced.

Select account-incarnation comparison, not receipt-owner comparison. Current stamp{id,email,createdAt} cannot distinguish the required same-id/email/clock replacement fixture. No existing immutable incarnation field was found in current accounts/stamp. Exact source proposal therefore needs a NEW PRIVATE accounts.incarnation token, allocated once on row creation/upgrade, unchanged by credential refresh, provider replacement, owner cleanup or queueSend. This is a named schema/interface compatibility requirement for root/sole critique, not allocated or implemented. No sixth receipt table or general retirement journal; it is a fixed<=128-byte private account column. Public Account/RPC bootstrap does not gain it. Receipt owners bind this token as well as current stamp; old owner UUID and incarnation together fence late work.

```ts
// MailStore.accounts, private trusted backend use
removalGuard(id:number): Promise<{id:number;incarnation:string}|null>;
clearRemovalPhotoState(guard:{id:number;incarnation:string},
  patch:(raw:unknown)=>unknown):Promise<"cleared"|"stale">;
remove(id:number, expected?:{id:number;incarnation:string}):Promise<{
  removed:boolean; receiptCleanup:"pending"|"complete";
}>;
```

No receiptOwnerId in the removal guard. Final remove captures whatever owner currently belongs to the MATCHING incarnation, fences it and deletes base account/secrets in the SAME existing atomic transaction. A changed/missing owner in the same account is allowed; new incarnation is stale and cannot delete credentials. Direct trusted callers without guard capture current incarnation at command entry as today; backend removal always supplies guard. Missing account is idempotent removed=false, never permission to bind a replacement.

#### Exact proposed call order

1. Backend beginAccountRemoval captures the actual AccountLifetime object before any await. accountRead(life,removalGuard) checks same live object before/after. Await icons.capturePhotoRemoval(id), a read/load plus capture of exact people/abort/sync record references, with no deletion. Recheck guard and captured lifetime before destructive work. A replacement discovered here returns stale without photo/credential mutation.
2. Without an intervening await, start existing dropAccount(id,{remove:true}) against that same life. It installs existing removing/abort/provider admission fence synchronously, then awaits admitted life.pending. Add used BackendCore.queueSend wrapper for handlers.compose.send: capture life and invoke accountWrite around the WHOLE queueSend promise, including async preflight, so drop waits earlier admitted queue work and later compose calls fail before mutation. No lock spans the await; life.pending is a finite set of admitted promises, not a queue/timer. Worker’s final admission and credential replacement fences remain unchanged.
3. Check captured removal-life identity (map still contains same object with removing=true, not assertCurrent on its intentionally aborted signal). Call store.accounts.clearRemovalPhotoState(guard). This one store command checks incarnation and updates only app.googlePhotos[id] under its existing settings codec/transaction. It is NOT an earlier unguarded read followed by setGooglePhotoState. Stale returns before any settings mutation. Introduce the narrow actual store operation in both adapters; use the same migration/shape semantics as settings.ts, using a used synchronous patch closure from settings.ts which calls the existing migrate and removes only googlePhotos[id]. The store reuses its settings-update mutation inside the guarded command, never awaits the closure and rejects a Promise result. The store does not import backend or duplicate migrate. This is the actual dependency seam already used by settings.update, specialized to removal identity.
4. On cleared, invoke the previously captured icon removal closure synchronously. It removes/aborts only if every captured map/controller reference still matches. A new association installed under a reused ID is untouched. No await between identity check and map mutation; no blanket delete-by-id after an awaited load. Persisted photo state was already guarded in step3. This is a used icons/service.ts capture API, not a new cache framework.
5. Recheck removal-life identity, then store.accounts.remove(id,guard). In its single transaction: compare immutable incarnation; capture CURRENT receipt owner for that incarnation; mark owner retiring; run existing removeAccount/secrets/rescan deletion. No owner scan or receipt child cascade. Only successful actual commit may call accountRemoved for the captured life; adapt accountRemoved(id,expectedLife) so a new map entry/credentials owner cannot be cleared. Then existing autocomplete/accounts/owner notifications. A matching account whose receipt owner appeared/disappeared during awaits must complete removal. No false stale due to owner-only drift.

Storage failure after photo clear but before base deletion retains the current existing partial-removal/fenced-account semantics; do not claim photos and database deletion are one transaction. The new source design eliminates owner-only false refusal, not every preexisting account-removal failure. A genuinely replaced account may be stale; old map references/photo state/credentials cannot be targeted by later steps. If guarded settings mutation or exact icon capture cannot be fitted to actual shared settings/cache seams without a broader change, this is an explicit interface conflict to resolve before implementation, not permission to retain the old unsafe call order.

#### Exact compatibility surfaces and options

Proposed optionA1: private immutable account column + guarded photo mutation + reference-scoped icon capture + compose accountWrite admission. Changes needed: db migrations/repos createAccount/sql-store accounts methods; IDB schema/mail createAccount/store methods and native image validation/copy; MailStore signatures; backend core/handlers/settings pure removal patch/icons service; receipt owner codec/stamp matching. Existing account row getters/exports remain explicitly projected; never leak incarnation into bootstrap, diagnostics or mailbox export. Upgrade assigns one token per existing account without reading mail bodies; subsequent reopen/copy retains it. Token creation/migration is a separately measured bounded native-callback gate, not a reserved schema number. Current five receipt tables and root ceilings remain; account metadata column is not an extra receipt history allocation.

AlternativeA2: retain only old stamp and explicitly drop the same-id/email/clock replacement guarantee. ROOT requires that guarantee, so A2 is not an acceptable silent implementation shortcut. Using mutable owner/null as identity is also rejected. A broader whole-account asynchronous deletion remains unselectedB. Root must read A1’s additional account/settings/icon compatibility surface before approving code or a schema.

Controls: admitted queue creates owner while drop awaits→matching incarnation removed; cleanup deletes empty owner during photo work→matching removal succeeds; replacement with identical old stamp but different incarnation before each awaited phase→new credentials/photo association survive; same-incarnation credential refresh never changes token; old accountRemoved continuation cannot erase new life. Abort/failure before and after actual guarded settings/base transactions must be distinguished from caller-ACK failure. No source assertion is a runtime reproduction.

Exact icon signature: `capturePhotoRemoval(accountId:number):Promise<()=>void>`. After existing load, capture the actual People object, peopleSyncing Promise<void> and peopleAborts AbortController (all three are Maps in current service.ts:77–81). Returned synchronous closure compares those exact references, then uses existing abort/map/cache/savePeople/invalidate behavior only for matches. It cannot adopt a newer association. Existing savePeople serializes its current map and queues existing peopleWrite; this adds one existing removal save, not a new promise tail. Existing write/cache-close behavior remains a separate gate, not newly proven physical termination.

Stale final remove throws content-free STALE before any row/secrets mutation; `removed:false` means already missing only. Backend does not call captured accountRemoved on stale or failed commit. New localization must not expose stamp/incarnation/token/secret. Current stamp is retained for existing OAuth/secret replacement checks; private incarnation supplements removal identity, never replaces those fences.

R3 identity closure: createAccount SQL/IDB writes one newly allocated private incarnation and UNIQUE native/SQL index. Upgrade supplies one token per existing account under bounded callbacks/actual completed migration; no receipt body scan. Full-store image copy preserves token; mailbox export/bootstrap/diagnostics never include it, and ordinary mailbox import calls actual creation to generate NEW identity rather than honoring private fields. Credential refresh/secret CAS does not rotate token. Summary guards use native accounts.incarnation getKey, not provider-config parsing. Existing source stamp/OAuth/secret rules stay authoritative. All shapes/version values remain unallocated plan candidates.


<!-- NORMATIVE APPENDIX 7: RETIREMENT.md; source SHA256 9fc8137374257f52361a9eaf9cf860e5e187efd9f1f6fa30da3cd3b422c36e96 -->

## Appendix G — RETIREMENT.md

### r3 durable receipt ownership/retirement, scalar counters and crash states

ROOT selects receipt-only A/C1-L, not whole-account asynchronous B. Resource ceilings remain8192 headers/active account owner;32768 total headers;65536 reserved/materialized part slots;32768 owners;256MiB total receipt charge including reserved/retiring; unchanged256MiB combined account attachment+receipt. Per receipt<=3000 occurrences,120 parts,25 entries/64KiB per part,8MiB admitted charge; fixed identity bounds remain. These are policy ceilings for critique, never preallocation/eager startup scans/perf proof or eviction permission.

#### Native ownership and charge

Five store definitions/indexes and actual private native write plans are LAZY-STORAGE. Owner UUID binds immutable A1 account incarnation plus existing local stamp; no owner/header FK to account/op. SQL RESTRICT versus native checked parent/child guards; no hypothetical MemDb RESTRICT. Account final remove first compares immutable incarnation, then captures and retires CURRENT matching owner in its one existing base deletion transaction. Owner drift within same incarnation never causes false stale. Current send-op deletion is account cascade; explicit non-send coalescing/prune needs no new receipt helper. No unused direct-op-delete API.

Header logical retire (Forget/terminal abandonment) or owner retire (account deletion) immediately fences all receipt reads/new writes/publication. No child enumeration/capacity release. A returned pending means physical cold rows remain. Later units select one eligible owner/header via native index, delete<=8 explicit byte+metadata units in actual committed transactions, advance durable contiguous cleanup cursor, then delete empty header/owner only under indexed child-exists guard. Account/owner locks and native callbacks never span an application yield. Reused account/old continuation cannot recreate owner, header, mail or credentials.

Charge is logical bounded storage accounting, not claimed SQLite/WAL/browser page size: header1024+UTF8(opId+sourceMessageId), part512+worst seed/outcome encoded bytes; owner512+UTF8(email+incarnation); singleton1024. Source/outcome/envelope digests and origin enum fit fixed metadata allowances. No other_warning4096 reservation/composite list remains. Reserve at queue before draft deletion; publication may reduce to actual bytes. Retiring header keeps its ENTIRE remaining charge/slots until final header deletion, then subtract once using existing row amount. Owner charge released only at empty-owner delete. Replayed delete finds missing row, subtracts nothing. Global counters include deleted-account owners so blocked cleanup+repeated account churn cannot retain unbounded address bytes. No automatic age eviction or loss of unknown-send evidence.

Actual asset creation centralized through attachments.create adds current receipt-owner charge with a bounded command-local budget view; never uses missing prefetch as0. SQL current transaction does indexed query. IDB guard-only native plan couples final asset creation/quota snapshot; cleanup grace/ref/attachment/MIME limits unchanged. Old deleted owner's charge remains global, never resurrects attachment_usage or charges a replacement account. Counter underflow/overflow/corrupt access fails safe; no provider fallback on failed admission.

#### Event-driven bounded maintenance

Existing ops.cleanupSendReceiptSlice(limit1..8) returns {removedUnits,pending}; status returns scalar pending/idle charge, backend adds current blocked only if a storage failure actually occurred. One backend pump+one wake flag, not one promise/job per receipt. Wake on committed retirement, admitted startup and explicit settings Retry. Use actual BULK_SLICE15ms target with initial1/floor1/ceiling8; measure actual synchronous callback, native terminal latency and whole deletion independently. Even one unit may fail. Yield after each completed unit outside store serialization; no new polling timer/network. Stop waits only current unit, leaves rest durable. Storage failure stops pump/keeps pending owner; blocked need not persist when storage itself failed. Reopen can report pending and resume, never fictitious durable blocked certainty.

C1-L startup admits layout/version/marker/scalar structure only. Point/page validates accessed facts; full debug/SOURCE/COPIED streams all cold referential/digest/owner/global totals. No clean-marker cryptographic certificate or all-record startup scan. Scope-owned row/miss/index facts are released at actual terminal on success/abort/uncertain; no cold MemDb cache or negative facts survive. Uncertain write poisons/closes before admission releases, never fake rollback. Source/copy/image primitive/format claims are unexecuted design.

#### Durable state / authority / crash table

| State | Owner/source/quota | Permitted authority | Failure/reopen |
| --- | --- | --- | --- |
| Before queue | Draft generation/revision/attachment refs; no receipt | No new send | Preflight/quota refusal preserves original draft, DATA/APPEND0. |
| Queue actual commit | Original op/source+refs; active owner/reserved header/full charge | Existing queued-send authorization only | Lost ACK is not clean refusal; actual transaction/marker decide. |
| Legacy no header | Existing old op/source/refs | Original provider path, no new quota/evidence | No new limit check/fabricated acceptance; missing previously observed header is NOT legacy. |
| Seed preparation | Immutable token, owner/incarnation/gen; committed contiguous private parts | No SMTP until ready/final current/hold/credential checks | Each native unit actual terminal, same seed idempotent. |
| SMTP unresolved | Ready private envelope/op refs/reservation | Existing transport acceptance/ambiguity only | Unknown DATA stays unknown; no inferred partial arrays or copy task. |
| Successful DATA/old caught APPEND before return | Evidence still volatile, same source | Same-call old best-effort APPEND only | Existing submission acceptance crash gap remains open. |
| Provider returned/completion staging | Backend accepted latch, private outcome digest/gen parts | No provider resubmit; no public receipt yet | Failure→T01 unknown/noneligible; no automatic publish resume. |
| Publication committed | Op succeeded/IDs/original warning+immutable receipt, actual charge, old asset unlink | Counts/details prove SMTP subset only, not final delivery/copy | ACK loss/read/replay preserves exact publication until explicit Forget. |
| Deliberate Forget | Header retire/view revision + recipient-only warning replaced atomically | Fixed address-free partial truth; unrelated warning unchanged; no SMTP | Per-op/page invalidation fences late responses; completion replay inert. |
| Header/owner logically retired | Read/write fence, full charge retained | Local indexed bounded physical cleanup only | Cold legal prefix survives interruption; no new owner adoption. |
| Physical cleanup prefix | Durable cursor/remaining parts; charge conservative | <=8 units/current actual command | Abort restores ordinary Memory/native unit; uncertain poisons; ACK loss replay skips prefix. |
| Final header/owner removed | Owning subtraction committed once; no tombstone slot | Terminal op remains terminal if present | Reopen totals exact; replay cannot restore recipient warning or bytes. |
| Replacement account | New incarnation/current owner; old retiring global charge separate | New queue under new identity only | Old remove/photo/icon/accountRemoved/complete cannot target replacement. |

A1 detailed quiescence/photo/secret/lifetime failure schedules remain REMOVAL-GUARD; its new private column/index/create/upgrade/copy/export surfaces are plan candidates only. Credentials refresh does not change incarnation or replace existing OAuth/secret CAS. Existing partial photo-removal failure is not falsely rolled back. Whole T07 original wire/durable submission/copy repair/full UI remains OPEN.

Exact wake callers: Forget/accounts.remove inspect their pending cleanup result; successful completion of an unsupported/no-evidence provider retires its unused reservation and returns private optional receiptCleanup:"pending" alongside touched/deltas, which Backend executeOp consumes to wake once. Normal publication does not wake cleanup. Existing send failure recording wakes once on state===failed; existing unknown markSent/discard resolution handler wakes once after its committed transition (retry does not). Legacy transitions may cause one bounded no-work check, never polling. Startup and explicit settings Retry remain the other owners. No task is created only after provider completion and interpreted as SMTP acceptance.


<!-- NORMATIVE APPENDIX 8: FAILURE-TEST-IMAGES.md; source SHA256 720156d2db9d0b83636343fa44ffa2abe664458ef28cd7eb56e39f4be1ab05f2 -->

## Appendix H — FAILURE-TEST-IMAGES.md

### First-receipt failure and public test images

R4 terminology: “mixed warning” means the mixed-recipient send’s single recipient-origin warning. It does not mean a synthetic recipient/copy-warning composition; no such current producer is proposed.


All predictions UNEXECUTED. PUBLIC-RED.test.ts.txt is complete proposed source, not imported/collected/compiled/run. New-method images below require actual contract/handler wiring. Missing exports, unsupported RPC, fixture/setup failure and compile errors are not RED evidence. Preserve existing imap.int mixed-recipient warning/body test and T01 tests unchanged as independent controls.

#### Failure at each owning await

| Await/boundary | Required authority/durable result | Independent transport oracle |
| --- | --- | --- |
| Cloned queue input / bounded envelope hash / attachment preflight | No draft mutation, no op/header; preserve draft on encoding/yield failure. | DATA0 APPEND0. |
| Queue final transaction capacity refusal | Abort draft deletion/local Sent/op/ref/header/counters atomically. No dispatch fallback. | DATA0 APPEND0; same draft generation/revision/body/refs. |
| Queue actual commit acknowledged / ACK lost | Committed op/header/draft deletion are ordinary queued send authority; cannot claim refusal/restore a second draft. Existing IDB uncertain/marker semantics apply. | No transport merely from queue command; later normal worker only. |
| Claim/auth/hydrate / admitted-envelope stage | Same current ownership/drain checks; private header is neither acceptance nor copy task. Legacy missing-header takes old path without new quota. | No SMTP until ready/final checks. |
| Seed-part commit/ACK/yield failure | Same seed digest/part progress idempotent; never ready before every part commit. Existing pretransport release/recovery remains exact. | DATA0 APPEND0 for that dispatch. |
| Account drop/hold/credential replacement during staging | Final checks stop undispatched call; private owner generation cannot be adopted by replacement. | DATA0 APPEND0; sibling account remains live. |
| Auth/pre-DATA error/definitive refusal | Existing safe retry/park/error behavior; no successful receipt; reservation reusable while eligible. | All RCPT refused DATA0; no APPEND. |
| Unknown final DATA response | Current unknown/noneligible; no fabricated accepted/rejected arrays or receipt. | DATA start counted independently; APPEND0. |
| Successful DATA then info getter/normalization/yield/close fails | Immediate accepted latch; bounded accepted/incomplete fallback. No retryable transport error from new code. | DATA1; same ordinary best-effort APPEND. |
| Existing APPEND reject/unknown | Existing catch/order/warning behavior; receipt records SMTP evidence only. No repair state/automatic append. | DATA1; count actual APPEND starts. |
| Backend result/warning conversion fails | accepted=true already latched; T01 unknown, no provider retry. | Counts unchanged through retryNow/reopen. |
| Outcome normalization/hash/private part stage abort | No public evidence; same private writer digest or refusal, existing T01 unknown. | No new DATA/APPEND. |
| Final publication transaction abort | No published receipt/op success; actual rollback/marker/poison oracle, not just thrown JS. | No resubmit. |
| Final commit before caller ACK / event projection failure | Original success/IDs/warning/summary/bytes/charge survive reopen. Complete replay inert before any result getter/mutation. | Exactly original counts. |
| Concurrent complete / explicit unknown retry generation | Same-generation coalescing; different digest cannot overwrite. Old-generation completion cannot publish into a newer running attempt. | No transport from store replay; explicit user retry only retains existing authority. |
| Logical Forget/account retirement commit/ACK loss | Header/owner fence survives; pending physical work is honest. No immediate child fanout or quota release. | Never SMTP/APPEND. |
| Cleanup part command abort/commit-before-ACK/yield/shutdown | Durable prefix cursor/cold deletes and conservative charge resume idempotently; no scope/account lock across awaits. | Never provider/secrets/network. |
| Final header/owner cleanup ACK loss | Missing row means no second subtraction; global and owner sums exact after reopen. | Idle after no pending work. |
| Detail native request succeeds but transaction aborts / owner retires between pages | No page before completed marker-guarded transaction and final owner/gen/lifetime recheck; unavailable/retired instead. | No network. |

#### D1 — reached public RED and independent controls

PUBLIC-RED.test.ts.txt uses actual createRegistry IMAP/SMTP, real smtp-server and imapkit, renderer memory RPC, ordinary compose.send/runWorker/store get/list, SQL file or same native-IDB factory across reopen. First witness RCPT250/550, DATA1, APPEND1, Bcc-free original DATA and exact Sent bytes, original body/warning/catalog. Then missing sendRecipients on frozen524/cc800 is the intended behavior RED. All-accepted is also a behavioral RED: its missing-receipt assertion fails; only the two before-commit T01 cases are predicted controls. Reopen and replay complete with wrong warning/ID must preserve original publication and not send. Wrapper throws before versus after real complete distinguish precommit T01 unknown from committed success/receipt despite lost ACK. Fixture/byte mismatch is a control failure to fix before interpreting receipt assertions.

The appended quota image reserves actual existing account attachment budget through attachments.create (size+1024 charged by current SQL trigger/IDB accounting), leaving256 bytes. It uses no receipt test-limit knob or large buffers. A real saved draft must survive rejected compose.send exactly; DATA/APPEND0, no send op. Close/reopen preserves it. Explicitly discard one unpinned unfinished reservation, retry the SAME generation/revision, then witness DATA1/APPEND1/success/draft deletion. Frozen code instead queues/consumes the draft: that is an independent meaningful admission RED. Run both real stores. Attachment reservations are test-owned local data, never provider uploads.

#### D2 — details, replay and privacy image

After wired success for To one/reject and Bcc hidden, ordinary renderer ops.sendDetails({opId,limit:2}) must return available, accepted2/rejected1/unknown0, complete true, exact original warning/catalog, rows ordinal0 to one accepted; ordinal1 to reject rejected responseCode550; nextOrdinal2. Page2 returns ordinal2 bcc hidden accepted and nextOrdinal null. The same request from MCP is denied before any byte read. Limits0,101/fractional offset/extra key are rejected. Unknown fields in stored JSON are unavailable without excerpts. Broad op event has summary/hasSendWarning and null lastError/no lastErrorI18n; ordinary ops.list retains exact warning. Assert diagnostics/observer only content-free code/counts, never addresses/error response/receipt JSON. Detail native reads count<=5 bounded parts and wait for actual transaction terminal.

Replay actual complete with conflicting IDs/warning/evidence and a throwing result getter after success: ordinary get/list/details/charge/bytes remain exactly original; terminal guard must precede getter access. Concurrent same-generation completions run one real writer; fault after staged part then retry same digest no duplicate charge/part, different digest refused. Explicit unknown retry increments private generation, resets old outcomes in bounded dispatch stage; an old-generation completion interleaved with the new running op cannot publish. This does not authorize automatic resend of unknown work.

#### D3 — post-DATA accepted latch and append controls

Use64 unique recipients so bounded normalizer reaches a real yield. In actual platform scheduler, arm a throw only after independent server DATA completion and before normalization’s next yield; verify the arm was reached. Expect succeeded smtp-accepted incomplete, remaining outcomes unknown, one DATA and unchanged one best-effort APPEND. A pre-DATA yield throw is a separate no-DATA control. Test malformed successful info via actual transport-success boundary only as a narrow getter fault in addition to this public case; never replace the real SMTP send as the main RED. Similarly throw synchronous close after successful DATA; accepted result must survive. Keep all-RCPT550, final DATA550 and lost final reply as distinct existing-classification controls; no rejected/unknown error fabricates success arrays.

For APPEND definite NO versus disconnect after command/literal, count command starts and keep current caught provider behavior. Receipt still concerns SMTP accepted subset; no new copy task, reconciliation or retry claim. DATA/APPEND byte equality witnesses this single lifetime only, not restart wire retention or final delivery.

#### D4 — actual SQL/native-IDB transaction failure images

SQL: on the test-owned SQLite file install a real test trigger `BEFORE UPDATE OF state ON ops WHEN NEW.state='succeeded' AND NEW.kind='send' BEGIN SELECT RAISE(ABORT,'t07 test abort'); END`. It aborts the actual publication transaction after independently reached DATA/APPEND. Remove trigger after the observation; reopen must show T01 unknown, no published summary, original private staging/charge retained, no retryNow transport. Neutral WHEN0 trigger control succeeds. A JavaScript throw before entering complete is only wrapper control, not native rollback proof.

IDB: use current real factory/transaction abort pattern from idb.store.test.ts. Spy actual object-store put, delegate to real put; only when `this.name==='send_receipts'`, row.phase published and observed DATA1, queueMicrotask(() => this.transaction.abort()). Assert the injection fired and actual transaction abort, ordinary state/receipt after reopen, then retryNow counts unchanged. A neutral spy is control. Separate synthetic request failure with a committed dirty marker from true abort: uncertain partial write must poison before fence release and fail closed on reopen, not be labelled rollback. A suspended request success with no terminal completion cannot resolve details/queue/complete. Repeat at seed stage (DATA0), outcome stage (DATA1) and final publication. Do not assume a generic transaction spy necessarily hit the intended stage.

#### D5 — concrete retirement/crash interleaving image

Create real successful receipts via the D1 public fixture, including at least one76-occurrence receipt (4 bounded parts), an unrelated account/receipt and multiple additional headers. Record actual Sent/DATA bytes and private row/charge oracle via debug.verify plus test-owned native reads. Close/reopen before deletion so byte rows are cold. Drive real store slice commands (not fake arrays); backend pump may be paused before entering its next store command by a test barrier, with no held native transaction/lock.

1. Forget target published receipt: immediate logical retired/pending, succeeded op/IDs immutable; deliberate Forget replaces recipient warning with address-free partial truth as UI-CLEAR.md specifies, no child scan or physical charge release. New details do not disclose it. Complete replay inert. Unrelated receipt remains available. First cleanup slice(limit1) removes exactly one known byte+metadata pair, advances durable cursor, preserves full header charge. Close/reopen each prefix0/1/3/4; suffix and charge must match. After final header deletion exactly one charge/slot subtraction, repeat slice no double subtraction. No row/absence cache remains pinned.
2. Account removal: capture real removalGuard; fence owner+delete base account atomically, no receipt child cascade. Capture callback and whole deletion times separately. Response pending while cold receipts remain. Reopen continues retiring owner even with account/op absent. Create replacement with reused numeric account ID/email/test clock via existing account fixture; it gets a distinct UUID, global retired charge persists, new owner bytes remain untouched. Interleave old provider completion/seed/outcome continuation at each barrier: no upsert/publish/new account mutation. An old removalGuard cannot delete replacement. Owner appearance/disappearance under the same immutable account incarnation must NOT refuse removal; replacement incarnation is stale before mutation.
3. Real abort before owner/header fence => old details still available and no cleanup eligibility. Commit-before-ACK fence => retired/pending survives, replay inert. Abort one part deletion => cursor/rows/counters unchanged; committed part+lost ACK => replay skips prefix. Abort final header delete => full charge remains; committed delete+lost ACK => no second decrement. Corrupt missing byte in active published header => unavailable; the same missing prefix is legal only with matching retiring cursor. Owner/global sums recompute exactly after every image.
4. Stop backend after one committed unit; no timer/network or lock spans yield/close, remaining durable work resumes on next open. Cleanup storage failure stops pump blocked; state may become pending on reopen because blocked failure was not durably writable. Explicit renderer retry restarts only cleanup, never SMTP. At no pending work, spy timers/network/store calls over an idle observation and expect zero repeating work. Wakes coalesce into one active pump+one flag, never N promises for N receipts.

Resource-cap tests use proposed production slot/byte limits through public adapters or native complete-image fixtures, without a hidden fake quota in shipped API. At exact limit, next queue refuses while draft remains; retirement does not free spendable capacity until owning deletion commits. Repeated create/delete accounts while cleanup is blocked must hit the global bound before accumulating unbounded orphan addresses. Never silently evict still-needed evidence to make the test pass.

#### D6 — actual renderer and legacy queued-send images

Use actual boot.ts, real RpcClient memory transport and real backend/store handler; shim only connection startup to attach that transport. Publish normal mixed receipt. Intercept real op event: flag/counts, no recipient warning. Expect immediate actions.send.partial and then exact localized original description from renderer details, never actions.send.sent. Denied/not-recorded/retired/timeout details remain generic partial. Attach a new actual transport between response resolution and enrichment microtask; connectionVersion changes, no old description. Emit actual accounts event/removal/replacement in the same gap; local generation changes, no stale recipient description. Two active enrichments maximum; further partials stay generic without queue/timer. EN+ES light/dark captures must be visually inspected later; all settings cleanup controls named/keyboard reachable, no new animation/layout assumptions.

Open actual accounts-tab, remove a receipt-bearing account: preserve account.removed but pending description/status until receiptCleanup event idle. Block storage and expect truthful blocked state with explicit Retry; callback invokes renderer cleanup RPC only. MCP cannot call it. Close settings => no polling/subscription leak. These are used UI paths, not merely direct unreferenced RPC tests.

Legacy fixture: a genuine physical11/old SQL-version image containing queued, running and unknown send ops and attachment refs, created by existing historical fixture writers. Upgrade to new schema with no receipt rows; put account capacity at full with existing public asset reservations. Queued legacy send still reaches normal DATA/APPEND and existing warning/body/refs/IDs; no receipt fabricated. Running recovery remains unknown/noneligible, manual unknown resolution semantics unchanged. An oversized legacy envelope also bypasses new receipt-only index limits (bounded evidence fallback), preserving the historical send/warning path. New compose.send under same full account refuses before draft consumption. Missing receipt cannot be a fallback for a present malformed/mismatched header or arbitrary materialization exception. Do not stamp legacy status from clock/seq heuristics or auto-enrich old succeeded ops.

#### D7 — schema, image copy, export and load gates

Use matched physical10 without op parts, physical11 with exact C/T/E parts, and future receipt-version images. Raising only max-readable ceiling must preserve physical11 interpretation. Missing physical receipt stores/indexes or invalid singleton/marker fail startup admission. Cold field/key/owner/part/digest/total errors fail when accessed or under full debug/image validation; startup must not claim it scanned them. Preserve complete clean SOURCE and COPIED images including pending retirement prefixes; owned disposable COPYING target prefix may remain incomplete under existing role rules, never a dirty source exemption. Exact full copy reads preserve immutable bounded receipt bytes and owner generation; no mail content upload. Advisory app.export still excludes successful receipts/private reservation/retirement state and import never resends them; whole-store copy is the history-preservation route.

50k+ thread/load/perf gates for both stores: compare startup first usable/early snapshot, eager metadata bytes/counts, ops.list/recent query count, lazy bytes read<=page bound, renderer render count and event loop. No per-op envelope parse. Max-receipt preflight/normalizer/staging processes bounded<=64KiB units with macrotask progress. Retirement measure longest synchronous callback (including native request enqueue and MemDb mutation), actual completed transaction latency, total physical deletion time and UI interleaving separately. Actual backend BULK_SLICE is15ms; earlier8ms assumption is withdrawn. Use existing SliceSizer with initial1/ceiling8 and record overruns, but even one unit can fail the gate: report/fix it, do not assert a batch count proves fit or shrink useful history as a shortcut. Existing base account delete fanout remains a separately reported limitation of optionA, not concealed by receipt-only measurements.

Future required suite/package gates are in Plan65. No fixture has been executed or qualified here; syntax/fixture defects remain predictions to resolve before any behavioral RED claim.

#### R2 matched source images (not extra claims for the original10 definitions)

R2-UI1 persistent recovery: actual account settings opens lazy history page25 from8192 terminal headers; native query returns<=26 fixed headers, no envelope/body/recipient reads, one in-flight page, authenticated encrypted cursor<=512 bytes bound to renderer/account incarnation. Close/reopen settings after the12s send toast expires; select<=25 rows and clear sequentially via real handler+stores. Each committed logical clear removes its row and shows pending; row/byte capacity is released only after actual cleanup commit. A new queued draft stays intact at cap; after sufficient selected cleanup it can send normally. No full owner scan, unbounded bulk mutation, account deletion or unrelated attachment deletion is the UI recovery path. New completion/retirement during paging follows documented keyset consistency; forged/stale/reconnected/reused-account cursor yields content-free stale/refresh, never cross-account rows.

R2-UI2 Forget normal mixed send: before Clear exact legacy lastError/ref/description remain. After real Forget commit expect same succeeded state/provider IDs/Sent bytes/body and exact fixed errors.smtp.partialDetailsCleared with empty recipient params; summary/history row retires, partial flag remains after physical header deletion/reopen. Late complete remains inert and cannot restore original recipient list. Assert known rejected fixture addresses absent from warning/ref/event/diagnostics (Sent/source recipients intentionally remain). Repeat Forget idempotently. New explicit details query returns address-free retired warning/pending-or-complete; it never fabricates count zeros.

R3-WARN unrelated warning preservation: use the existing generic warning input to real store completion/backend result boundary with recipientWarning absent, then deliberate Clear. Stored unrelated warning bytes/reference remain exact through reopen/replay; counts/IDs/Sent stay unchanged. Actual current IMAP recipient-only normal/Forget control remains. R2's synthetic combined-producer image is retained in immutable r2 archive, but removed from current scope because no shipped mixed-warning caller exists. It was not an executed passing control. No warningParts/composite/i18n helper or4096 warning metadata budget is justified by that synthetic case. A future mixed producer requires explicit contract design before shipping.

R2-UI4 late enrichment: hold actual renderer detail result before response delivery, start local Forget, invalidate op epoch immediately; commit retire event before resolving old result. No rejected-address description reappears. Reverse event/result order: old description may arrive before retirement notification, then event immediately replaces it with generic partial. Exercise another renderer’s Clear, actual RpcClient.attach, account replacement, already-visible toast and physical header deletion. Bounded enrichment map holds only pending/visible owners, released at toast/page unmount; no persistent per-op map/timer. Failed Forget stays generic until a new explicit read, never resurrects from old promise.

R2-GUARD: use exact schedules in REMOVAL-GUARD. Hold admitted real queueSend in async preflight, begin removal, allow it to reserve/create owner; drop waits registered accountWrite, final matching-incarnation remove succeeds. Hold photo load/settings await while cleanup removes empty owner; final same-incarnation remove succeeds with no stale-owner error. Replace row using identical legacy id/email/createdAt but different proposed incarnation at every await: guarded settings/base transaction cannot mutate replacement; captured icon closure cannot delete new People/Promise/Controller references; accountRemoved cannot clear new lifetime/credentials. These are tests of proposed private identity, not a claim current product was observed failing. New schema token survives native reopen/complete-image copy; ordinary mailbox import creates a NEW token through actual createAccount, never accepts one from export. Token remains absent from export/bootstrap/logs.

R2-FIXTURE: inject sync/async listen failure, late successful listen after native deadline, backend constructor/open rejection, hung actual stop, close rejection, raw socket error, stream callback throw and APPEND>4. Body error and afterEach AggregateError both remain visible. All independent closes start; actual native listener/socket/store/provider joins decide terminal; uncertain work retains references/TMP, and next acquisition throws before mkdtemp/listen. SMTP timeout callback alone cannot pass terminal proof. Native timers advance even when application timers are fake. No fault fixture is counted among8behavioral RED/2controls. FIXTURE-LIFETIME and INVERSE.json freeze first/lower oracle attribution.

#### R3 C1-L / actual recent / facts and native-plan images (all unexecuted)

R3-L1 startup: open a future-version real adapter with32768 header/65536 part ceilings represented as cold native fixture rows. Observe native object-store calls: no owner/header/part/byte full scan/getAll, no MemDb hydration/indices/negative sets. Only fixed usage plus existing nonreceipt/op startup admission. Cold malformed header is NOT claimed caught until point access; invalid layout/singleton/marker is caught at startup. Explicit debug/full SOURCE/COPIED must catch that cold corruption and global mismatch with legitimate retiring-prefix control. Never reinterpret a clean marker as cold certification.

R3-L2 recent: real ops.list→recent100 and direct default recent100_000. Instrument native point/cursor keys and projected op facts: each unit16 rows<=98 facts/keys, no body/target parse/new E-warning read, yield after actual unit terminal. Populate different owner/incarnation per selected send to defeat deduplication assumptions. Every scope hit/miss/index result must release on success, actual abort and uncertain completion; no new MemDb receipt rows/index facts exist. Reopen negative->new header and header->retired/missing cases cannot reuse cached absence/index facts. Mark singleton/publication/Forget epoch drift between batches and final response: partial decoration discarded, one restart only, repeat drift unavailable, no old recipient warning returned. No-header legacy and missing observed admitted header remain distinct. Existing app.export uses receiptProjection:false; same unfinished output scope with ZERO new receipt lookups, not100_000 discarded projections. Actual old op-row query/array cost remains measured separately.

R3-L3 native write plans: existing public queue/prepare/complete/Forget/cleanup/attachments.create must hit real same marker/persist transaction with bounded plan. An empty ordinary Memory commit plus receipt seed/cleanup plan STILL commits. Abort guarded epoch/account/incarnation/owner/header/op-control drift BEFORE mutations; one bounded rebuild then unavailable, never no-header/SMTP fallback. Inject request failure with committed marker vs actual abort separately; poison before admission release, clear every local row/miss/index/plan reference after terminal without claiming rollback. No scope plan is used after poison. Count no additional generic Table.evict/readLazy framework path.

R3-L4 full validator: ordered effective BASE/header merge keeps one op/header lookahead, no all32768-op/owner map/per-receipt wide BASE parse. Verify C/T/E effective state and orphan checks still run. Second receipt-only grouped pass retains one owner sum/scalar global total, parts<=one64KiB +120 digests. Wrong kind/account/state/source digest/part coverage/owner totals/orphans fail; valid retired owner without account/op and exact cleaned prefix pass. Change epoch during pass→no certificate/destructive admission; full image SOURCE/COPIED only after existing locks/marker/validator. Owned disposable COPY-prefix exception is not a dirty source exemption.

R3-L5 history:26 covering native keys+52 op existence/control facts+<=5 shared guards<=83, no recipient/warning/body reads or MemDb.by8192. Native accounts.incarnation unique index gives key-only guard, no provider-config parse. Missing/unready actual op-control facts must wait existing admission or unavailable, never produce succeeded counts from header alone. Clear last row/empty-owner replacement invalidates opaque cursor and refreshes page1. Capacity remains pending until physical owning subtraction.

R3-CURSOR: follow CURSOR recipes using built-in AEAD, byte bounds and actual connected receipt RPC. Inspect raw token envelope/ciphertext, not HMAC plaintext; no UUID/incarnation/key string in RPC/log/export. Private codec known-key roundtrip is a separate algorithm control, never runtime production-key access. Tamper IV/tag/ciphertext/AAD/account, old Backend/key/reconnect/new nonce, disconnect/detach/send error/ctx replacement during each await fail fixed safe. Trusted direct invoke of unrelated method remains GREEN control with original {clientId,origin}; direct receipt invoke without live ctx refused. Concurrent<=2 issuance unique counters, no wrap/reset on failure, key.extractable false. No context/key/timer tail after stop. None executed.
