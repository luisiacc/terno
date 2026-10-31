# Plan 94: Unsubscribe from the conversation menu

## Request (verbatim)

> if we identify a one clck subscription in the metadata or an unsubscribe url in the email, on the email list, lets add a menu to the right click menu called "Unsubscribe" that will just click that one

## What exists

- `List-Unsubscribe` is read at ingest only as a yes/no: `bulkHeaders()` (core `people.ts`) folds it into `messages.is_bulk` (plan 17). Neither the header's URIs nor `List-Unsubscribe-Post` are kept.
- IMAP fetches `list-unsubscribe` with the envelope headers (`imap.ts`); Gmail parses the raw message (`mime.ts` `parseRaw`).
- Bodies are stored locally (`message_bodies`), so a link in the mail can be found without the network.
- The thread menu (`thread-menu.tsx`) already loads per-row data lazily when it opens (Review's Always offers, the Similar submenus).
- The network policy (`net-policy.ts`) names a purpose for every connection; sender icons (plan 22) reach arbitrary sites through a Node transport that refuses every non-public address and follows no redirect on its own.
- `store.compose.queueSend` sends mail through the ops queue (Sent copy, retries, sign-in holds).

## Design

### 1. What counts as "identified"

A conversation can be unsubscribed from when its newest message that isn't yours (not sent, not a draft) offers one of, in this order:

1. **One-click** (RFC 8058): `List-Unsubscribe` has an `https:` URI and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Terno POSTs `List-Unsubscribe=One-Click` to it. Nothing opens.
2. **Mail** (RFC 2369): a `mailto:` URI in `List-Unsubscribe`. Terno sends that message from the account the mail came to (the URI's `subject` and `body`, else subject "unsubscribe"), through the normal send queue.
3. **Page**: an `http(s):` URI in `List-Unsubscribe` without one-click. Terno opens it in the browser (the page usually asks to confirm).
4. **Link in the mail**: no usable header (older mail, or senders without one): the last `<a>` in the HTML (or `Unsubscribe: https://…` in the text) whose text, `title` or `aria-label` says unsubscribe (English and Spanish: unsubscribe, opt out, darse/dar de baja, cancelar (la) suscripción, desuscribir(se), anular suscripción). Opened in the browser, exactly as a click on it in the reader would.

Only `http:`, `https:` and `mailto:` URIs are kept; each at most 2,048 characters (a longer one is dropped, not truncated). One-click needs `https:`.

### 2. Storage (both stores)

- Core (`unsubscribe.ts`): `type Unsubscribe = { oneClick?: string; mailto?: string; url?: string }`, `parseListUnsubscribe(listUnsubscribe, listUnsubscribePost)`, `findUnsubscribeLink(html, text)`, `mailtoParts(uri)`, and `unsubscribePlan(source)`, the order of §1, shared by both stores and the backend.
- `ParsedMessage.unsubscribe` and `IncomingMessage.unsubscribe?: Unsubscribe | null`. IMAP adds `list-unsubscribe-post` to the headers it already fetches; Gmail reads both from the raw message.
- **SQL v38**: `ALTER TABLE messages ADD COLUMN unsubscribe TEXT` (compact JSON, NULL when none). Insert writes it; a re-ingest keeps it unless the new copy carries one (`coalesce`).
- **IndexedDB**: the same field on the message record (absent reads as null), `LOGICAL_SCHEMA = 38`, no index, no IDB version change. Messages live in memory there: the field is absent for most mail and ≈150 bytes for a newsletter (at most 3 × 2 KB by the caps).
- **`threads.unsubscribeSource(threadId)`** (both stores, one conformance suite): the thread's newest 50 messages that aren't sent or drafts (by the thread index), your addresses skipped; the first with the header wins, else the newest one and only its body (see the review's #5 and #6). The debug snapshot carries the column, so the stores' parity tests compare it.
- Mail stored before v38 has no header data; the link in the mail (§1.4) still works. No backfill (the backfill never touches the network, as plan 17 §8).
- Demo data: newsletters carry a `mailto:` header only (review #12).

### 3. Backend (`unsubscribe.ts`, `unsubscribe-node.ts`)

- `unsubscribe.find({ threadId })` → `{ messageId, method, target, name, url? } | null`, read when the menu opens, no network. `target` is what the user sees: the host (one-click, page) or the address (mail). Only a page carries its `url` (the renderer opens it); the one-click URI and the mail's body never reach the renderer.
- `unsubscribe.run({ threadId, messageId, method, target })` resolves again and refuses (`STALE`) when that changed (review #9), then:
  - one-click: checks the destination (`postAllowed`: https, port 443, no credentials, no non-public IP literal, no local name), asserts the policy, POSTs through the host's `UnsubscribeTransport` with a 10 s deadline. 2xx: `unsubscribed`; 3xx or an opaque answer: `requested`; a refusal, a failure or a refused destination: `open` with `failed: true` when the header has a page, else an error. A host without a transport: `open`, `failed: false`.
  - mail: `store.compose.queueSend` from the account the mail came to (`recordReply: false`), its categorizer deltas applied, `notifyChanged`, `kickWorker`: `queued` with the op id.
  - page: `open` (only reached by an older renderer: the menu opens pages itself).
- **Network policy**: a new purpose, `"unsubscribe"`, allowed in both modes: it is the user's explicit, per-conversation choice, to the sender who sent the mail (the same reasoning as loading a message's remote content in local mode, plan 37). It is never made without that click. In a browser it is sent with `redirect: "manual"`.
- **Node transport**: `node:https`, one socket, the icons' public-address lookup (now `publicOnlyLookup`, shared), no cookies, no referrer, a browser User-Agent, the response body never read. One narrow exception in the architecture test.
- **Web**: `browserUnsubscribeTransport(net.fetchFor("unsubscribe"))`, built by core on the web host: `mode: "no-cors"`, `credentials: "omit"`, `referrerPolicy: "no-referrer"`. A browser can't resolve names, so the guarantee there is the URL check (literals and local names) plus the browser's own private-network protections.
- backend-dev takes `unsubscribeTransport`; the e2e fixture always passes a recorder.

### 4. Renderer

- `thread-menu.tsx`: for one conversation (not a selection or a "select all N"), `UnsubscribeItem` asks `unsubscribe.find` when the menu opens and shows **Unsubscribe** (`MailMinus` icon, the target muted beside it) only when something was found. It sits at the end of the sender group (after Copy address), so appearing doesn't move the items above it.
- A page opens in the click itself (a browser blocks a window opened after a wait). The rest runs `unsubscribe.run`, with a snackbar that says what happened:
  - one-click, 2xx: "Unsubscribed from {name}."
  - one-click, 3xx or opaque: "Sent an unsubscribe request to {host}."
  - mail: "Queued an unsubscribe request to {address}."
  - page: "Opened {host}’s unsubscribe page in your browser."
  - one-click refused, with a page: "{host} didn’t take the one-click request. Finish on its unsubscribe page." and an **Open page** action (a click of its own, so the browser lets it open).
  - failure without a page: "Couldn’t unsubscribe: {host} didn’t take the request. Open the message and use its unsubscribe link."
- `openLink` moved to `lib/open-link.ts` (mail-body re-exports it) so the menu doesn't import the mail frame's module.
- New strings in `en` and `es`; the icon is one catalog line.

## Tests

- core: `parseListUnsubscribe` (order, angle brackets, whitespace and folding, one-click only for https, caps, bad URIs); `findUnsubscribeLink` (HTML anchors by text/title/aria-label, last one wins, entities, Spanish words, text bodies, ignores `javascript:` and non-http).
- mail: `parseRaw` reads both headers; the IMAP header list includes `list-unsubscribe-post`.
- stores (conformance, both): ingest keeps `unsubscribe` through a reopen and a re-ingest without it; `unsubscribeSource` skips sent mail, drafts and your own address (a copy that came back), prefers the header, else reads the newest body; null for only your mail or no thread.
- backend: `find` order (one-click > mail > page > link; your own messages skipped); `run` one-click POSTs exactly `List-Unsubscribe=One-Click` with the form content type and no credentials; failure with and without a page; mail queues a send from the right account; works in local mode; the node transport refuses private addresses (test lookup).
- e2e (`apps/web/e2e`): right-click a newsletter → Unsubscribe → the recording transport saw the POST and the snackbar says so; a personal conversation has no item; a selection of two has no item.

## Perf

- Opening the menu adds one indexed read of at most 50 message rows and, without header data, one body (≤ 512 KB scanned, linear regexes). Nothing on ingest beyond parsing two short headers.
- No new indexes, no backfill, no timers, no network until the click.

## Out of scope

- Unsubscribing several conversations at once; a reader-pane button; the palette command.
- Remembering that you unsubscribed (hiding the item, or archiving their mail afterwards).
- Fetching headers again for mail stored before v38.

## Revisions after the Codex review

1. **Redirects.** The policy's browser branch forces `redirect: "follow"`. The `"unsubscribe"` purpose gets `redirect: "manual"` there (an opaque redirect comes back, never followed); the Node transport never follows one. A 3xx is "sent", not "unsubscribed" (point 4).
2. **Address checks before the request.** The Node transport refuses before connecting: anything but `https:`, a port other than 443, credentials in the URL, an IP literal that isn't public (v4, v6, v4-mapped), and then resolves through the icons' guarded lookup (every answer public, the socket pinned to the checked address). Tests cover literals, mapped v6 and mixed public/private answers.
3. **The browser can't resolve names.** The web transport refuses non-public IP literals and local names (`localhost`, single-label hosts, `.local`, `.localhost`, `.internal`, `.lan`, `.home.arpa`) before the request; it can't see where a public name resolves, which the plan states instead of claiming the Node guarantee (browsers' own private-network protections apply on top).
4. **Honest outcomes.** `run` answers one of: `unsubscribed` (a 2xx on Node), `requested` (a 3xx, or the web's opaque answer: the request went out, the answer can't be read), `queued` (mail), `open` (a page), and on a refused or failed POST `open` with `failed: true` when the header has a page, else an error. Copy: "Unsubscribed from {name}." / "Sent an unsubscribe request to {host}." / "Unsubscribe request to {address} queued." / "Opened {host}'s unsubscribe page in your browser." / "{host} didn't take the one-click request, so its unsubscribe page opened in your browser."
5. **Whose message.** A store read, not `MessageDetail` (which has no draft flag): the thread's newest messages that aren't sent, drafts, or from one of your accounts' addresses, by `date DESC, id DESC`.
6. **Bounded read.** New `threads.unsubscribeSource(threadId)` in both stores: the newest 50 such messages' metadata (`fk_thread_id` index), the first with header data wins; only without one is the newest one's body read (one body: SQL a point read, IndexedDB `readLazy` of one id). No change to `MessageDetail` or `getThread`.
7. **mailto contract.** Only `to` (one valid address, no `,;` or whitespace), `subject` and `body` are used; other fields (`cc`, `bcc`, headers) are ignored; the first of a repeated field wins; a bad percent-encoding refuses the URI; CR/LF are removed from the subject; subject ≤ 998, body ≤ 10,000 characters.
8. **Queued, not sent.** Mail says "queued", returns the op id, and applies `queueSend`'s categorizer deltas as `compose.send` does.
9. **The offer that was shown is the one that runs.** `find` returns `{ messageId, method, target }`; `run` takes them back and refuses ("This conversation changed. Open the menu again.") when its own resolution differs.
10. **Wiring.** `BackendOptions.unsubscribeTransport`: desktop (`backend.ts`) defaults to the Node transport; the web worker gets the browser one (built by core on the web host from `net.fetchFor("unsubscribe")`); backend-dev and e2e inject a recorder; `null` means this host can't POST, and one-click falls back to the page. The architecture test gets one narrow exception for the Node transport file. Every POST asserts the policy first (`net.assert("unsubscribe", url)`).
11. **IMAP body completion** doesn't enrich it: IMAP reads both headers with the envelope (it now fetches `list-unsubscribe-post` too), so the body pass has nothing new; Gmail parses both from the raw message at ingest.
12. **Demo data.** Mock newsletters get `List-Unsubscribe: <mailto:unsubscribe@{list}>` (the demo provider never sends), so the demo never opens a real site through this; the e2e intercepts both the recorder's POST and the page opening.

## What the Codex code review changed

1. **Linear link scan.** The anchor regex rescanned the rest of the body for every unclosed `<a` (≈0.7 s at 64 KB of `<a `, on the menu's open). `findUnsubscribeLink` now walks anchors in one forward pass (the next `</a>` found once and reused, an anchor opened inside another ends it, as a browser reads it). Test: four adversarial bodies up to 512 KB, each under 150 ms.
2. **The web's POST was never sent.** Browsers refuse a `no-cors` request whose redirect mode isn't `follow`, and the policy sends `"unsubscribe"` with `manual`. The web transport now uses `cors` mode: a form POST is a simple request (no preflight), so it is sent; a sender that doesn't allow the origin answers unreadably, which counts as `requested` (as an opaque redirect does); offline it fails. Tests pin the init through the real policy wrapper and the Fetch rule.
3. **A moved menu could keep the last row's offer.** `UnsubscribeItem` is keyed by the conversation, so a menu moved onto another row starts empty (and stays so if that row's lookup fails). The e2e makes the lookup fail and fails without the key.
4. **`+` in a mailto body was turned into a space.** RFC 6068 keeps it (tokens use it); only `%20` is a space. Test: `token+ABC%2BD%20E`.
5. **IndexedDB read the whole conversation, filtered and sorted it.** `unsubscribeCandidate` walks the thread index's keys once, keeping the newest 50 in a small sorted window. Perf test: a 60,000-message conversation within a frame.

The full unit run's other failures (IndexedDB legacy-image upgrades, the i18n scan and store-boundary on `w02-action-fixture.ts`, `app.import` counting snippets, a Gmail clock test) fail the same on `main` at 890371a4; `gmail-cooldown` W05 and two `network.int` cases are timing-flaky on `main` too.
