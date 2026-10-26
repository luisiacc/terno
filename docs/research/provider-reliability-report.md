# Email provider reliability: investigation and day-one safeguards

Research date: 2026-10-26. This is a design and implementation investigation, not a production incident audit. No application behavior was changed.

## Guide to this report

- [Most transferable lessons](#read-first-the-most-transferable-lessons)
- [Terno: protections, gaps and priorities](#terno-what-to-keep-and-what-to-address-first)
- [Proposed implementation contracts](#how-to-translate-the-findings-into-terno)
- [Provider and protocol requirements](#protocol-requirements-that-extend-beyond-the-source-evidence)
- [60 acceptance scenarios](#acceptance-test-matrix)
- [Shipping sequence](#shipping-sequence)
- [Evidence appendix A](#appendix-a-implementation-and-historical-evidence)
- [Evidence appendix B](#appendix-b-implementation-and-historical-evidence)
- [Review and verification status](#review-and-verification-status)

The investigation inventoried 6,396 issue/PR endpoint records across the two sources, then selectively inspected relevant discussions, patches, code and tests. The appendices contain 83 evidence entries; they are not 83 independently reproduced bugs or 83 proven Terno defects. Full sampling counts, snapshot hashes, ancestry caveats and coverage limits are in each appendix. General SMTP/IMAP findings come from the source that implements them plus protocol documentation; the other source does not establish arbitrary-server coverage.

## What matters most

A fast email client earns trust by preserving intent through partial failure. The expensive problems are usually not the happy-path API calls: they are a cursor saved too early, an old credential failure overwriting a successful sign-in, an ambiguous send retried twice, a message move mistaken for deletion, or a draft update racing with send.

This report combines code, tests, historical changes and public incident reports from two implementations with current provider documentation and a static comparison against Terno. External implementation evidence is anonymized as A and B. Their names and repository links are intentionally omitted. Anonymous source locators retain snapshot commits, paths, change hashes and issue numbers where available; direct provider documentation is linked normally. This reduces external click-through traceability, but does not hide the distinction between confirmed code and an unverified report.

The priority labels mean:

- **P0:** risk of sending twice, sending to the wrong person, losing work, exposing mail, or mutating the wrong remote message. Block the affected capability until the invariant is covered.
- **P1:** substantial correctness/recovery failure, silent staleness or unsupported provider behavior. Required before broad provider rollout.
- **P2:** polish, efficiency or advanced capability that can follow a clearly scoped initial release.

A P0 recommendation is not automatically a confirmed Terno vulnerability. The Terno assessment explicitly separates existing protections, static gaps and scenarios still needing execution.


## Read first: the most transferable lessons

1. **Persist what happened after submission, even if local storage fails.** The highest-priority Terno candidate is remote acceptance followed by failed local completion (T01). Historical fixes independently separated send acceptance from an immediately unreadable sent copy (B21) and restricted retries for ambiguous writes (B22). A successful send followed by a failed read or commit must not become an ordinary resend.
2. **Enumerate a stable work set before a destructive bulk action.** A verified Outlook fix covers 250 messages: archiving the first page shrank the same offset-paged query, so the next offset skipped mail (B15). A separate fix covers conversations longer than one page and prevents later-page failure from mutating only a prefix (B16). Spool large target sets durably instead of holding every ID in memory.
3. **Identity and authorization are versioned data.** Refresh writes can overwrite newer credentials (B01); stale failures can disconnect a successful reconnect (B02); wrong-session reconnect can attach another mailbox (B03); an auth dependency upgrade can change identity keys (B04). Terno already addresses several of these races. Preserve those tests and add upgrade/migration coverage rather than rebuilding auth around address strings.
4. **A skipped event needs durable recovery ownership.** Failed processing locks suppressed immediate retries (B07); catch-up markers could be cleared by an older worker after a newer skip (B09); Outlook throttling needed a remembered catch-up window (B08). Never equate notification acknowledgement, dedupe acquisition, or a greater cursor with successfully completed work.
5. **Draft text and attachments mutate one resource.** Provider draft replacement can overwrite an attachment uploaded concurrently (B26). Missing drafts must stop autosave rather than loop or resurrect them (B27). Stable edit-session identity also prevents sync echoes from replacing the active composer (B30). Terno's local revision guards are worth preserving when remote drafts or attachments are added.
6. **Mail is a MIME tree with distinct alternative and sequential parts.** Sequential parts split around an image are different from alternate representations; choosing the last HTML fragment can show only a signature (B31). Invalid or enormous metadata can wedge account sync (B32), and one unreadable Graph item can poison a page (B33). Isolate message failures while retaining a durable repair path.
7. **Shared interfaces need provider-specific behavioral tests.** Categories versus folders (B18), stale category PATCHes (B19), empty versus omitted recipient fields (B28), and Gmail syntax passed into Graph search (B36) all broke apparently generic abstractions. Test the exact remote effect, including later pages and concurrent changes.
8. **Partial success must stay partial in the data model.** Mixed batch statuses (B20), missing attachment bytes (B23), and SMTP recipient acceptance need distinct outcomes. Returning a generic success or failure throws away the exact repair set and can create duplicates or empty files.
9. **Scope claims are part of reliability.** Terno currently has concrete limitations around attachment transport, arbitrary IMAP folders, Microsoft OAuth/native integration, and browser IMAP/SMTP (T02–T03). An honest supported-capability surface is safer than an integration that signs in but cannot preserve expected mailbox behavior.
10. **Preserve the local architecture while borrowing the logic.** Hosted recovery services, centralized caches and server attachment storage are evidence about failure modes, not deployment templates. Use local durable operations, bounded reconciliation and account-scoped caches under Terno's privacy and resource rules.

Four quieter safeguards from the other implementation are also useful. **Version each pending message/label intent**, so a late acknowledgement cannot settle a newer toggle, and retain a delivered overlay until provider history confirms it (A05–A08). **Gate local counts on known coverage**, so a partly imported folder does not look empty (A13). **Reserve request capacity for foreground work** and persist cooldown/admission state, so background recovery cannot starve interaction or bypass throttling after restart (A09–A10). **Treat capability fallbacks as correctness decisions**: a no-UIDPLUS expunge fallback can remove unrelated already-deleted mail, while discarding SMTP partial-acceptance results hides failed recipients (A31–A33). These are current code/test observations and inferred hazards; many came from a large aggregate change, so they are not presented as individually verified production incidents. Borrow the invariants and adversarial fixtures; this is not a recommendation to replace Terno's established IMAP/SMTP libraries with custom wire clients.

The evidence appendices below distinguish merged fixes, current safeguards, unmerged proposals and unresolved reports. The 60-scenario matrix is a proposed test backlog; it is not a statement that all scenarios currently fail or that all need new tests.

## Terno: what to keep and what to address first

The inspected Terno snapshot is `35509d2ffcd2608d0531c2ee9c0e326b92e9afa9`. The following is based on source and test inspection; tests were not run. “Covered in code/tests” means an explicit implementation and test oracle were found, not that live-provider interoperability was verified.

### Existing protections worth preserving

- **Durable intent and store parity.** Queueing a send atomically consumes its saved draft and writes an optimistic copy plus operation. The store contract covers exactly-once draft consumption, threading, optimistic state and revision conflicts across stores. See `packages/db/src/sql-store.ts:517`, `:579`; `packages/idb/src/store.ts:947`; `packages/store/src/conformance/store.ts:1345`.
- **Conservative send uncertainty.** SMTP tracks the DATA boundary; Gmail treats possibly submitted failures and unreadable successful responses as ambiguous. Restart marks running sends unknown rather than automatically retrying them. Keep these guards when changing retries. See `packages/mail/src/smtp.ts:32`, `:54`; `packages/mail/src/gmail-api.ts:139`; `packages/db/src/repos.ts:546`; `packages/idb/src/mail.ts:1354`.
- **Sign-in recovery handles races.** Refresh requests coalesce; refused-token invalidation checks the token identity; credential generations fence off stale failures; wrong-account reconnect is rejected. SMTP-only authentication refusal does not stop incoming IMAP. See `packages/mail/src/gmail.ts:133`, `:175`; `packages/backend/src/core.ts:891`, `:1069`; `packages/backend/src/identity.ts:107`; `packages/backend/src/resign-in.test.ts:196`, `:242`, `:271`.
- **IMAP identity has real safeguards.** UIDVALIDITY changes clear/reidentify old locations; destructive operations check the validity epoch; COPYUID results update destination locators. Tests include reused UIDs, missing/duplicate Message-IDs and old mail outside the sync window. See `packages/mail/src/imap.ts:261`, `:298`, `:457`, `:474`; `packages/backend/src/imap.int.test.ts:248`, `:306`, `:331`, `:406`.
- **Gmail recovery is stronger than a recent-message refresh.** List/history paths paginate. Full recovery refreshes older cached messages and deletes them only on explicit 404; other errors abort cursor advancement. The full-scan history anchor is captured before listing, helping catch concurrent changes later. See `packages/mail/src/gmail-api.ts:232`, `:252`, `:278`, `:335`; `packages/backend/src/gmail.int.test.ts:328`, `:355`, `:381`.
- **Local state is not subject-only threading.** Threads use account-scoped provider IDs or RFC references and support late parents. Actions capture target messages, so a later arrival is not automatically swept into an earlier archive intent. See `packages/db/src/ingest.ts:69`; `packages/idb/src/mail.ts:367`; `packages/store/src/conformance/store.ts:57`, `:231`.
- **Draft and HTML safety already have foundations.** Autosave tracks revisions, retries failures and flushes controlled exits; stale saves do not simply overwrite newer drafts. Mail HTML is sanitized, sandboxed and resource restricted; local mode disables remote content. See `apps/web/src/lib/drafts.ts:281`, `:355`; `packages/db/src/repos.ts:650`; `apps/web/src/components/mail-body.tsx:33`, `:122`; `apps/web/src/lib/mail.ts:5`.

### Prioritized gaps and candidates

| Priority | Finding and confidence | Concrete next step |
|---|---|---|
| P0 candidate | A remote send can succeed before a local completion error enters retry handling. Retry control flow established by inspection; duplicate delivery not reproduced. | Fault-inject completion writes and worker recovery before expanding retry behavior. |
| P1 limitation | Attachments are not usable end to end, including CID byte retention. Explicit implementation scope. | Implement a complete attachment lifecycle or clearly limit launch claims. |
| P1 limitation | IMAP sync covers selected role folders, not arbitrary folders; no native Microsoft adapter/protocol OAuth was found. | Define supported provider/account capabilities and qualify them separately. |
| P1 observed classification gap | Gmail transient quota 403 and token-endpoint 429 are not fully classified. | Reason-aware retry tests and Retry-After scheduling. |
| P1 observed handling / outcome validation | IMAP whole-operation retry and Gmail untrash handling can hide partial progress. | Step-level failure injection and exact server-state assertions. |
| P1 candidate | Enlarging the sync window does not visibly backfill an existing cursor. | Specify and test window expansion with old and newly arriving mail. |
| P1 gap | A failed Sent copy is swallowed after SMTP submission. | Persist a copy-repair task and truthful warning; never resend. |
| P1 limitation | Reply-To is not retained for automatic reply addressing. | Extend the shared model and ingestion before changing composer selection. |
| P1 validation | Initial OAuth exchanges lack the refresh path's bounded request wrapper; desktop granted-scope handling needs parity. | Stalled exchange and reduced-consent fixtures. |
| P2 measurement | IMAP repeatedly enumerates all UIDs/known flags and retains new metadata before ingest. | Measure recovery on a 50k mailbox and bound raw-body memory. |
| P2 UX decision | HTML frame code permits inner scrolling past a height cap. | Reconcile this exception with the no-inner-scroll product rule. |

**T01 — Remote success versus local completion (P0 candidate).** Provider execution and `store.ops.complete` share a try block at `packages/backend/src/core.ts:1053` and `:1057`. A normal storage exception can enter retryable failure at `:1079`; unexpected worker errors can requeue a running operation at `:1000`. SQL failure handling (`packages/db/src/repos.ts:488`) and IndexedDB failure handling (`packages/idb/src/mail.ts:1299`) do not require the row still to be running, so even a committed completion followed by a rejected acknowledgement can put a succeeded send back in the queue. Post-completion categorization/notification also share this try block. The existing startup unknown-send rule does not by itself establish that this live-process path is safe. Test SMTP and Gmail success followed by failure before the completion transaction, during it, and after commit but before acknowledgement; also fail the failure-recording step. Include exceptions in post-completion work and assert that succeeded rows cannot regress to automatically ready. The oracle is the server's accepted-message count and the durable operation state; runtime incidence is unmeasured. Recommended fix direction: preserve the boundary that the provider was invoked/accepted and let only local completion or reconciliation retry. No change is implemented by this report.

**T02 — Attachment capability (P1, established limitation).** Reader tiles are view-only at `apps/web/src/components/reader.tsx:142`; `SendPayload` has no attachment field at `packages/mail/src/types.ts:7`. Parsing retains attachment metadata rather than reusable bytes (`packages/mail/src/mime.ts:79`), and IMAP body ingestion does not persist that metadata (`packages/mail/src/imap.ts:441`). The rich composer plan explicitly excludes attachments. A UI tile is therefore not evidence that download, forward, inline display or outgoing attachment transport works. Prioritize this if the initial release is meant to replace a daily mail client.

**T03 — Mailbox coverage and Microsoft support (P1, established limitation).** Sync selects inbox, sent, archive/all, junk and trash (`packages/mail/src/imap.ts:532`); ordinary folders and Drafts are outside that selection. An external move into an unscanned folder needs a completeness test before local orphan removal is trusted. Role discovery uses special-use plus limited naming heuristics (`:57`, `:196`). IMAP/SMTP use a shared password with separate usernames, and no protocol OAuth configuration was found (`:115`, `:496`; `packages/mail/src/registry.ts:33`). Valid password-server behavior cannot establish Outlook/Microsoft 365 support where OAuth or tenant policy applies.

**T04 — Gmail retry decisions (P1 observed classification gap).** REST retryability checks 429 and 5xx at `packages/mail/src/gmail-api.ts:166`; token refresh checks 5xx at `packages/mail/src/gmail.ts:160`. Structured reasons and Retry-After are not interpreted there. Test quota 403 separately from domain-policy 403; test token 429 separately from invalid_grant. Hold sends conservatively when a result may be ambiguous, even if reads using the same status are retryable. This recommendation is supported by the [provider error contract](https://developers.google.com/workspace/gmail/api/guides/handle-errors).

**T05 — Partial mutations and swallowed errors (P1 observed handling; remote outcomes need fixtures).** IMAP reconnect retry wraps entire operation closures (`packages/mail/src/imap.ts:173`, `:548`). Test lost acknowledgement after MOVE/COPY, including library fallback without MOVE/UIDPLUS and multiple source folders. Gmail move-to-inbox catches every untrash failure before batchModify (`packages/mail/src/gmail-api.ts:371`) and lacks the 1,000-ID chunking used by ordinary label operations (`:378`). Test 429/503 on untrash and a captured target set over 1,000. Cover benign already-untrashed messages separately from transient/auth refusals; do not blindly remove error handling without defining those cases. A successful operation must correspond to the actual final mailbox state, rather than merely the last request succeeding.

**T06 — Backfill and disappearing messages (P1 validation).** Updating account preferences does not visibly reset/backfill an existing cursor (`packages/db/src/repos.ts:106`). Verify 30→365-day expansion on both transports. A message disappearing between Gmail listing and raw retrieval can fail fetchFull (`packages/mail/src/gmail-api.ts:190`). The outer incremental handler (`:335`) catches any escaping 404 and starts fullSync, conflating a message-level 404 with expired history. This static provenance loss can cause unnecessary rescans; a further list/get race can fail recovery again. Test endpoint-specific errors and eventual progress under repeated concurrent deletions. For IMAP UIDVALIDITY resets, inject crashes between location clearing, reattachment, reconciliation and cursor save, including ID-less twins. Existing uninterrupted tests are valuable but do not establish crash convergence.

**T07 — Sent copies and partial recipients (P1 gap).** SMTP preserves rejected recipients as a warning, but the shared result has no structured per-recipient outcome ledger (`packages/mail/src/types.ts:116`). Sent APPEND errors are swallowed after submission (`packages/mail/src/imap.ts:500`). Preserve the current no-resend behavior while making missing-copy repair and partial acceptance discoverable. Classify rejected versus unknown APPEND outcomes; reconcile an unknown copy before replaying APPEND to avoid duplicate Sent copies. Unknown sends currently offer explicit mark-sent/retry/discard (`packages/db/src/sql-store.ts:490`); automatic reconciliation by Message-ID was not established.

**T08 — Scope, identity and timeout qualification (P1 validation).** Desktop records granted OAuth scopes without a visible normal-connect rejection for missing mail scope (`packages/mail/src/gmail.ts:119`; `packages/backend/src/handlers.ts:485`); browser UI checks it (`apps/web/src/web/google.ts:84`). Initial token/profile exchanges lack the refresh wrapper's bounded request handling (`packages/mail/src/gmail.ts:114`; `packages/mail/src/gmail-web.ts:20`). The callback waiting deadline does not bound every later exchange. Add reduced-consent, stalled-exchange and cancelled-flow tests. Compose derives From from the account rather than a provider-authorized alias set (`packages/db/src/sql-store.ts:519`); qualify send-as before exposing arbitrary identities.

**T09 — Resource and UI contracts (P2).** Established IMAP mailbox sync enumerates all UIDs and known flags (`packages/mail/src/imap.ts:393`), retains fresh metadata before ingestion (`:282`, `:359`), and limits body count/concurrency without an obvious byte ceiling (`:429`). Measure large initial/recovery sync rather than assuming bounded batches imply bounded memory. The HTML height cap permits inner scrolling (`apps/web/src/components/mail-body.tsx:68`), which needs an explicit UX decision under the working agreement.

**T10 — Reply-To is lost before recipient selection (P1, established source-level limitation).** Parsed metadata does not retain Reply-To (`packages/mail/src/mime.ts:5`, `:65`), nor does IMAP envelope ingestion (`packages/mail/src/imap.ts:360`). The composer chooses the last received message's From for a reply (`apps/web/src/lib/compose-fields.ts:33`). A legitimate reply destination different from From is therefore not selected automatically. Carry reply addresses through the shared message model, persistence/migrations and both ingest paths before changing recipient selection. Test a synthetic From/Reply-To mismatch through Gmail and IMAP, both stores, reply and reply-all, and inspect the exact queued recipients. This is a model issue, not only a provider-native reply API opportunity.

### Desktop/web/privacy boundaries

Desktop uses Gmail REST or IMAP/SMTP. The actual browser target creates a local backend worker and supports direct Gmail API access; IMAP/SMTP are explicitly unavailable (`apps/web/src/web/worker/providers.ts:13`; `apps/web/src/web/worker/backend.worker.ts:148`; `apps/web/src/rpc/connection.ts:65`). Browser Gmail stores access tokens only in worker memory and has no refresh token (`packages/mail/src/gmail-web.ts:9`, `:18`, `:38`): reload or token expiry requires the token-acquisition/reconnect flow before work resumes. Queued work must survive that wait without duplicate submission. Closed-tab mail background work is another platform limitation. Persisting refresh tokens or introducing a hosted token broker would require a separate security/privacy design. Development WebSocket/backend code is not evidence of a hosted production mail proxy.

Fresh settings enable local mode and disable optional AI/icons; policy fetch gates non-mail purposes (`packages/backend/src/settings.ts:52`; `packages/backend/src/net-policy.ts:125`). OAuth/profile requests and provider sign-in scripts are part of identity integration, while a hosted web shell and its future JavaScript remain a deployment trust boundary. A hosted IMAP proxy or image fetcher would be a new explicit privacy decision. Do not silently route it through the existing always-allowed `mail` purpose.

A targeted full audit can be reconstructed from the source anchors above and plans 04, 03–04 reconciliation, 10, 16, 20 and 25. This research did not access real profiles, authenticate to mail providers, execute application tests, or establish the OAuth application's external verification/publication status.

## How to translate the findings into Terno

### Keep a local durable record of intent

The following is a proposed implementation contract, not a claim that either source already implements it completely.

Before a remote mutation, persist an operation identity, account identity, credential generation, target locator and its validity epoch, requested change, exact inverse when supported, and a payload revision. After each remote step, record what is known. Keep the local operation separate from the provider's response ID.

For sends, model at least: queued; waiting for sign-in; waiting for connectivity; submitting; accepted; partially accepted; outcome unknown; permanently rejected; and sent-copy pending. Some are orthogonal flags rather than a single enumeration. Provider acceptance is not recipient delivery. A later bounce can still arrive.

Recovery after process termination must use durable evidence, not an in-memory promise or a toast. An uncertain send should offer a clear reconciliation path and an explicit duplicate-risk choice if the user elects to send again. Searching Sent by Message-ID is useful evidence, but an empty search is not proof of non-delivery: indexing can lag, a copy may be disabled, or another folder may contain it.

### Make sync checkpoints describe completed work

A notification marks an account or folder dirty. A serialized reconciliation worker reads from the committed checkpoint, stages or idempotently applies changes, then promotes the checkpoint after every required page and item is durably handled. A crash after applying a page but before saving its checkpoint must be safe to replay.

Use a coalesced dirty flag so an event arriving while sync is in flight forces another pass. A lock without a trailing pass can lose the last event. Where multiple workers or tabs exist, include a generation or fencing token: a worker whose lease expired must not advance the checkpoint after a replacement worker finishes.

One malformed message must not silently disappear behind a successfully advanced cursor. Either fail the checkpoint or atomically persist a retry/quarantine record containing only the local identifiers needed for repair. If a body is unavailable, a metadata row can remain visible with a per-message error. A global account failure is appropriate only when the failure is account-wide.

Full reconciliation must state its scope. A 30-day list is not proof that older cached messages were deleted. Apply tombstones only from explicit deletion evidence or a successfully completed authoritative enumeration of the same scope. Preserve local drafts, pending mutations, focus and scroll while rebuilding provider-derived state.

### Preserve provider identity below the shared UI

Use account-scoped opaque provider identifiers. Preserve case when the provider requires it. Distinguish a local conversation ID, provider conversation ID, provider message ID, RFC Message-ID, Gmail history cursor, IMAP UID locator and Graph delta URL.

A generic folder/label method must not erase semantics. Gmail has many-to-many message labels; Outlook messages belong to folders; IMAP moves create new destination UIDs. Terno's category move behavior can remain consistent while adapters express the different remote operations underneath it.

Prefer a capability description over scattered provider-name checks: native reply support; folder versus label membership; immutable-ID mode; remote draft support; send-as identities; large-file upload; permanent-delete permission; push/IDLE availability; shared-mailbox access; and search dialect. Resolve capabilities from the actual account grant and server, not a marketing provider name.

### Classify failures by action and outcome

A useful adapter error contains a stable local code, operation, provider status/reason, retryability, authentication scope, outcome certainty, retry-after time and affected item IDs. Raw server responses can contain addresses, subjects or tokens and should not become diagnostics by default.

Examples: history 404 means resynchronize; message 404 may mean a concurrent deletion; a Graph folder removal can mean a move; Gmail 403 can mean quota or administrator policy; SMTP AUTH refusal can block send while IMAP keeps receiving. A single global unauthorized or not-found handler loses these distinctions.

Backoff belongs at the account/provider boundary with bounded concurrency and jitter. Give interactive operations a bounded place in the schedule so a large backfill cannot starve send or opening a message. Do not multiply a library retry loop by an adapter retry loop and another queue loop. Retry reads and idempotent set-state mutations differently from creates, sends and move steps whose outcome may be unknown.

### Fit the architecture to local mode

Hosted webhook brokers, centralized token stores, third-party image proxies, remote body fetchers and continuous cloud workers can be reasonable in a hosted service. They cannot be copied into Terno's default local mode without violating its stated privacy contract.

Desktop IMAP IDLE and direct provider requests have a different lifecycle from hosted webhooks. Browser workers cannot speak arbitrary IMAP/SMTP TCP. Web parity must therefore distinguish direct supported APIs from a user-authorized transport or explicitly unsupported capability. Never silently introduce a mail relay to claim parity.

Resume, reconnect and opening an account are natural repair triggers. If provider documentation requires a safety reconciliation after missing notifications, schedule a bounded repair appropriate to the chosen mode and document the resource tradeoff. An event-driven design still needs recovery after sleep, expiry and lost events; it does not imply an always-running fixed-rate poller.

## Protocol requirements that extend beyond the source evidence

### Gmail

An expired history cursor requires a bounded, restartable full reconciliation. History IDs are decimal strings with gaps; retain exact values. Read all history pages, deduplicate overlapping event records, and promote the cursor only after durable handling. A single-message 404 must be distinguished from history expiration. [Synchronization guide](https://developers.google.com/workspace/gmail/api/guides/sync), [history listing contract](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).

Label state is per message; a thread-level label list is a union. A thread label change affects existing messages and future replies do not inherit it. Drafts have special label limitations. Define unread, archived and category state using the relevant message set, and test a new inbound reply after archiving a conversation. [Label semantics](https://developers.google.com/workspace/gmail/api/guides/labels).

Reply insertion requires the provider thread ID, compliant reply reference headers and a matching subject under Gmail's documented criteria. An internal conversation identifier alone cannot produce a correct provider reply. [Threading requirements](https://developers.google.com/workspace/gmail/api/guides/threads).

For an explicitly chosen server push integration, watch renewal and missed-notification recovery are separate from message synchronization; receiving a notification never authorizes simply jumping the stored cursor. Device clients have different guidance. [Push lifecycle](https://developers.google.com/workspace/gmail/api/guides/push).

OAuth consent is not a permanent capability guarantee. Check granted scopes, preserve an existing refresh token when a later response omits its replacement, and distinguish a temporary refresh failure from revocation. Testing-mode mail grants can expire in seven days. These are release-configuration and recovery concerns as well as code concerns. [OAuth lifecycle](https://developers.google.com/identity/protocols/oauth2), [offline access](https://developers.google.com/identity/protocols/oauth2/web-server#offline).

Remote drafts have their own identity lifecycle: the draft container remains stable while replacing its content changes the underlying message ID; sending removes the draft and creates a sent message. Store the container and message locators separately, and fence delayed autosaves after send/discard. Search parity also needs an explicit contract: Gmail API alias expansion and thread-wide matching differ from the provider UI, and date-only queries use the documented PST boundary. Prefer epoch boundaries for exact time ranges. [Draft lifecycle](https://developers.google.com/workspace/gmail/api/guides/drafts), [API search differences](https://developers.google.com/workspace/gmail/api/guides/filtering).

### Outlook and Microsoft 365

Choose a native Graph adapter or explicitly implemented protocol OAuth; a generic password form is not a complete Microsoft integration. IMAP and SMTP have distinct OAuth resource scopes, and a tenant can disable a protocol regardless of valid credentials. As of this research date, the January 2026 SMTP AUTH announcement supersedes older March/April 2026 retirement dates: behavior remains unchanged until December 2026, followed by default disablement, with a final removal date to be announced in the second half of 2027. Do not turn a moving policy date into a hard-coded diagnosis. [Protocol OAuth](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth), [updated transition timeline](https://techcommunity.microsoft.com/blog/exchange/updated-exchange-online-smtp-auth-basic-authentication-deprecation-timeline/4489835).

If Graph is implemented, consistently request immutable IDs where supported, including subscription creation and each relevant request. Normal IDs can change on folder moves. Even immutable IDs have a mailbox-bound guarantee, and IDs are case-sensitive. [Identifier contract](https://learn.microsoft.com/en-us/graph/outlook-immutable-id).

Track message delta per folder, follow returned opaque URLs unchanged, continue through empty pages when a next link exists, and save terminal delta links only after the round finishes. Handle token reset/expiration by scope. Repeated changes require idempotent merging. Cross-folder moves need reconciliation rather than global deletion on the first folder tombstone. [Message delta](https://learn.microsoft.com/en-us/graph/delta-query-messages), [delta lifecycle](https://learn.microsoft.com/en-us/graph/delta-query-overview).

A successful batch envelope does not prove all requests succeeded: inspect every subresponse and honor Retry-After for the failed ones. A sendMail 202 proves acceptance for processing, not completed processing or delivery. [Throttling and batch behavior](https://learn.microsoft.com/en-us/graph/throttling), [sendMail result](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0).

If subscriptions are introduced, handle renewal, reauthorization, removed-subscription and missed-notification events; shared-mailbox reads do not automatically grant shared-mailbox notification support. Native replies should respect Reply-To and the draft/reply API's payload constraints. [Subscription lifecycle](https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events), [mailbox notification permissions](https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview), [createReply](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0).

Attachment handling is provider-specific. Graph's documented direct attachment and upload-session flows cross a 3 MB boundary, with upload-session support up to 150 MB subject to mailbox/service restrictions. Session URLs carry preauthorization and must be treated as sensitive. A message with only inline attachments can have hasAttachments=false, so that flag cannot gate CID resolution. Distinguish file, item and reference attachments before assuming a download is plain bytes. [Large attachment flow](https://learn.microsoft.com/en-us/graph/outlook-large-attachments), [message properties](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0), [attachment types](https://learn.microsoft.com/en-us/graph/api/resources/attachment?view=graph-rest-1.0).

### IMAP and SMTP

The external implementations do not establish broad interoperability for arbitrary mail servers. Treat the following as standards-backed additions and validate them with controlled protocol fixtures.

An IMAP locator needs account, mailbox identity, UIDVALIDITY and UID. Sequence numbers can shift. When UIDVALIDITY changes, invalidate old remote locators and park or re-resolve queued destructive operations before they can target reused UIDs. [IMAP identity model](https://www.rfc-editor.org/rfc/rfc9051.html#section-2.3.1.1).

A move changes the destination UID. Prefer UID MOVE when supported; test the fallback's partial steps and never issue a broad EXPUNGE that removes another client's deleted messages. Even a multi-message MOVE can partly succeed. Discover special-use mailboxes before guessing English folder names; support namespace prefixes, delimiters, non-ASCII names, absent Archive/Trash, read-only folders and changed folder names. [MOVE semantics](https://www.rfc-editor.org/rfc/rfc6851.html), [special-use discovery](https://www.rfc-editor.org/rfc/rfc6154.html).

SMTP needs stage-aware failure handling. An explicit negative response and a lost final acknowledgement carry different evidence. A long scan after DATA can exceed an aggressive client timeout after the server accepted the message; blind retry can duplicate mail. Keep the ambiguous state durable and review stage-specific timeouts. [SMTP timeout and duplicate-submission risk, §4.5.3.2.6](https://www.rfc-editor.org/rfc/rfc5321.html#section-4.5.3.2.6).

A resolved send can still reject some recipients. Persist accepted/rejected outcomes separately; retrying the original full envelope can duplicate delivery to accepted recipients. For SMTP, omit Bcc from the transmitted MIME headers and preserve recipients in the separate envelope. Gmail API submission instead needs Bcc in its raw submission payload because it derives recipients from headers; the privacy requirement applies to recipient-delivered mail. Preserve the user's local Bcc state in either transport. A Sent APPEND failure is a copy-repair concern after a successful submission, never a reason to resend the message. Distinguish a definitive copy rejection from an unknown APPEND result: reconcile uncertain copies before replaying their creation, or the Sent folder can gain duplicates. [Nodemailer partial-success contract](https://nodemailer.com/#send-a-message), [SMTP envelope and Bcc rules, §7.2](https://www.rfc-editor.org/rfc/rfc5321.html#section-7.2).

TLS downgrade, invalid certificates, temporary AUTH 454, permanent credential refusal, recipient refusal, quota and message-size rejection need separate fixtures. A socket EOF before DATA is different from one after DATA. Keep test-only insecure transport switches out of production account configuration. These are recommendations for the test matrix, not reports that the external sources encountered every listed case.

## Acceptance test matrix

These are proposed behavior tests, not tests executed during this research. Each needs a scripted fake with assertions on calls and durable state; UI screenshots alone cannot prove provider correctness. For store-backed behavior, run the same contract against SQLite and IndexedDB. Use synthetic mail and temporary profiles.

### Synchronization and state

1. An expired Gmail history cursor triggers recovery; a transient message fetch failure does not advance beyond unhandled work.
2. Three history pages overlap message IDs and contain repeated label changes; the final materialized state is correct with no duplicate message or duplicate automation.
3. Fail after applying a page and before saving its cursor, restart, and replay; state remains correct.
4. An empty Graph page includes nextLink; the worker continues to the terminal deltaLink.
5. A notification arrives while reconciliation is running; one trailing pass occurs and the final event is reflected.
6. Two workers race and the older lease expires; only the current worker can promote the checkpoint.
7. An initial backfill races with a new arrival, archive, delete and read change; the next incremental pass catches every concurrent mutation.
8. One malformed message or missing body is isolated without silently skipping it; a durable repair record survives restart if the cursor advances.
9. A recent-window full listing omits an older cached message; the message is not tombstoned on that evidence.
10. A message is deleted between list and get; the run completes with the correct per-message outcome and no account-wide auth error.
11. A folder move yields a removal and later addition; local message content, selection and operation targeting survive.
12. IMAP UIDVALIDITY changes with a reused UID; an old queued delete cannot touch the new message.
13. An IMAP EXPUNGE renumbers messages while fetching; durable identity never uses the sequence number.
14. A read/unread change on an old message appears after sleep; the sync window does not hide it forever.
15. Folder rename, deletion, recreation, noselect parent and non-ASCII name produce correct locators and navigation.
16. Cancel backfill, close the account, and disconnect it while an item is in flight; no stale completion repopulates the removed account.

### Authentication, errors and scheduling

17. Twenty simultaneous expired-token reads produce one refresh operation per credential generation.
18. Refresh or renewed consent omits refresh_token; the previously valid stored token is retained for that same identity.
19. An old request returns 401 after successful sign-in; it cannot invalidate the replacement token or re-park resumed work.
20. Reconnect selects a different mailbox or tenant; reject identity replacement and preserve the intended account's local state.
21. Reading works while SMTP authentication fails; receiving continues and only sends wait.
22. Consent grants read but not send, or an administrator blocks a permission; expose the affected capability and the right next action.
23. Gmail quota 403, policy 403 and message 404 follow different recovery paths.
24. Graph batch envelope is 200 with mixed 204/429/404; retry only eligible failed members after the server delay.
25. A provider remains throttled through restart; persisted next-attempt timing prevents a burst on launch.
26. A large backfill is running when the user sends or opens a message; interactive work has bounded latency.
27. Sleep, VPN change, captive portal and reconnect interrupt work; cancellation closes only the relevant reads, and no automatic resend follows uncertain submission.
28. Remove a refused account; all queued jobs, reconnect timers and pending sign-in results are fenced off.

### Sending, drafts and identity

29. Persist an intent, crash before submission, and restart; the queued message is eligible exactly once.
30. The server accepts the message but the final response is lost; the durable result is unknown and no automatic resend occurs.
31. Submission succeeds but saving the local result fails before commit, after commit before acknowledgement, or in post-completion work; neither a running nor succeeded send may become automatically queued again.
32. Submission succeeds but Sent APPEND is rejected or its acknowledgement is lost; keep submission accepted, reconcile uncertain copies before replay, and never resubmit SMTP.
33. Two recipients are accepted and one is rejected; expose partial submission and never silently send again to the accepted set.
34. Bcc-only and mixed To/Cc/Bcc sends preserve actual delivery recipients without exposing Bcc in recipients' raw messages. SMTP submission omits the Bcc header; Gmail raw API submission retains it as required to address delivery.
35. Reply, reply-all and forwarding cover Reply-To, multiple aliases, self-sent messages, mailing lists and malformed addresses; compare displayed chips with the exact queued envelope.
36. Identical subjects in unrelated mail never merge solely on subject; missing or duplicated Message-ID does not erase distinct mail.
37. A valid provider reply maintains conversation linkage; a deliberate subject change starts the intended new context.
38. Autosave revision N completes after N+1, during send, and after discard; it cannot restore an older draft or resurrect a sent/discarded draft.
39. Attachment upload/removal races with Send; the queued payload references an immutable, complete revision.
40. A user edits recipients or attachments while offline after queuing; the pending operation's snapshot stays explicit and predictable.
41. Double click Send, repeat keyboard shortcut, two tabs and process restart cannot create duplicate local send intents.
42. A send-as alias is removed or loses permission after composition; submission fails safely and keeps the draft and selected identity visible.
43. Provider acceptance is followed by an NDR/bounce; do not claim that acceptance proved delivery.
44. Undo before dispatch cancels the exact operation; undo after remote acceptance never promises to unsend mail without a supported provider operation.

### Content, privacy and scale

45. Nested MIME, empty HTML with useful plain text, invalid charset, missing Date, future Date, duplicate headers and message/rfc822 parts render with deterministic fallback.
46. Inline CID images with case/encoding variations, duplicate filenames, no filename and Unicode filename preserve the intended content without path traversal.
47. Attachments cross direct/upload-session boundaries, expire midway, exceed provider/mailbox limits and lose network; recover without duplicate attachment records.
48. A large encoded MIME payload includes base64 overhead; enforce the actual transmission budget and bound concurrent decoding memory.
49. A raw import is retried; it neither duplicates the import nor converts malformed source into a destructive empty message.
50. HTML with remote pixels, CSS URLs, forms, scripts and navigation attempts causes no unapproved network or active content in local mode.
51. Logs, error objects, crash breadcrumbs and upload URLs are checked for synthetic secret/address/subject markers; sensitive values stay out of diagnostic output.
52. A 50k-thread backfill/recovery runs within existing event-loop and UI budgets; queue memory, retained raw bodies and tombstones stay bounded.
53. Long account/provider errors in English and Spanish remain actionable, keyboard reachable and screen-reader named in light/dark themes.
54. Reauthentication or background recovery while typing preserves composer content, caret, selection, list focus and scroll.
55. Idle after healthy sync or an authentication refusal has no spinning retry timers or unexpected network, apart from explicitly selected transport liveness requirements. Browser reload/expiry preserves queued work while token reacquisition is pending.
56. A recoverable per-message error remains discoverable after the global sync indicator returns to healthy.
57. Date-range search crosses midnight, DST and a non-PST timezone; exact epoch boundaries return the intended set.
58. Gmail API results differ from alias-expanded/thread-wide provider UI results; communicate or implement the chosen parity rather than treating absence as deletion.
59. A remote draft replacement changes its underlying message ID and a send removes the container; delayed autosave cannot target the sent message or resurrect the draft.
60. An inline-only Graph message reports no ordinary attachments; CID images still resolve under the explicit content policy.

## Shipping sequence

First protect irreversible outcomes: exact message identity, durable send uncertainty, partial recipients, draft revisions and replay-safe mutation recovery. Next make full/incremental reconciliation correct under interruption, then harden provider-specific semantics. Treat native Microsoft support as a capability rollout with its own identity/auth/sync tests. Finish with resource bounds and calm recovery UX across desktop and web.

Each implementation should get its own feature plan, the repository's plan critique, tests that fail before the change, code review and applicable integration/performance/packaged checks. This report is the input to those plans; it is not evidence that the proposed fixes have already shipped.


## Appendix A: implementation and historical evidence


Research date: 2026-10-26. Public source and public tracker/history only. No application implementation, dependency installation, third-party code execution, provider-account access, real profiles, or secrets were used.

### Snapshot, provenance, and interpretation

- **S (current snapshot):** `8c170b8cd27dc08571722bc393a89d27f2bd244f`, committed **2026-10-24 07:45:41 UTC**.
- **C (large current implementation ancestor):** `57184121c89cdc7b547e9054f9be2680f53a7e72`, committed **2026-10-14 04:53:19 UTC**. This is an aggregate commit: 397 changed files, approximately 38,946 insertions and 9,910 deletions. It contains substantial Gmail durability/quota and IMAP/SMTP code. Its vague title does not establish individual production incidents or deployment. No individual merged PR attribution was established for these additions.
- **D (later provider/composition changes):** `e98d0260eb5960828ef3de08e472ab89111ff546`, committed **2026-10-24 00:59:32 UTC**. Inspected actual diff, including IMAP draft ownership and inline-attachment metadata.
- Unless another revision is specified, every file/line reference below is **at S**. Paths are relative to source A. For compact references, bare storage filenames and `driver/` or `imap/` paths resolve under `apps/server/src/lib/`; `routes/` resolves under `apps/server/src/`. Source names, identifying URLs, branding, and identifying class names are intentionally omitted. Historical paths are preserved when generic; no repository hyperlink is required to resolve a claim locally with `git show <sha>:<path>`.
- **Current + tests** means implementation and test assertions were read, **not that tests were run**. **Merged historical** means the API confirmed `merged_at`; it does not imply inclusion in S or production deployment. **Inference** means a risk derived from code, not a reproduced defect. **Report** means a user's claim, not independently verified behavior.

#### Acquisition and sampling coverage

Commands, with the source identifier anonymized:

```text
git clone --filter=blob:none <A-public-git-url> source-a
gh api --paginate 'repos/<A>/issues?state=all&per_page=100'
gh api --paginate 'repos/<A>/pulls?state=all&per_page=100&sort=created&direction=desc'
gh api 'repos/<A>/commits?per_page=100'
gh api 'repos/<A>/git/trees/main?recursive=1'
gh api 'repos/<A>/contents/<path>?ref=<S>'
gh api 'repos/<A>/issues/<n>'
gh api 'repos/<A>/issues/<n>/comments'
gh api 'repos/<A>/pulls/<n>'
gh api 'repos/<A>/pulls/<n>/files'
git log --all --format='<sha> <date> <title>'
git log HEAD -- <provider paths>
git show <sha> -- <path>
git show <sha>:<path> | nl -ba
git merge-base --is-ancestor <merge-sha> HEAD
rg -n '<provider/edge-case terms>' <source and inventories>
```

Inventory totals: **2,058 issue-endpoint records** (276 issues, 1,782 PR-shaped records); separate pull-request endpoint: **1,785 PRs**, 1,317 merged and 15 open. These independently paginated APIs were not an atomic snapshot; the three-record discrepancy was not reconciled. **4,237 commit titles across all fetched refs; 3,718 commits reachable from S; 919 recursive tree entries.** Broad title screening covered auth, Gmail, Outlook/Microsoft, IMAP/SMTP, sync/history, drafts, replies, attachments, labels/folders, pagination, retries, and deletion. Meaningful fixes were then inspected through patches, exact historical files, issue discussions, and linked test changes. Ninety-three pinned TypeScript source/test files were fetched into the clone's `.research-source` cache, plus additional focused files. This is download coverage, not a claim that every line was read.

The filtered clone and checkout completed successfully. During slow lazy blob downloads, pinned public Contents API reads supplied the files needed without waiting for every checkout blob. A final tracked-file status check was clean. Raw inventories and fetched files are investigation material inside the owned clone; this report is the anonymized deliverable.

### Findings

#### A01 — Denied Gmail consent and revoked authorization need different recovery from transient failures

**Merged historical; ancestor of S.** PR **#1804**, merged **2025-07-23**, commit `ec6bd3155c09d9e35f5ee4d21c02de0c82eaf8b4`: historical `apps/server/src/trpc/trpc.ts:43–82`, `activeDriverProcedure`, recognizes lowercase substrings for insufficient permissions/invalid credentials/precondition failure. `invalid_grant` clears access and refresh tokens and requests reconnect. Related issue **#1736** (2025-07-15 → 2025-08-07) describes unchecking Gmail consent, entering the app successfully, then receiving a generic send failure. Its `not_planned` stale closure is not verified resolution.

**Tests/lesson:** no regression test added in that PR. Test denied Gmail scope separately from revoked refresh token, quota 403, transient profile errors, and differently capitalized messages. Preserve drafts and unrelated accounts; give the broken connection an actionable reconnect state. Avoid using every 403 as evidence that credentials must be deleted.

#### A02 — Failed identity lookup and sessions with no accounts require explicit cleanup

**Merged historical; NOT an ancestor of S.** PR **#1963**, merged **2025-08-09**, commit `91c43496341c141ee213342e9df25a8589d83f8d`. Historical `apps/server/src/lib/auth.ts:91–127`, `connectionHandlerHook`, revokes/reset connections when provider identity lookup fails or returns no address. `apps/server/src/lib/server-utils.ts:521–552`, `getActiveConnection`, handles a session with no remaining account. The same PR's inbox listing recovery schedules forced resync behind a 30-second per-connection cooldown (`apps/server/src/trpc/routes/mail.ts`, block after historical line 153).

**Inference/limits:** a profile endpoint outage need not mean bad credentials; one historical revocation path can throw before reset. Empty after snooze filtering also triggers resync. No auth regression tests were added. Test missing address, deleted connection, revocation failure, truly empty inbox, all-snoozed inbox, and concurrent empty-list calls. Use bounded repair and retain recoverable editor state.

#### A03 — Expired Gmail history requires resumable reconciliation, followed by catch-up from a pre-enumeration baseline

**Current + tests; C.** `apps/server/src/routes/agent/index.ts:730–765,830–838`, history tick, captures `getMailboxHistoryId()` before enumeration, checkpoints each page, and queues verification for cached threads absent from the inventory. `apps/server/src/lib/driver/google.ts:151–173`, `getMailboxHistoryId`/`listMailboxThreadIds`, includes spam/trash and uses 500-thread pages. `apps/server/src/lib/mail-history-store.ts:402–436`, `beginSnapshot`/`snapshotPage`/`finishSnapshot`, persists the baseline, page token, and final-page sentinel.

**Tests:** `mail-history-store.test.ts:96–113` reconstructs the store mid-reconciliation and preserves newer signals. Gmail officially documents expired history as HTTP 404 requiring full sync ([provider guide](https://developers.google.com/workspace/gmail/api/guides/sync)). **Recommendation:** never delete solely because a thread was absent from a nontransactional paginated inventory; verify absence. Test new mail and moves during every enumeration boundary, crash after the last page, and expired/invalid page tokens. Storage tests do not prove the entire provider integration.

#### A04 — Cursor advancement, durable jobs, and notification revisions belong in the same transaction

**Current + tests; C.** `mail-history-store.ts:198–203,252–263,276–322`, `signal`, `commit`, `enqueue`, `acknowledgeJob`, stores a monotonically incremented request revision, applies work before committing cursor, and acknowledges jobs only by captured version. Integration: `routes/agent/index.ts:768–828` commits history changes and import jobs together.

**Tests:** `mail-history-store.test.ts:57–113` covers rollback of jobs and cursor, notification during sync, old completion after re-enqueue, restart. `:143–175` separates browser notification delivery from backfill jobs and preserves newer notifications after older acknowledgments. **Recommendation:** crash-inject between page fetch, transaction, body download, object-store write, and acknowledgment. A queue acknowledgment or advanced cursor must never mean “all bodies were fetched” unless durable work is already recorded.

#### A05 — Thread unread/star state cannot be taken only from the latest message

**Current + tests; C.** `mail-label-store.ts:147–205,267–291`, `setUnread`, `setThreadLabels`, `threadLabels`, applies message-level intent, skips drafts, and aggregates effective labels across the thread. `mail-count-store.test.ts:97–160` tests distinct-thread counts with label-scoped unread messages and pending changes.

**Tests:** `mail-label-store.test.ts:98–113,176–193` includes older unread messages, preserved pending intent, draft exclusion, and no-op writes. **Recommendation:** fixture a read latest message plus unread older message, messages in different labels, a draft-only thread, and mixed star state. Derive counts and row/context-menu state from the same effective model. Do not claim that every message in a thread has identical provider labels.

#### A06 — Independent per-label versions prevent a late acknowledgment from erasing a newer action

**Current + tests; C.** `mail-label-store.ts:157–205,488–552`, `setThreadLabels`, `pendingBatches`, `acknowledge`, stores one intent per message/label, coalesces repeated desired state, groups identical add/remove sets, and version-matches acknowledgment. Acknowledged writes remain delivered overlays until matching provider history or a fresh snapshot confirms them (`:372–405`).

**Tests:** `mail-label-store.test.ts:114–147,194–233,271–305,327–438` covers old ack/new toggle, reconstruction, rollback, matching confirmation, independent archive/star, repeated delivered intent, 1,000-message batches, and 100 add/remove-label limits. **Recommendation:** carry versions through retry, delivery, and UI settlement; test read→unread, star→unstar while archive is pending, and “HTTP success before history.” Idempotent label modification is safer to replay than send.

#### A07 — Trash/restore must model provider-implied label removals and newer user restores

**Current + tests; C.** `mail-label-store.test.ts:285–326` explicitly exercises spam-to-inbox restore racing older trash delivery/history and inbox restore before Gmail confirms its implicit inbox removal. `mail-cleanup-store.test.ts:34–138` protects newer restores, including real no-op restores, across long provider-wide cleanup discovery, retry, and reconstruction. `mail-label-policy.ts` is the shared label policy; `mail-cleanup-store.ts` maintains persisted discovery/target/move-order state.

**Recommendation:** treat trash/spam moves as complete provider state transitions, including loss of INBOX. Persist enumeration before mutating membership, and fence bulk cleanup against user moves made afterward. Tests should cover a restore that looks locally unchanged, rapid trash→restore, crash midway through discovery, and partial delivery. These are code/test observations; no bulk operation on a real mailbox was performed.

#### A08 — Tombstones and per-message history checkpoints stop stale body caches from resurrecting deletions

**Current + tests; C.** `mail-label-store.ts:107–143,409–450`, `importMessages`, `acceptHistory`, `deleteMessage`, compares history IDs numerically with `BigInt`, records deleted-message identity, cancels pending writes, and rejects stale imports. `routes/agent/index.ts:807–825,876–918` queues verification/import/cleanup and removes confirmed missing threads.

**Tests:** `mail-label-store.test.ts:207–251` checks numeric ordering, deleted-message resurrection, snapshot confirmation, and pruning after expired history. **Recommendation:** test partial thread deletion with a cached latest body, final-message deletion, history IDs beyond safe JavaScript integer range, object-store cleanup failure, and old snapshot completion after deletion. Distinguish attachment 404 from thread 404; missing one asset must not tombstone the parent thread.

#### A09 — Shared quota requires mailbox identity, project admission, foreground reserves, and crash-recoverable leases

**Current + tests; C.** `gmail-quota-store.ts:33–119,126–171`, `reserve`, `cooldown`, `prune`, atomically checks project/mailbox rolling-window usage and grants concurrency leases. Current defaults reserve 30% from backfill and 10% from live sync for higher-priority work; concurrent mailbox caps are 4/6/8 for backfill/sync/foreground, with two-minute lease expiry. These are source A's policy choices, not asserted provider requirements.

**Tests:** `gmail-quota-store.test.ts:33–105` tests shared budgets, denial without partial charging, minute-boundary bursts, foreground headroom, persisted cooldown, and lease expiry. `gmail-quota-client.test.ts:62–115` tests no network on denied admission and release on failure. **Recommendation:** key quota by normalized provider mailbox identity, not application user; ensure two app accounts linked to one mailbox share capacity. Keep token-refresh traffic separate from Gmail resource charges.

#### A10 — Retry classification must preserve Retry-After and avoid turning admission deferral into provider failure

**Current + tests; C.** `gmail-delivery-failure.ts:3–65`, `gmailDeliveryFailure`, unwraps errors, treats quota deferral separately, recognizes rate-limited 403/429, blocks revoked credentials/permanent requests, and takes the maximum of Retry-After and jittered exponential backoff. `gmail-quota-client.ts:40–69` scopes cooldown to mailbox when error wording denotes user concurrency, and always releases leases. `routes/agent/index.ts:839–850,920–929` does not increment provider attempts for local quota deferral; backfill pauses independently.

**Tests:** `gmail-delivery-failure.test.ts:7–48`; `mail-history-store.test.ts:45–56,114–141`. **Recommendation:** test numeric and date Retry-After, nested SDK wrappers, network/408/5xx, `invalid_grant`, repeated push during cooldown, and user-vs-project 403. Persist retry state so restart and notification storms cannot bypass a pause.

#### A11 — Push payload parsing and authenticated delivery are separate correctness boundaries

**Current + tests; C.** `gmail-push.ts:5–42`, `verifyGmailPushToken`, `gmailSubscriptionConnection`, `gmailNotification`, validates signature through remote keys, issuer/audience, verified service identity, project-prefixed connection subscription, and numeric history syntax. Wrapped/unwrapped payloads work; safe integer numbers normalize to strings, unsafe numbers are rejected.

**Tests:** `gmail-push-auth.test.ts:31–49` signs local test JWTs and rejects bad audience/email/signature; `gmail-push.test.ts:8–36` tests wrappers, project mismatch, malformed and numeric IDs. These tests do not exercise live remote key rotation or durable queue acknowledgment. **Recommendation:** authenticate before mailbox lookup; acknowledge only after durable admission, and return retryable failure on admission loss. Use occasional incremental recovery for missed/dropped pushes; Google documents watch renewal and possible notification loss ([push guide](https://developers.google.com/workspace/gmail/api/guides/push)).

#### A12 — Search cache identity must preserve opaque page tokens and query semantics, with invalidation fencing

**Current + tests; C.** `mail-search-store.ts:28–115`, `invalidate`/`read`/`fetch`, includes folder, original internal query whitespace/case, page size, canonical labels, and opaque token in cache identity. It stores membership/version/token only, coalesces requests by revision, fences older writes, uses 30-second TTL, and caps at 128 pages. `google.ts:83–104`, `listHistory`, follows all history pages with the original start cursor.

**Tests:** `mail-search-store.test.ts:44–155` covers persistence, exact token/query semantics, mailbox/page separation, invalidation races, errors, and bounded growth. **Recommendation:** do not lowercase quoted queries or parse/rebuild opaque tokens. Add actual multi-page history integration tests: storage-level tests alone do not prove every provider page is applied. A failed search must not become a cacheable empty success.

#### A13 — Folder counts must know whether local coverage is complete

**Current + tests; C.** `mail-count-store.ts:76–85,105–180`, `hasCompleteCoverage`/`readCounts`, requires cursor, no reconciliation, no outstanding jobs, and message-label coverage before local counts replace provider snapshots. Before that it retains complete provider totals, persists backoff, and rejects invalid/empty snapshots. Deferred refresh state prevents a browser invalidation from being consumed before refresh is due.

**Tests:** `mail-count-store.test.ts:52–94,146–279` covers restart, incomplete import, refresh throttling, invalid totals, catalogue rename/deletion, initial failure without false empty totals, and complete counts without provider calls. **Recommendation:** UI must distinguish partial import from an empty folder; retain last known good totals without presenting them as fresh. Test a new live thread arriving after complete counts, local pending moves, and history changes during snapshot TTL.

#### A14 — Draft/asset caching has different identities, size limits, and failure semantics

**Current + tests; C.** `mail-draft-store.ts:33–119` caches typed details for five seconds and list pages for ten, fences by revision/history, coalesces reads, caps 128 rows, and bypasses cache for >1 MiB UTF-8 serialized DTOs. `mail-asset-cache.ts:16–48` hashes mailbox + asset identity, caches legitimate empty bytes, and falls back to provider on object-store outage. `google.ts:109–128` keys attachment bytes by message/attachment IDs.

**Tests:** `mail-draft-store.test.ts:43–123`; `mail-asset-cache.test.ts:18–80`. **Recommendation:** edited provider drafts can replace underlying message identity even if draft ID stays stable. Never cache partial downloads or substitute old attachment bytes after edit. Test same attachment ID in two mailboxes, empty files, failed storage writes, multibyte oversized drafts, and slow pre-edit response arriving after save.

#### A15 — Send the canonical provider draft and the exact latest editor contents

**Merged historical, ancestor of S, plus current.** PR **#767**, merged **2025-04-25**, commit `791516565493b456806a6c9ca8327735b325bbd1`: historical `apps/mail/actions/send.ts:45–64`, `sendEmail`, passes draft ID to `sendDraft` instead of always creating another message; historical `apps/mail/app/api/driver/google.ts:835–854` adds provider drafts.send. No regression tests were added there.

At S, `driver/google.ts:692–708`, `sendDraft`, supplies current raw MIME and `threadId`. `driver/microsoft.ts:611–624` fills current draft content before send because autosave can lag. **Recommendation:** assert one sent message, consumed draft, exact latest body/recipients/attachments, preserved reply thread, and failure retaining recoverable draft. Explicitly model ambiguous acceptance; provider draft-send is not proof that arbitrary network retry is exactly-once.

#### A16 — Autosave identity and reactive navigation are both part of draft correctness

**Merged historical; both ancestors of S.** PR **#855**, merged **2025-05-07**, `aa8cb91a9b021f5cb635b6da520bfa8e6bd1e30f`, historical `apps/mail/components/create/email-composer.tsx:304–371`, retains draft ID so each save does not create a new draft. PR **#1203**, merged **2025-06-05**, `29c048af4a737b1a8525522f66412fd6c6d91b4e`, same file `:343–377` and `:107–111`, replaces local mirror/browser-history workaround with reactive query state, and removes a reply-composer loading gate that hid the editor during save.

**Tests/limits:** neither patch adds regression tests. Historical save functions cleared dirty state in `finally`; this is a historical risk, not a confirmed S defect. **Recommendation:** save-generation checks; late first ID response; typing during slow save; failure then retry; refresh/reopen; query navigation while saving; exactly one provider draft with no lost editor content.

#### A17 — Draft reads must prove editability and fail closed on missing attachments

**Current + tests; D.** `driver/imap.ts:955–997`, `getDraft`, now requires actual Drafts-folder location, returns From/thread/references, and optionally includes inline assets. `driver/microsoft.ts:732–739` checks `isDraft`. `driver/draft-providers.test.ts:148–174,176–245` rejects sent-message-as-draft, confines draft pagination to an HTTPS Graph drafts endpoint, parses nested Gmail multipart content, escapes plain-text HTML while retaining newlines, and rejects unreadable attachments. `driver/imap.test.ts:245–256` rejects an inbox message as editable draft.

**Recommendation:** “message exists” is insufficient authorization to edit as draft. Preserve original until complete read succeeds. Add tests for externally sent/deleted draft during hydration, inline CID assets, duplicate filenames, and cross-mailbox draft IDs; reject partial attachment hydration rather than silently resaving a smaller draft.

#### A18 — Reply-To, own-message follow-up, aliases, and Bcc need separate tests

**Current + tests; C/D.** `apps/mail/lib/reply.ts:79–139`, `buildReplyRecipients`/`pickFromAddress`, honors Reply-To; replies to own sent messages target original recipients; own aliases are removed case-insensitively; original Bcc is never inherited; From is selected from owned receiving identities. `reply.test.ts:43–115` covers quoted comma names, Reply-To, dedupe, own-message and note-to-self, and alias From.

**History:** merged **#1331**, **2025-06-17**, `71fcb892851c7294b7e591975204941125113dcf`, historical composer `:207–216`, changed reply-all only; single reply still used sender. Its title overstated coverage. **Recommendation:** independent single reply/reply-all matrices, multiple direct receiving aliases, explicit From choice retained across save/reopen/send, own sent mail, and privacy checks for blind recipients. Do not derive these rules from subject alone.

#### A19 — Browser reconnect must invalidate fresh caches and retire only settled optimistic overrides

**Current + tests; C.** `apps/mail/lib/mail-ui-sync.test.ts:90–185` exercises real optimistic manager, Jotai store, and query cache: old action completion cannot settle newer work; reconnect prunes retired read overrides but keeps pending actions; a one-hour-fresh active thread refetches after a missed socket event; thread/list archive and star membership reconcile together. `mail-cache-sync.test.ts` covers cache-update coordination.

**History:** merged **#1063**, **2025-05-25**, `11ea9fc8cccc4e6e474aa6ed158860cf05c8d5de`, historical `apps/mail/hooks/use-threads.ts:62–84`, invalidates detail by history version rather than stable ID; unknown→known versions were a guard gap. **Recommendation:** test focus, reconnect, restore from persisted cache, connection switching with overlapping IDs, late fetches, and old completion after a newer action. Cache staleness duration must not suppress explicit recovery.

#### A20 — Execution-platform budgets and successful empty pages must be modeled separately from provider failures

**Merged historical; neither an ancestor of S.** PR **#1941**, merged **2025-08-06**, `b9a5db50ae8924b25afa2685c21a292fe76c2548`, adds `apps/server/src/workflows/sync-threads-coordinator-workflow.ts:105–150`, `run`, creating one workflow per page to avoid execution request limits. Its prose claims fallback/one-second polling; actual diff comments fallback out and polls at five seconds for 60 attempts. Author notes limited local testing; no regression tests added.

PR **#1931**, merged **2025-08-05**, `a3068ee3edeb61d838a2eb79d2e740f793368a4f`, historical `routes/agent/index.ts:1190–1262`, `syncThreads`, returns empty threads on errors and only updates `hasMore` for nonempty results. **Historical inference:** legitimate empty success can loop without error sleep. **Recommendation:** discriminated failure/success types, terminal empty-page tests, durable page checkpoints, bounded retries, and >1,000-thread platform-budget fixtures.

#### A21 — Outlook batch success is not the same as success of each message operation

**Current code inference; not reproduced.** `driver/microsoft.ts:151–169`, `modifyMessageReadStatus`, sends all message patches in one raw `/$batch` call and ignores response entries. Label/folder mutation does the same at `:573–583`. No chunking to 20 or per-item status handling is visible in these functions. Microsoft documents a 20-request batch limit and independent response statuses ([Graph batching](https://learn.microsoft.com/en-us/graph/json-batching)).

**Recommendation/test:** 21 selected messages; overall HTTP 200 containing one 429, one 404 and remaining 200 responses; unordered response IDs; Retry-After per failed item; mixed permanent/transient failure. Settle only successful operations and retry only retryable failures. No targeted current regression test for this failure matrix was found in the inspected tests.

#### A22 — Returning an Outlook nextLink without consuming it makes the pagination contract incomplete

**Current code/inference.** `driver/microsoft.ts:272–359`, `list`, always builds the initial folder request; supplied `pageToken` only emits a warning, yet `nextPageToken` returns Graph's nextLink. Query search/order are commented out, and every listed message is hydrated through a full unbounded `Promise.all`. `:1459–1460`, `listHistory`, simply returns empty history with the original cursor. This driver does not implement Graph delta synchronization through that method.

Draft paging separately validates and follows its Graph nextLink (`:760–788`; regression in `draft-providers.test.ts:158–174`). **Recommendation:** implement and test provider-specific opaque cursors, large mailbox dedupe/end conditions, ordered stable pagination, filtered queries, bounded hydration, and folder delta/reconciliation. Do not infer Outlook parity from Gmail's functioning history path or from the presence of a subscription helper.

#### A23 — Graph replies need real reply/forward drafts, including migration of older standalone drafts

**Current; D.** `driver/microsoft.ts:585–639`, `sendDraft`, `sendAsReply`, `createReplyDraft`, checks whether an existing draft's `conversationId` matches the intended thread; otherwise creates a real provider reply/forward, fills it, sends it, and removes the replaced standalone draft. It uses `/createReply` or `/createForward` rather than fabricating conversation association. `:828–901`, `createDraft`, uses the same provider primitive for new reply drafts.

**Tests/limits:** `assistant.test.ts:837` asserts no fabricated cross-mailbox Outlook threading. Direct Graph threading behavior was not live-tested. **Recommendation:** legacy standalone reply draft, reply-to-old-message rather than latest, forward with CID images, failed fill after provider draft creation, and different sender mailbox. Preserve old draft until safe replacement, and do not treat inability to fetch existing draft as proof it was standalone without considering transient failure.

#### A24 — A failed Outlook draft update must not trigger destructive replacement

**Current + tests; D.** `driver/microsoft.ts:878–901`, `createDraft`, patches an existing draft and propagates failure before creating any replacement or syncing attachments. `driver/draft-providers.test.ts:130–145` injects patch failure and asserts no create/delete calls. `microsoft.ts:646–696`, `fillDraft`/attachment synchronization, preserves inline content selectively; normal attachments are matched by name because provider sizes can include encoding overhead.

**Inference/next tests:** name-only maps can conflate multiple attachments sharing a filename, and attachment sync can partially succeed after body patch. Test duplicate names/different bytes, a failed second upload, external draft edits between read/save, inline CID replacement, and >one attachment page. Current `getMessageAttachments` follows nextLink (`:78–115`), but that does not prove every attachment mutation enumerator does. Keep recovery state instead of presenting partial save as success.

#### A25 — IMAP identity is folder + UIDVALIDITY + UID, not UID alone

**Current + tests; C.** `imap/sync.ts:230–279`, `syncFolder`, compares UIDVALIDITY during STATUS/SELECT and rebuilds affected folder state. `imap/imap-store.ts:428–490`, `upsertMessage`, uses Message-ID where available; missing Message-ID fallback includes folder, UIDVALIDITY and UID. `sync.ts:284–343` applies QRESYNC VANISHED/changed flags, falls back to CONDSTORE CHANGEDSINCE or UID rescans, and does not advance highest modseq past incompletely fetched new mail.

**Tests:** `imap/sync.test.ts:103–136`; `imap/client.test.ts:111–140` selects with QRESYNC and parses vanished/changed/COPYUID. **Recommendation:** same UID reused after UIDVALIDITY reset, reset between STATUS and SELECT, NOMODSEQ, server lacking QRESYNC/CONDSTORE, missing UIDNEXT, and expunge during fetch. Store provider capabilities per live connection and never persist sequence numbers as stable identity.

#### A26 — Bounded IMAP backfill is a product limit, and capability fallbacks can leave old flags stale

**Current code + tests; C.** `imap/sync.ts:38–46,309–375` defaults to 90-day history, 2,000 messages/system folder, 500/user folder, 400 fetched headers/run, batches of 100; no-CONDSTORE flag rescan covers only 300 recent UIDs. Backfill is newest-first and persists cursor. One failed folder should not stop others (`:153–185`); disappeared LIST folders are forgotten (`:125–132`).

**Tests:** `imap/sync.test.ts:53–136,200` covers cross-folder backfill, run-budget resume, flags/deletions/reset, missing folder. **Inference:** old known messages outside the 300-UID flag window can retain stale flags on limited servers; “complete” means completion within configured retention, not full mailbox parity. UID searches/flag rescans are not counted by the fetched-header budget. **Recommendation:** expose retention scope, and add periodic bounded complete flag reconciliation plus large/search-response resource tests.

#### A27 — IMAP folders and keyword tags need separate mutation semantics

**Current + tests; C.** `imap/folders.ts:31–100,142–180`, `mapFolders`, prefers SPECIAL-USE over multilingual names, avoids virtual/nonselectable views, and treats INBOX case-insensitively. `driver/imap.ts:1153–1180`, `storeKeywordLabels`, applies tag keywords without moving mail, skips drafts, and reports refused keyword writes. `:1067–1108`, `moveLocations`, maps destination UID through COPYUID or searches Message-ID when UIDPLUS mapping is unavailable.

**Tests:** `imap/imap-store.test.ts:56–93`; `driver/imap.test.ts:301–379` covers tags versus folders, unsupported permanent keywords, and tags added by other clients. **Recommendation:** localized Sent/Drafts names, Unicode/nested paths, NIL delimiters, duplicate SPECIAL-USE folders, unsupported keywords, MOVE with/without COPYUID, and missing Message-ID. User-facing labels must not silently become folder creation or movement.

#### A28 — Cross-folder dedupe and out-of-order threading need stable logical identity, but Message-ID is imperfect

**Current + tests; C.** `imap/imap-store.ts:428–490,620–680`, `upsertMessage`/thread assignment, keeps logical messages separate from folder locations, links References/In-Reply-To, merges threads when parent arrives late, and transfers dirty/new-mail obligations to surviving thread. Reply-subject fallback uses a time window when headers are absent.

**Tests:** `imap/imap-store.test.ts:111–184` covers late parents, same Message-ID across folders, moves, subject fallback and last-location deletion. **Inference/limits:** broken senders can reuse Message-ID; pure ID dedupe can conflate distinct raw messages. Subject fallback can merge unrelated conversations. **Recommendation:** fixture same ID/different content, missing/invalid IDs, same subject/different participants, parent outside retention, and UI selection after merge. Preserve provenance and define collision handling instead of assuming internet headers are globally trustworthy.

#### A29 — IDLE must not monopolize the connection used for foreground actions

**Current + tests; C.** `imap/client.ts:649–747`, `idle`/`executeIdle`, holds the command queue until DONE and handles EXISTS/EXPUNGE/FETCH/VANISHED plus BYE, timeout and abort. `driver/imap.ts:345–389`, `waitForInboxChange`/`stopWatching`, uses a dedicated INBOX connection and closes it directly rather than queuing LOGOUT behind IDLE. Repeated initial EXISTS count alone does not trigger false new mail.

**Tests:** `driver/imap.test.ts:429–462` marks read successfully while IDLE is active, receives incoming mail, times out, aborts, and returns unsupported for a server lacking IDLE. **Recommendation:** reconnect after BYE, DONE races with an update, unsupported capability fallback, background suspension and listener shutdown. Only watching INBOX is not evidence of push coverage for every folder; keep bounded reconciliation for external folder changes.

#### A30 — SMTP wire correctness includes envelope privacy, dot-stuffing, TLS upgrade, and capability changes

**Current + tests; C.** `smtp/client.ts:62–99`, `prepareData`/`stripBccHeader`, normalizes CRLF, dot-stuffs, terminates DATA, and removes folded Bcc headers only from headers. `:153–202` requires advertised STARTTLS, re-EHLOs after upgrade, then authenticates with PLAIN/LOGIN/XOAUTH2. `driver/imap.ts:856–875` sends envelope recipients separately from the Bcc-free wire body.

**Tests:** `smtp/client.test.ts:63–109` covers STARTTLS/auth/wire framing, LOGIN fallback, auth errors, total RCPT rejection and folded Bcc; `driver/imap.test.ts:192–214` verifies hidden envelope recipient, no wire Bcc, threaded Sent copy. **Recommendation:** split multiline replies and DATA terminator across reads, lone CR/LF, UTF-8 envelope without SMTPUTF8, TLS failure before auth, server capability changes after upgrade, and explicit byte/body limits. These are fake-transport tests, not live compatibility certification.

#### A31 — Partial SMTP acceptance and ambiguous post-DATA failure need a richer send result

**Current code inference; not reproduced.** `smtp/client.ts:205–237`, `send`, accumulates RCPT rejections, sends DATA if any recipient is accepted, then returns `{accepted,rejected,reply}`. `driver/imap.ts:868–888`, `sendRaw`, discards that result and returns general success. A user can therefore receive no per-recipient failure information through this driver path. A new random Message-ID is generated per `sendRaw` invocation (`:813–815,856–865`), so manual/blind retry after ambiguous acceptance can create another message.

**Test gap:** inspected SMTP tests cover total rejection, not partial acceptance or connection loss after server accepts DATA. **Recommendation:** 1 accepted/1 permanent reject/1 temporary reject; disconnect before/after final 250; cancellation during DATA. Persist send-attempt identity and explicit accepted/rejected/unknown states; never resend accepted recipients indiscriminately. A stable Message-ID aids reconciliation but does not alone guarantee server deduplication.

#### A32 — Filing Sent and deleting a sent draft are post-delivery operations

**Current; C.** `driver/imap.ts:878–904`, `sendRaw`/`sendDraft`, uses `serverSavesSent` to avoid duplicate Sent copies; failed APPEND logs rather than reports send failure because SMTP already succeeded. Failure deleting sent draft is likewise logged. This preserves the crucial distinction between delivery and cleanup.

**Tests/limits:** `driver/imap.test.ts:192–214` proves happy-path Sent append/threading, not failure cleanup. **Recommendation:** durable reconciliation jobs for failed Sent APPEND/draft cleanup, plus user-visible “sent, copy pending” state if needed. Test provider auto-filing enabled/disabled, delayed auto-file arrival, failed APPEND after successful DATA, failed draft delete, and restart. Do not offer “send again” merely because filing a copy failed. Retrying filing must not rerun SMTP.

#### A33 — IMAP draft replacement should append before deletion; legacy expunge fallback can delete unrelated mail

**Current + tests/inference; C/D.** `driver/imap.ts:927–948`, `createDraft`, retains Message-ID/stable logical ID, APPENDs replacement before marking old Drafts locations deleted. `driver/imap.test.ts:217–242` asserts stable ID, one draft and v2 contents after update. `imap/client.ts:581–603`, `uidMove`/`uidExpunge`, falls back to COPY + Deleted + EXPUNGE; without UIDPLUS, plain EXPUNGE removes **every** already-Deleted message in the selected folder, not only targeted UIDs.

**Recommendation:** failure injection before APPEND, after APPEND before old delete, duplicate logical ID recovery, and concurrent external edits. For no-UIDPLUS servers, explicitly protect unrelated Deleted messages or defer broad expunge under a designed policy. Test preexisting Deleted mail during draft autosave, move and delete. The unrelated-expunge risk is directly visible code behavior; no live deletion or destructive test was run.

#### A34 — OAuth rotation must survive reconnect and persistence failure

**Current + tests; C.** `driver/imap.ts:222–241`, `accessToken`, refreshes before expiry, encrypts rotated refresh tokens with connection-associated data, updates current settings, and attempts persistence. IMAP/SMTP connect retry forced refresh on XOAUTH2 auth errors (`:258–302`). `driver/imap.test.ts:492–end` tests refresh and persisted rotation; `crypto/credentials.test.ts:7–40` tests AAD binding, key rotation and fresh IVs.

**Inference/test gap:** persistence callback failure is caught and only logged, leaving a newly rotated token in memory while storage can retain invalidated old credentials. **Recommendation:** durable rotation state/retry and explicit recoverability after process restart. Test simultaneous IMAP/SMTP token expiry, provider rotating refresh token, persistence outage, forced reauthorization, and connection ID changes. Never log token-bearing request data.

#### A35 — Recursive MIME and malformed optional headers require adversarial fixtures

**Merged historical + current tests.** PR **#940**, merged **2025-05-11**, `83d4ebffab8dc00572a0345b41914169d439469e` (ancestor of S), historical `driver/google.ts:1037–1066`, `findAttachments`, replaces shallow attachment extraction with recursion and handles `.eml`. **Historical inference:** a named message/rfc822 could be emitted twice by two branches; no tests added in that PR. Current nested-draft fixtures are in `driver/draft-providers.test.ts:176–245`; `imap/parser.test.ts:28–95` covers literal bytes, escaped mailbox names, response codes and modified UTF-7.

**Unmerged proposal:** PR **#2084**, created **2026-07-20**, closed with `merged_at:null`, adds a List-Unsubscribe invalid-URL guard and tests for `<here>`/prose and valid URL. Do not call that merged behavior. **Recommendation:** nested mixed/related/alternative MIME, forwarded `.eml`, no body, invalid charsets, CID references, duplicate attachments, huge literals and invalid optional header URLs. One malformed optional header must not make an entire message unreadable.

#### A36 — Undo and tracker closure are not evidence of exact recovery

**Merged historical outside S ancestry, unmerged proposal, and unresolved reports.** PR **#1947**, merged **2025-08-08**, `240024366a4af3779212c98fe871ca3ab9d12843`, historical `apps/mail/hooks/use-undo-send.ts:63–104`, restores serialized recipients/body/attachments after cancellation but reopens a fresh composer, losing original reply context. Open PR **#1980** (created **2025-08-11**, `merged_at:null`) proposes restoring thread/mode/active reply/draft identity. Neither supplies regression tests for exact restoration.

Issue **#1965** (2025-08-08 → 2025-08-15) reports missing hour-old Gmail mail; **#2030** (2025-09-23 → 2025-09-27) reports updates appearing only after refresh; **#2031** (same dates) reports reply From alias replaced with default address. All closed `not_planned`; inspected discussion gives stale closure, not linked verified fixes. **Recommendation:** use these as scenarios, not current defect claims. Test cancellation deadline races, every attachment byte, selected From, reply mode/thread, scroll/focus, storage quota failure, and concurrent compose tabs.

### Priority recommendations for the target client

1. **Durable state before acknowledgment:** transactional cursor/job/outbox updates; captured versions on all async completion; tombstones and incoming snapshot order checks (A03–A08).
2. **Explicit provider operation outcomes:** pending/delivered/confirmed/blocked/unknown, per-recipient SMTP and per-item Graph batches; preserve drafts and suppress blind resend (A10, A15–A17, A21, A24, A31–A34).
3. **Provider-specific identity and capabilities:** Gmail labels/history; Graph nextLink/conversation and delta behavior; IMAP UIDVALIDITY, folder locations, keywords, and server capability fallbacks (A05, A18, A22–A29).
4. **Recovery on the real UI:** missed events, cache restore, focus/reconnect, late autosave, explicit retry and exact undo; do not erase pending newer intent (A16–A19, A36).
5. **Bounded resource behavior:** shared request budgets and foreground headroom; resumable retention/backfill; bounded caches and MIME parsing; platform request-budget tests in addition to provider limits (A09–A14, A20, A26, A30, A35).

### Missing evidence and honest limits

- This snapshot **does implement IMAP and SMTP** with a driver, transport/parser, indexing/sync, discovery, OAuth, and fake-server tests. The separate closed-unmerged **#2086** scaffold proposal is not its provenance. No POP3 implementation was established.
- Graph `listHistory` is a stub at S; normal Outlook listing ignores nextLink input. A working subscription helper or a historical “provider added” PR does not prove complete sync/recovery parity. Closed-unmerged **#1996** Outlook repair proposal and **#1685** attachment optimization proposal were not treated as fixes.
- No suites, builds, dependencies, live mail providers, webhook delivery, TLS sockets, Cloudflare alarms, or deployment migrations were executed. Existing test assertions are evidence of intended guarded behavior, not proof that S passes them. Repository notes include live-validation narratives, but those were not independently reproduced and are not adopted as proof here.
- The large aggregate C commit prevents clean attribution of each present behavior to a separately reviewed fix. “Present in S,” “merged to some branch,” and “deployed” are deliberately distinct.
- Historical regression coverage is often absent. One merged action smoke suite (**#1922**, merged 2025-08-07, `68a1714ca16b190102cd0a382317b9651a01cdd4`; not ancestor of S) adds `packages/testing/e2e/mail-actions.spec.ts:1–75`, but clickability/menu checks with fixed waits do not prove rollback, persistence, push-race handling, or final provider state.
- Issue/PR title inventory was broad; deep review was selective. No exhaustive crosslink graph, full security audit, every-commit review, RFC conformance certification, multi-provider load test, or 50k-mailbox benchmark was performed. Reported failures were not reproduced. Findings labeled inference should become regression fixtures before being treated as defects in a different client.
- Official provider docs were checked for Gmail expired history/push and Graph batch semantics. Provider quotas, SDK retries, alias permissions, immutable Graph IDs, SMTPUTF8 behavior and server-specific quirks deserve further direct documentation/fixture review before implementation decisions.
- Anonymization removes direct source hyperlinks intentionally. Full hashes, dates, file/function/line references, tracker numbers, and the locally owned clone preserve traceability without naming the source.


## Appendix B: implementation and historical evidence


Research snapshot: 2026-10-26; retrieval began approximately 19:30 UTC and report verification finished 2026-10-26T19:41:21Z. Inspected default-branch SHA: `70a5a78416a092e05e6fd025d693924532d54bfc`; commit timestamp `2026-10-26T18:00:38+01:00` (17:00:38 UTC). Later remote work may exist. All unqualified file/line references below refer to this SHA. Paths are relative to the source B clone. References deliberately use anonymous B evidence IDs, commit hashes, paths, and issue/PR numbers; identifying source names, authors, remote URLs, and package namespaces are omitted.

### Method and evidence limits

- Cloned public source using `git clone --filter=blob:none <B-remote> source-b`. Obtained default branch plus remote branch history; checkout completed. No dependency installation, build, tests, or third-party application code execution. Git, read-only shell/Python text processing, and `gh api` were used solely for source/history/API inspection.
- Enumerated all issues and PRs through paginated `gh api '<B>/issues?state=all&per_page=100'`: **4,338 records: 268 issues, 4,070 PRs; 148 open records** at inventory time. Issue-list API includes PRs. Read the 100 most recently updated closed PR titles and open-issue titles, then filtered the full title inventory for provider, OAuth, sync, draft, attachment, reply, webhook, and quota topics.
- Main history contains **11,702 commits**; a case-insensitive provider/sync/draft/attachment title filter matched **1,238 commits**. Read the recent 230 matching titles across branches, 150 narrower main-history titles, and 65 targeted auth/history titles. Older auth fixes were deliberately included to counter recency bias.
- Drilled selected `git show`, PR metadata/files/patches, current implementation, and linked test files. A background read-only pass separately queried merged-PR searches for Graph/webhooks, draft/reply/attachments, and auth/token refresh, and relevant issue searches (up to 100 results per query). Findings below include precise regression fixtures where available.
- **Merged** means the cited fix is in inspected main history and/or API merge metadata verified it. **Current safeguard** means code/test behavior was inspected without claiming a production incident. **Unmerged** means the patch is not an ancestor of the snapshot. **Open report** means a user's claim, not independently reproduced. Recommendations are research-derived proposals, not claims about the target application's current implementation.
- One exploratory lazy fetch of an older Git blob failed with an HTTP/2 framing error. The checkout, current cited files, and cited patches were otherwise available through Git or the API; that incomplete multi-commit statistics request was not treated as proof of uninspected code.
- Tests were **read, never run**. Their existence is evidence of intended behavior, not proof they pass today. Not every issue comment or PR discussion was read; not every historical provider fix was examined. This is a broad inventory followed by purposive sampling, not an exhaustive audit.
- During the source B investigation, only public source/history and tracker data were inspected. No credentials, real mail, local user profiles, or target-project files were inspected or modified in that pass; the separate Terno comparison appears earlier in the assembled report. API authentication was used through existing tooling without reading or printing credential values.

### Highest-value implications

Prioritize: credential-generation checks; durable per-account recovery checkpoints; explicit ambiguous-send states; serialized draft mutations; complete enumeration before destructive operations; provider-native folder/category semantics; and poison-message isolation. These principles recur across independent fixes. A provider-neutral method signature is insufficient unless its observable semantics are tested for each provider.

### Auth and identity

#### B01 — Refresh success can overwrite newer credentials

**Merged fix:** PR #2495, commit `56a2e1a470999ce2f9c24b6246e8cc8561a1c40d`, 2026-05-04.

**Evidence:** `apps/web/utils/auth/save-tokens.ts:9–83`, `saveTokens`, preserves an existing refresh token when the refresh response omits it, and conditionally persists with the expected prior expiry. A zero-row update returns `status: conflict`. Millisecond-range matching appears at `:133–139`. Provider clients pass `expectedExpiresAt`. `apps/web/utils/auth.test.ts:256–360` includes “reports a conflict instead of overwriting newer email account tokens”; Gmail and Outlook client tests around `:149–180` validate propagation.

**Failure/scenario:** two requests refresh an expired account; a slower refresh finishes after a newer token set has already been saved. An unconditional update replaces valid newer state. Test stale expiry versus changed DB expiry, omitted refresh token, and concurrent waiters.

**Recommendation:** version credential writes and reload on conflict; treat rotated refresh credentials as shared state rather than per-request mutable cache. This implementation uses expiry as its concurrency guard; a dedicated generation would be clearer where equal expiries are possible.

#### B02 — Old auth failures must not disconnect a freshly reconnected mailbox

**Merged fix:** PR #3520, `d8fe93acf2770cae11f58cf0270dfd5e206fb869`, 2026-09-06.

**Evidence:** `apps/web/utils/auth/cleanup-invalid-tokens.ts:26–123`, `cleanupInvalidTokens`, compares failed access/refresh token snapshots with current credentials (`:81–90`) and conditionally clears with `updatedAt` and disconnected state (`:97–123`). Provider wrappers capture the failing credential before invoking async operations (`apps/web/utils/email/provider.ts:93–104`). Tests `cleanup-invalid-tokens.test.ts:47–82` cover reconnected credentials and absent snapshots; provider/client/watch tests were changed by this commit.

**Scenario:** user reconnects while an old request is in flight; that request later returns invalid-grant. Fresh credentials must remain connected. A second race between loading the row and cleanup must also preserve the reconnect.

**Recommendation:** carry credential-generation evidence into failure handling. Do not let an old 401 or invalid-grant delete whichever token happens to be current.

#### B03 — Reconnect must be bound to the intended mailbox

**Merged fix:** PR #3708, `8988e25bfdb75727193940a9e87e2dadef7f2554`, 2026-09-15.

**Evidence:** `apps/web/utils/oauth/reconnect-target.ts:1–36`, `findReconnectTarget`/`isReconnectTargetMismatch`; Google and Outlook `linking/auth-url/route.ts` and callbacks. The change carries the target mailbox in signed state, sends a login hint, checks user/provider ownership, and rejects a callback for another identity before account creation/merge. `reconnect-target.test.ts` and Outlook callback tests contain regression cases.

**Scenario:** reconnect mailbox A while the provider browser session is logged into B. Previously this silently added B instead of fixing A.

**Recommendation:** distinguish add-account from reconnect-account in state and UI, cryptographically bind reconnect to its target, and give a recovery message for an identity mismatch. A login hint is a convenience, not validation.

#### B04 — Library updates can silently change provider identity keys

**Merged fix:** PR #3704, `cb6c742fc3b98232bbb375ecb16bab5b1e692dfa`, 2026-09-15.

**Evidence:** `apps/web/utils/auth/microsoft-account-subject.ts:9–55`, `reconcileMicrosoftAccountSubject`; legacy Microsoft rows keyed by OIDC `sub` are reconciled to Entra `oid` before lookup. The auth library had changed its identifier from `sub` to `oid`; existing users fell through to email matching and got account-not-linked. The callback derives the same key, retaining legacy subject/Graph ID fallbacks. Tests: `microsoft-account-subject.test.ts`, callback tests, and provider-account-subject assertions introduced with #3708.

**Scenario:** upgrade the auth dependency with existing Microsoft accounts; sign-in and reconnect must reuse their mailbox rather than fail or duplicate it. Also test a conflicting preexisting `oid` row.

**Recommendation:** own and test identity-key derivation across dependency upgrades; plan key migrations as data migrations. Do not substitute email as a universal provider identity.

#### B05 — Verified email renames require provider-specific authority and ownership checks

**Merged fix:** PR #3663, `1650aeabbb46db6164dc28e27e3afaf9d3ad0aee`, 2026-09-11.

**Evidence:** `apps/web/utils/auth/rename-email.ts:37–110`, `renameGoogleEmail`: stable subject must match; email must be verified and belong to Gmail or a hosted domain (`:58–65`). Comments explicitly reject treating Google-verified third-party addresses or Microsoft profile emails as equivalent identity proofs. Primary versus secondary mailbox behavior and cross-user conflicts are checked before a transaction. `rename-email.test.ts:129–150` covers secondary mailbox preservation and conflicts; `apps/web/__tests__/db/email-rename.test.ts` covers DB behavior.

**Scenario:** Workspace administrator renames a mailbox; reconnect should retain rules/history/account identity. Renaming a secondary mailbox must not change the user's primary login; an address already owned by another user must not be taken.

**Recommendation:** separate stable account ID, current address, aliases, and login identity. Make address updates transactional and conditional on the previous mailbox ownership.

### Sync cursors, ordering, and replay

#### B06 — Concurrent Gmail webhook processors can move the history cursor backward

**Merged fix:** PR #1292, `5a289562c5336d5401c9079f1b657f1f72e6dafa`, 2026-01-16.

**Evidence:** current `apps/web/utils/webhook/google/process-history.ts:365–390`, `updateLastSyncedHistoryId`, uses a conditional SQL update only when the incoming history ID is greater. It compares with `NUMERIC`, not signed `BIGINT`: Gmail's unsigned 64-bit range exceeds signed 64-bit. The original commit explains duplicate rule execution from slower processors overwriting progress; its test update mocks the raw conditional update. A dedicated concurrency integration test was not established in this sample.

**Scenario:** processor H200 completes before slower H100; saved progress must stay H200. Include history IDs above signed 64-bit maximum and equal IDs. IDs are represented as strings/BigInt during normalization (`:552–566`).

**Recommendation:** monotonic cursor updates plus idempotent actions; never compare decimal IDs lexicographically or route large IDs through unsafe JavaScript numbers. Monotonicity alone does not guarantee all effects below a cursor have completed.

#### B07 — Failed deduplication locks can turn recoverable failures into permanent skips

**Merged fix:** PR #4268, `dfb122fbb8799cdf30c0078e8196be95cf7f01bf`, 2026-10-20.

**Evidence:** `apps/web/utils/redis/message-processing.ts:12–38`, `withMessageProcessingLock`, releases its owned lock on failure, preserves the original exception if cleanup fails, and retains successful locks for deduplication. Prior failures kept the five-minute lock, so catch-up skipped the same message and could advance beyond it. `message-processing.test.ts:26,45,66,80` covers failure/replacement owner/success dedupe/concurrency; Gmail and Outlook integration fixtures were also changed.

**Scenario:** acquire message lock, encounter provider throttling, immediately replay, then replay again after success. Processing should run for the first failed attempt and successful retry, but not the third delivery. Cleanup must not remove another worker's replacement lock.

**Recommendation:** separate in-progress ownership from completed-message dedupe. Failed processing must remain eligible for replay before checkpoint advancement.

#### B08 — Throttled Outlook webhooks require a remembered catch-up window

**Merged fix:** PR #4040, `98a5c2f957c795ee1c6d32b02c07146102c3c66d`, 2026-10-07.

**Evidence:** `apps/web/utils/outlook/rate-limit-catch-up.ts:9–67`, `catchUpAfterOutlookRateLimit`, replays from five minutes before the skipped window, with a 100-message cap. `apps/web/utils/redis/outlook-rate-limit-catch-up.ts:7–18,53–70` atomically preserves the earliest timestamp and claims it using GETDEL; expiry is 24 hours. `outlook/rate-limit-catch-up.test.ts:33,41,62,77,93` covers another throttle before/during recovery, no mark, success, and unrelated failures.

**Scenario:** notifications are acknowledged/skipped during a cooldown; later processing must recover messages from before its end, even when new skips race with recovery.

**Limits/inference:** this code's recovery is bounded and triggered by later notifications; it is not evidence of lossless catch-up for a quiet mailbox or >100 skipped messages. Non-rate-limit failures are logged without restoring the claimed mark (`:52–66`).

**Recommendation:** durable catch-up jobs with progress/completion state; test a silent mailbox, 101+ missed messages, 24-hour expiry, and unrelated errors after GETDEL.

#### B09 — Catch-up markers themselves need concurrency ownership

**Merged fix:** PR #3957, `7e03256901651f81c8d9c2bdc865cc440d424a18`, 2026-10-02.

**Evidence:** `apps/web/utils/redis/gmail-history-catch-up.ts:15–29,49–64` creates a new token for each mark and clears only the owned token. `apps/web/utils/webhook/google/process-history.ts:155–167` chooses a wider history gap when this mark exists; processing saves progress per history entry (`:349–360`). Follow-up processing tests also address quota-consuming scans.

**Scenario:** catch-up reads marker A; another notification is skipped and writes B; completion of A must not clear B. A function timeout after several history entries should retain saved progress.

**Limits:** markers expire after 24 hours; wider bounded windows and progress checkpoints are not an unlimited recovery log.

**Recommendation:** use compare-and-delete ownership or durable generation IDs for recovery requests, and checkpoint at recoverable work boundaries.

#### B10 — Bootstrap and incremental cursors must represent different phases

**Merged fix:** PR #4264, `3be202232e2bf49251146736b6fae78ea5b2d616`, 2026-10-22.

**Evidence:** `apps/web/utils/mail-api/source.ts:451–466,675–692`, `catchUpCheckpoint`/`toGmailDeltaCursor`. Asking Gmail for a one-message sync page yielded a snapshot continuation, so post-bootstrap catch-up re-listed and hydrated the entire mailbox before showing changes. The fix converts that checkpoint to a delta cursor at the same pre-listing history ID, dropping the listing page token. `source.test.ts:784–830` constructs a snapshot with page-2 and asserts a delta cursor without pageToken.

**Scenario:** bootstrap a mailbox with more than one message while mail/read/archive events arrive; first catch-up must read history from the initial watermark without replaying the whole snapshot.

**Recommendation:** make snapshot/delta phases explicit. Do not apply Gmail's conversion to Outlook: Graph must finish the first delta enumeration to obtain a deltaLink.

#### B11 — One history record can exceed a whole application sync-page budget

**Unmerged branch evidence, not a shipped fix:** `84ab112571a6088ba1a5077aa19395ee24426262`, 2026-10-22; confirmed **not an ancestor** of inspected main. No merged PR number verified.

**Evidence:** its diff to `apps/web/utils/gmail/mailbox-sync.ts` adds message-level page positions and a fixed `untilHistoryId` while repeatedly reading a provider history page. Current main `mailbox-sync.ts:64–81` collects all IDs from returned records and hydrates them without this slicing. Proposed regression in the branch's `mailbox-sync.test.ts` adds five IDs in one label-removal record with application limit=2; a later deletion/addition must not shift the remaining slice. Three responses deliver all five IDs and end at history 200.

**Scenario:** a Gmail bulk label operation puts thousands of message changes into very few history records. Provider maxResults bounds records, not the number of messages those records name; the response can repeatedly exceed downstream limits.

**Recommendation:** budget actual expanded work, persist intra-page progress, and freeze the logical page boundary while slicing. This is a concrete test candidate; do not represent the proposed implementation as currently deployed behavior.

#### B12 — Expired history, archive, and deletion are different states

**Current safeguard:** `apps/web/utils/gmail/mailbox-sync.ts:13–20,94–122,126–166`. Tests `mailbox-sync.test.ts:218,261,309,329`.

**Evidence:** incremental requests include label additions/removals as well as message additions/deletions. Archive is an INBOX-label removal, not message deletion. History 404 rebuilds from a snapshot; while paging, the original startHistoryId is preserved until the final page. Changed IDs are deduplicated; deletion wins within a page; summary message IDs are read when typed arrays are missing.

**Scenario:** archive in another client, mark read, delete during a paged delta, or resume from an expired cursor. Archived mail must remain in all-mail; read/star metadata must update; an expired history cursor must not be treated as an empty successful delta.

**Recommendation:** test each semantic separately and preserve cursor validity. Official [Gmail synchronization guidance](https://developers.google.com/workspace/gmail/api/guides/sync) confirms history expiry can vary and a stale history ID returns 404 requiring full sync.

#### B13 — An omitted batch result is not evidence of deletion

**Current safeguard introduced by merged PR #3748:** `9f4c72b134557b1c4ebd5211da9a9b00079e4f78`, 2026-09-17.

**Evidence:** `apps/web/utils/gmail/sync-messages.ts:12–54`, `getGmailSyncMessages`, serializes batches of 100 unique IDs, validates returned IDs, individually fetches missing batch entries, and treats only confirmed 404 as deletion. `sync-messages.test.ts:11,35,49` tests dedupe/serialization, foreign IDs, and throttle propagation. `mailbox-sync.test.ts:69,95` tests confirmed deletion versus successful recovery of omitted items.

**Scenario:** a partial batch silently omits one throttled request. The client must not delete that message or advance beyond an unrecovered provider error.

**Recommendation:** retain per-item status and verify absence. Validate IDs before writing a batch into account-scoped local storage.

#### B14 — Repeated resync requests can create an idle CPU/network loop

**Merged fix:** PR #3895, `fb37a30de281d05bfcfbea93f9aedfe5c0045a2c`, 2026-09-27.

**Evidence:** `packages/mail-core/src/engine.ts:1100–1140,1200–1250`, resync/idle gating and `resumesBootstrap`. Previously resync cleared the once-per-minute gate, restarting bootstrap several times a second. The engine now resumes stored scans and sets the idle gate for repeated resyncs. `packages/mail-sqlite/src/engine-bootstrap.test.ts:440,473,524` tests repeated requests, multi-run completion without idle delay, and process-restart resume.

**Scenario:** provider repeatedly rejects a checkpoint; large bootstrap spans several time slices; process restarts halfway. Avoid both hot loops and a bootstrap that never resumes.

**Recommendation:** distinguish a new invalidation from active recovery, persist recovery progress, and test resource behavior over repeated idle runs.

### Pagination, folders, and concurrent mutations

#### B15 — Mutating an offset-paged inbox skips every other page

**Merged fix:** PR #4263, `f392d95bc067dfaa9fba7b468920aea97d7ed1b9`, 2026-10-22.

**Evidence:** `apps/web/utils/outlook/batch.ts:380–403,486–546`, `moveMessagesForSenders`/`listSenderMessages`, first enumerates IDs and then mutates. The previous loop archived a page then followed a $skip offset into a result set it had just shrunk. It now deduplicates IDs and detects repeated links. A qualification remains: continueOnError defaults to true, so a later listing failure can return the collected prefix for mutation. Complete-enumeration failure semantics require continueOnError=false. `batch.test.ts:236` models 250 inbox messages with page size 100; all 250 must be moved. `:254` asserts no mutation when the initial listing fails with stop-on-error; it does not establish the later-page case.

**Scenario:** archive/delete all mail from a sender whose messages span multiple pages. Add a fixture with a successful first page and failed second page under both continueOnError modes: either no mutations, or an explicitly reported partial target set. This later-page failure fixture is a recommendation, not the cited existing test.

**Recommendation:** snapshot the work set before destructive changes, or use a provider-supported stable enumeration. For very large mailboxes, spool IDs rather than copying this implementation's whole-result in-memory collection uncritically.

#### B16 — Thread actions must enumerate the entire conversation before writing

**Merged fix:** PR #4265, `4bffc4db4b0a8d8870abc1db17192dd09c4c6d35`, 2026-10-22.

**Evidence:** `apps/web/utils/outlook/thread-helpers.ts:8–10,37–94`, `listThreadMessages`, follows continuation pages with ID dedupe, caps pagination, and completes enumeration first. `OutlookThreadPaginationError` (`:12–35`) prevents a later-page error from being mistaken for unsupported-filter fallback that mutates only a prefix. `runThreadMessageMutation` uses concurrency=3 (`:96–118`). `label.test.ts:120,142,163,182,200,239` covers paged archive, no partial archive after list failure, read, label, unarchive, and restore-from-trash.

**Scenario:** a long conversation exceeds Graph's first page; later page errors, repeats a link, or contains duplicate IDs. Every message must be updated or the operation must expose failure accurately.

**Recommendation:** define thread completeness for destructive actions; do not reuse a preview-oriented first-page fetch. Preserve provider error codes in wrappers so throttle logic still works.

#### B17 — All-mail must include custom folders and exclude deleted-folder descendants

**Merged fix:** PR #4244, `f4c702732c66c23e1aaff0db92eeb9d0e1971ffd`, 2026-10-20.

**Evidence:** `apps/web/utils/email/microsoft.ts:2011–2144` searches the whole mailbox and filters unwanted parent folders locally. `getJunkAndDeletedFolderIds` (`:2844–2871`) includes descendants. Deleted Outlook folders move beneath Deleted Items while their messages retain the child folder's ID; excluding only the root misses them. `__tests__/integration/outlook-mail-view-parity.test.ts` and `email/microsoft.test.ts` add custom-folder/deleted-subfolder cases.

**Scenario:** move a sender's mail to a user folder, then search/delete all sender mail. Delete an entire folder afterward; its messages should not appear in all-mail.

**Limit:** descendant-listing failures are logged and filtering can be incomplete (`:2866–2868`).

**Recommendation:** treat folder hierarchy as provider data, not a hardcoded Inbox+Archive pair. Make incomplete hierarchy recovery visible to synchronization logic.

#### B18 — Outlook categories are not folders

**Merged fix:** PR #4219, `87d1c42128d7d154af61489214d6fe8305963812`, 2026-10-19.

**Evidence:** `apps/web/app/(app)/[emailAccountId]/mail/LabelPickerDialog.tsx:52–91,99–120` selects actual Outlook folders for Move, displays hierarchical paths, and submits `kind: move, folderId`. Categories remain labels. `LabelPickerDialog.test.tsx` adds 161 lines exercising this behavior; `apps/web/utils/mail-api/operations.ts` was updated.

**Scenario:** user chooses Move to a custom folder. Applying a category may decorate the message while leaving it in Inbox, violating the apparent action.

**Recommendation:** keep move versus tag distinct in the domain model and provider adapter. Preserve stable folder/category IDs and provider-specific UI affordances.

#### B19 — Category read-modify-write needs ETags and fresh recomputation

**Merged fix:** PR #4032, `1262e000a6f8bb3cb9b681863a64cdccc4a1f2eb`, 2026-10-06; related report #3899 opened 2026-09-27 and closed 2026-10-19.

**Evidence:** `apps/web/utils/outlook/label.ts:245–298`, `updateMessageCategories`, reads current categories and ETag, sends If-Match, and re-reads/recomputes on conflicts, at most three attempts. Unchanged categories require no write. `label.test.ts:278,312,327` covers concurrent changes, no-op, and unrelated errors.

**Scenario:** another client adds B after this client reads A but before adding C. The result must retain A/B/C. Retrying the old PATCH would lose B or repeatedly conflict.

**Recommendation:** retry the transaction around the new provider state, not the stale request body. Bound retries and preserve unrelated categories.

#### B20 — Bulk success is per item, not the batch HTTP status

**Current behavior with regression tests:** `apps/web/utils/outlook/batch.ts:13–18,72–105,406–456`. `batch.test.ts:132,182,287,324` tests successful moves before partial failure, small write batches, thread-level results, and stopping after rate-limit responses.

**Evidence:** JSON batch cap is 20 while move concurrency is restricted to 4; bookkeeping only includes successful message IDs. A whole batch response can contain failed subrequests. This matters when users retry a bulk action after partial success.

**Scenario:** Graph returns HTTP 200 with a mix of 201 and 429 subresponses. Preserve successful moves, stop issuing more work when appropriate, and retry only recoverable failed IDs.

**Recommendation:** expose partial outcomes and exact retry sets; do not infer all-success from the outer status. Official [Graph throttling guidance](https://learn.microsoft.com/en-us/graph/throttling) explicitly documents per-request throttling inside successful batch responses and lack of automatic SDK retries for those subrequests.

### Sends, drafts, attachments, and UI recovery

#### B21 — Send acceptance must be independent of sent-copy readability

**Merged fix:** PR #4076, `ab0d9e8eda03166217479f2dc1ee7177306d29e7`, 2026-10-08.

**Evidence:** `apps/web/utils/outlook/draft.ts:70–110`, `sendDraft`, obtains conversationId before POST /send and returns known IDs afterward. Old code sent first and then GET failed during the move to Sent Items. `draft-send.test.ts:1–100` tests later 404/403/read errors, a rejected 503 with exactly one send, and missing metadata preventing send.

**Scenario:** send is accepted but the immediate follow-up read fails. A failure UI encouraging resend can duplicate delivered mail.

**Recommendation:** split accepted/delivered/confirmed/enriched states. Optional metadata must not turn an accepted send into a send failure. Official [Outlook immutable-ID guidance](https://learn.microsoft.com/en-us/graph/outlook-immutable-id) confirms the sent copy may not be readable immediately and documents header requirements for stable IDs.

#### B22 — Retry policies for sends must differ from reads

**Current safeguard; shared retry refactor:** PR #3922, `a8f96364bbdfef402d2b6500ac4b6c8c49e632af`, 2026-09-30.

**Evidence:** `apps/web/utils/gmail/retry.ts:38–49`, `withGmailNonIdempotentWriteRetry`, uses rate-limit-only policy. General reads retry transient server/network failures; ambiguous writes do not. `gmail/retry.test.ts:329–365` verifies explicit throttle rejection is retried while ambiguous failures are not. `utils/retry/provider-retry.ts` centralizes policy and blocking-delay caps.

**Scenario:** server accepted a send but connection drops before the response; a generic retry helper repeats the send. In contrast, explicit provider throttling is evidence the attempt was rejected and can be retried under this policy.

**Recommendation:** classify operations by idempotency/ambiguity and retain an explicit unknown outcome requiring reconciliation. A single universal retry helper is unsafe for mail submission.

#### B23 — Missing contentBytes is not an empty attachment

**Merged fix:** PR #4081, `361729317eb9eb99c80273acb46f9e68a077d13c`, 2026-10-08.

**Evidence:** `apps/web/utils/outlook/attachment.ts:5–39`, `getOutlookAttachment`, falls back to authenticated /$value streaming when contentBytes is missing and metadata is not explicitly zero-length. Stream handling at `:41–67` checks response success, body, abort, and cancellation. `attachment.test.ts:1–113` covers existing data, genuine empty files, binary bytes, and raw-download failures.

**Scenario:** metadata fetch succeeds but lacks embedded content; previously downstream code could deliver an empty file despite a non-empty attachment.

**Recommendation:** represent metadata-fetch success and content-fetch success separately; absence of inline bytes must not be normalized to empty successful content.

#### B24 — Attachment metadata size is not always the raw-byte size

**Merged fix:** same PR #4081 and commit as B23.

**Evidence:** `outlook/attachment.ts:22–34` says Graph size includes metadata; final code permits raw bytes smaller than that size, rejecting known-size empty or oversized content. `attachment.test.ts` accepts **34,877 downloaded bytes versus metadata size 35,137** and returns actual downloaded size. Earlier PR wording described exact-size checks; the final patch/tests supersede that description.

**Scenario:** valid attachment is rejected by a checksum-like metadata equality check.

**Recommendation:** use provider-specific size semantics and actual byte counts. Do not infer a general integrity checksum from metadata.size; test empty, too large, smaller valid, and unknown-size cases.

#### B25 — Server-local attachment staging fails across application instances

**Merged fix:** PR #4094, `3cf6e3b678b967c53b6250afff768ca8936b840a`, 2026-10-09.

**Evidence:** attachment state moves onto provider drafts, and send uses that draft. `apps/web/utils/outlook/draft-attachments.ts:49–114` supports direct small files and upload sessions for large files; deletion at `:116–141` treats already-missing files idempotently. `__tests__/integration/draft-attachments.test.ts:45,159` covers provider operations. `__tests__/playwright/emulated/mail/compose-attachment-send.spec.ts:21,35,119–120` sends small/large attachments and compares Sent-file bytes.

**Scenario:** upload request lands on server A; send runs on B with no staged file. Also reopen a composer after reload before sending.

**Recommendation:** persist attachment ownership with the durable draft or another durable, account-scoped store; verify the exact bytes of the sent attachment, not only the UI chip.

#### B26 — Gmail draft replacement makes concurrent autosave and upload destructive

**Merged fix:** PR #4094, commit as B25.

**Evidence:** `apps/web/app/(app)/[emailAccountId]/compose/draft-operation-queue.ts:1–26` serializes operations per compose session, including queued work after component closure. Its comment identifies Gmail whole-message replacement overwriting an attachment uploaded concurrently with autosave.

**Scenario:** upload starts; user types; autosave runs; component closes; send/reopen later. Both latest body and uploaded files must survive, including replacement message IDs.

**Recommendation:** serialize all mutations of a provider draft, not separate text and attachment queues. Maintain stable logical compose-session identity despite provider message replacement.

#### B27 — Missing drafts are terminal autosave state

**Merged fix:** PR #4092, `fe55fc671b62685c1591178cdb92e9b243387ab0`, merged 2026-10-09 (commit history displays 2026-10-08 in author-local date).

**Evidence:** typed DraftNotFoundError reaches an action-level missing status; already-missing discard succeeds. `apps/web/hooks/useProviderDraftAutosave.ts:24–29,79–133,140–143` halts after terminal missing-draft errors; normal resume does not clear halted. `useProviderDraftAutosave.test.ts` around `:135` advances 12 seconds after edits/resume and expects exactly one save attempt.

**Scenario:** another client sends/deletes the draft while this composer remains open. Repeated autosaves must not spin indefinitely or resurrect the old draft silently.

**Recommendation:** explicitly distinguish transient failure, missing, replaced, and sent states. Preserve recoverable local text and provide a deliberate new-draft/recovery path.

#### B28 — Empty arrays and omitted recipient fields have different semantics

**Merged fix:** PR #4123, `98ef3cd43d0a4f40aaad00ccd6f0b5e24938e20c`, merged 2026-10-10.

**Evidence:** `apps/web/utils/email/microsoft.ts:717–790`, especially `:730–741`, omits empty initial To/Cc/Bcc when creating replies so Graph createReply's recipients survive the subsequent content PATCH. `microsoft.test.ts:2482` checks recipient fields are absent when initially empty.

**Scenario:** create an inline reply before the UI has supplied recipients; patching To=[] erased the provider's valid inferred recipient.

**Recommendation:** model field omission separately from intentional clearing throughout draft APIs. Tests should distinguish create defaults from later explicit edits, including Cc/Bcc.

#### B29 — Reply identity must follow the destination alias, including its signature

**Merged fix:** PR #4135, `d4a3e82523965628b601cef1e0f1307b027b61a4`, 2026-10-13; browser follow-up PR #4138.

**Evidence:** `apps/web/utils/email/send-as.ts:16–32`, `findReplySendAsAddress`, matches recipient candidates against the user's send-as addresses, case-insensitively, then defaults. Formatter quotes display names safely. `send-as.test.ts:14,23,32,43` covers alias selection, first-match precedence, fallback, and comma-containing names. Provider/composer changes preserve sender through draft creation/restoration and switch alias signature without discarding message body. Integration/e2e follow-ups #4138/#4140 cover aliases and image signatures.

**Scenario:** support@ alias receives mail, but reply silently goes from personal@; switching aliases duplicates a signature or erases typed text.

**Recommendation:** store chosen From as draft state; filter to provider-authorized identities, resolve replies deliberately, and keep signature replacement independent from editable message content.

#### B30 — Provider autosave echoes must not replace the live composer

**Merged fix:** PR #4220, `d7c4afa9b3f0cb387be3fd3200a00b894e7f0d5a`, 2026-10-19.

**Evidence:** `apps/web/components/email-list/EmailMessage.tsx:192–202` introduces a retained new-reply-open state so a synced copy of the new draft does not replace the editor mid-sentence. `apps/web/hooks/useReplyDrafts.ts:25–43` keeps previous data and suppresses spurious loading when message IDs change. Component/hook tests add autosave-echo and loading regressions; emulated mail inspection tests were updated.

**Scenario:** type while the first autosave syncs back into the conversation, or while another message joins the thread. Body, focus, selection, and open compose session must survive.

**Recommendation:** render by stable logical edit-session identity; provider drafts and local editors are two observations of the same session, not competing UI rows.

### Parsing, automation, and operational failures

#### B31 — MIME alternatives and sequential parts must be handled differently

**Merged fix:** PR #4027, `b12ad92832fbf23dab6f6516a525d5339ff229f7`, 2026-10-06.

**Evidence:** `apps/web/utils/gmail/message-bodies.ts:18–103`, `gmailMessageBodies`/`collect`/`preferAlternative`, joins sequential mixed parts while selecting formats within alternatives. The prior parser retained only the last text part; Apple Mail can split text around an inline image and end with a signature-only HTML part. It also falls back from signature-only HTML to complete plaintext. `message-bodies.test.ts:24–211` covers split text/image/signature, plaintext alternatives, signature padding/entities, normal formatting/links/quotes, and exclusion of attached text or message/rfc822 content.

**Scenario:** list snippet contains the real message but reader displays only “Sent from my iPhone”; alternatively an attached .eml leaks into the main body.

**Recommendation:** parse the MIME tree semantically; preserve alternative-vs-sequential structure and keep attached messages separate. Avoid a blanket HTML-preferred rule when the formats have unequal content.

#### B32 — Malformed mail and oversized metadata can wedge a whole account

**Merged fix:** PR #4200, `d74fb23ca4ddfbafc4d54b7f659f9cc8929fbd92`, 2026-10-18; related current protocol guards.

**Evidence:** `apps/web/utils/mail-api/observations.ts:130–165,168–224` clamps descriptive metadata, bounds recipients, preserves a trailing mailbox when shortening an oversized display name, and skips observations that still violate protocol limits. Attachment IDs are not truncated; unrepresentable IDs are omitted. Oversized Content-ID is nulled rather than replaced by a filename. `observations.test.ts:112,132,151,269,330` exercises these cases. B31 also adds a one-megabyte malformed-tag timing test (`message-bodies.test.ts` around `:160–180`) and a non-CI benchmark.

**Scenario:** one sender supplies a huge filename, MIME type, Content-ID, recipient list, or invalid provider ID. Retrying the identical unrepresentable page forever blocks unrelated mail.

**Recommendation:** validate/bound data before durable ingestion, isolate poison records, preserve authoritative retrieval IDs, and instrument skipped records with bounded metadata. Tests should assert account progress, not merely rejected input.

#### B33 — One unreadable Graph item can poison a whole continuation page

**Merged fix:** PR #4353, `70a5a78416a092e05e6fd025d693924532d54bfc`, 2026-10-26.

**Evidence:** `apps/web/utils/outlook/message.ts:1340–1399`, `getContinuationPage`, recovers supported 404 offset pages using single-message reads, skips unreadable items, and advances past the original page. Recovery is bounded at 20 items. Search, skiptoken, and oversized-page cases keep the original failure behavior; an entirely unreadable page throws because it may represent a deleted folder. `message.test.ts:658–746` tests $skip=620,$top=3 with unreadable middle item and next continuation 623.

**Scenario:** the 621st message becomes unreadable; every attempt at page 620 otherwise returns the same 404 and sync never reaches later mail.

**Recommendation:** separate poison-item recovery from container deletion and cap amplification. Do not interpret opaque continuation tokens as editable offsets.

#### B34 — A local rate-limit guard must not refresh its own expiry

**Merged fix:** PR #4030, `61a08a51f63d44fab1d81061d232923f065cdd13`, 2026-10-06.

**Evidence:** `apps/web/utils/email/rate-limit.ts:286–303` excludes ProviderRateLimitModeError before recording a provider throttle. Previously the local guard's own error text matched the provider classifier and every rejected local request pushed retryAt forward. The same series addresses self-conflicting status-category changes by sequencing removal/addition.

**Scenario:** continue interacting during cooldown; repeated locally blocked operations must not indefinitely extend the original provider recovery time.

**Recommendation:** distinguish local control-flow state from remote responses with typed errors. Test that the stored deadline remains fixed during repeated guarded calls and changes only on a new provider response.

#### B35 — Gmail disabled is a permanent precondition failure, not a retry opportunity

**Merged fix:** PR #4172, `d8f2d3523f56d1dd16e900ab74e2f8a7764b739e`, 2026-10-16.

**Evidence:** `apps/web/utils/gmail/retry.ts:136–187` excludes “mail service not enabled” from transient failed-precondition handling, also separately recognizes the duplicate-push-client error (`:191–200`). Rate-limit 403 reasons are distinguished from arbitrary 403s. `retry.test.ts:116,144,159` tests forbidden, duplicate push client, and disabled Gmail; tests at `:296` cover backoff above the blocking cap.

**Scenario:** authenticated Google account has no active Gmail service; repeated API retries delay actionable setup feedback and consume request lifetime.

**Recommendation:** classify action-required failures separately from temporary network/server/quota failures. Present the specific service/access recovery step, and honor Retry-After without blocking a worker for an unbounded interval.

#### B36 — Provider-neutral search can silently inherit Gmail semantics

**Merged fix:** PR #4289, `fc021c43286a9728d1433b34363b9af1cee99ff7`, 2026-10-22.

**Evidence:** `apps/web/utils/email/microsoft.ts:1833–1912` replaces Gmail-like reply-history expressions with Graph Sent Items participant queries, exact-address confirmation, and paginated exact-sender counts. Previously Gmail syntax was passed to a path implementing subject containment, returning no useful results and disabling sender thresholds. `microsoft.test.ts:1035–1172` covers lookalikes filling page one and rejection of similar addresses.

**Scenario:** replies to alice@example.com exist but the assistant believes none were sent; mail from alice+other or a similarly named sender must not satisfy exact identity checks.

**Limits:** reply scan is capped at three pages and Sent Items scope; messages moved out of Sent Items can be missed. On errors the code conservatively returns replied=true/count=0.

**Recommendation:** test the behavioral contract of provider adapters against realistic mailbox fixtures; do not mock an incompatible query into returning the desired result.

#### B37 — Static body rules must use visible text for HTML-only messages

**Merged fix:** PR #4290, `5a6fd0c8af7f7ce3e49cfe09241d3e12a63ccc64`, 2026-10-22.

**Evidence:** `apps/web/utils/ai/choose-rule/match-rules.ts:1050–1062`, `getStaticMatchBodyText`, uses plaintext when available, otherwise visible HTML text with wrapping and automatic heading uppercase disabled. Outlook commonly has only HTML; matching against empty plaintext silently missed rules. `match-rules.test.ts:128–179` tests HTML-only unsubscribe, a phrase beyond default wrapping, mixed-case heading, invisible CSS rejection, and plaintext precedence.

**Scenario:** a static unsubscribe rule fails on an HTML newsletter while AI understands the same mail. Default text conversion wraps inside a phrase, or uppercases a heading and breaks case-sensitive matching.

**Recommendation:** specify text-normalization semantics for matching separately from display. Test provider body shapes and conversion options, including invisibly embedded content.

#### B38 — Scheduled actions can lose stable IDs and report success without doing work

**Merged fix:** PR #4266, `435482eff2fa8c6acfa276e2f9764ea51916e731`, 2026-10-22.

**Evidence:** `apps/web/utils/scheduled-actions/scheduler.ts:62–70` persists labelId/folderName/folderId; `executor.ts:65–79` reconstructs them. Previously delayed move omitted its destination and returned early while recorded as succeeded; delayed labels fell back to names and could recreate an old renamed label. `scheduler.test.ts` adds stable-label persistence; `executor.test.ts` adds folder/label reconstruction regressions.

**Scenario:** schedule a move/label, rename the destination, and wait for execution. The intended existing destination must be used; missing required parameters must not produce success.

**Recommendation:** persist the complete versioned action payload, use stable IDs, and make action outcome explicit: applied, skipped-with-reason, deferred, or failed.

#### B39 — An invented AI rule name must not become successful no-op processing

**Merged fix:** PR #4255, `4128ed23452df835a646adbc6d5ba72fd7441b4c`, 2026-10-20; linked issue #3853.

**Evidence:** `apps/web/utils/ai/choose-rule/ai-choose-rule.ts:78–86` throws if the model claims a match but none of the returned names resolve to offered rules. `ai-choose-rule.test.ts:172,180,212` covers invented single names, all-invalid multi-rule names, and mixed output retaining valid offered rules.

**Scenario:** model chooses a nonexistent rule; previously mail could be recorded as handled despite no valid action. A legitimate no-match response must remain distinct from malformed claimed-match output.

**Recommendation:** validate AI output against the actual candidate set and retain failed work for retry/review. Do not convert validation failure into empty success.

#### B40 — Concurrent automation-history writes require retrying the version allocation

**Merged fix:** PR #4324, `7e7d313c5067ec1c0f95a64c3afa4ac7171e704d`, 2026-10-22.

**Evidence:** `apps/web/utils/rule/rule-history.ts:6,52–90`, `createRuleHistory`, re-reads the maximum version and retries at most three times only for the specific unique constraint on ruleId/version. `rule-history.test.ts:111,133` covers conflict then next-version success and bounded repeated conflict.

**Scenario:** UI and assistant update the same rule concurrently; both allocate N+1. History creation must retry correctly without swallowing unrelated database errors.

**Recommendation:** centralize ordered audit/version writes with clear concurrency semantics; preserve exact before/after action payloads, including Cc/Bcc, folder and label IDs.

### Reports not established as current fixed behavior

#### B41 — Onboarding quota exhaustion must have a recovery path

**Open report:** issue #4348, opened 2026-10-26T06:01:28Z, still open in the inventory.

**Reported evidence:** concurrent stats preloading and persona analysis at initial onboarding trigger Gmail 403 rateLimitExceeded on a fresh cloud project. Reporter says retries leave onboarding stalled with no fallback. Named code path: `apps/web/app/(app)/[emailAccountId]/onboarding/OnboardingContent.tsx`, EmailStatsPreloader, analyzePersonaAction, getMessagesWithPagination. The report's account of initial quota constraints and root cause was not independently verified.

**Regression/recommendation:** exhaust quota during optional onboarding analysis; permit progress, expose retry/skip, and share account-level quotas between background tasks. This is an unresolved report, not evidence that a particular fix shipped.

#### B42 — Parallel Graph fetches can surface as unavailable-mail UI

**Open report:** issue #3580, opened 2026-09-07. Reporter describes 47 concurrent message GETs, ErrorAccessDenied, and History displaying “Email unavailable”; attributes it to mailbox concurrency throttling.

**Status/limit:** no linked merged resolution verified. The specific access-denied-to-throttling causal claim is the reporter's inference; an access error alone does not prove throttling.

**Regression/recommendation:** load a large history result set with mixed 403/429/per-item failures; bound concurrency, preserve successful cards, and distinguish transient retry from permission recovery. Check both explicit rate-limit responses and permanent authorization denial.

#### B43 — Multi-account attachment regressions need ownership tests

**Open report:** issue #543, opened 2025-07-05, attachment download reportedly broke around multi-account support. No verified resolution in this sample.

**Regression/recommendation:** open account A's message, switch to B while its attachment request is in flight, then download/retry. Requests, cache keys, provider clients, and UI completion must remain bound to A. This is a useful user-reported scenario, not a demonstrated present defect.

### Additional verified identity and recovery cases

#### B44 — Search results can use a different Outlook ID namespace

**Merged fix:** PR #3967, `c641cd02f247e5c28037d9b7e324406057dc2160`, 2026-10-05.

**Evidence:** `apps/web/utils/outlook/client.ts:31–39` sets the immutable-ID preference globally. Despite that preference, `apps/web/utils/outlook/message.ts:1291–1331`, `normalizeOutlookSearchIds`, explicitly handles search returning folder-dependent REST IDs by calling translateExchangeIds with source restId and target restImmutableEntryId. Missing translations are dropped while valid results remain. `message.test.ts:351,378,398` tests first-page conversion, continuation-page conversion, and one stale ID without losing valid results or pagination. The emulator bypasses translation (`message.ts:1301–1302`), a test-environment gap to remember.

**Scenario:** persist an execution-history entry for a search result, move the message to a different folder, then open it. Persisting a mutable search ID makes the history pointer appear broken.

**Recommendation:** normalize IDs at every ingress path, including search, delta, batch, push, and restored drafts; test cross-path identity rather than only each endpoint independently. Provider documentation says immutable IDs remain stable within the same mailbox but are case-sensitive and can change across archive-mailbox moves or export/reimport; see [Outlook identifier guidance](https://learn.microsoft.com/en-us/graph/outlook-immutable-id). This does not establish that every Graph search deployment violates the preference; the behavior claim comes from this fix and its regression fixtures.

#### B45 — Reply-To may contain several addresses and must survive both UI and provider drafting

**Merged fixes:** PR #4228, `934005d6e2fe48c00ac770983836369845d35048`, and PR #4279, `b1495f9b447e01f7f488f0d423935025b111b56f`, both 2026-10-20.

**Evidence:** `apps/web/components/email-list/EmailMessage.tsx:1030–1038` prefers Reply-To over From for received mail. `apps/web/utils/email/reply-all.ts:22–59` seeds a seen-address set from **all** Reply-To addresses before adding original To/Cc, excluding the user's identities. `apps/web/utils/outlook/mail.ts:293–302` builds provider draft recipients from Reply-To with override/fallback behavior. Tests: `EmailMessage.test.tsx:287,423`, `email/reply-all.test.ts`, and `outlook/mail.test.ts` (+117 lines in #4228).

**Scenario:** a helpdesk message has From=noreply and Reply-To=session-address; a mailing list has multiple Reply-To addresses also present in To/Cc. Replies must go to the operational destination exactly once. Quoted display names with commas must not split incorrectly.

**Recommendation:** parse address lists, do not treat Reply-To as one raw email string, and test generated provider drafts as well as composer prefill. Preserve distinction between replying to received mail and continuing a message the user sent.

#### B46 — Undo must release idempotency admission while still blocking real duplicate sends

**Merged fix:** PR #4053, `47793715bbb18ace54a967308d2fec7762152d31`, 2026-10-08.

**Evidence:** `apps/web/app/(app)/[emailAccountId]/compose/queued-reply.ts:57–81` recognizes undone commands and allocates another send-command identity, while the saved logical draft identity remains reusable. `wasSendUndone` observes cancelled/superseded state (`:191–219`); `isSendCommandFor` associates resends with the original compose (`:324–339`). `queued-reply.test.ts:79,134,175,202` tests conflicting payload rejection, undo of original and retry followed by another resend, and continued duplicate blocking while a resend remains pending. Current tests at `:292,373,406,426` also assert uncertain delivery is not automatically retried, a slow submit still gets an undo hold, reconnection recovery is explained, and slow sends remain queued.

**Scenario:** send, undo, edit/resend, undo again, resend again; then double-click while the last attempt is pending. A single permanent idempotency key can incorrectly suppress legitimate resends, while a fresh key on every click duplicates real sends.

**Recommendation:** distinguish logical draft/session identity, admission/idempotency key, and concrete send attempt. Undo must be an acknowledged state transition, not merely restoring editor text; uncertain provider delivery must remain separate from acknowledged cancellation.

#### B47 — Non-protocol HTTP failures must not be parsed as successful sync pages

**Merged fix:** PR #3864, `7749e8833f8febb9ecadf317a6d467081aed4dae`, 2026-09-25.

**Evidence:** `packages/mail-core/src/protocol/backend-adapter.ts:494–553`, `readError`/`mapReadError`, classifies plain middleware/platform/proxy responses by HTTP status before applying the normal mail-result schema. Prior code treated error bodies without the protocol error envelope as successful results, threw validation errors, abandoned catch-up, and retried in a tight loop. `backend-adapter.test.ts:34–99` supplies a bare 401 permissions error, 429 platform limit, non-protocol 400, and null-body 502; scope discovery, enumeration, and search must return blocked_auth or a bounded pause. The same series pauses blocked bootstrap scans until their retry time.

**Scenario:** an expired session returns middleware JSON instead of the mail protocol; a proxy returns HTML/empty body; deployment layers answer 429. These must not wedge the engine or repeatedly show generic parse errors.

**Recommendation:** validate the transport outcome before the payload schema, preserve typed recovery states through every layer, and test errors originating outside the application's normal API handler. Keep this classification separate from send execution: unknown send outcomes require uncertainty handling rather than automatic replay.

### Missing coverage and research cautions

- **SMTP/IMAP coverage is missing.** Current provider construction in `apps/web/utils/email/provider.ts:18–47` selects Google or Microsoft and rejects unsupported providers. The inspected source/history did not establish a general IMAP/SMTP client implementation. Issue #62 (opened 2023-12-30) and #925 (opened 2025-11-07) remain open requests/proposals. Source B therefore supplies no implementation evidence about UIDVALIDITY/UIDNEXT, QRESYNC/CONDSTORE, EXPUNGE sequence renumbering, IMAP IDLE reconnect, SMTP partial recipient acceptance, STARTTLS downgrade behavior, or APPEND sent-copy reconciliation. See Appendix A and the standards-backed section for those cases.
- **Do not misread issue #1238 as an implementation.** It is a closed issue, not a merged PR; opened/closed 2026-01-08. A follow-up by its author disavows the purported implementation as generated spam. It is not evidence of shipped SMTP/IMAP support.
- Issue #1744, opened 2026-02-27 and closed 2026-03-08, proposes that folder moves fail to teach category-removal automation. Its author explicitly described the report as theoretical and untested. Closure is not proof of a fix; no present-defect claim is made here.
- Open issue #3983 reports periodic Gmail disconnection; token/consent configuration was not independently verified. B01–B05 are actual inspected fixes and should not be presented as a proven explanation for that report.
- Unmerged B11 was discovered because inventory included branch history. Main-ancestry verification prevented promoting it to a shipped fix. Other unmerged commits, dependency changes, and duplicate historical fixes were not counted as independent findings.
- Provider documentation (accessed 2026-10-26) corroborates semantics, not source B test execution or target-application bugs. No real accounts were used, and API-emulator tests do not establish behavior across every tenant, mail server, organizational policy, attachment type, or OAuth consent setup.

### Suggested regression shortlist for the target application

1. Overlapping refresh/reconnect/old-auth-failure permutations preserve newest credentials and intended mailbox identity (B01–B05).
2. Out-of-order/duplicate webhooks; crash after action but before checkpoint; failed lock replay; catch-up marker replacement; cursor expiry (B06–B14).
3. 250-message sender mutation; 101+ message conversation; later-page failure; deleted custom-folder descendants; mixed JSON-batch statuses (B15–B20).
4. Accepted send with lost response/post-send 404; explicit throttle versus ambiguous network failure; upload/autosave/reopen/send interleavings; alias/Reply-To/ID normalization and undo/resend admission (B21–B30, B44–B46).
5. MIME split around images, signature-only HTML, oversized/malformed/poison items, optional analysis quota failures, AI invalid selection and delayed action payload round-trips (B31–B43, B47).

Recommendations are research outputs only. No application implementation, project changes, or commits were made.


## Review and verification status

An independent read-only review checked the proposed contracts and Terno conclusions against the local code. Seven substantive corrections were incorporated: completion-committed send retry paths; message-404 versus history-404 provenance; Reply-To retention; uncertain Sent APPEND outcomes; Gmail-versus-SMTP Bcc submission; confidence labels for retry/untrash behavior; and recurring browser token acquisition. A second independent review sample-checked ten high-value external evidence entries and selected ancestry claims. Two further corrections made B15's default partial-enumeration behavior explicit and scoped Appendix B's coverage disclaimers to that investigation. Identifying source names were scanned out of the deliverable. Neither review was an exhaustive re-audit of every claim.

Research validation consisted of public source/history/API inspection, current official provider/standards documentation, source/test cross-references and report review. Third-party code was not installed or executed. No real mail accounts or profiles were used. Application source was not changed and no fixes were implemented. The project's type/lint/unit/e2e/web/UI-performance/desktop packaging suites were not run for this documentation-only investigation; this report makes no claim about their current results. The proposed acceptance scenarios must be selected by enabled capability and implemented/run as part of future feature/fix plans.
