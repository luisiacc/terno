# Plan 201: agents give links to emails, and a click opens them in Terno

## Request (verbatim)

> i think we should be able to , on the mcp, give links to emails and they be able to see it in our app, so a click on that link lets them to our app, lets build this please and make sure it works by testing it.
>
> also if you build email ids, make sure the id is not random but the way tobuild the id needs to be repeatable using the unique email metadata, so for example if in the future we build an app for mobile we can consistely build ids in both for the same email and the email be the same.

## What exists

- **The MCP server** (`packages/mcp/src/server.ts`) names conversations and messages by Terno's local row ids (`threadId`, `messageId`): numbers from an autoincrement, different on every device and after any re-sync. Nothing an agent returns can be opened by the user.
- **Message-IDs are stored canonically.** Every message keeps its RFC 5322 `Message-ID` header in `messages.rfc_message_id`, normalized by ingestion (`normalizeMessageId` in `packages/db/src/ingest.ts` and `packages/idb/src/mail.ts`, the same code twice): trimmed, one `<` and `>` taken off, trimmed again, lower case. It is indexed per account in both stores (`messages_rfc` in SQLite, `rfc` in IndexedDB). `drafts.findMessage(accountId, rfc)` and `drafts.messageRef(messageId)` already read it.
- **Opening a conversation from outside the page**: a notification's click goes main → `OpenRelay` (`apps/desktop/src/attention.ts`, holds the last click until the window's page listens) → `terno:open-thread` → preload's `onOpenThread` → `openFromNotice` (`apps/web/src/lib/notify.ts`). Ask's sources (`openSource`, `apps/web/src/lib/ask.ts`) open a conversation that isn't in the current list and focus one of its messages (`revealSummaryMessage`, `focusMessage`).
- **No URL scheme**: the packaged app declares none, and main has no `open-url` handler. `second-instance` only brings a window forward.

## Design

### The id: the message's own Message-ID

A link names a message by its **canonical Message-ID**: the `Message-ID` header with surrounding whitespace removed, one leading `<` and one trailing `>` removed, whitespace removed again, then lower-cased (`<CAF3x+9@mail.gmail.com>` → `caf3x+9@mail.gmail.com`).

