# Plan 207: The first screen, and one number

- **Status:** plan.
- **Builds on:**
  - plan 204, which reserved 207 for "the first screen";
  - plan 210 §5–6, the feed's count (`TODAY_COUNTED`) and "the first screen stays 207's";
  - plan 211, AI on by default wherever it can run;
  - plans 147 and 150, the one AI gate (`aiFeaturesAvailable`, Dev mode's switch), which plan 85's Pro joins in one line;
  - plan 41, the Dock's number;
  - plan 113, tips (the "today-first" tip this replaces).
- **Changes plan 204's choice:** the first screen is set in Settings → General and asked once, not by right-clicking a sidebar row.

## The request

> i'm concerned now users have 2 numbers to track, the 'unread' count and the numbers to see on the feed, this could get users confused, what do you think we could do about this? also consult fable 5.2 and gpt 6.2 astra with subagents

Fable 5.2 and GPT 6.2 Astra agreed the concern is real. The two numbers sit on neighbouring sidebar rows in one tone, and they move by different rules: reading drops the Inbox's, while Done, Later or Remove drops What matters'. Reminders and Follow-ups add two more "due" digits, whose items What matters already counts. The Dock shows unread, so someone who clears What matters still sees a red number. Astra proposed one number, chosen by the first screen; Fable proposed two numbers that look different. The owner chose Astra's:

> lets do the single number and decided by the user which they want as default, lets prompt the user to do that when they activate the pro plan with ai or when they activate ai(let me see pictures of it too, it needs to be concise and carry the benefits of using the feed instead of the inbox).
>
> lets make this easily changeable in settings as well so they can decide which will be the default.

## What exists

- **Launch.** The app opens on the Inbox (`view: "inbox"` in `apps/web/src/state/app.ts`). `boot()` (`apps/web/src/lib/boot.ts`) restores the focused account (`restoredFocus`) and, in List, a reloaded conversation (`bootPage`). Nothing opens What matters at launch.
- **The sidebar's numbers** (`apps/web/src/components/sidebar.tsx`):
  - the unified Inbox: `counts.inboxUnread`;
  - each account's Inbox: `counts.inboxUnreadByAccount`;
  - What matters: `counts.today`, said as "N need you", with its help;
  - Reminders and Follow-ups: "N due";
  - categories, folders and tabs: their unread counts.
- **What matters' number** is the backend's: `TodayService.withCount` sets `counts.today`, and is absent when What matters isn't available or shown. It is null during plan 17's backfill.
- **The Dock** (`packages/backend/src/attention.ts` `counts`) and the web's app badge (`apps/web/src/lib/notify.ts` `syncBadge`) both show `inboxUnread` when `dockBadge` is on. The setting reads "Show unread count in the Dock".
- **When AI turns on:** `todayOffered` (`apps/web/src/lib/ai.ts`) is `aiAllowed` && `aiFeaturesAvailable(settings)` && `today.show`. It turns true when a provider is set up in Settings → AI, or when Dev mode's switch turns on a local build. Pro will be one more input to `aiFeaturesAvailable` (plan 85: nothing is built). The sidebar offers the "today-first" tip at that moment.
- **Pro** doesn't exist yet, so "when they activate Pro" means the same gate turning on.

## Design

### 1. One setting: `firstScreen`

Add `firstScreen: "inbox" | "whatMatters" | null` to `AppSettings` (`packages/core/src/rpc/contract.ts`). It defaults to null, meaning "not asked yet", which behaves as Inbox. The usual path, end to end:
- the contract's patch schema;
- the backend defaults (`settings.ts`);
- import's key list (`import.ts`).

A null in the patch is accepted (only Settings' reset and tests use it).

**The effective first screen** is one pure function in core (`packages/core/src/first-screen.ts`), used by every window and by the backend:

```ts
leadScreen(firstScreen, whatMattersShown): "inbox" | "whatMatters"
// "whatMatters" only when chosen AND What matters is shown (AI gate, today.show)
```

When AI goes off, or What matters is hidden, everything falls back to the Inbox. The saved choice stays, and comes back with AI.

### 2. One number

The lead screen's row is the only one of the two with a number. The Dock shows that same number.

| | Inbox first (the default) | What matters first |
|---|---|---|
| Inbox (unified, and each account's Inbox) | unread, as now | no number |
| What matters | no number | "N need you", as now |
| Reminders | "N due", as now | no number (What matters counts a reminder due today), unless an account is out of What matters (plan 211) |
| Follow-ups | "N due", as now | "N due", as now: who hasn't answered you is never What matters' (plan 210, sixth panel round) |
| Categories, folders, Promotions/Social, Archive/Spam | as now | as now: they say where unread mail sits, not what to do |
| The Dock (desktop) and app badge (web) | Inbox unread | What matters' number |

- **Rows without a number keep their screen-reader description.** The row keeps its count and gets the tone `"hidden"` (`NavItem`'s `countTone`): the number isn't drawn, and the description still says "12 unread". The same tone reaches a favourited Inbox, each account's row and Inbox, and the focused account's sidebar.
- **The Dock never flashes.** During What matters' backfill (`counts.today === null`) it keeps the number it shows. When What matters isn't available (`today` absent), it shows the Inbox's.
- **`dockBadge`'s copy follows the rule.** The label becomes "Show count in the Dock". The hint says which count it shows:
  - "Unread conversations in the Inbox, the same number as in the sidebar." (Inbox first)
  - "What needs you in What matters, the same number as in the sidebar." (What matters first)
- **One function for both badges.** `badgeNumber(settings, counts, last)` in core is used by `attention.ts` and `notify.ts`. The backend reads `firstScreen` with `dockBadge` (`readAttention`), and `settings.update` refreshes the attention when `firstScreen` changes, as it does for `dockBadge`.

### 3. Launch

At boot, when `leadScreen` is What matters, the first screen is What matters (`today: true`) instead of the Inbox. A few cases:
- **A reload that reopens a conversation** (`bootPage`) keeps it. That's the user's position, not a launch.
- **A focused account** (`restoredFocus`): What matters wins, as clicking it does. The feed is every account's. The remembered focus isn't applied and isn't forgotten either: it comes back at the next launch on the Inbox.
- **Before the gate is known** (devAi, settings): both arrive in `app.bootstrap`, so the choice is made once, before the first list is asked for.

### 4. The question, asked once

**When.** When What matters is offered (`todayOffered` turns true) and `firstScreen` is null, the app asks once. That covers:
- a provider set up in Settings → AI;
- Dev mode's switch;
- later, Pro's entitlement, through the same gate.

It also covers an existing user who already has AI: they're asked at their next launch, since their sidebar changes with this plan.

**Where.** Nothing is ever put over another dialog. If Settings is open (where AI is usually turned on), the question waits until it closes. It's `dialog: "firstScreen"` in the app state, set by the same effect that offers the "today-first" tip today, and only when `dialog` is null.

**It replaces the "today-first" tip.** The question already says what What matters is. Answering it marks the tip seen, and the tip is offered only when the question isn't (`firstScreen` already set).

**The look.** A small dialog (`Dialog`, BoardUI's Modal port), about 400 px wide, calm, in the design's tokens:
- **A picture of the feed in miniature** (built with `tip-picture.tsx`'s pieces): a "Today" heading and three rows, each one sentence with a "when" on the right: "Reply to Ana about Friday's venue · 3 pm", "Pay the water bill · Fri", "Send Marco the deck, as you said · Tue". It is decorative (`aria-hidden`).
- **Title:** "Start with What matters?"
- **One line:** "It picks out what needs you from your mail, so you don't have to dig through the Inbox."
- **Three benefits**, each a muted icon and one line:
  - "Only what needs you: replies owed, bills due, what you promised"
  - "Nothing slips: a date that passes shows under Missed"
  - "One number to clear: Done takes it off"
- **Buttons:** "Keep the Inbox" (secondary), "Open What matters first" (primary, the default focus).
- **A quiet footnote:** "You can change this any time in Settings → General."

**The answer.**
- **"Open What matters first"** saves `whatMatters` and goes to What matters now, so the user sees what they chose.
- **"Keep the Inbox"** or Esc saves `inbox`. The question never returns, and Settings is the way back. There's no close ×: the answers say it, and a × sat over the picture's corner.
- **Saving fails:** the dialog stays open and the error says so in plain words ("Couldn't save your choice. Try again."). It isn't asked again behind the user's back.

### 5. Settings → General: "Open at launch"

A row at the top of General: **"Open at launch"**, with a two-item segmented control (`ToggleGroup`): Inbox / What matters. The hint: "Its count is the one in the sidebar and the Dock."
- It shows only where What matters is offered (plan 147: AI settings show only where AI can run).
- It's found by the settings search (`search-index.ts`, `find="general.firstScreen"`).
- Changing it saves `firstScreen`, and the sidebar and Dock follow at once. The current screen doesn't move: it only decides launches.

### 6. Copy

Every string goes in `en` and `es` together. es: "Abrir al iniciar", "¿Empezar por Lo importante?", "Seguir con la Bandeja de entrada", "Abrir primero Lo importante", and so on.

## Tests

- **Unit (core, `first-screen.test.ts`):**
  - `leadScreen` for each setting × shown;
  - `badgeNumber`: Inbox first, What matters first, backfill (null keeps the last number), `today` absent (Inbox), `dockBadge` off (0).
- **Unit (backend, `attention.test.ts`):**
  - the Dock shows What matters' number when it's first;
  - a `firstScreen` change refreshes it;
  - backfill doesn't flash.
- **Unit (web, sidebar):**
  - the counts table above, both ways, including the hidden numbers' descriptions;
  - What matters hidden → the Inbox's number is back.
- **e2e (`first-screen.spec.ts`, one `scenario()` page; `today` and a new `firstScreen: null` fixture option):**
  1. Turning AI on asks the question, after Settings closes. Choosing What matters opens it; the sidebar shows only its number; the Inbox row's description still says unread. Reloading launches on What matters.
  2. In Settings → General → Open at launch, choosing Inbox brings back the Inbox's number and launches on the Inbox. Settings search finds the row.
  3. Esc on the question keeps the Inbox and never asks again (reload).
  4. axe on the question, light and dark.
- **The fixture:** the server sets `firstScreen: "inbox"` unless a test opts in, as the `today` fixture does. Otherwise every AI spec would meet the question.
- **Pictures:** the question and the settings row in light and dark, in the default design, looked at.

## Performance and resources

- No new query. The sidebar picks between numbers it already has.
- The Dock's rule runs where the counts are already sent (`sendCounts`).
- Nothing runs until the gate turns on, and the question is one dialog, mounted only while open.

## Out of scope

- Right-click "Open at launch" on the sidebar rows (plan 204's first idea; Settings and the question cover it).
- "12 unread" in the Inbox's header when What matters is first (Astra's suggestion): left until the panel says people miss it.
- Hiding category or folder counts.
- Pro itself (plan 85). It joins by `aiFeaturesAvailable`'s entitlement, and the question follows with no change.

## Revisions after the Codex review

Codex's critique (12 points), and what changed:

1. **Two windows can both ask.** Not taken: there's no settings event between windows today (every setting has this), and the desktop has one main window. Each window asks at most once, and the last answer wins.
2. **Stale settings answers.** Not taken, for the same reason as every other setting: the answer is applied from `settings.update`'s own reply.
3. **A focused account at launch.** Taken: What matters wins and the remembered focus waits (§3).
4. **Launch races the first list.** Taken: the launch place goes into bootstrap's one `setApp`, so the first list asked for is the feed's, never the Inbox's then the feed's.
5. **A reload on a conversation.** Taken: List's address (`#/…`) keeps the conversation, and the launch rule doesn't apply.
6. **A hidden number loses its description.** Already avoided: the count stays, only its drawing goes (`"hidden"` tone).
7. **More Inbox numbers.** Taken: a favourited Inbox, account rows, account Inboxes and the solo sidebar follow the same tone.
8. **"No dialog" isn't a clear stage.** Taken: `FirstScreenAsk` waits for no dialog, no menu and no modal (as tips do). It re-checks on every change, and the dialog closes itself if the gate goes.
9. **A failed save.** Taken: the question calls `settings.update` itself, stays open with "Your choice wasn't saved. Try again.", and its buttons are disabled while saving.
10. **Cached counts against the gate.** Partly: the badge reads `today`'s presence in the counts the backend sends, which follow the backend's own gate. Overlapping count reads are as before (the Inbox's number has the same window).
11. **Reminders of an account out of What matters.** Taken: Reminders keeps its number while any account is out of What matters. And on review of the count: Follow-ups keeps its number whatever leads, because What matters never shows who you're waiting on.
12. **Imports and the web badge.** Taken: an imported `firstScreen` refreshes the Dock, a file's null never replaces this install's answer, and the web's app badge copy follows the rule too. The fixture's row wait skips a launch on What matters.

Also:
- The "today-first" tip is removed rather than kept dormant: the question replaces it. The desktop smoke tests that dismissed it now dismiss the question.
- After the first screenshots, the first benefit was shortened to one line ("Only what needs you: replies, bills, your promises").
