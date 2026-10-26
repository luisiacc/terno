# Provider reliability implementation worklist

Status: in progress. Source: [research report](provider-reliability-report.md). Plan: [26](../plans/26-provider-reliability.md). Detailed baseline mapping: [coverage audit](provider-reliability-baseline.md).

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
| A01 | Denied Gmail consent and revoked authorization need different recovery from transient failures | Pending: W04/W05; E+R | Baseline audit records existing tests and required new oracles. |
| A02 | Failed identity lookup and sessions with no accounts require explicit cleanup | Pending: W04/W03; E+R+L | Baseline audit records existing tests and required new oracles. |
| A03 | Expired Gmail history requires resumable reconciliation, followed by catch-up from a pre-enumeration baseline | Pending: W03; E+R | Baseline audit records existing tests and required new oracles. |
| A04 | Cursor advancement, durable jobs, and notification revisions belong in the same transaction | Pending: W03; E+R+L | Baseline audit records existing tests and required new oracles. |
| A05 | Thread unread/star state cannot be taken only from the latest message | Pending: W02/W11; E+R | Baseline audit records existing tests and required new oracles. |
| A06 | Independent per-label versions prevent a late acknowledgment from erasing a newer action | Pending: W02; E+R | Baseline audit records existing tests and required new oracles. |
| A07 | Trash/restore must model provider-implied label removals and newer user restores | Pending: W02; E+R | Baseline audit records existing tests and required new oracles. |
| A08 | Tombstones and per-message history checkpoints stop stale body caches from resurrecting deletions | Pending: W03/W02; E+R | Baseline audit records existing tests and required new oracles. |
| A09 | Shared quota requires mailbox identity, project admission, foreground reserves, and crash-recoverable leases | Pending: W05/W11; R+L | Baseline audit records existing tests and required new oracles. |
| A10 | Retry classification must preserve Retry-After and avoid turning admission deferral into provider failure | Pending: W05; E+R | Baseline audit records existing tests and required new oracles. |
| A11 | Push payload parsing and authenticated delivery are separate correctness boundaries | Pending: W03/W04; L+R | Baseline audit records existing tests and required new oracles. |
| A12 | Search cache identity must preserve opaque page tokens and query semantics, with invalidation fencing | Pending: W11/W03; E+R+L | Baseline audit records existing tests and required new oracles. |
| A13 | Folder counts must know whether local coverage is complete | Pending: W11/W12; E+R | Baseline audit records existing tests and required new oracles. |
| A14 | Draft/asset caching has different identities, size limits, and failure semantics | Pending: W08; C+R | Baseline audit records existing tests and required new oracles. |
| A15 | Send the canonical provider draft and the exact latest editor contents | Pending: W08/W01; E+C+R | Baseline audit records existing tests and required new oracles. |
| A16 | Autosave identity and reactive navigation are both part of draft correctness | Pending: W08/W12; E+R | Baseline audit records existing tests and required new oracles. |
| A17 | Draft reads must prove editability and fail closed on missing attachments | Pending: W08; C+R | Baseline audit records existing tests and required new oracles. |
| A18 | Reply-To, own-message follow-up, aliases, and Bcc need separate tests | Pending: W09; E+C+R | Baseline audit records existing tests and required new oracles. |
| A19 | Browser reconnect must invalidate fresh caches and retire only settled optimistic overrides | Pending: W02/W11/W12; E+R+L | Baseline audit records existing tests and required new oracles. |
| A20 | Execution-platform budgets and successful empty pages must be modeled separately from provider failures | Pending: W03/W11; E+R+L | Baseline audit records existing tests and required new oracles. |
| A21 | Outlook batch success is not the same as success of each message operation | Pending: W07/W02; C+R | Baseline audit records existing tests and required new oracles. |
| A22 | Returning an Outlook nextLink without consuming it makes the pagination contract incomplete | Pending: W07/W03; C+R | Baseline audit records existing tests and required new oracles. |
| A23 | Graph replies need real reply/forward drafts, including migration of older standalone drafts | Pending: W07/W08/W09; C+R | Baseline audit records existing tests and required new oracles. |
| A24 | A failed Outlook draft update must not trigger destructive replacement | Pending: W08/W07; C+R | Baseline audit records existing tests and required new oracles. |
| A25 | IMAP identity is folder + UIDVALIDITY + UID, not UID alone | Pending: W06/W03; E+R | Baseline audit records existing tests and required new oracles. |
| A26 | Bounded IMAP backfill is a product limit, and capability fallbacks can leave old flags stale | Pending: W06/W11; E+R | Baseline audit records existing tests and required new oracles. |
| A27 | IMAP folders and keyword tags need separate mutation semantics | Pending: W06; E+C+R | Baseline audit records existing tests and required new oracles. |
| A28 | Cross-folder dedupe and out-of-order threading need stable logical identity, but Message-ID is imperfect | Pending: W06/W03; E+R | Baseline audit records existing tests and required new oracles. |
| A29 | IDLE must not monopolize the connection used for foreground actions | Pending: W06/W11; E+R | Baseline audit records existing tests and required new oracles. |
| A30 | SMTP wire correctness includes envelope privacy, dot-stuffing, TLS upgrade, and capability changes | Pending: W06/W01; E+R | Baseline audit records existing tests and required new oracles. |
| A31 | Partial SMTP acceptance and ambiguous post-DATA failure need a richer send result | Pending: W01/W08; E+R | Baseline audit records existing tests and required new oracles. |
| A32 | Filing Sent and deleting a sent draft are post-delivery operations | Pending: W01/W08; E+R | Baseline audit records existing tests and required new oracles. |
| A33 | IMAP draft replacement should append before deletion; legacy expunge fallback can delete unrelated mail | Pending: W06/W08; C+R | Baseline audit records existing tests and required new oracles. |
| A34 | OAuth rotation must survive reconnect and persistence failure | Pending: W04; E+C+R | Baseline audit records existing tests and required new oracles. |
| A35 | Recursive MIME and malformed optional headers require adversarial fixtures | Pending: W10/W08; E+R | Baseline audit records existing tests and required new oracles. |
| A36 | Undo and tracker closure are not evidence of exact recovery | Pending: W02/W08/W09/W12; E+C+R | Baseline audit records existing tests and required new oracles. |
| B01 | Refresh success can overwrite newer credentials | Pending: W04; E+R | Baseline audit records existing tests and required new oracles. |
| B02 | Old auth failures must not disconnect a freshly reconnected mailbox | Pending: W04; E+R | Baseline audit records existing tests and required new oracles. |
| B03 | Reconnect must be bound to the intended mailbox | Pending: W04; E+C+R | Baseline audit records existing tests and required new oracles. |
| B04 | Library updates can silently change provider identity keys | Pending: W04/W07; C+R | Baseline audit records existing tests and required new oracles. |
| B05 | Verified email renames require provider-specific authority and ownership checks | Pending: W04/W09; R+C+L | Baseline audit records existing tests and required new oracles. |
| B06 | Concurrent Gmail webhook processors can move the history cursor backward | Pending: W03; E+R+L | Baseline audit records existing tests and required new oracles. |
| B07 | Failed deduplication locks can turn recoverable failures into permanent skips | Pending: W03; E+R+L | Baseline audit records existing tests and required new oracles. |
| B08 | Throttled Outlook webhooks require a remembered catch-up window | Pending: W03/W05/W07; C+R+L | Baseline audit records existing tests and required new oracles. |
| B09 | Catch-up markers themselves need concurrency ownership | Pending: W03; R+L | Baseline audit records existing tests and required new oracles. |
| B10 | Bootstrap and incremental cursors must represent different phases | Pending: W03/W07; E+C+R | Baseline audit records existing tests and required new oracles. |
| B11 | One history record can exceed a whole application sync-page budget | Pending: W03/W11; R | Baseline audit records existing tests and required new oracles. |
| B12 | Expired history, archive, and deletion are different states | Pending: W03; E+R | Baseline audit records existing tests and required new oracles. |
| B13 | An omitted batch result is not evidence of deletion | Pending: W03/W07; E+C+R+L | Baseline audit records existing tests and required new oracles. |
| B14 | Repeated resync requests can create an idle CPU/network loop | Pending: W03/W11; E+R | Baseline audit records existing tests and required new oracles. |
| B15 | Mutating an offset-paged inbox skips every other page | Pending: W02/W11; E+R | Baseline audit records existing tests and required new oracles. |
| B16 | Thread actions must enumerate the entire conversation before writing | Pending: W02/W07; E+C+R | Baseline audit records existing tests and required new oracles. |
| B17 | All-mail must include custom folders and exclude deleted-folder descendants | Pending: W06/W07; C+R | Baseline audit records existing tests and required new oracles. |
| B18 | Outlook categories are not folders | Pending: W06/W07; E+C+L | Baseline audit records existing tests and required new oracles. |
| B19 | Category read-modify-write needs ETags and fresh recomputation | Pending: W07/W02; C+R | Baseline audit records existing tests and required new oracles. |
| B20 | Bulk success is per item, not the batch HTTP status | Pending: W07/W02; C+R | Baseline audit records existing tests and required new oracles. |
| B21 | Send acceptance must be independent of sent-copy readability | Pending: W01/W08; E+R | Baseline audit records existing tests and required new oracles. |
| B22 | Retry policies for sends must differ from reads | Pending: W01/W05; E+R | Baseline audit records existing tests and required new oracles. |
| B23 | Missing contentBytes is not an empty attachment | Pending: W08/W07; C+R | Baseline audit records existing tests and required new oracles. |
| B24 | Attachment metadata size is not always the raw-byte size | Pending: W08; C+R | Baseline audit records existing tests and required new oracles. |
| B25 | Server-local attachment staging fails across application instances | Pending: W08; C+R+L | Baseline audit records existing tests and required new oracles. |
| B26 | Gmail draft replacement makes concurrent autosave and upload destructive | Pending: W08; E+C+R | Baseline audit records existing tests and required new oracles. |
| B27 | Missing drafts are terminal autosave state | Pending: W08; E+C+R | Baseline audit records existing tests and required new oracles. |
| B28 | Empty arrays and omitted recipient fields have different semantics | Pending: W08/W07; E+C+R | Baseline audit records existing tests and required new oracles. |
| B29 | Reply identity must follow the destination alias, including its signature | Pending: W09; C+R | Baseline audit records existing tests and required new oracles. |
| B30 | Provider autosave echoes must not replace the live composer | Pending: W08/W12; E+C+R | Baseline audit records existing tests and required new oracles. |
| B31 | MIME alternatives and sequential parts must be handled differently | Pending: W10; R | Baseline audit records existing tests and required new oracles. |
| B32 | Malformed mail and oversized metadata can wedge a whole account | Pending: W10/W03; R | Baseline audit records existing tests and required new oracles. |
| B33 | One unreadable Graph item can poison a whole continuation page | Pending: W07/W03; C+R | Baseline audit records existing tests and required new oracles. |
| B34 | A local rate-limit guard must not refresh its own expiry | Pending: W05; R | Baseline audit records existing tests and required new oracles. |
| B35 | Gmail disabled is a permanent precondition failure, not a retry opportunity | Pending: W05/W04; E+R | Baseline audit records existing tests and required new oracles. |
| B36 | Provider-neutral search can silently inherit Gmail semantics | Pending: W11/W07; E+C+L | Baseline audit records existing tests and required new oracles. |
| B37 | Static body rules must use visible text for HTML-only messages | Pending: W10; E+R | Baseline audit records existing tests and required new oracles. |
| B38 | Scheduled actions can lose stable IDs and report success without doing work | Pending: W02/W06; E+R+L | Baseline audit records existing tests and required new oracles. |
| B39 | An invented AI rule name must not become successful no-op processing | Pending: W10/W12; E+R+L | Baseline audit records existing tests and required new oracles. |
| B40 | Concurrent automation-history writes require retrying the version allocation | Pending: W02/W11; E+R+L | Baseline audit records existing tests and required new oracles. |
| B41 | Onboarding quota exhaustion must have a recovery path | Pending: W05/W12; E+R+L | Baseline audit records existing tests and required new oracles. |
| B42 | Parallel Graph fetches can surface as unavailable-mail UI | Pending: W07/W05/W12; C+R | Baseline audit records existing tests and required new oracles. |
| B43 | Multi-account attachment regressions need ownership tests | Pending: W08; C+R | Baseline audit records existing tests and required new oracles. |
| B44 | Search results can use a different Outlook ID namespace | Pending: W07/W09; C+R | Baseline audit records existing tests and required new oracles. |
| B45 | Reply-To may contain several addresses and must survive both UI and provider drafting | Pending: W09; C+R | Baseline audit records existing tests and required new oracles. |
| B46 | Undo must release idempotency admission while still blocking real duplicate sends | Pending: W01/W08/W02; E+R | Baseline audit records existing tests and required new oracles. |
| B47 | Non-protocol HTTP failures must not be parsed as successful sync pages | Pending: W03/W05/W07; E+R | Baseline audit records existing tests and required new oracles. |
| S01 | An expired Gmail history cursor triggers recovery; a transient message fetch failure does not advance beyond unhandled work. | Pending: W03; E+R | Baseline audit records existing tests and required new oracles. |
| S02 | Three history pages overlap message IDs and contain repeated label changes; the final materialized state is correct with no duplicate message or duplicate automation. | Pending: W03; R | Baseline audit records existing tests and required new oracles. |
| S03 | Fail after applying a page and before saving its cursor, restart, and replay; state remains correct. | Pending: W03; E+R | Baseline audit records existing tests and required new oracles. |
| S04 | An empty Graph page includes nextLink; the worker continues to the terminal deltaLink. | Pending: W07; C+R | Baseline audit records existing tests and required new oracles. |
| S05 | A notification arrives while reconciliation is running; one trailing pass occurs and the final event is reflected. | Pending: W03; E+R | Baseline audit records existing tests and required new oracles. |
| S06 | Two workers race and the older lease expires; only the current worker can promote the checkpoint. | Pending: W03/W11; E+R+L | Baseline audit records existing tests and required new oracles. |
| S07 | An initial backfill races with a new arrival, archive, delete and read change; the next incremental pass catches every concurrent mutation. | Pending: W03; E+R | Baseline audit records existing tests and required new oracles. |
| S08 | One malformed message or missing body is isolated without silently skipping it; a durable repair record survives restart if the cursor advances. | Pending: W10/W03; R | Baseline audit records existing tests and required new oracles. |
| S09 | A recent-window full listing omits an older cached message; the message is not tombstoned on that evidence. | Pending: W03; E+R | Baseline audit records existing tests and required new oracles. |
| S10 | A message is deleted between list and get; the run completes with the correct per-message outcome and no account-wide auth error. | Pending: W03; R | Baseline audit records existing tests and required new oracles. |
| S11 | A folder move yields a removal and later addition; local message content, selection and operation targeting survive. | Pending: W06/W07/W12; E+C+R | Baseline audit records existing tests and required new oracles. |
| S12 | IMAP UIDVALIDITY changes with a reused UID; an old queued delete cannot touch the new message. | Pending: W06/W03; E+R | Baseline audit records existing tests and required new oracles. |
| S13 | An IMAP EXPUNGE renumbers messages while fetching; durable identity never uses the sequence number. | Pending: W06; E+R | Baseline audit records existing tests and required new oracles. |
| S14 | A read/unread change on an old message appears after sleep; the sync window does not hide it forever. | Pending: W06/W11; E+R | Baseline audit records existing tests and required new oracles. |
| S15 | Folder rename, deletion, recreation, noselect parent and non-ASCII name produce correct locators and navigation. | Pending: W06/W07; C+R | Baseline audit records existing tests and required new oracles. |
| S16 | Cancel backfill, close the account, and disconnect it while an item is in flight; no stale completion repopulates the removed account. | Pending: W03/W04; E+R | Baseline audit records existing tests and required new oracles. |
| S17 | Twenty simultaneous expired-token reads produce one refresh operation per credential generation. | Pending: W04; E+R | Baseline audit records existing tests and required new oracles. |
| S18 | Refresh or renewed consent omits refresh_token; the previously valid stored token is retained for that same identity. | Pending: W04; R | Baseline audit records existing tests and required new oracles. |
| S19 | An old request returns 401 after successful sign-in; it cannot invalidate the replacement token or re-park resumed work. | Pending: W04; E+R | Baseline audit records existing tests and required new oracles. |
| S20 | Reconnect selects a different mailbox or tenant; reject identity replacement and preserve the intended account's local state. | Pending: W04/W07; E+C+R | Baseline audit records existing tests and required new oracles. |
| S21 | Reading works while SMTP authentication fails; receiving continues and only sends wait. | Pending: W04; E | Baseline audit records existing tests and required new oracles. |
| S22 | Consent grants read but not send, or an administrator blocks a permission; expose the affected capability and the right next action. | Pending: W04/W07/W12; R+C | Baseline audit records existing tests and required new oracles. |
| S23 | Gmail quota 403, policy 403 and message 404 follow different recovery paths. | Pending: W05/W03; E+R | Baseline audit records existing tests and required new oracles. |
| S24 | Graph batch envelope is 200 with mixed 204/429/404; retry only eligible failed members after the server delay. | Pending: W07/W02/W05; C+R | Baseline audit records existing tests and required new oracles. |
| S25 | A provider remains throttled through restart; persisted next-attempt timing prevents a burst on launch. | Pending: W05; E+R | Baseline audit records existing tests and required new oracles. |
| S26 | A large backfill is running when the user sends or opens a message; interactive work has bounded latency. | Pending: W05/W11; R | Baseline audit records existing tests and required new oracles. |
| S27 | Sleep, VPN change, captive portal and reconnect interrupt work; cancellation closes only the relevant reads, and no automatic resend follows uncertain submission. | Pending: W01/W04/W06; E+R | Baseline audit records existing tests and required new oracles. |
| S28 | Remove a refused account; all queued jobs, reconnect timers and pending sign-in results are fenced off. | Pending: W04/W03; E+R | Baseline audit records existing tests and required new oracles. |
| S29 | Persist an intent, crash before submission, and restart; the queued message is eligible exactly once. | Pending: W01; E+R | Baseline audit records existing tests and required new oracles. |
| S30 | The server accepts the message but the final response is lost; the durable result is unknown and no automatic resend occurs. | Pending: W01; E | Baseline audit records existing tests and required new oracles. |
| S31 | Submission succeeds but saving the local result fails before commit, after commit before acknowledgement, or in post-completion work; neither a running nor succeeded send may become automatically queued again. | Pending: W01; R | Baseline audit records existing tests and required new oracles. |
| S32 | Submission succeeds but Sent APPEND is rejected or its acknowledgement is lost; keep submission accepted, reconcile uncertain copies before replay, and never resubmit SMTP. | Pending: W01/W08; E+R | Baseline audit records existing tests and required new oracles. |
| S33 | Two recipients are accepted and one is rejected; expose partial submission and never silently send again to the accepted set. | Pending: W01/W08; E+R | Baseline audit records existing tests and required new oracles. |
| S34 | Bcc-only and mixed To/Cc/Bcc sends preserve actual delivery recipients without exposing Bcc in recipients' raw messages. SMTP submission omits the Bcc header; Gmail raw API submission retains it as required to address delivery. | Pending: W01/W09; E+R | Baseline audit records existing tests and required new oracles. |
| S35 | Reply, reply-all and forwarding cover Reply-To, multiple aliases, self-sent messages, mailing lists and malformed addresses; compare displayed chips with the exact queued envelope. | Pending: W09; E+C+R | Baseline audit records existing tests and required new oracles. |
| S36 | Identical subjects in unrelated mail never merge solely on subject; missing or duplicated Message-ID does not erase distinct mail. | Pending: W03/W06; E | Baseline audit records existing tests and required new oracles. |
| S37 | A valid provider reply maintains conversation linkage; a deliberate subject change starts the intended new context. | Pending: W09/W07; E+C+R | Baseline audit records existing tests and required new oracles. |
| S38 | Autosave revision N completes after N+1, during send, and after discard; it cannot restore an older draft or resurrect a sent/discarded draft. | Pending: W08; E+R | Baseline audit records existing tests and required new oracles. |
| S39 | Attachment upload/removal races with Send; the queued payload references an immutable, complete revision. | Pending: W08; C+R | Baseline audit records existing tests and required new oracles. |
| S40 | A user edits recipients or attachments while offline after queuing; the pending operation's snapshot stays explicit and predictable. | Pending: W08/W01; E+C+R | Baseline audit records existing tests and required new oracles. |
| S41 | Double click Send, repeat keyboard shortcut, two tabs and process restart cannot create duplicate local send intents. | Pending: W01/W08; E+R | Baseline audit records existing tests and required new oracles. |
| S42 | A send-as alias is removed or loses permission after composition; submission fails safely and keeps the draft and selected identity visible. | Pending: W09/W04; C+R | Baseline audit records existing tests and required new oracles. |
| S43 | Provider acceptance is followed by an NDR/bounce; do not claim that acceptance proved delivery. | Pending: W01/W12; R | Baseline audit records existing tests and required new oracles. |
| S44 | Undo before dispatch cancels the exact operation; undo after remote acceptance never promises to unsend mail without a supported provider operation. | Pending: W01/W02/W08; E+R | Baseline audit records existing tests and required new oracles. |
| S45 | Nested MIME, empty HTML with useful plain text, invalid charset, missing Date, future Date, duplicate headers and message/rfc822 parts render with deterministic fallback. | Pending: W10; R | Baseline audit records existing tests and required new oracles. |
| S46 | Inline CID images with case/encoding variations, duplicate filenames, no filename and Unicode filename preserve the intended content without path traversal. | Pending: W08/W10; C+R | Baseline audit records existing tests and required new oracles. |
| S47 | Attachments cross direct/upload-session boundaries, expire midway, exceed provider/mailbox limits and lose network; recover without duplicate attachment records. | Pending: W08/W07; C+R | Baseline audit records existing tests and required new oracles. |
| S48 | A large encoded MIME payload includes base64 overhead; enforce the actual transmission budget and bound concurrent decoding memory. | Pending: W08/W10/W11; C+R | Baseline audit records existing tests and required new oracles. |
| S49 | A raw import is retried; it neither duplicates the import nor converts malformed source into a destructive empty message. | Pending: W10/W03; E+C+R+L | Baseline audit records existing tests and required new oracles. |
| S50 | HTML with remote pixels, CSS URLs, forms, scripts and navigation attempts causes no unapproved network or active content in local mode. | Pending: W12; E+R | Baseline audit records existing tests and required new oracles. |
| S51 | Logs, error objects, crash breadcrumbs and upload URLs are checked for synthetic secret/address/subject markers; sensitive values stay out of diagnostic output. | Pending: W12; E+R | Baseline audit records existing tests and required new oracles. |
| S52 | A 50k-thread backfill/recovery runs within existing event-loop and UI budgets; queue memory, retained raw bodies and tombstones stay bounded. | Pending: W11/W03; E+R | Baseline audit records existing tests and required new oracles. |
| S53 | Long account/provider errors in English and Spanish remain actionable, keyboard reachable and screen-reader named in light/dark themes. | Pending: W12; E+R | Baseline audit records existing tests and required new oracles. |
| S54 | Reauthentication or background recovery while typing preserves composer content, caret, selection, list focus and scroll. | Pending: W12/W08; E+R | Baseline audit records existing tests and required new oracles. |
| S55 | Idle after healthy sync or an authentication refusal has no spinning retry timers or unexpected network, apart from explicitly selected transport liveness requirements. Browser reload/expiry preserves queued work while token reacquisition is pending. | Pending: W11/W04/W05; E+R | Baseline audit records existing tests and required new oracles. |
| S56 | A recoverable per-message error remains discoverable after the global sync indicator returns to healthy. | Pending: W10/W12; R | Baseline audit records existing tests and required new oracles. |
| S57 | Date-range search crosses midnight, DST and a non-PST timezone; exact epoch boundaries return the intended set. | Pending: W11; E+R | Baseline audit records existing tests and required new oracles. |
| S58 | Gmail API results differ from alias-expanded/thread-wide provider UI results; communicate or implement the chosen parity rather than treating absence as deletion. | Pending: W11/W12; E+R+L | Baseline audit records existing tests and required new oracles. |
| S59 | A remote draft replacement changes its underlying message ID and a send removes the container; delayed autosave cannot target the sent message or resurrect the draft. | Pending: W08; C+R | Baseline audit records existing tests and required new oracles. |
| S60 | An inline-only Graph message reports no ordinary attachments; CID images still resolve under the explicit content policy. | Pending: W08/W07/W12; C+R | Baseline audit records existing tests and required new oracles. |

Additional audit candidates X01–X06 (late settled observations, refresh-token rotation, poison mail, visible-text matching, response validation, account-removal fencing) remain open and are specified in the baseline audit.
