# Plan 251: the digest's list beside the newsletter

## Request

> we need an improvement here in the automated emails section, when i click a newsletter or just an item here, that list right there needs to move to the left so i can click whichever, and we'd need a key shortcut if you press the j,k,down arrow, up arrow , it moved to the next/previous depending on the key , we'd remove the 'press esc to go back'
>
> to move the list from there to the left when they click in one of them, we need a fast and smooth transition, maybe a view transition, figure out what would be clean and smooth.

## What exists

- The digest's page (plan 145, plan 161, plan 162; Automated mail is its digest-off form, plan 235) is `DigestPage` (`components/digest-page.tsx`), drawn by the reader when `selectedId === DIGEST_ROW_ID`. In Split, What matters' feed is the list column beside it.
- A row's Open (`openFromDigest`, `state/today.ts`) keeps the page's pick (ticks, scroll, `from`, `opened`), sets `fromDigest` and selects the newsletter: the page unmounts and the reader shows the newsletter, with a "Back to the digest (Esc)" button above it. Esc, that button, the reader's × and the reader's Archive/Trash/Spam (`leaveToDigest`) come back to the page (`backToDigest`), which restores its scroll and puts the keys on the row it came from. Everything the page holds outlives it in `useToday.pick`: it is built to be unmounted and mounted again.
- The page has the list's keys while it has the keys (`digestKeys`): j/k (and ↓/↑, the same commands) move a focus cursor over its rows, x ticks, Enter opens. With a newsletter open the page is gone, so j/k walk What matters' feed behind it.
- Nothing in the app uses the View Transitions API yet. Electron 45 (Chromium 142) has it, `view-transition-class` too.

## Design

### One model: a newsletter opened from the digest has the digest as its list

In Split, while a newsletter the digest opened is in the reader (`fromDigest === selectedId`), the list column shows the digest's list instead of the feed: the same `DigestPage`, in its column form (`place="column"`), over the feed. The feed stays mounted under it, invisible and inert, as the mail list stays laid out under a page, so its scroll and place survive. Nothing new holds state: the column reads and writes the same `pick` the page does, so ticks, what was opened and what was archived are one set whichever form shows them.

