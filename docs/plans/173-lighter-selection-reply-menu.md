# Plan 173: Lighter selection, marks on the preview line, Sent pinned, Reply's menu

## The request

The owner, verbatim (after comparing two screenshots of the app: an older build and the current one in Lumen with GitHub Light):

> i want to bring back these
> **Rows have more breathing room.** Image 1 puts the attachment and star icons on the preview line, so the name and time line stays clean. Image 2's top line gets busy: count, colour dot, paperclip, star and time all compete.
> **The selected row is softer.** Image 1's light blue rounded card feels gentler than image 2's heavier grey-blue fill.
>
> this is for lumen palettes and github light but i think we should do the same with other colors too, at least in light mode the selected-item wether is row or sidebar items should be lighter, it looks ugly now.
>
> move "Sent" outside the 'more'
>
> bring backthe reply all on the top, but not as a button, lets make the 'reply' button on the top show a dropdown in it and show reply all and reply only to the owner(have a good wording here like 'reply to xxx' or similar/better), of course this is only if 'reply all' is actually valid and there are more than 1 person to reply to.

## What exists

- **Row marks** (`components/thread-row.tsx`). The three-line row's first line is `from · count · [code chip, category dots, clip, star, bell, place, kept] · date`; its third line is the snippet, then the account tag (`ml-auto`). One-line rows (compact and wide) have their own columns and aren't part of this.
- **Selection colours.** `row-selected`, `row-hover` and `sidebar-accent` are explicit tokens per palette (`themes/registry.ts`); `sidebar-hover` derives from `sidebar-accent` (60 % of its alpha). Plan 160 (`2a98173ff`, `1bd9bda7f`, 2026-11-08) darkened every palette's selection to hold `TINT_FLOOR` (1.35:1 against the pane or sidebar, `BOUNDARY_STEPS`), and its hover to `HOVER_FLOOR` (1.15:1). `SURFACE_STEPS` holds the rated palettes' open row at 1.18:1 off the background and 1.1:1 off a hover. Before plan 160 the light selections sat at about 1.12 to 1.2:1, which is the look in the owner's first screenshot.
- **Sidebar More** (`components/sidebar.tsx`, plan 21). `VIEWS` is Inbox, Starred, Sent, Archive, All Mail, Spam, Trash; `PINNED = 2` shows the first two, the rest (and Reminders, Follow-ups) wait behind More. `MORE_VIEWS` derives from `PINNED`.
- **Reply in the toolbar** (`ReplyGroup` in `components/reader.tsx`). A `ButtonGroup` of Reply (words, R on the pill) and Forward. Plan 158 removed Reply all from the toolbar ("one clear way to reply … no menu"); Reply all is in the reply bar, the message's ⋯ menu, the row menu, the palette and `a`. `reachesSeveral(detail, mine)` decides whether Reply all reaches more than one person; `replyAllTo(detail, mine)` (reply-ready.tsx) says who, as "To Liam Taylor, cc Ana Ruiz and Ben Wu". `fitWords` measures which words fit, re-run when `toolbarSet` changes.

## Design

### 1. Marks on the preview line (three-line rows only)

