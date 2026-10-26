# Plan 23: the receiving account on rows, in all-accounts views

- **Status:** planned.
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
- **What it looks like:** the existing ring in the account's color (kept, `data-testid=account-mark`, same size and stroke) followed by the label in `text-2xs text-muted-foreground` (muted-foreground on pane, row-hover, row-selected and tint are all in `CONTRAST_PAIRS`: AA), at most `max-w-[9rem]` (`7rem` in compact), truncated with an ellipsis, `title` = the full address. The ring leaves the marks group, where it was.
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
