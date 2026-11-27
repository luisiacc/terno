# Plan 284: A link's own items in the reader's menu

- **Status:** built.

## The request (verbatim)

> when right lcicking in an email view, on a link or in this case an email address, we need some items added there, for example in here we need to have one to send a message to that address

The screenshot: a right-click on `casasupport@tacsecurity.com`, a `mailto:` link in an HTML mail, opens the conversation's menu (Reply to this message, Forward, New message to ESOF…, Copy conversation as text, Print…), with nothing about the link under the pointer.

And, while it was being built:

> also right now clicking that and selecting 'copy address' it copies the address of the sender, not the address of the email addres i right licked into, lets also look into the other items if they make sense to show while right clicking an email address, do the same for links, lets have useful items in the right click menus when lcicking those

## What exists

- **The conversation's menu** (`components/message-menu.tsx`, `MessageMenu`): one `ContextMenu` around the conversation. Its `onContextMenu` reads the message under the pointer (`[data-message-id]`) and any selected text; the menu starts with Copy for a selection (the desktop app has no native menu), then `MessageItems`: the message's answers, the person it's from (`PersonItems`, plan 194), copy, print, original.
- **HTML mail** (`components/mail-body.tsx`): a right-click inside a mail's frame doesn't leave it, so the frame's document replays it as a new `contextmenu` on the `<iframe>` element. The menu sees the frame as the target and loses what was under the pointer.
- **Plain-text mail** renders its URLs as `<a href>` in the page (`URL_RE`), so a right-click there reaches the menu with the link as its target. Bare addresses in text aren't linked.
- **`wantsNativeMenu`** (`lib/print-open.ts`): on the web build, a link, image, field or selection keeps the browser's own menu; the desktop app has none, so it always gets ours.
- **A link's click** (`lib/open-link.ts`): http(s) and `mailto:` go to the system (desktop) or a new tab (web), never anywhere in Terno.
- **Person items** (`components/person-menu.tsx`): "New message to {name}" opens a new draft to them from the conversation's account; "Conversations with {name}" searches everywhere for the address (plan 140, an inline `setApp`); Copy address (`copyAddress`, with its "Copied: …" snack).
- **`mailtoParts`** (`packages/core/src/unsubscribe.ts`): RFC 6068 parsing of one-recipient `mailto:` URIs, with plan 96's "unsubscribe" defaults for subject and body.

## Design

A right-click on a link is about the link: the menu holds the link's items **instead of** the message's. The message's items there were about someone else (the sender's Copy address copied the sender), and Mail does the same. A right-click beside the link, or the message's ⋯, still has the message's. A selection's Copy stays first.

1. **Which link.** The frame's replay records the element it came from: `lib/menu-origin.ts` keeps a `WeakMap<Event, Element>` (`replayMenu(frame, source, init)` dispatches and records; `menuOrigin(event)` reads it back, or the event's own target). `MessageMenu` takes `closest("a[href]")` of the origin and its resolved `href`. No DOM attribute, no module state that outlives the event.
2. **What a link offers** (`lib/menu-link.ts`, pure): `menuLink(href)` is
   - `{ kind: "mail", to, subject }` for a `mailto:` with one valid address (parsed by a general `mailtoLink` in core, which `mailtoParts` now builds on with its unsubscribe defaults);
   - `{ kind: "web", href }` for http(s);
   - `null` for anything else (a `mailto:` to several people or none, `tel:`, a fragment), which adds nothing.
3. **The items:**
   - an address: **New message to {address}** (a new draft to it from the conversation's account, with the link's subject when it gives one; the same `compose` hand-off as the person items, so focus lands in the draft), **Conversations with {address}** (the same search as the person items, now one `searchConversationsWith(email)` in `lib/people.ts` that both call), **Copy address** (`copyAddress`).
   - a web link: **Open link** (`openLink`, as its click), **Copy link** ("Copied link" snack, "Couldn't copy" on failure).
   The labels reuse `people.newMessage`, `people.conversations`, `threadMenu.copyAddress` and `compose.link.open`; only "Copy link" and its snack are new (en + es). Open in People isn't offered: an address in a link may have no mail, and its page would be empty.
4. **Width.** An address is long: with an address's items the menu is `w-max min-w-60`, at most 24 rem or the room there is (`--available-width`), and each label truncates.
5. **The web build.** A `mailto:` link now takes our menu there too (`wantsNativeMenu` lets it through): the browser's own offers only to copy it, and writing to the address is what the user wants. A web link keeps the browser's menu (open in a new tab, copy link). The desktop app gets both kinds from us, as it already gets the menu.

The body a `mailto:` may carry isn't used: a new draft's body is the composer's (signature, rich text), and a link's prefilled body is rare. Its cc and bcc aren't either, as `mailtoParts` has it.