The column form:
- the title on the list header's line, in the list's title type (as "What matters" sits); for a digest, its provenance at the title row's end (who wrote the lines stays said wherever they're shown). The page's hints (the off hint, coverage, the tick hint) are the page's: the column is for moving between items.
- the same rows (tick, sender, subject, date, a digest's line), on the feed's column and padding, the open one marked as the list marks its open row (`bg-row-selected`, `aria-current`). A click opens that one in the reader; the column stays.
- the same foot (count, Tick all, Hide, Archive selected): ticking while reading works.
- no ×: the reader's × and Esc are the way back (below), and two closes side by side would read as two different things.

### Keys

While the column shows, it has the list's keys wherever focus is (the reader included), as the mail list has them in Split, except in a dialog, a menu or a field (the resolver already keeps fields and dialogs):
- j / ↓ and k / ↑: the next / previous row opens in the reader (the list's own step, `list.next`/`list.prev`). Focus stays where it was: in the column it moves to the new row; in the reader it stays in the reader. The row scrolls into view.
- x: ticks the row with focus in the column, else the open one.
- Enter / o on the open row: into the reader, as the list's Enter does (`focusReader`); on another row: opens it.
- Esc: back to the page (unchanged), and the list moves back to the reader.

The "Back to the digest (Esc)" button above the newsletter goes: the list beside is the way back to any item, and Esc and the reader's × ("Close (Esc)") still go back to the page.

### The move: a view transition

`lib/morph.ts`: `morph(update)` runs a state change inside `document.startViewTransition`, with `flushSync` so React's commit is the new snapshot. Elements marked `data-morph="<name>"` are given that `view-transition-name` (inline, only for the transition) when they're fully in view in their scroller (`data-morph-clip`, less its `scroll-padding-bottom`, which is the foot bar's height): an element scrolled out of its pane would otherwise fly in from outside it. Named in the old state before the update, cleared, and named again in the new state inside the callback, all cleared when it finishes.

Marked: each row (`digest-row-<threadId>`, class `digest-row`), the title (`digest-title`) and the foot (`digest-foot`). A row keeps its height and its left edge's content on both sides, so its images aren't scaled: `object-fit: none`, anchored left, cropped by the group (`overflow: clip`). The row glides from the reader's column to the list's while it narrows; the rest (the feed going, the newsletter coming) cross-fades as the root.

Timing: `var(--motion)` (the user's 0–100 ms), `--motion-ease-drawer`. Motion off or reduced (`motionMs() === 0`), or no API (an older browser for the web build): the update runs at once, no transition. The transition only runs where the layout changes: Split, page → column (`openFromDigest` from the page, `reopenFromDigest`) and column → page (`backToDigest`, so Esc, ×, and the reader's Archive/Trash/Spam). Opening another row from the column changes only the reader: no transition.

To make the glide mostly horizontal, the row lands at the height it left: the pick keeps the row a newsletter was opened from and its height on screen (`anchor: { id, y }`), written as it's opened from the page, and by the column as it goes back only if it moved there (scrolled, or another row open: else the column may have clamped it and the page lands where it was); whichever form mounts puts that row at that height. The page's existing restore (`pick.scroll`) is the base; the column's scroll is its own (it never writes `pick.scroll`), and `from` (the page's way-back row) is the page's to use.

### List

No list column to move to: the newsletter is a page over the feed, as before. The in-body button goes there too, so the toolbar's Back (List's own way back) says the digest's title and goes back to the digest page (`goBack` → `backToDigest` first). j/k on that page keep their behaviour (out of scope below).

### Owner's decisions kept

- Archive, e, Trash and Spam on a newsletter the digest opened go back to the page, where it was (owner's decisions (2)); with the list beside, that is the list moving back.
- The reader's × does what Esc does: the digest first.
- Opened is read and stays in the Inbox unless ticked (plan 145, plan 235): j through the list opens (reads) each row. In a digest that unticks them, as opening one by one always has; x ticks one back.

## Tests

- Unit (`lib/morph.test.ts`): no API or motion off runs the update without a transition; names only the fully visible marked elements, in the old and the new state, and clears them after; a throw in the update still clears.
- e2e (`today.spec.ts`), Split:
  - Automated mail: clicking a row puts the list in the list column (the feed hidden, the page gone), the newsletter in the reader, the open row marked; no back-to-digest button. Clicking another row opens it, the column stays. j/↓ and k/↑ open the next/previous, from the column and from the reader, focus staying where it was; x ticks the open row; Enter goes into the reader. Esc: back to the page, on the row, ticks kept.
  - the existing digest flows (ways back, owner's decisions (2), keys on the page) move off the removed button to Esc / the reader's ×; "the digest's way in" is no longer reachable with the column over the feed, so it leaves that list.
  - a view transition runs on page → column with motion on, none with motion off (`document.startViewTransition` spied).
- e2e List: the toolbar's Back says the digest's title and goes back to the page.
- Screenshots of the column in light and dark, macOS and another style, looked at.

## Perf

The digest is at most 40 rows (`DIGEST_CANDIDATES_MAX`): the column renders them plainly, as the page does. Opening another row re-renders that list once. The transition is one `startViewTransition` per layout change, nothing at rest, no timers; names exist only during it.

## Out of scope

- j/k stepping through the digest in List (the newsletter's page there keeps the feed's keys).
- Changing what an opened row means for Archive (plan 145).
- Animating anything else with view transitions.

## Revisions after the Codex critique

1. **A deferred update breaks an action's Undo** (`act()` reads the selection it leaves at once). The state helpers stay synchronous; only a person's way there and back glides (the page's row Open, Esc, the reader's ×, ⌘[ in a frame). The reader's Archive/Trash/Spam (`leaveToDigest`) and Undo (`reopenFromDigest`) change the layout at once, without a transition.
2. **A queued transition can act on stale navigation.** Each deferred update checks again that nothing moved (the page still open, the newsletter still the one); a change while a transition runs skips it and goes at once (`morph`'s `running`); each transition clears only its own names.
3. **Selection commands would act on the hidden feed.** While the list is beside, ⌘A, `* a/r/u/s` and ⇧J/⇧K select nothing (`digestListBeside`); the feed is inert under it.
4. **j/k inside an HTML mail's frame** never reach the app: as the mail list's own j/k there. Left as is (out of scope).
5. **Enter on the open row** is a native button click: the row's Open on the row already open goes into the reader (`focusReader`), for Enter, `o` and a click alike.
6. **One scroll value can't hold both forms.** The column keeps its own scroll, never writes `pick.scroll`, never consumes `from`; the anchor is used only when its row is there; the column keeps its open row above its foot.
7. **The two forms may render from different snapshots.** Both seed from the same `useToday.digest` and read the same endpoint as the page always has; what's live is set from the first render (not an effect), so a form mounted for the new snapshot never shows an archived row as live.
8. **The open row can leave the list** (Hide sender, Archive selected, a new batch). The column keeps the open row's place; j then opens the row that took its place, k the one above it.
9. **List's Back has more ways in.** `goBack` checks the digest only on a conversation page (a closed page keeps its selection); ⌘[ inside a frame goes back to the digest in List too.
10. **Skip to list and F6 would target the covered feed.** The column is inside the list's section (the feed's wrapper alone is inert), and `focusFeed` hands focus to the column's open row.
11. **Rows at the column's width.** Beside, the sender and a row's state shrink and truncate so the subject keeps room, a digest's line is clamped to two lines, and the opened row's "stays in Inbox" (the page's to say) isn't repeated there. The foot puts its count on a line of its own with the buttons at the end.
12. **Tests.** The feed's scroll is checked untouched under the column; the old button's assertions now check the column (`BESIDE`); axe in light and dark on the column (today.spec) and in every design (design-axe). No render-count gate: the digest is at most 40 rows and isn't virtualized (as the page always was). UI rating (`a08-today-digest` rates the page, which looks as it did): not run with this series; the column beside a newsletter isn't one of the rated captures yet.
