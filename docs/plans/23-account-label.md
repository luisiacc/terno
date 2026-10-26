# Plan 23: the receiving account on rows, in all-accounts views

- **Status:** done (see "Revisions after the Codex review" and "Implementation notes").
- **Builds on:** `da55479` (main after plan 20); built alongside plan 22 (both touch the thread row).
- **Request (verbatim):** "when we are on the view of all emails for all email accounts we need to show very subtly to whicch email its coming to from all my current accounts, similar to how Mac mail does it"

## 1. What exists

- `ThreadList` computes `showAccount = accountId === null && accounts.length > 1` (every mailbox not narrowed to one account: the unified Inbox, All Mail, Starred, categories, search) and passes it to each `ThreadRow`.
- With it, `ThreadRow` draws `account-mark`: a 6 px ring in the account's color among the marks beside the date (plan 15). It names nothing: you have to know the colors (the sidebar's), and screen readers get nothing.
- `ThreadSummary.accountId` is on every row; `useApp` holds `accounts` (`displayName`, `email`, `color`).
- Row heights are fixed per design and density (`design.rows`, read by the virtualizer and asserted by the ui-perf tests).
- Seeded data: 8 accounts with display names ("Personal", "Acme Studio", "Freelance", …).

## 2. Design

Apple Mail, in All Inboxes, writes the mailbox's account in small grey text on the message's second line, right-aligned under the date. Terno does the same, in every design and density:

- **What it says:** the account's display name; when it's empty or another account has the same one (two Gmail accounts both called "Luis Cordero"), the address. An address truncates in its local part and keeps `@domain` (`luis.cord…@gmail.com`), so the part that tells accounts apart survives.
- **What it looks like:** the existing ring in the account's color (kept, `data-testid=account-mark`, same size and stroke) followed by the label in `text-2xs text-muted-foreground` (muted-foreground on pane, row-hover, row-selected and tint are all in `CONTRAST_PAIRS`: AA), at most `max-w-[min(8rem,40%)]` (`7rem` in compact), truncated with an ellipsis, `title` = the full address. The ring leaves the marks group, where it was.
- **Where:**
  - **macOS (`classic`), comfortable:** line 2 (subject — snippet), right end, under the date.
  - **Atelier (`avatar`), comfortable:** line 2 (subject), right end, under the date.
  - **Lumen (`large-avatar`), comfortable:** line 2 (subject), right end, under the date.
  - **Compact (all designs, one line):** in the right group, before the marks and the date.
- **When:** exactly when the ring shows today (`showAccount`): any mailbox not narrowed to one account, and only with more than one account. A single account or an account's own mailbox shows nothing.
- **Screen readers:** the label is text in the option, so the row's name ends with it; a visually hidden "to" before it reads as "…, to Personal" (`list.accountLabel.prefix`, en/es).
- **No new queries, no new state per row:** the labels for all accounts are derived once per `accounts` change (a memo in `lib/account-labels.ts`); each row selects its own entry by id (a stable object), so rows re-render only when their account's label changes.
- **No height change:** the label sits on lines that already exist; rows keep `design.rows` (asserted).

## 3. Tests

- **Unit (`account-labels.test.ts`):** display name vs address, duplicates and empty names fall back to the address, the split for the address form, the memo returning the same objects for the same accounts.
- **e2e (`account-label.spec.ts`, tagged `@design`, so it runs in all three designs):**
  - the unified Inbox shows a label on every row, naming that row's account (checked against the backend's account for the thread), right-aligned at the date's right edge (comfortable) or before the date (compact);
  - an account's own mailbox shows none; with one account (the others removed) none;
  - the row height is unchanged in both densities;
  - the existing ring tests (categories, search) keep passing.
- **ui-perf:** the existing scroll and j-holding tests already run in "All Mail" with several accounts (labels on): their gates hold, and `ThreadRow` render counts per move are unchanged.
- **Screenshots** in light and dark, each design, both densities: `/tmp/unica-scratch/account-label-23/`. Visual baselines that show the unified list are updated (only the label is new).

## 4. Out of scope

- Per-account filtering from the label (the sidebar does that), labels in the reader (it already shows the account chip).

## Revisions after the Codex review

Codex (plan critique, 10 points) checked the plan against the row code. What changed:

1. **Width budget (classic, Atelier, Lumen).** Line 2's subject, draft and snippet now sit in one `min-w-0 flex-1` group and the label is its sibling, `shrink-0`, capped at `min(8rem, 40%)` of the line (narrowed from 9rem/45% after the lead saw a long name crowd the subject) (`min(7rem, 32%)` in compact), so a long subject and a long label share the line instead of overflowing. The classic subject's 60 % cap is now of that group.
2. **Right-aligned under the date in every comfortable layout** (`ml-auto` on the label, which is outside the subject group).
3. **Compact:** the label left the right-hand `shrink-0` group (marks and date): it sits between the subject (which shrinks) and that group, with its own cap.
4. **Address truncation:** the local part shrinks first (`min-w-[1ch]`), then the `@domain`, so a very long domain still ends in an ellipsis inside the cap instead of overflowing (see the code review below for how).
5. **Same-domain addresses sharing a long prefix:** not changed. The ring's color and the `title` (the full address) tell them apart, and naming the accounts in Settings → Accounts is the fix; a computed middle truncation was judged not worth its cost for a rare case.
6. **Checked rows** (accent background): the label uses `accent-foreground` there (`muted-foreground` on `accent` isn't a certified pair); the cursor row and the rest keep `muted-foreground`.
7. **Screen readers:** the visible label is `aria-hidden`; one visually hidden ", to {account}" (`list.accountLabel.sr`, en/es) is the row's last child, so the option's name ends with it in every layout (asserted with `toHaveAccessibleName`).
8. **Stable label objects across new `accounts` arrays:** labels are reused by value equality, so sync-state events re-render no row (unit test, and an e2e that counts `ThreadRow` renders: zero for metadata-only events, exactly that account's visible rows for a rename).
9. **Overflow the height checks can't see:** the e2e asserts that nothing a row draws (outside what an ancestor clips) leaves the row's box, in all three designs and both densities, with a long name and address labels.
10. **Fixtures:** the e2e renames accounts to create a shared name (both fall back to addresses), a long name, and checks the label-to-account mapping in the inbox, a search and a category, in both densities.

## What the Codex code review changed

One finding (medium), fixed with a regression test that failed before the fix:

1. **A domain wider than the label spilled out of it.** The domain had `flex-shrink: 0.01`; once the local part reached its minimum, the domain was the only shrinking item and a factor under 1 resolves only that fraction of the overflow (CSS Flexbox §9.7), so the rest overflowed the row (comfortable) or over the marks and date (compact). Now the local part has `shrink-[100]` and the domain the default 1: the local part still gives way first, and the domain ends in an ellipsis. Test: "an address whose domain alone is wider than the label truncates inside it" (all designs, both densities).

Codex found no performance regression (render counts, frame times and DOM size are asserted by the existing gates and the new render-count e2e).

## Implementation notes

- `apps/web/src/lib/account-labels.ts` (derivation and reuse), `thread-row.tsx` (placement per layout), `e2e/account-label.spec.ts` (`@design`).
- Visual baselines showing the unified list were updated (the label is the only difference; checked against the diffs).
- Screenshots: `/tmp/unica-scratch/account-label-23/{macos,lumen,atelier}-{light,dark}-{comfortable,compact}.png`.
