# Outlook reliability checklist for future integration

User direction: “for the outlook related things, just take note on them to do them later on after outlook integration is done”.

Status: deferred by the user; no Outlook adapter, OAuth registration, subscription broker, remote draft API or Graph behavior is being implemented in this hardening series. Resume this checklist after the integration exists. Shared reliability invariants remain active for Gmail, IMAP/SMTP and local storage.

## Integration acceptance requirements

- Bind stable tenant/mailbox/account identity and handle auth-library subject migrations and reconnect mismatches.
- Request/normalize immutable IDs across every ingress path, including search, continuation pages, subscriptions, drafts and moves. Keep IDs case-sensitive and handle archive-mailbox boundaries.
- Implement per-folder delta, opaque next/delta links, empty continuation pages, cursor expiry/reset, replay, folder hierarchy and custom/deleted-folder descendants.
- Separate folder moves from categories, use version/ETag-aware updates, snapshot mutation targets before offset pagination changes them, and account for exact per-item partial outcomes.
- Batch at most 20 requests, correlate response IDs, inspect each status and respect per-item Retry-After and bounded concurrency.
- Use native reply/forward drafts, preserve omitted versus intentionally empty recipients, Reply-To and authorized From identities.
- Keep send acceptance separate from sent-copy readability; a 202 does not establish completed processing or delivery. Never replay uncertain sends automatically.
- Implement exact attachment content retrieval, item/reference/inline distinctions, metadata-size semantics, small-upload versus upload-session boundaries and sensitive session URL handling.
- Handle lifecycle/permission differences for subscriptions/shared mailboxes only in the integration's explicit local/privacy design; no silent hosted relay.
- Qualify provider-specific search, exact participants/addresses, poison-page recovery and HTML-only body shapes.

## Deferred report entries

- **A21:** Outlook batch success is not the same as success of each message operation
- **A22:** Returning an Outlook nextLink without consuming it makes the pagination contract incomplete
- **A23:** Graph replies need real reply/forward drafts, including migration of older standalone drafts
- **B04:** Library updates can silently change provider identity keys
- **B15:** Mutating an offset-paged inbox skips every other page
- **B16:** Thread actions must enumerate the entire conversation before writing
- **B17:** All-mail must include custom folders and exclude deleted-folder descendants
- **B18:** Outlook categories are not folders
- **B19:** Category read-modify-write needs ETags and fresh recomputation
- **B20:** Bulk success is per item, not the batch HTTP status
- **B23:** Missing contentBytes is not an empty attachment
- **B24:** Attachment metadata size is not always the raw-byte size
- **B28:** Empty arrays and omitted recipient fields have different semantics
- **B33:** One unreadable Graph item can poison a whole continuation page
- **B36:** Provider-neutral search can silently inherit Gmail semantics
- **B42:** Parallel Graph fetches can surface as unavailable-mail UI
- **B44:** Search results can use a different Outlook ID namespace
- **S04:** An empty Graph page includes nextLink; the worker continues to the terminal deltaLink.
- **S24:** Graph batch envelope is 200 with mixed 204/429/404; retry only eligible failed members after the server delay.
- **S60:** An inline-only Graph message reports no ordinary attachments; CID images still resolve under the explicit content policy.

## Mixed entries that remain partly active

A02/A14–A19/A24/A34 and B01–B03/B05/B08–B14/B21–B22/B25–B32/B34–B35/B37–B41/B43/B45–B47 include shared or Gmail/IMAP behaviors. Their non-Outlook requirements remain open in the main worklist; Graph-specific drafting, attachment, ID, folder and notification details are deferred here. Likewise S11, S22, S35, S37, S42, S47 and S59 retain relevant existing-provider coverage while Graph-specific tests wait. No deferred entry is presented as implemented or tested.

Sources, historical changes and regression details remain in [the research report](provider-reliability-report.md); active work is in [the main worklist](provider-reliability-worklist.md).