## Tests

- **Unit** (`mailto.test.ts`): one address with its subject and body, nothing where it gives none (no unsubscribe default); several, none, a `to` field, a broken escape → `null`; a fragment left out, `%23` read as `#`. `unsubscribe.test.ts` keeps `mailtoParts`' defaults.
- **Unit** (`menu-link.test.ts`): `menuLink` for addresses, pages and everything else; `linkAt` from inside a link, and a frame's `#top` and `""` as written (no items); `menuOrigin` for a replayed event and any other.
- **e2e** (`link-menu.spec.ts`, one page): in an HTML mail's frame, a right-click on an address's link (inside a span) has exactly New message to …, Conversations with …, Copy address, and Copy address copies the link's address; beside the link, the message's items and no link's; on the web a page's link keeps the browser's menu, uncancelled; ⇧F10 on a focused link opens the address's items; Conversations with searches the address; New message opens a draft to it with the link's subject, from the conversation's account, and the menu leaves no shortcut waiting.
- The desktop's web-link items are the same code path (`menuLink`'s web kind, the same component); no packaged smoke for them.

## Perf

Nothing on a hot path: one `closest` and a string parse per right-click.

## Out of scope

- Clicking a `mailto:` link still hands it to the system (plan 37's rule for links). Opening it as a Terno draft is its own change.
- Bare addresses in text, images (Save image, Copy image), and a link's destination shown in the menu.

## Revisions after the Codex review

Codex's critique of the plan (10 points), and what changed:

1. **The replay and the origin stay apart** (point 1): the menu still reads the message, the selection and its containment from the event's own target (the frame); only the link comes from `menuOrigin(e.nativeEvent)`.
2. **One native-menu decision** (point 2): only an address the menu can write to (`linkAt(…).kind === "mail"`) leaves the browser's menu on the web; a malformed `mailto:` or one to several keeps it. A selection keeps it too, as before. The menu no longer asks again for a right-click the app replayed (`isTrusted`): that was decided where it began, and there is no browser menu behind a replay.
3. **The raw `href`** (point 3): `linkAt` reads the attribute as the mail wrote it. A frame's `srcdoc` resolves `#top` or `""` against the app's own address, which would have offered Open link on the app.
4. **`mailto:` edge cases** (point 4): a `to` field (someone else) makes it no one address; a literal `#` ends it; `%23` is a `#` in the subject. `mailtoParts` keeps its cases.
5. **The keyboard** (point 5): ⇧F10 or the menu key on a link focused in a mail's frame is forwarded to the app (as F6 is), and `openFocusedMenu` replays the menu on the frame with that link. A plain-text link is `data-context-menu`, so the key opens the menu with its items there too.
6. **Conversations with** (point 6) is the person menu's search, unchanged, now one function both call (`searchConversationsWith`); whether it should leave a focused account is plan 140's question, not this one's.
7. **The draft** (point 7): the e2e asserts its account and subject (the test hook now reports both); the unit test covers a link with no subject, which gets none.
8. **Two Copy address rows** (point 8): gone with the owner's follow-up: on a link, only the link's items.
9. **Width** (point 9): capped by the room there is.
10. **Desktop smoke for the web link** (point 10): not added. Open link is `openLink`, the same call the link's click makes, and Copy link is the clipboard as Copy address uses it; the e2e covers the shared path.

## What the Codex code review changed

Seven findings; five fixed, each with an e2e check that fails without it:

1. **⇧F10 off a link** (finding 1): the frame forwarded the key wherever focus was in the mail, and with no link the list's menu opened for its selection. The frame forwards it only on a link whose menu is ours.
2. **⇧F10 on a page's link on the web** (finding 2): it opened our menu, where a right-click keeps the browser's. One rule now says whose a link's menu is (`ownsLinkMenu`: every link we offer on the desktop, an address's on the web), used by the right-click (`wantsNativeMenu`), the frame's key, `openFocusedMenu` and a plain-text link's `data-context-menu`.
3. **A right-click on a plain-text URL on the web had no menu at all** (finding 3, older than this plan): skipping Base UI's handler left its document listener, which cancels every right-click inside the trigger. A right-click left to the browser stops at the trigger.
4. **A picture inside an address's link** (finding 4) took the browser's menu on the web: the link around it decides now.
5. **The draft's account** (finding 6): the mail is in the second account, so the compose fallback (the first) would fail the check.

Not changed: a long press on a touch screen keeping the last link's items (finding 5; the menu learns what it's on from `contextmenu`, as it always has for the message, and a touch screen on the desktop app is rare), and a packaged smoke for Open link and Copy link (finding 7; see point 10 above).
