# Provider reliability implementation worklist

Status: in progress. Source: [research report](provider-reliability-report.md). Plan: [26](../plans/26-provider-reliability.md).

Every report entry remains open until investigation establishes its Terno disposition and records tests, review, and commits. Duplicate scenarios can share a reviewed change; evidence from other systems is not automatically a Terno bug. New capability work is not dismissed merely because older plans deferred it.

| ID | Report item | Status / workgroup | Validation / review / commit |
|---|---|---|---|
| T01 | Remote success versus local completion (P0 candidate) | Investigating: accepted-send completion | — |
| T02 | Attachment capability (P1, established limitation) | Pending investigation | — |
| T03 | Mailbox coverage and Microsoft support (P1, established limitation) | Pending investigation | — |
| T04 | Gmail retry decisions (P1 observed classification gap) | Pending investigation | — |
| T05 | Partial mutations and swallowed errors (P1 observed handling; remote outcomes need fixtures) | Pending investigation | — |
| T06 | Backfill and disappearing messages (P1 validation) | Pending investigation | — |
| T07 | Sent copies and partial recipients (P1 gap) | Pending investigation | — |
| T08 | Scope, identity and timeout qualification (P1 validation) | Pending investigation | — |
| T09 | Resource and UI contracts (P2) | Pending investigation | — |
| T10 | Reply-To is lost before recipient selection (P1, established source-level limitation) | Pending investigation | — |
| A01 | Denied Gmail consent and revoked authorization need different recovery from transient failures | Pending investigation | — |
| A02 | Failed identity lookup and sessions with no accounts require explicit cleanup | Pending investigation | — |
| A03 | Expired Gmail history requires resumable reconciliation, followed by catch-up from a pre-enumeration baseline | Pending investigation | — |
| A04 | Cursor advancement, durable jobs, and notification revisions belong in the same transaction | Pending investigation | — |
| A05 | Thread unread/star state cannot be taken only from the latest message | Pending investigation | — |
| A06 | Independent per-label versions prevent a late acknowledgment from erasing a newer action | Pending investigation | — |
| A07 | Trash/restore must model provider-implied label removals and newer user restores | Pending investigation | — |
| A08 | Tombstones and per-message history checkpoints stop stale body caches from resurrecting deletions | Pending investigation | — |
| A09 | Shared quota requires mailbox identity, project admission, foreground reserves, and crash-recoverable leases | Pending investigation | — |
| A10 | Retry classification must preserve Retry-After and avoid turning admission deferral into provider failure | Pending investigation | — |
| A11 | Push payload parsing and authenticated delivery are separate correctness boundaries | Pending investigation | — |
| A12 | Search cache identity must preserve opaque page tokens and query semantics, with invalidation fencing | Pending investigation | — |
| A13 | Folder counts must know whether local coverage is complete | Pending investigation | — |
| A14 | Draft/asset caching has different identities, size limits, and failure semantics | Pending investigation | — |
| A15 | Send the canonical provider draft and the exact latest editor contents | Pending investigation | — |
| A16 | Autosave identity and reactive navigation are both part of draft correctness | Pending investigation | — |
| A17 | Draft reads must prove editability and fail closed on missing attachments | Pending investigation | — |
| A18 | Reply-To, own-message follow-up, aliases, and Bcc need separate tests | Pending investigation | — |
| A19 | Browser reconnect must invalidate fresh caches and retire only settled optimistic overrides | Pending investigation | — |
| A20 | Execution-platform budgets and successful empty pages must be modeled separately from provider failures | Pending investigation | — |
| A21 | Outlook batch success is not the same as success of each message operation | Pending investigation | — |
| A22 | Returning an Outlook nextLink without consuming it makes the pagination contract incomplete | Pending investigation | — |
| A23 | Graph replies need real reply/forward drafts, including migration of older standalone drafts | Pending investigation | — |
| A24 | A failed Outlook draft update must not trigger destructive replacement | Pending investigation | — |
| A25 | IMAP identity is folder + UIDVALIDITY + UID, not UID alone | Pending investigation | — |
| A26 | Bounded IMAP backfill is a product limit, and capability fallbacks can leave old flags stale | Pending investigation | — |
| A27 | IMAP folders and keyword tags need separate mutation semantics | Pending investigation | — |
| A28 | Cross-folder dedupe and out-of-order threading need stable logical identity, but Message-ID is imperfect | Pending investigation | — |
| A29 | IDLE must not monopolize the connection used for foreground actions | Pending investigation | — |
| A30 | SMTP wire correctness includes envelope privacy, dot-stuffing, TLS upgrade, and capability changes | Pending investigation | — |
| A31 | Partial SMTP acceptance and ambiguous post-DATA failure need a richer send result | Pending investigation | — |
| A32 | Filing Sent and deleting a sent draft are post-delivery operations | Pending investigation | — |
| A33 | IMAP draft replacement should append before deletion; legacy expunge fallback can delete unrelated mail | Pending investigation | — |
| A34 | OAuth rotation must survive reconnect and persistence failure | Pending investigation | — |
| A35 | Recursive MIME and malformed optional headers require adversarial fixtures | Pending investigation | — |
| A36 | Undo and tracker closure are not evidence of exact recovery | Pending investigation | — |
| B01 | Refresh success can overwrite newer credentials | Pending investigation | — |
| B02 | Old auth failures must not disconnect a freshly reconnected mailbox | Pending investigation | — |
| B03 | Reconnect must be bound to the intended mailbox | Pending investigation | — |
| B04 | Library updates can silently change provider identity keys | Pending investigation | — |
| B05 | Verified email renames require provider-specific authority and ownership checks | Pending investigation | — |
| B06 | Concurrent Gmail webhook processors can move the history cursor backward | Pending investigation | — |
| B07 | Failed deduplication locks can turn recoverable failures into permanent skips | Pending investigation | — |
| B08 | Throttled Outlook webhooks require a remembered catch-up window | Pending investigation | — |
| B09 | Catch-up markers themselves need concurrency ownership | Pending investigation | — |
| B10 | Bootstrap and incremental cursors must represent different phases | Pending investigation | — |
| B11 | One history record can exceed a whole application sync-page budget | Pending investigation | — |
| B12 | Expired history, archive, and deletion are different states | Pending investigation | — |
| B13 | An omitted batch result is not evidence of deletion | Pending investigation | — |
| B14 | Repeated resync requests can create an idle CPU/network loop | Pending investigation | — |
| B15 | Mutating an offset-paged inbox skips every other page | Pending investigation | — |
| B16 | Thread actions must enumerate the entire conversation before writing | Pending investigation | — |
| B17 | All-mail must include custom folders and exclude deleted-folder descendants | Pending investigation | — |
| B18 | Outlook categories are not folders | Pending investigation | — |
| B19 | Category read-modify-write needs ETags and fresh recomputation | Pending investigation | — |
| B20 | Bulk success is per item, not the batch HTTP status | Pending investigation | — |
| B21 | Send acceptance must be independent of sent-copy readability | Investigating: accepted-send completion | — |
| B22 | Retry policies for sends must differ from reads | Investigating: accepted-send completion | — |
| B23 | Missing contentBytes is not an empty attachment | Pending investigation | — |
| B24 | Attachment metadata size is not always the raw-byte size | Pending investigation | — |
| B25 | Server-local attachment staging fails across application instances | Pending investigation | — |
| B26 | Gmail draft replacement makes concurrent autosave and upload destructive | Pending investigation | — |
| B27 | Missing drafts are terminal autosave state | Pending investigation | — |
| B28 | Empty arrays and omitted recipient fields have different semantics | Pending investigation | — |
| B29 | Reply identity must follow the destination alias, including its signature | Pending investigation | — |
| B30 | Provider autosave echoes must not replace the live composer | Pending investigation | — |
| B31 | MIME alternatives and sequential parts must be handled differently | Pending investigation | — |
| B32 | Malformed mail and oversized metadata can wedge a whole account | Pending investigation | — |
| B33 | One unreadable Graph item can poison a whole continuation page | Pending investigation | — |
| B34 | A local rate-limit guard must not refresh its own expiry | Pending investigation | — |
| B35 | Gmail disabled is a permanent precondition failure, not a retry opportunity | Pending investigation | — |
| B36 | Provider-neutral search can silently inherit Gmail semantics | Pending investigation | — |
| B37 | Static body rules must use visible text for HTML-only messages | Pending investigation | — |
| B38 | Scheduled actions can lose stable IDs and report success without doing work | Pending investigation | — |
| B39 | An invented AI rule name must not become successful no-op processing | Pending investigation | — |
| B40 | Concurrent automation-history writes require retrying the version allocation | Pending investigation | — |
| B41 | Onboarding quota exhaustion must have a recovery path | Pending investigation | — |
| B42 | Parallel Graph fetches can surface as unavailable-mail UI | Pending investigation | — |
| B43 | Multi-account attachment regressions need ownership tests | Pending investigation | — |
| B44 | Search results can use a different Outlook ID namespace | Pending investigation | — |
| B45 | Reply-To may contain several addresses and must survive both UI and provider drafting | Pending investigation | — |
| B46 | Undo must release idempotency admission while still blocking real duplicate sends | Pending investigation | — |
| B47 | Non-protocol HTTP failures must not be parsed as successful sync pages | Pending investigation | — |
| S01 | An expired Gmail history cursor triggers recovery; a transient message fetch failure does not advance beyond unhandled work. | Pending investigation | — |
| S02 | Three history pages overlap message IDs and contain repeated label changes; the final materialized state is correct with no duplicate message or duplicate automation. | Pending investigation | — |
| S03 | Fail after applying a page and before saving its cursor, restart, and replay; state remains correct. | Pending investigation | — |
| S04 | An empty Graph page includes nextLink; the worker continues to the terminal deltaLink. | Pending investigation | — |
| S05 | A notification arrives while reconciliation is running; one trailing pass occurs and the final event is reflected. | Pending investigation | — |
| S06 | Two workers race and the older lease expires; only the current worker can promote the checkpoint. | Pending investigation | — |
| S07 | An initial backfill races with a new arrival, archive, delete and read change; the next incremental pass catches every concurrent mutation. | Pending investigation | — |
| S08 | One malformed message or missing body is isolated without silently skipping it; a durable repair record survives restart if the cursor advances. | Pending investigation | — |
| S09 | A recent-window full listing omits an older cached message; the message is not tombstoned on that evidence. | Pending investigation | — |
| S10 | A message is deleted between list and get; the run completes with the correct per-message outcome and no account-wide auth error. | Pending investigation | — |
| S11 | A folder move yields a removal and later addition; local message content, selection and operation targeting survive. | Pending investigation | — |
| S12 | IMAP UIDVALIDITY changes with a reused UID; an old queued delete cannot touch the new message. | Pending investigation | — |
| S13 | An IMAP EXPUNGE renumbers messages while fetching; durable identity never uses the sequence number. | Pending investigation | — |
| S14 | A read/unread change on an old message appears after sleep; the sync window does not hide it forever. | Pending investigation | — |
| S15 | Folder rename, deletion, recreation, noselect parent and non-ASCII name produce correct locators and navigation. | Pending investigation | — |
| S16 | Cancel backfill, close the account, and disconnect it while an item is in flight; no stale completion repopulates the removed account. | Pending investigation | — |
| S17 | Twenty simultaneous expired-token reads produce one refresh operation per credential generation. | Pending investigation | — |
| S18 | Refresh or renewed consent omits refresh_token; the previously valid stored token is retained for that same identity. | Pending investigation | — |
| S19 | An old request returns 401 after successful sign-in; it cannot invalidate the replacement token or re-park resumed work. | Pending investigation | — |
| S20 | Reconnect selects a different mailbox or tenant; reject identity replacement and preserve the intended account's local state. | Pending investigation | — |
| S21 | Reading works while SMTP authentication fails; receiving continues and only sends wait. | Pending investigation | — |
| S22 | Consent grants read but not send, or an administrator blocks a permission; expose the affected capability and the right next action. | Pending investigation | — |
| S23 | Gmail quota 403, policy 403 and message 404 follow different recovery paths. | Pending investigation | — |
| S24 | Graph batch envelope is 200 with mixed 204/429/404; retry only eligible failed members after the server delay. | Pending investigation | — |
| S25 | A provider remains throttled through restart; persisted next-attempt timing prevents a burst on launch. | Pending investigation | — |
| S26 | A large backfill is running when the user sends or opens a message; interactive work has bounded latency. | Pending investigation | — |
| S27 | Sleep, VPN change, captive portal and reconnect interrupt work; cancellation closes only the relevant reads, and no automatic resend follows uncertain submission. | Pending investigation | — |
| S28 | Remove a refused account; all queued jobs, reconnect timers and pending sign-in results are fenced off. | Pending investigation | — |
| S29 | Persist an intent, crash before submission, and restart; the queued message is eligible exactly once. | Pending investigation | — |
| S30 | The server accepts the message but the final response is lost; the durable result is unknown and no automatic resend occurs. | Investigating: accepted-send completion | — |
| S31 | Submission succeeds but saving the local result fails before commit, after commit before acknowledgement, or in post-completion work; neither a running nor succeeded send may become automatically queued again. | Investigating: accepted-send completion | — |
| S32 | Submission succeeds but Sent APPEND is rejected or its acknowledgement is lost; keep submission accepted, reconcile uncertain copies before replay, and never resubmit SMTP. | Pending investigation | — |
| S33 | Two recipients are accepted and one is rejected; expose partial submission and never silently send again to the accepted set. | Pending investigation | — |
| S34 | Bcc-only and mixed To/Cc/Bcc sends preserve actual delivery recipients without exposing Bcc in recipients' raw messages. SMTP submission omits the Bcc header; Gmail raw API submission retains it as required to address delivery. | Pending investigation | — |
| S35 | Reply, reply-all and forwarding cover Reply-To, multiple aliases, self-sent messages, mailing lists and malformed addresses; compare displayed chips with the exact queued envelope. | Pending investigation | — |
| S36 | Identical subjects in unrelated mail never merge solely on subject; missing or duplicated Message-ID does not erase distinct mail. | Pending investigation | — |
| S37 | A valid provider reply maintains conversation linkage; a deliberate subject change starts the intended new context. | Pending investigation | — |
| S38 | Autosave revision N completes after N+1, during send, and after discard; it cannot restore an older draft or resurrect a sent/discarded draft. | Pending investigation | — |
| S39 | Attachment upload/removal races with Send; the queued payload references an immutable, complete revision. | Pending investigation | — |
| S40 | A user edits recipients or attachments while offline after queuing; the pending operation's snapshot stays explicit and predictable. | Pending investigation | — |
| S41 | Double click Send, repeat keyboard shortcut, two tabs and process restart cannot create duplicate local send intents. | Pending investigation | — |
| S42 | A send-as alias is removed or loses permission after composition; submission fails safely and keeps the draft and selected identity visible. | Pending investigation | — |
| S43 | Provider acceptance is followed by an NDR/bounce; do not claim that acceptance proved delivery. | Pending investigation | — |
| S44 | Undo before dispatch cancels the exact operation; undo after remote acceptance never promises to unsend mail without a supported provider operation. | Pending investigation | — |
| S45 | Nested MIME, empty HTML with useful plain text, invalid charset, missing Date, future Date, duplicate headers and message/rfc822 parts render with deterministic fallback. | Pending investigation | — |
| S46 | Inline CID images with case/encoding variations, duplicate filenames, no filename and Unicode filename preserve the intended content without path traversal. | Pending investigation | — |
| S47 | Attachments cross direct/upload-session boundaries, expire midway, exceed provider/mailbox limits and lose network; recover without duplicate attachment records. | Pending investigation | — |
| S48 | A large encoded MIME payload includes base64 overhead; enforce the actual transmission budget and bound concurrent decoding memory. | Pending investigation | — |
| S49 | A raw import is retried; it neither duplicates the import nor converts malformed source into a destructive empty message. | Pending investigation | — |
| S50 | HTML with remote pixels, CSS URLs, forms, scripts and navigation attempts causes no unapproved network or active content in local mode. | Pending investigation | — |
| S51 | Logs, error objects, crash breadcrumbs and upload URLs are checked for synthetic secret/address/subject markers; sensitive values stay out of diagnostic output. | Pending investigation | — |
| S52 | A 50k-thread backfill/recovery runs within existing event-loop and UI budgets; queue memory, retained raw bodies and tombstones stay bounded. | Pending investigation | — |
| S53 | Long account/provider errors in English and Spanish remain actionable, keyboard reachable and screen-reader named in light/dark themes. | Pending investigation | — |
| S54 | Reauthentication or background recovery while typing preserves composer content, caret, selection, list focus and scroll. | Pending investigation | — |
| S55 | Idle after healthy sync or an authentication refusal has no spinning retry timers or unexpected network, apart from explicitly selected transport liveness requirements. Browser reload/expiry preserves queued work while token reacquisition is pending. | Pending investigation | — |
| S56 | A recoverable per-message error remains discoverable after the global sync indicator returns to healthy. | Pending investigation | — |
| S57 | Date-range search crosses midnight, DST and a non-PST timezone; exact epoch boundaries return the intended set. | Pending investigation | — |
| S58 | Gmail API results differ from alias-expanded/thread-wide provider UI results; communicate or implement the chosen parity rather than treating absence as deletion. | Pending investigation | — |
| S59 | A remote draft replacement changes its underlying message ID and a send removes the container; delayed autosave cannot target the sent message or resurrect the draft. | Pending investigation | — |
| S60 | An inline-only Graph message reports no ordinary attachments; CID images still resolve under the explicit content policy. | Pending investigation | — |
