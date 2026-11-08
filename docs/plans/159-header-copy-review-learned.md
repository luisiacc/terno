# Plan 159: "to reply to", "Sort into categories", and a rule offer shown once

- **Status:** built (2026-11-08): commits 95755d6fb to 86b733625; rating round pending (the lead's).
- **Builds on:** plan 17 (people and waiting), plan 63 and 80 (category suggestions and Review), plans 91 and 143 (learned rules), plan 158 (the UI rating; rounds 4 and 5 raised all three).

## The request

> A change from the owner to the header copy, based on what the raters said in rounds 4 and 5 (both rounds raised it; the issues are in /tmp/terno-scratch/ui9/rounds/r04 and r05). Follow the usual process: plan, Codex critique, tests, light and dark screenshots, Codex review.
>
> - `list.waitingCount` "128 waiting for your reply" → "128 to reply to", with a tooltip that says exactly what counts. Read the code to find the real rule first, and keep the wording consistent with the related strings (`list.filterEmpty.waiting*`, `palette.showWaiting`).
> - `sidebar.reviewAll` "Review 79 suggestions" → "Sort 79 into categories", shown as a real sidebar row with an icon and a count badge, not a caption. Today the total covers every category but the click opens one category (Review · Lecturas) without saying so: open the review with a category switcher at the top showing a count per category (or an All view).
> - The learned-rule banner at the top of every list: show it once, then move it somewhere quieter (Rules or the review queue). "Create rule" at regular weight, and show the full sender condition before it is accepted.
> - Update en and es together.
>
> Don't tell the raters about any of this; the next round judges it blind.

## What the raters said (rounds 4 and 5, all four styles)

- The count reads "100 unread · 128 waiting for your reply": waiting exceeds unread and "waiting" isn't defined (Lumen, Claude, both rounds).
- "Review 79 suggestions" is a grey 12 px caption, not a control (macOS, Graphite, Claude); the total covers every category but the click opens "Review · Lecturas" with no explanation and no way to switch (every style, Codex, both rounds).
- The learned-rule banner sits above the first row in every list and screenshot; "Create rule" is bold, the second-strongest text in the column; at 1100 px the domain truncates ("daily.morningbre…") while Create rule stays actionable (every style, both raters).

## What exists

**The waiting rule** (`packages/core/src/people.ts` `decide`, `packages/db/src/queries.ts` `waitingCounts`, `WAITING_WINDOW_MS = 30 days`). A conversation counts when all of these hold:

1. it's in the Inbox (the Inbox as shown: with Gmail's tabs apart, the Primary part), for the account in view or all accounts;
2. its newest visible message (not a draft, not a failed send, not in Trash or Spam) came from someone else, and that sender is a person, not an automated sender;
3. you're on that message's To line, not only its Cc;
4. nothing you sent answers it, anywhere;
5. it arrived in the last 30 days.

Read state plays no part, which is why "waiting" can exceed "unread". The related strings already say "waiting for your reply" (`list.filterEmpty.waitingTitle`, `…waitingBody` "Conversations where someone wrote to you in the last 30 days, and you haven't answered, show up here.", `palette.showWaiting` "Show conversations waiting for your reply"). The count is a link button that toggles the Waiting filter (`thread-list.tsx` `Subtitle`).

**The review entry** (`sidebar.tsx` `ReviewLine`): a 24 px text line under "Categories", `sidebar.reviewAll` with the total of pending suggestions across categories; a click opens the review of the category with the most (`navigate({ view: "all", reviewCategoryId })`). The review list's header names only that category ("Review · Lecturas"). Each category's own review is in its context menu.

**The learned-rule offer** (`learned-banner.tsx`): `learning.proposals` gives the first proposal; it shows as the list's first item, 32 px (`LEARNED_H`), in the Inbox whenever no search is on, until answered (× or Create rule), then hushed for the session (`sessionStorage`). The Rules dialog (`filters-dialog.tsx`) already lists the same proposals (`learning.proposals`).

## Design

### 1. "128 to reply to"

- `list.waitingCount`: en "# to reply to" (one and other); es "# por responder".
- The count keeps its job (it turns the Waiting filter on and off) and gains a tooltip with the rule in plain words, en: "Conversations in your Inbox from the last 30 days where someone wrote to you directly and you haven't replied. Read or not." es to match. The tooltip names the account when one is in view? No: the rule is the same; the count already follows the account.
- Consistency: `palette.showWaiting` → "Show conversations to reply to"; `list.filterEmpty.waitingTitle` → "Nothing to reply to"; `…waitingBody` reworded to the same rule ("Conversations in your Inbox from the last 30 days where someone wrote to you directly, and you haven't replied, show up here."); `…waitingSearchBody` → "Nothing that matches is waiting for a reply" → "Nothing that matches needs a reply". The filter's own name in the filter menu ("Waiting for reply") → "To reply to". Check every `waiting` string in `en.ts` and keep one phrase.

### 2. "Sort 79 into categories"

