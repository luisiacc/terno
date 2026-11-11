# Plan 180, a menu on each person in a conversation

## The request (verbatim)

> i think we can do some nice menu on right click with some cool actions for each, what useful actions we could have on that right click menu

The owner pointed at the people chips under the subject (plan 177). Proposed and agreed ("ok lets build this, make sure it works, don't add useless tests, just the right tests") as the first set: New message to them, Reply to them only, Conversations with them, Everything from them (file their mail, a rule), Copy address.

## What exists

- `ThreadPeople` (`components/thread-people.tsx`, plan 177): a `ul` of `Chip`s (avatar, first name; the full name and address for screen readers), the first 6 and a "+N" toggle. Information only: no chip is a Tab stop.
- The conversation sits inside `MessageMenu`'s `ContextMenuTrigger` (`message-menu.tsx`): a right-click in the header today opens the conversation's menu (Copy as text).
- The thread menu's sender section (`thread-menu.tsx` `MoreItems`): "File all their mail ▸" (into a category, `applyScope(c, {kind: "sender"})`, or out of one the mail is in, `removeSenderFromCategory`, plan 77), "Create rule…" (the filters dialog prefilled with from = address), "Search their mail" (`from:`), "Copy address".
- Composing: `composeLanding("new", null, 0, prefill, accountId)` opens a new message with fields (plan 93's snippets); `composeLanding("reply", threadId)` then `addressReply(key, threadId, {name, address})` makes a reply to one person, their newest message as its source (plan 133 §5.2, used by AI drafting). `addressReply` never replaces recipients the person chose.
- Search: a bare address means a message whose sender or any recipient is that address (plan 140).
- ⇧F10 / the ContextMenu key on a focused element inside `[data-context-menu]` replays a right-click on it (`openFocusedMenu`, plan 106).

## Design

### The chip becomes a menu button

Each chip is the trigger of its own `DropdownMenu` (BoardUI's menu, Base UI): a click, Enter, Space or ↓ opens it under the chip; a right-click opens the same menu (and stops there: the conversation's menu doesn't open too); ⇧F10 on a focused chip does what a right-click does (`data-context-menu`). One menu root per shown chip (at most 6 before "+N"), its content mounted only while open.

So the chips are controls now: each a Tab stop, named by its full name and address, `aria-haspopup="menu"`. Plan 177's "information, not controls" is superseded. At rest they look as they did; hover and open take the menu-row hover fill (`bg-accent`), the focus ring only from Tab (plan 54).

### The menu

```
Mei Nakamura                       ← the full name, semibold
mei.nakamura@acme.studio           ← muted
─────────────
✎  New message to Mei
↩  Reply to Mei only               (not for the one person a plain Reply already goes to alone)
─────────────
🔍 Conversations with Mei
⧉  Copy address
─────────────
🏷  File all their mail ▸          (only someone who wrote here; only with categories)
⚗  Create rule…                    (only someone who wrote here)
```

- **New message to {name}**: a new message from the conversation's account, To = that person (name and address), focus in the body. Like any new message it takes the reader pane.
- **Reply to {name} only**: a reply in this conversation to them alone: their newest message is its source (someone only written to keeps the reply's usual source). A draft already open in the conversation whose recipients the person chose keeps them (`addressReply`'s rule: never lose their work); the reply opens as it is.
- **Conversations with {name}**: a search for the address, everywhere (plan 64), sender or recipient (plan 140), as "Search their mail" leaves the view.
- **File all their mail ▸ / Create rule…**: the thread menu's sender items, the same component (moved out of `thread-menu.tsx` into `sender-menu-items.tsx`, rendered with either menu's parts), so the two never drift. "Out of {category}" for the categories this conversation is in. Only for someone who wrote a message here: these are about mail *from* them.
- **Copy address**: as the thread menu's (the same function), "Copied: …".

`{name}` is the chip's own word (first name; full name or address when two share it).

Focus: an item that opens a draft hands focus to it (the closing menu restores none, as `useRespond` does); otherwise focus returns to the chip.

### Copy

New: `people.newMessage` ("New message to {name}" / "Nuevo mensaje a {name}"), `people.replyOnly` ("Reply to {name} only" / "Responder solo a {name}"), `people.conversations` ("Conversations with {name}" / "Conversaciones con {name}"). Reused: `threadMenu.fileAll`, `threadMenu.createFilter`, `threadMenu.copyAddress`, `threadMenu.copied`, `threadMenu.copyFailed`, `threadMenu.toCategory`, `threadMenu.outOfCategory`, `threadMenu.filterName`.

## Tests

Only what can break:

- jsdom (`thread-overview.test.tsx`, extended): a right-click on a chip opens its menu and not the conversation's (`MessageMenu` around it); the menu says who; "Reply only" is absent when they're the only other person; the sender items only for someone who wrote. Replaces plan 177's "no Tab stop but +N" assertion.
- e2e (`reader.spec.ts`, the plan 177 scenario): Reply to Mei only opens a reply addressed to Mei alone; New message to Mei opens a new message to Mei; Conversations with Mei runs the address search; ⇧F10 on a focused chip opens its menu; axe on the open menu in light and dark.
- The shared sender items keep the thread menu's existing tests (thread-menu e2e) as they are.

## Performance

Nothing on a hot path: a menu root per shown chip (≤ 6, React Compiler memoized), content mounted only open. The search and compose paths are the existing ones.

## Out of scope

- Files from them, Remind me if they don't reply, a contact card (no contact store), block, anything AI.
- A menu on the "To:" names in each message's header.

## Revisions after the Codex review of the plan

Eleven points; ten taken:

1. **"Reply only" isn't about a head count**: Reply follows Reply-To. It's hidden only for the person a plain Reply already goes to alone (`autoRecipients("reply")`: To is them, no Cc).
2–4. **Not a second step after the reply opens.** `addressReply` refused any authored draft, and a converted Reply all is authored, so the two-call path could leave a reply to someone else; its later write also had no ownership check. Instead `composeLanding` takes `only` (`ComposeOpenOptions`): applied where the reply's fields are built, inside compose's own guarded transaction. A draft here that goes to anyone else is readdressed the way a retarget is (a conversion), with Undo when it held their words ("The draft now goes only to Mei Nakamura" when only the recipients changed). Their newest message is the source (`sourceId`).
5. **Focus per action**: a draft takes it (none handed back); a refused or failed open gives it back to the chip while it's connected; search and rule creation leave it to what they open (Base UI's check that focus moved elsewhere, `menuFinalFocus`).
6. **`menuOpen`** is set while open and cleared if the chip goes while open (a new message replaces the reader), as `AccountMenu` does.
7. **The right-click bridge** is explicit: `onContextMenu` prevents the system menu, stops the event before `MessageMenu`'s trigger, and opens the controlled dropdown on its own trigger (anchor, `aria-expanded`, focus return). ⇧F10 goes through `openFocusedMenu` (`data-context-menu`).
8. **Refused opens** restore focus (above).
9. Not taken: a browser run of the person menu's "File all their mail" submenu. The thread menu's specs cover those rows and the parts are typed; the e2e checks the sender rows show only for someone who wrote.
10. **The e2e proves the source**: Mei wrote twice, Yuki last; Reply to Mei only answers Mei's newest message (`inReplyToMessageId`), To = Mei, no Cc. Plus an untouched Reply all converted, and a reply with an added recipient readdressed with Undo.
11. **A real button** wraps the chip (hover and open on the chip's surface); the menu is as wide as its words, not the chip.
