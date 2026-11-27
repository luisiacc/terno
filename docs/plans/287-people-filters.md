# Plan 287: People's filter, and People inside a focused account

- **Status:** plan. Not built.
- **Builds on:** plan 281 (People), plan 108 (focus on one account), plan 18 (the recipient index), plan 278 (who is a person), plan 54 (focus rings), plan 271 (motion).

## The request

> on the 'people' list, lets have a filter button above [the top right of People's header], there they can select a date filter and also they can select if they want to show only people from certain accounts only, its a multi-select, make it intuitive and very easy to use.
>
> after that , lets add the "People" view on the focused view of an account [the sidebar focused on one account, plan 108] it would be below 'Inbox', and itwould only show the 'People' things from that account, and the fitler would not have the option to select another account

## What exists

- **People** (plan 281): `PeopleService` (`packages/backend/src/people.ts`) groups What matters' open items and the replies owed to you by person (Open), lists everyone you've written to from the recipient index (`ContactIndex.written`, Everyone, ≤ 5,000), searches names and addresses (`ContactIndex.people`), and reads one person's page (`person`: their items and their 20 newest conversations, `threads.searchText` on the address, `place: "all"`). Rows that have nothing open show "Last email …" (`people.lastEmails`: one indexed search per drawn row). The renderer: `state/people.ts` (the list, search, page), `lib/people.ts` (reads, acts, ways in), `components/people/` (the list, the page, the card).
- **Each item knows its account:** a `TodayItem`'s `thread` and an awaiting row's `thread` are `ThreadSummary`s with `accountId`.
- **The recipient index** keeps, per contact, a bit for each account it was seen in (`accounts`, the first 32 accounts, plan 18's same-account boost) and one `last` date (the newest message either way, spam and drafts never counted). There is no per-account date.
- **`threads.searchText`** takes one optional `accountId`.
- **Focus on one account** (plan 108): `soloAccountId`; invariant `accountId === soloAccountId` while set (`keepSoloValid`); the sidebar is `SoloSidebar`: back row, title, `SOLO_VIEWS` (Inbox, Starred, Sent, Archive, All Mail, Spam, Trash), tabs, folders. Shortcuts and the palette stay in the account while focused (`goToFolder`).
- **People is an own list of every account:** `navigate` sets `accountId: null` for every own list, and `keepPeopleValid` leaves People on any write with an `accountId`. So today People in a focused account would end the focus.
- **Menus:** BoardUI's Dropdown (`dropdown-menu.tsx`) has `CheckboxItem`, `RadioGroup`/`RadioItem`, `Label`, `Separator`; the chip (`chip.tsx`) has a named remove.

## Design

### 1. The filter (`PeopleFilter`, core)

```ts
type PeopleWithin = "week" | "month" | "quarter" | "year";
interface PeopleFilter { within?: PeopleWithin; accounts?: number[] }   // absent = any time / every account
```

- **Date: "Last email".** Who you last emailed with (either way) within the period: past week (7 days), past month (30), past 3 months (91), past year (365), counted back from now by the backend's clock. It's the date the rows already say ("Last email Oct 12"), so the filter and the rows agree. It chooses *who* is listed, never which of their items: a person's open items are all shown (the page is the person whole).
- **Accounts:** people you've emailed with in any of the chosen accounts. For Open, a person's items are only those whose conversation is in a chosen account (a promise made from iuspro.com isn't lccpacc's); someone with none left isn't in Open. For Everyone and the search, the contacts the index has seen in one of those accounts. The person page and its conversations follow the accounts too (so the page agrees with the row it was opened from); "Last email" on a row and the page is the last one in those accounts.
- **Date and accounts together:** the last email *in those accounts* within the period. The index gets a per-account last date (below) so this is exact, not "seen in A and, somewhere, recently".
- **Search** looks within the filter: in a focused account it never finds someone you only know from another account. The list's line says so when a filter is on ("3 people in your filter").

### 2. Backend

- `people.list`, `people.search`, `people.person`, `people.lastEmails` take an optional `filter` (zod: `within` one of the four, `accounts` ≤ 64 positive ints, deduplicated, sorted). An empty `accounts` is no account filter. Unknown account ids are ignored (an account removed while the window held the filter).
- **Open:** the cached grouping stays as it is (one read for every filter); a filter is a cheap pass over it: each person's items kept by `thread.accountId`, `since` and the order recomputed (`personSince`, `sortPeopleOpen`, the existing functions) only for people whose items changed, then the date: the person's last email in those accounts (§3), else (index not ready, or the index doesn't know the address) the newest of their kept items' conversations (`thread.lastDate`): a fallback that only errs toward showing someone.
- **Everyone:** `index.written(max, filter)`: the predicate applied before the cut (a filtered list is the top 5,000 *of those who match*, not the top 5,000 filtered). The cache holds the last 4 filters per version (a filter is one key: `accounts`'s bits and the `since` rounded down to the hour, so the cache survives between reads and the boundary moves hourly).
- **Everyone's version** (`known`): the version is bumped when the index's scores, the rules, **or the filter asked** differ from the last read; the renderer drops `known` when its filter changes.
- **Search:** `index.people(query, limit, keep)`: `keep(id)` applied inside the walk (`rank`'s `consider`, the short-query cache's filter, the address-piece scan), so a narrow filter still fills its 50.
- **Person page:** items kept by account; conversations: with one account, `searchText({ accountId })`; with several, one search per account (each `limit` 20), merged newest first, `more` if any had more. Same for `wroteIn`. `lastEmails`: one search per address per chosen account (rows drawn ≤ 60; a focused account is one search each, as today).
- **The card** (plan 281's person card in a chip's menu) is not filtered: it's about the conversation open beside it.

### 3. The index: a last date per account

`ContactIndex` gains `lastBy: Map<id, Float64Array(32)>`, only for contacts seen in two or more accounts (most are seen in one; then `last` is that account's). `touch` keeps it: on a contact's second account, the slot of the first gets the old `last`; each message raises its account's slot. `lastIn(id, mask)`: no mask → `last`; the contact's accounts all inside the mask → `last`; else the newest slot in the mask. Compaction remaps it like `alts`; the snapshot gains `lastById` (u32) and `lastBySlots` (f64, 32 per id), and its `format` goes 6 → 7 (an old snapshot is rebuilt in the background, as any format change; no users yet). Memory: 256 bytes per multi-account contact (20k such contacts ≈ 5 MB at the desktop cap's scale; counted in `allocatedBytes`).

The 33rd account onward has no bit (plan 18's limit): filtering on it finds nobody in Everyone or the search (Open still works: it goes by the conversation's account). Said here, not in the UI: 32 accounts is far past anyone's mailbox.

### 4. The renderer's state

- `usePeople.filter: { within: PeopleWithin | null; accounts: number[] }`, remembered on this device (`terno:people-filter`, read once, written on change; a removed account dropped when the accounts load).
- **What's asked** (`peopleFilter()`): `within`, and the accounts: in a focused account, that account alone; else the chosen ones. One function, used by every read (`fetchList`, `searchPeople`, `loadPage`, `settle`, `askLastEmails`).
- **A change of the filter** (or of the focus) reads the list again without `known`, runs the search again, reads the page again, and forgets the rows' last emails (they were another scope's). The list's scroll goes to the top (another list); the selected person stays selected (their page reads again).
- Acts (Done, Later, Undo) are unchanged: their settle reads go through the same filtered reads.

### 5. People in a focused account

- **State:** People may carry an account: `navigate({ people: true })` keeps `accountId` as the focused account while focused (`accountId: people ? s.soloAccountId : null` for own lists); `keepPeopleValid` leaves People when `accountId` is neither null nor the focused account. So the focus and People hold together, and leaving the focus (the back row, a notification, another account) leaves People in the same write, as it leaves any of the account's places.
- **Ways in:** the focused sidebar's **People row, right below Inbox** (`nav-solo-people-<id>`, the `Users` glyph, "People", `g p` shown as its shortcut), when AI features are offered (`aiFeaturesOffered`, People's gate). `g p`, the palette's People and "Open in People" while focused go to the focused People (plan 108: shortcuts stay in the account).
- **Its list:** "People" with the account's name as the title's suffix, as a focused search's header has it ("People · Personal"); Open and Everyone of that account only (§1); the page and conversations of that account.
- **The sidebar's active row:** while People is on, no view row is active in the focused sidebar (People's `view` is `"all"`, which would light All Mail).
- **Compose** from a focused People page already goes from that account (`s.accountId`); New message on a person's page keeps its own rule (the account of the newest conversation shown, now that account's).

### 6. The filter button and menu (UI)

- **Where:** at the end of People's title line (the request's arrow), a quiet icon button (`IconButton` ghost, `ListFilter` glyph, 16 px), tooltip "Filter people". Its label for screen readers says what's on: "Filter people: Past month, 2 accounts".
- **Active:** while a filter is on, the button carries the active look of the list's other toggles (the accent ink on its glyph, `aria-pressed` isn't used: it opens a menu), and under the subtitle a line of chips, one per facet, each with a named remove ("Past month ×", "lccpacc, luis@iuspro.com ×", more than two accounts: "3 accounts ×"). Removing a chip removes that facet. The chips line is in the header (not the list), with the list's hairline under it.
- **The menu** (BoardUI Dropdown, aligned to the button's end):
  - **Last email** (label): Any time · Past week · Past month · Past 3 months · Past year (radio items; picking one closes the menu).
  - separator, **Accounts** (label, only when not focused and with two or more accounts): **All accounts** (a checkbox item, ticked when none is chosen; picking it clears the choice), then each account (its diamond in its color, its name) as a checkbox item that **keeps the menu open** (multi-select). Choosing every account is "All accounts" (the choice is cleared).
  - separator, **Clear filters** (only when one is on).
  - The menu scrolls past the window's height (15 accounts fit on a laptop).
- **Keyboard:** the button is one Tab stop after the search field's (title line order); Enter/Space/↓ open the menu; arrows move, Space/Enter tick; Esc closes, focus back on the button (Base UI). No new shortcut.
- **Empty under a filter:** "No one matches these filters." with a "Clear filters" link button (`people-filter-clear`), instead of "People you write to show here."
- **Motion:** none of its own: the list is another list (no glide between filters); the menu's own open is the Dropdown's.

### 7. Copy (en / es)

| key | en | es |
| --- | --- | --- |
| `people.filter.button` | Filter people | Filtrar personas |
| `people.filter.buttonOn` | Filter people: {what} | Filtrar personas: {what} |
| `people.filter.date` | Last email | Último correo |
| `people.filter.any` | Any time | Cualquier fecha |
| `people.filter.week` | Past week | Última semana |
| `people.filter.month` | Past month | Último mes |
| `people.filter.quarter` | Past 3 months | Últimos 3 meses |
| `people.filter.year` | Past year | Último año |
| `people.filter.accounts` | Accounts | Cuentas |
| `people.filter.allAccounts` | All accounts | Todas las cuentas |
| `people.filter.accountsCount` | {count} accounts | {count} cuentas |
| `people.filter.clear` | Clear filters | Quitar filtros |
| `people.filter.remove` | Remove filter: {what} | Quitar filtro: {what} |
| `people.filter.none` | No one matches these filters. | Nadie coincide con estos filtros. |
| `people.titleIn` | People · {account} | Personas · {account} |
| `people.foundIn` (plural) | # person in your filter / # people in your filter | # persona en tu filtro / # personas en tu filtro |

## Performance

- The filter adds no read: Open's pass is over the cached grouping (≤ a few hundred people); Everyone's filtered `written` is one typed-array pass (the same as today's, with a predicate) and cached per filter; the search's predicate runs inside the existing walk.
- Perf gate (`contacts.perf.test.ts`): 250k contacts, 20k written, 5k multi-account: `written(5000, { accounts: [one], since: month })` cold and cached, `people(q, 200, keep)` at one letter, within the existing budgets; `lastBy` memory reported.
- A person page across several accounts is one indexed search per account (bounded by the accounts chosen).
- Nothing new runs while People is closed; the filter is read from local storage once.

## Tests

- **Index** (`contacts.test.ts`): `lastIn` for one account, two (the first slot seeded from `last`), the mask covering all; `written` with accounts and `since` (filter before the cut, cached per filter, cache cleared by a new version); `people` with `keep` (a narrow filter still fills); compaction and snapshot round-trip keep `lastBy`; format 7 refuses a format 6 snapshot.
- **Backend** (`people.test.ts`): Open by account (items kept per account, `since` recomputed, a person with none left gone); by date (index date; the items' fallback); Everyone and search by account and date; the person page's items and conversations by one account and by two (merged, `more`); `lastEmails` per account; `known` dropped across filters; unknown account ids ignored.
- **State** (`state/app` and `state/people` tests): `navigate({ people: true })` while focused keeps the account and the focus; leaving the focus leaves People; another account's write leaves both; `peopleFilter()` with and without focus; the filter remembered and an account removed from it.
- **Renderer unit:** the chips' words (one account, two, three or more; date), the button's label.
- **e2e** (`people-view.spec.ts`, one `scenario()` added): the filter button opens the menu; Past week narrows Everyone; ticking two accounts keeps the menu open and narrows Open and Everyone; the chips show and their × removes a facet; "No one matches" and Clear filters; the search within the filter; the focused sidebar's People row right below Inbox; focused People lists only that account's people, its menu has no Accounts section, its page's conversations are that account's; leaving the focus leaves People; axe on the open menu and the chips in light and dark.
- **Perf:** the gate above; `today.perf.test.ts`'s People case with a filter.

## Out of scope

- A custom date range (presets only); "haven't emailed in …" (the inverse).
- Filtering the person card.
- Per-account names for a person.
- People's row anywhere but the focused sidebar's top (the all-accounts sidebar keeps its one People).

## Revisions after the Codex review

Twelve points. These override the sections above where they differ.

1. **Two dates, said plainly.** Membership by date uses the index's last date (any message with them in those accounts, Trash included: the index can't tell). The rows and the page keep plan 281's exact "Last email" (newest conversation, never Spam or Trash). They differ only when someone's newest mail is in Trash or was deleted: such a person may be listed under "Past week" with an older "Last email". Accepted (a heuristic that only errs toward showing someone); a store query of every address since a date, in both engines, costs far more than it buys. Where the index doesn't know a person (it isn't ready, or never saw them) the date is unknown and they're kept, never judged by their open items' dates.
2. **Account bits.** The index's 32 account bits stay the mechanism (an account past the 32nd has none: filtering on it finds nobody in Everyone or the search; Open goes by the conversation's account and is exact). Unrestricted, chosen and "chosen but none of them exist any more" are three cases: the service resolves the ids once per call (`scope`) and an all-gone choice is unrestricted, as an empty one is. The handlers pass `filter` through (done).
3. **Everyone in an account is who you wrote to from it.** A new `sentIn` bit set per contact (the accounts you sent to them from); Everyone with accounts requires `sentIn & mask`, so someone you wrote to only from B who was copied on mail in A isn't in A's Everyone (the search, which finds anyone, still has them). One address per person stays plan 281's rule (two spellings of one person are read by the spelling kept).
4. **Everyone's version per filter.** A version per filter key (a few kept), so two windows on different filters don't make each other resend; it includes the index's identity (a rebuilt index can repeat a `scoreVersion`) and is read after Everyone is built, not before the awaits. The date's part of the key moves by the hour. The renderer sends `known` only for the filter its Everyone came from.
5. **A generation per scope in the renderer.** Changing the filter (or the focused account) bumps a generation that every read snapshots: the list, the search (and Enter's queued open, `hitsFor`), the page, the rows' last emails (their map and pending marks reset, late answers and failures dropped), and `openFromPerson`.
6. **Acts across a filter change.** The change invalidates the reads in flight (`listSeq`, `pageSeq`), lets go of `held`, and reads again at once; `leaving` keeps the items being taken out until their acts answer, so the new read never brings one back; a settle that lands after the change finds its sequence stale and draws nothing (the change's own read is current); a failed act reads again, in the current scope.
7. **State.** `keepPeopleValid` runs after the focus is settled and holds one rule: People's `accountId` is the focused account's, or null with no focus. A write that ends the focus without going anywhere (`soloAccountId: null` alone) keeps People, for every account (`accountId: null` in the same write); any place elsewhere leaves it, as before. A notification into the focused account is that account's Inbox, which leaves People (it's another place).
8. **Truncation.** The predicate runs inside the index's walk (and the short-query cache falls through to the walk when the cached top doesn't fill); own addresses and senders that aren't people are still left out after it, so Everyone and the search keep plan 281's over-ask (×2, ×4) as their cap, said here. The search's counts are the filter's accounts' (as rows and pages).
9. **The engines' account set.** `threads.searchText` takes `accountIds` (resolved into `ResolvedSearch.accountIds`, which both engines already read, and into the search's key): one search per read, its own `limit` and cursor, never one per account.
10. **Costs.** The per-account dates are sparse: `[bit, date]` pairs per contact seen in two or more accounts (16 bytes a pair), not 32 slots; counted in `allocatedBytes`, remapped by compaction, validated on restore. The perf gate adds a narrow account filter, a filter change after new mail (cold `written`), and a common-domain search under a filter.
11. **A selected person the filter leaves out.** Their page stays (they're still selected); Back in List goes to their row, else the search field. People's kept scroll is per scope (the focused account's apart). New message on a page: in a focused account, from it; else the newest shown conversation's account (within the filter), else the filter's first account, else the default.
12. **Keyboard and states.** The filter button is on the title line, `no-drag`, before the search in the DOM as it is on screen; removing a chip by keyboard, or Clear filters, puts the keyboard on the button. "No one matches these filters" only after the current filter's answer; warming, failure and the search's cap keep their lines. The focused sidebar's People is the shared `NavItem`, after Inbox, current while People is on; no view row is current then.