- **The sidebar row:** a real row like Inbox or Starred: the nav row's height, padding, hover and selected state, an icon from the catalog (a sorting or tag-stack glyph, picked by eye beside the category dots), and the count as the same right-aligned count the other rows use. Its visible label is "Sort into categories" with the count in the count's place; its accessible name and tooltip say the whole sentence, `sidebar.reviewAll` "Sort # into categories" (es "Ordenar # en categorías"), so the number isn't said twice on screen. It sits where the line is now, first under the Categories heading. Shown only when there's something to sort.
- **The review screen gets a switcher:** at the top of the review list, a `ToggleGroup variant="segmented"` or, when categories don't fit, a select: "All" plus each category with pending suggestions and its count ("Lecturas 31"). The header says what you're sorting ("Sort into categories" over the switcher), not "Review · Lecturas".
  - **All** is the default when coming from the sidebar row: every pending suggestion, each row naming its proposed category on its accept action ("Add to Lecturas"). Check whether the backend's review query can return all categories' suggestions in one paged list at 50k threads in both stores; if it can't within the perf gates, the default is the category with the most, with the switcher showing that and the total, and All is left out (say so in the plan's revisions).
  - Choosing a category in the switcher narrows to it; the counts update as suggestions are accepted or rejected. A category's own "Review" in its context menu opens with that category chosen.
  - Esc leaves the review to where you came from (round 5: Esc landed in the category, with two sidebar rows highlighted).

### 3. The rule offer, once