- The first line becomes **who, how many, then the date**: `from · count · [code chip] · date`. The code chip stays up there: it's the one mark you act on at a glance, and it already sits beside the time.
- The third line ends with the marks: `snippet · [category dots, clip, star, bell, place, kept] · account`. The account keeps the right edge under the date, so account names stay one column down the list; without an account the marks take that edge. (The first build put the marks after the account; in the screenshots the account names went ragged, so they swapped.)
- The marks are vertically centred on the snippet's line, so no line moves and the row's height is unchanged. The bell keeps its rule (on the Inbox's top the date carries it).
- In Review, the answers take the snippet's place as now, and have the line's width: the marks stay on the first line, by the date.
- Compact and wide rows are unchanged (their marks are columns already).

### 2. Lighter selection in light mode, every light palette

All ten light palettes. Dark palettes are unchanged.

| token | against | now | new |
| --- | --- | --- | --- |
| `row-selected` | the pane | 1.35:1 | **1.17:1** |
| `row-hover` | the pane | 1.15:1 | **1.07:1** |
| `sidebar-accent` | the sidebar | 1.15 to 1.36:1 | **1.13:1** |

Each palette keeps its hue and chroma; only lightness changes (translucent sidebar accents in Terno, Apple and Luma change their alpha, so the vibrancy still shows through). The values are solved once and written into the registry, as now. The selection stays a step above the hover (about 1.09:1, plus the selection's tint where the palette has one). `sidebar-hover` follows `sidebar-accent` as it does now.

**Floors.** This is the owner's decision against plan 160's floors, recorded as plan 160 recorded `FIELD_FLOOR`: in light mode, `BOUNDARY_STEPS` holds the open row and the sidebar's selection at `SELECTION_FLOOR_LIGHT = 1.12` and the hover at `HOVER_FLOOR_LIGHT = 1.05`; `SURFACE_STEPS` holds the open row at 1.15:1 off the background and 1.08:1 off a hover, in light mode. Dark keeps `TINT_FLOOR`, `HOVER_FLOOR` and the current steps. Every text pair on these surfaces (`CONTRAST_PAIRS`) still holds AA: a lighter fill only raises them.

Graphite keeps its menu highlight (`#DCDCDC`): menus weren't asked for.

### 3. Sent outside More

- `PINNED = 3`: Inbox, Starred, Sent always show; Archive, All Mail, Spam, Trash, Reminders and Follow-ups stay behind More.
- Nothing else about More changes (its memory, its slide, its held row). `MORE_VIEWS` already follows `PINNED`, so "the More row you're in" no longer counts Sent.

### 4. Reply's menu

- When Reply all reaches someone Reply doesn't (`reachesSeveral`, the same rule as the reply bar's Reply all), the Reply group gets a **chevron segment** between Reply and Forward: `[↩ Reply R | ⌄ | ↪ Forward]`. Reply itself still replies at once (one click, R), so the common case costs nothing. Where Reply all reaches no one else, there's no chevron and the group is as now.
- The chevron opens a menu under it, aligned to its end:
  - **Reply to Priya** (the reply bar's own words, `compose.bar.reply`), with R.
  - **Reply all** (`actions.replyAll`), with A, and under it in the quiet ink who it reaches: "To Priya Natarajan, cc Sam Rivera and Jonah Weiss" (`replyAllTo`, truncated to the menu's width, its whole text in the item's title).
- Keys shown in the menu follow the button's rule: while a reply is ready (plan 162), R and A belong to its card, so the menu shows none.
- The chevron is an icon-only group item: named "Reply options" ("Opciones de respuesta"), with that tooltip, `aria-haspopup` from the menu trigger; Tab reaches it after Reply. Choosing an item opens the composer and hands it focus, as the message's ⋯ menu does (`handedOff` / `finalFocus`), and if nothing opens the chevron gets focus back.
- `toolbarSet` includes whether the chevron shows, so `fitWords` measures again when it comes or goes. Forward stays at the toolbar's end; Reply moves left by the chevron's width on a conversation with others in it.
- The chevron's segment is narrow (24 px, the chevron at 14 px), on the group's hairlines, in every design: pill and square.

## Tests

- **Unit**
  - `thread-row` (new `thread-row-marks.test.tsx`, rendering `ThreadRowView`): a three-line row's clip, star and category dots are on the snippet's line, not the sender's; the date is the first line's last element; a compact row's marks stay on its one line.
  - `contrast.test.ts`: the new light floors are what the light palettes are held to; dark keeps plan 160's. A light palette whose selection is lighter than `SELECTION_FLOOR_LIGHT` fails.
  - `reader` Reply menu (new `reply-menu.test.tsx`): no chevron on a two-person conversation; with three, the chevron is named, the menu lists "Reply to Priya" and "Reply all" with its people, and each item opens its mode.
- **e2e**
  - `sidebar-panels.spec.ts`: Sent shows with More closed; five rows behind More; Tab goes Starred → Sent → More.
  - `graphite.spec.ts`: the pitch check includes Sent.
  - `reader.spec.ts`: on a group conversation, the chevron's menu opens Reply all with everyone in To/Cc; on a one-to-one, no chevron.
- Typecheck, lint, `pnpm --filter @terno/ui gen:themes` (and its generated-CSS check).

## Perf

- The row moves elements between its lines; no new selector, no new render. `pnpm test:ui-perf` row-render counts unchanged.
- The Reply menu mounts its content only when opened (Base UI). `replyAllTo` runs where `reachesSeveral` already runs, once per reader render.

## Out of scope

- Dark palettes' selection (the owner said "at least in light mode").
- Menus' and the palette's highlight.
- One-line rows' mark columns.
- The reply bar (it already has Reply all).

## Revisions after the Codex review

Codex read the plan against the code (ten points). What changed:

1. **Reply all's rule.** `reachesSeveral` counted Reply all's people, so "my own message to two" and several Reply-To addresses offered Reply all although it reaches the same people as Reply. Reply all's To is always Reply's, so the rule is now "Reply all has a Cc". This also fixes the reply bar, the message's ⋯ menu, the row menu and the palette, whose comments already said "reaches someone Reply doesn't" (`reply-all.test.ts`: the row flipped, two rows added).
2. **"Reply to …" names everyone Reply reaches.** `replyName` lists every first name in Reply's To ("Bob and Cara"); with To left empty (a Reply-To that is only me), the menu and the bar say "Reply".
3. **The two-line menu item** overrides the 28 px row (`h-auto min-h-7 py-1`); the menu sizes to its words (`w-max`, 224 to 384 px), the people truncating with their whole text in the item's title.
4. **Light-only floors** are mode-aware in both lists (`SurfaceStep.mode`; the test filters by mode). Dark keeps plan 160's floors exactly. A new test holds every light palette's selections under 1.22:1, so they don't drift back.
5. **The More perf gate** counts five rows (`MORE_ROWS`); measured 4 renders a toggle.
6. **`sidebar-panels.spec.ts`**: Sent visible with More closed, Tab Starred → Sent → More, Archive in place of Sent where the closing is checked.
7. **`reader.spec.ts`**: the chevron's order, Forward unmoved, Reply moved by exactly the chevron's width, the menu's two items and people, Esc back to the chevron, Reply all from the menu with the draft taking the keys.
8. **Focus handoff**: `ReplyChoices` keeps the conversation-level `composeLanding(mode)` and the ⋯ menu's `finalFocus` rule (no focus back to a menu whose choice opened a draft; the chevron takes it back on a refusal).
9. **The preview line's room**: the snippet keeps `min(8rem, 35%)` (a search's match stands within its first words); an account with marks beside it takes at most 30 % (40 % alone) and never shrinks, so its domain is never what's cut (`account-label.spec.ts`).
10. **Screenshots** in light and dark in every design, GitHub Light included, were looked at; baselines updated where the rows, the sidebar and the Reply group changed.

## Built

- GitHub Light's open row is `#DAF1FC`, its hover `#F5F7F9`, the sidebar's selection `#E6EAEE` (the owner's first screenshot). Graphite, which has no tint, is `#EAEAEA` open and `#F7F7F7` under the pointer: the first try (`#EDEDED`/`#F8F8F8`) read as one grey in its screenshot.
- Unrelated and left alone: Atelier's `send-group-rest.png` (the composer's Send group is 2 px taller than its baseline) fails on main without this series.