- **Repeatable and portable**: it comes from the message itself, set by the sender's server and kept by every copy (each recipient, each account, each folder, each provider). A mobile app (or anything else) gets the same id from the same message by applying the same five steps; no table, no randomness, no device state. It is also what Apple Mail's `message://` links use.
- **Findable without Terno's database**: a client that hasn't synced the message can still ask the server for it (Gmail's `rfc822msgid:` search, IMAP `SEARCH HEADER Message-ID`). A hash would lose that.
- **No migration**: the column and its indexes exist in both stores.
- The rule moves into one place, `canonicalMessageId` in `packages/core/src/mail-link.ts`; both ingestions and `normalizeRfcId` call it (they are the same code today), so a link and the stored value can't drift apart.
- A message without a `Message-ID` header (rare: some drafts, some old or broken mail) has no link. Inventing one from the sender, date and subject would not be unique or stable across providers (each reports a different date), so the MCP leaves the link out rather than give one that may open the wrong email.

### The link

`terno://message/<id percent-encoded>`, e.g. `terno://message/caf3x%2B9%40mail.gmail.com`.

- `mailLink(rfcMessageId)` builds it (canonicalizing first), `parseMailLink(url)` reads it back: the scheme, the `message` host, one path segment, decoded and canonicalized; anything else (another host, extra segments, a query, an empty or oversized id, bad percent-encoding) is null. Both live in `packages/core/src/mail-link.ts` with the canonical rule, so the MCP, main and the renderer share one definition.
- A link names a message; opening it opens the conversation that holds it, at that message. A conversation's link is its newest message's (below), so it keeps working when replies arrive or when the provider threads it differently.

### The backend

- A store namespace, `links` (`MailStore`, both stores, the conformance suite):
  - `find(id)`: the messages with that canonical Message-ID in every account: `{ id, threadId, accountId, spam, trash }[]`, first stored first (revision 2). SQLite probes `messages_rfc` once per account; IndexedDB uses `rfc` per account.
  - `newest(threadIds)`: each conversation's newest message (by date, then id) that has a Message-ID and isn't a draft, preferring one outside Spam and Trash (a conversation that is mostly elsewhere can hold a spam message: plan 185); a conversation with none is left out. SQLite walks `messages_thread` per conversation; IndexedDB its `thread_id` index. At most 500 per call (the RPC caps it).
- `links.resolve({ id })` → `{ threadId, messageId } | null`: the first of `find` outside Spam and Trash, else the first (revision 2). The renderer calls it on a click.
- `links.of({ threadIds, messageIds })` → `{ threads: Record<id, string>, messages: Record<id, string> }`: canonical ids for the MCP (`newest`, and `drafts.messageRef` per message). In `AGENT_METHODS` at `read`.
- `links.resolve` is not an agent method: agents don't open things in the app.

### The MCP

- `search_emails` and `list_threads`: each conversation gets `link` (one `links.of` call per result page).
- `get_thread`: each message gets `link` (from `rfcMessageId`, already in `MessageDetail`; no extra call).
- `wait_for_new_mail`: each arrival gets `link` (one `links.of` call).
- A link is left out when there is none (no Message-ID). In a mixed conversation (plan 185) the summary's link is to a message outside Spam, like its sender and lines.
- The instructions: "Each conversation and message comes with a link (terno://…) that opens it in Terno: when you point the user at an email, give it as a Markdown link, e.g. [Invoice from Acme](terno://message/…)."
- `SKILL.md` says the same in one line.

### The desktop app

- **The scheme is declared at packaging**: electron-builder `protocols: [{ name: "Terno", schemes: ["terno"] }]` in `commonConfig` (Info.plist `CFBundleURLTypes` on macOS, `x-scheme-handler/terno` in the Linux desktop entry). No runtime `setAsDefaultProtocolClient`: macOS and Linux register a declared scheme on install, and calling it from a test copy would take the user's links away from their real Terno. A dev run (`Electron.app`) can't be a scheme handler; it takes links from its command line only (below).
- **Main receives a link** three ways, all through one `openLink(url)`:
  - `open-url` (macOS), registered before `ready` so a link that launches Terno isn't lost;
  - a cold start's `process.argv` (Linux; a dev or test run);
  - `second-instance`'s argv (Linux; a second launch with a link while Terno runs).
  `openLink` parses it with `parseMailLink` (anything else is ignored), brings a window forward the way a notification's click does (the focused one, else the first, else a new one) and queues the id.
- **One relay for both**: `OpenRelay` carries an `OpenTarget` (`{ kind: "thread"; threadId: number | null } | { kind: "link"; id: string }`) instead of a thread id; the last asked-for wins, delivered once the page listens. The channel becomes `terno:open`; preload's `onOpenThread` becomes `onOpen`, validating each kind (a link's id is checked again with `parseMailLink`'s rules on the canonical id: a string, non-empty, at most 998 characters).
- The window comes forward with `present(win)` as for a notification; a test run in the background (`TERNO_TEST_BACKGROUND`) doesn't steal focus.

### The renderer

`openMailLink(id)` (`apps/web/src/lib/mail-links.ts`):

1. `links.resolve`. Not found: a snack, "That email isn't in Terno. It may have been deleted, or its account isn't connected here." (error tone).
2. Found: any dialog closes, a new message steps aside (`leaveNewDraft`, kept if written), a selection ends, then `openThread(threadId)`, `revealSummaryMessage(messageId)` and focus on that message (the shared `focusMessage` helper moves out of `ask.ts` into `mail-links.ts`'s neighbour `lib/focus-message.ts` so both use it without Ask's return state).
3. The list isn't changed: like an Ask source, the conversation opens in the reader wherever it lives (Split shows it beside the current list, List opens its page). A conversation in Spam or Trash opens too: the user clicked a link to it.

`startAttention` wires `onOpen` to `openFromNotice` or `openMailLink`.

### The web build

The MCP reaches the desktop app only (plan 183: `agents.status.available` is false on the web), so the web build has no link to receive. `openMailLink` is shared code; the web gets no entry point for it in this plan.

### Copy

`links.notFound` and `links.notFoundHint`, `links.failed` and `links.failedHint` (revision 9), in `en` and `es`.

## Tests

- **core** (`mail-link.test.ts`): canonical id (brackets, spaces, case, an id with `+`, `/`, `%`, `=`); `mailLink` → `parseMailLink` round-trips; parse refuses another scheme, host, extra segments, query/hash, empty, bad encoding, over 998 characters; the same header gives the same link whatever its brackets and case (the cross-device property).
- **Store conformance** (`packages/store/src/conformance`, both stores): `links.find` across two accounts, newest first, no drafts, flags; `links.newest` picks the newest, skips a draft and a message with no Message-ID, prefers outside Spam, leaves out a conversation with none.
- **Backend** (`backend.test.ts` or a new `links.test.ts`): `links.resolve` prefers a copy outside Spam/Trash, null for unknown; `links.of` for threads and messages; an `mcp` connection may call `links.of` at `read` and not `links.resolve`.
- **MCP** (`mcp.test.ts`): search, list, get_thread and wait results carry `link`s that `parseMailLink` reads back to the message's id; no link without a Message-ID.
- **Desktop** (`attention.test.ts`): `OpenRelay` with both kinds, last wins, delivered once listening; a unit test for main's argv extraction (`linkFromArgv`).
- **Renderer** (`mail-links.test.ts`): found → `openThread`, reveal; not found → the snack; a resolve for a link superseded by a newer click does nothing.
- **Packaged smoke** (`links.smoke.ts`): the built app's Info.plist declares `terno`; a second launch of the packaged binary with a `terno://message/…` argument opens that conversation at that message in the running window (the same `openLink` the macOS `open-url` event calls; LaunchServices can't be pointed at a test copy without taking the user's real links); an unknown id shows the snack.
- Typecheck, lint, the i18n guard.

## Performance and resources

- Nothing runs until a link is clicked or an agent asks: no listener beyond Electron's own `open-url` event, no timer.
- `links.of` costs one indexed probe per thread on the MCP path only; the list queries the UI uses are untouched.
- `links.resolve` is one index probe per account.

## Out of scope

- A "Copy link" command in the app's thread menu (a natural follow-up: `mailLink` is ready for it).
- An agent reading a link the user pastes (`get_thread` by link).
- Opening a message Terno doesn't have by asking the provider for it (the id allows it later).
- A web entry point (above).

## Revisions after the Codex review

1. **A link that launches Terno waits.** `open-url` is listened for at module load, but `LinkReceiver` (`apps/desktop/src/mail-links.ts`) only holds the id until `whenReady` has created the first window (after its async start-up), then opens it; later links open at once. Tested with a fake app (`mail-links.test.ts`) and, packaged, a cold start with a link (`links.smoke.ts`).
2. **A reused Message-ID can't redirect a link.** Some senders reuse Message-IDs, and the store keeps such messages apart. `links.find` lists copies first stored first (`ORDER BY id`), and `links.resolve` opens the first stored outside Spam and Trash, else the first: a copy that arrives later (a forged or careless reuse) never takes over a link that already opened something. Ambiguity isn't shown to the user: the same message in two accounts is the common case and opening either is right.
3. **A mixed conversation never links to its Spam message.** `links.newest` takes the newest message with a Message-ID outside Spam and Trash; it falls back to one in Spam or Trash only when the whole conversation is there. A mixed conversation whose clean messages have no Message-ID gets no link (conformance test).
4. **Drafts are the same everywhere.** `links.find` no longer skips drafts, so any message `get_thread` or `links.of` names opens; only `links.newest` skips them (a conversation's link is its mail, not a draft).
5. **A slow lookup yields.** `openMailLink` captures its own sequence, the selection-write revision and the focus intent (a key or a press) before `links.resolve`; any of them changing, or a notification's click (`supersedeMailLink`), makes it open nothing. Its focus follows `focusAfterDialog` with the same guard. `focusAfterDialog` and the message's focus target moved to `lib/focus-message.ts`, shared with Ask.
6. **The full-message view gives way.** `openMailLink` calls `returnFromMailReaderView()` before opening, so a link to another message of the conversation that's open in the full view shows it.
7. **Bounded work.** `links.find` returns at most `LINK_COPIES_MAX` (50) copies; `links.of` takes at most 100 conversations and 100 messages (an MCP page is at most 100). `newest` is one walk of a conversation's messages, as Ask's `askNewest` does on IndexedDB; it runs on agent calls only, never on the UI's lists.
8. **Test builds claim no scheme.** `protocols` is added only when `TERNO_TEST_BUILD` is unset, so an update-test bundle never competes for the user's links.
9. **"Couldn't look it up" is not "not found".** A rejected `links.resolve` (the backend restarting) shows "Couldn't open that email · Terno couldn't reach your mailbox just now. Try the link again in a moment." and changes nothing; "That email isn't in Terno" is only for a lookup that answered null.
10. **The real entry points are exercised.** The packaged smoke emits `open-url` on the running app's own listener, launches the binary a second time with a link (`second-instance`), and cold-starts with one.
11. **Tests at every level.** Unit tests for the renderer's opener (found, not found, failed, superseded), the packaged smoke for the visible result (the conversation shown, the message drawn open and focused), and `pnpm test:all` for the store contract change.

Not taken: e2e in the web build. The web build has no way to receive an OS link (above), so the whole visible path is the packaged smoke; Split versus List doesn't change `openMailLink` (it calls `openThread`, which already handles both).