- **Once:** a proposal is shown in the list one time. When it first renders in the Inbox it's marked seen (by its `key`, persisted locally, not per session); it stays while that list stays, and after you leave the Inbox or relaunch, it's not shown in lists again. Answering it (× or Create rule) also ends it, as now.
- **Somewhere quieter:** the Rules dialog already lists proposals; it stays the home. The sidebar's Rules row shows a quiet count of pending proposals (the same count style as other rows) so the offer stays reachable; nothing else in the list.
- **Regular weight:** "Create rule" is a regular-weight link button (BoardUI's secondary link), not bold.
- **The full condition before accepting:** the sender condition never truncates in the list or in Rules. At narrow widths the line wraps to two lines (the virtualizer measures its height rather than assuming 32 px), or the action moves under the sentence; whichever keeps the whole condition readable. The accessible name keeps the full sentence.

## Tests

- **Unit:** the waiting strings render for one and many in en and es; `ReviewLine` shows the row with the right total and count; the review switcher's counts per category and All; the offer's seen-once state (shown once, not after leaving the Inbox or a relaunch; answering ends it).
- **e2e:** the count's tooltip text; the sidebar row is a row (role, height, hover and selected state) and opens the review with the switcher showing All and the per-category counts; switching narrows; Esc returns where you came from; the offer shows once and not again after leaving the Inbox, and its full condition is visible at 1100x700 in every style; Rules shows the proposal and its sidebar count.
- **Screenshots:** light and dark, at 1440x900 and 1100x700, in Lumen and macOS at least; update baselines only after looking.
- **i18n:** every new or changed key in en and es; the type check enforces it.

## Perf

The waiting count and suggestion counts are already in `counts`; no new query on the list's hot path. An All review list, if built, must hold at 50k threads in both stores (`packages/db`, `packages/idb`), measured in the existing perf gates.

## Out of scope

- The rating itself: no change to the brief, and raters aren't told; the next round judges it blind.
- The other round 4 and 5 findings (reply controls, sticky header, filter menu icons, account labels at small widths).

## Revisions after the Codex review

The critique's twelve points, all taken. Where they change the design:

1. **The rule, stated exactly.** A message counts if you aren't *only* on its Cc (Bcc and forwarded copies count), its sender is a person by Terno's classification (an automated sender you've written to before can count), and nothing you sent answers it, by Message-ID. The tooltip, en: "Inbox conversations from the last 30 days where a person wrote last and you haven't answered. Read or not; mail you're only Cc'd on doesn't count." es to match. No "directly".
2. **Count versus filter.** The Inbox count's tooltip says "Inbox"; the Waiting filter also works in Archive, categories and search, so the shared empty-state body doesn't name a mailbox.
3. **The copy inventory, explicitly:** `list.waitingCount`, `list.filter.waiting`, `list.filterEmpty.waitingTitle`, `…waitingBody`, `…waitingSearchBody`, `list.scope.waiting`, `palette.showWaiting`, and a new `list.waitingCount.tip`. One phrase: "to reply to" (es "por responder"). No "needs a reply". Other "waiting" strings (sign-in, updates, queued sends, forwarding) are unrelated and stay.
4. **No All view.** `categorize.suggestions` has no cursor and Review is one terminal batch; an All list needs paged queries in both stores. The switcher shows each category with pending suggestions and its count, and opens on the category with the most; its header states the total ("79 to sort · Lecturas 31") so the sidebar's number and the screen agree.
5. Moot without All: Review stays one category at a time, so row identity, accept, reject, similar and undo keep deriving the category from `reviewCategoryId`.
6. **Review remembers where it came from.** Entering captures the origin (mailbox, account, search, selection, scroll); switching categories keeps it; Esc returns there, after closing any open menu, select or reader first. A category deleted, or the last suggestion answered, leaves Review the same way.
7. **Seen once, stored like tips** (plan 113): `localStorage`, keyed by the proposal's `key`, bounded to the last 200 keys, with a `storage` event so a second window agrees. Separate from `learning.dismiss`, which removes the offer from Rules too.
8. **The visit.** Persisting "seen" doesn't hide the banner on screen: a visit-local latch keeps it until you leave the Inbox (another mailbox, an account, a search, Review). Create rule then Undo, within the visit, brings it back as today.
9. **No Rules badge.** `counts` has no learned-proposal count and computing one means re-reading 60 days of actions on every refresh. The Rules dialog lists the proposals, as it does now; nothing in the sidebar.
10. **Wrapping is measured, not assumed.** The banner's natural height is measured and shared with the list's `lead` (virtualizer padding, headings, scroll restoration), replacing the fixed `LEARNED_H` for that, and kept stable through width, locale and design changes. `Announcement`'s fixed height and nested truncation give way for this use; long addresses and list IDs wrap.
11. **The condition is the rule's.** One shared, localized description ("from x@y.com", "from anyone at y.com", "from the list y") built from the proposal's field, used in the banner and in Rules.
12. **Done means the rule too:** BoardUI's `ToggleGroup variant="segmented"` or `Select` for the switcher, `Tooltip`, `Announcement`, `Button variant="link-secondary"`; keyboard and axe checks for the switcher and tooltip; Tab-only focus rings; then the Codex code review, `pnpm test:all`, and a rating round (raters told nothing, per the owner).

## As built

Where the build departs from the design and the revisions above, and why:

- **The sidebar row reads "To sort", not "Sort into categories".** At 1100 px in Lumen the longer label truncated ("Sort into catego…"). The row is a place with its count ("To sort 79"), as Review's header says "79 to sort"; its tooltip keeps the sentence, "Sort 79 into categories" (es "Por ordenar", "Ordenar 79 en categorías"), and Review's title is "Sort into categories". Its accessible name is the label and count, like every other row: axe's `label-content-name-mismatch` (WCAG 2.5.3) refuses a name that doesn't start with what's shown, so the sentence is the tooltip only.
- **The switcher is BoardUI's `Select`, always.** Five categories with counts don't fit a segmented control in the list's column; one control at every width. It sits on its own line under the title in every header kind (it never gives way on scroll or a short window), and in List's one-row header where the subtitle goes.
- **The last suggestion answered keeps Review** (revision 6 said it leaves). Leaving moved you away from the rows an Undo brings back (e2e caught it: "Always" on the last rows, then z). Review stays, its list says "All sorted" and where to go on (another category above, or Esc); Esc, or the category deleted, still leave for where Review was entered from.
- **The seeded offer is a mailing-list rule.** The shared description says the rule's own field: "Always archive mail from the list daily.morningbrew.com?" (before, "Always archive daily.morningbrew.com?" hid that it was a list). It wraps to two lines in the split list at 1440 too; the banner's vertical padding went so that one or two lines take the 32 px one line took, and plan 158's whole-row bars hold in every design at both sizes.
- **One offer per launch.** An offer shown is seen for good; once it's been shown, no other is offered until the next launch (a reload of the window included), so a mailbox with several proposals doesn't show one per visit.
- **Rules' line** reads "Archive mail from the list daily.morningbrew.com", whole, from the same description.

Tests: `lib/review.test.ts`, `lib/learned.test.ts`, `announcement.test.tsx`, `i18n.test.ts` (the phrase in en and es); e2e in `inbox-scan.spec.ts` (the row, the switcher, Esc's way back, the offer once and whole at 1100x700, the count's tooltip in `people.spec.ts`), `design-axe.spec.ts` (the switcher open, the sidebar row), and the Luma and Graphite 980-px baselines (the offer's two lines), each looked at first.

## What the code review changed

Codex code review, two rounds (`codex exec -s read-only`), every finding fixed with a test that fails without the fix:

1. **The switcher unmounted while open kept the shortcuts off.** Base UI doesn't call `onOpenChange(false)` on unmount, so a category deleted in another window while its switcher was open left `menuOpen` on: Esc, / and every key did nothing. It lets go on unmount (e2e, `inbox-scan.spec.ts`).
2. **Review entered from a search came back to the query on its first result.** The way back keeps a search's rows, cursor and offset (as a sentence's preview does) and refreshes them in place (`review.test.ts`).
3. **The way back checked nothing.** A category, account or folder gone meanwhile sends you to the Inbox (`review.test.ts`).
4. **The whole-condition e2e passed with a truncating span** (it measured the span's box). It measures the laid-out text against the span and the paragraph.
5. Round 2: **a sentence's preview opened from Review forgot the way back**, so Cancel then Esc went to the Inbox. Kept through a preview (`review.test.ts`).
6. Round 2: **a reload rotated the offers** within one launch. Showing one marks the launch (sessionStorage); the one on screen stays for its visit (`learned.test.ts`).
