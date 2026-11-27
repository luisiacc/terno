# Plan 294: settings pass 2 (where each setting lives, and whether it reads clearly)

- **Status:** built (§8, §9).
- **Builds on:** plan 08 (the first settings pass: every page reachable, named, editable), plan 203 (Settings search, `SETTINGS_INDEX` mirrors the rows), plan 246 (Settings remembers its place), plan 247 (What matters' section), plan 207 (Accounts' counts row first, by the owner), plan 188 (Undo send's time under its switch), commit 11bdb0bd6 (the JEV key in Settings → AI, by the owner today).
- **Request:** "lets do a pass over our settings, lets make sure that the settings items are on the places where they should be and sidebars where they should be, lets check if they are easy to change and understand. do a full pass here."

## 1. How the audit was done

- Every entry of `SETTINGS_INDEX` (`apps/web/src/components/settings/search-index.ts`, 130 rows, which `settings-search.test.ts` keeps in step with what Settings draws) dumped with its English label, hint and group.
- The e2e fixture (backend-dev, 4 accounts, demo AI), 1440×900: a scratch spec opened each of the 12 sections, an account and a category opened, scrolled top to bottom, screenshot per screen, light and dark.
- The code behind the doubtful rows: `accounts-tab.tsx`, `categories-tab.tsx`, `general-tab.tsx`, `capture-recovery.tsx`, `storage-tab.tsx`, `ai-tab.tsx`.

## 2. What exists

Sidebar, in order: General, What matters, Appearance, Accounts, Categories, Rules, Snippets, AI, Agents, Data, Storage, About (+ Dev mode on a local build).

| Section | Holds |
|---|---|
| General | Always load remote images · Language · Sync: Sync window · People: Who counts as a person · Notification settings: System notifications, Show sender and subject, Unread count on the icon · Writing: Suggest text, Undo send, Time to undo, Send sound · Keyboard: Single-key shortcuts, Keyboard shortcuts · Diagnostics: Error reports, What a report contains, Logs, build line |
| What matters | Show in the sidebar, Open at launch, Inbox count, Show finished items · What it looks for: Find dates and requests, In your words · Shown and hidden: Always shown, Hidden · Once a day: Newsletter digest, Senders left out, Daily notification, Time · Accounts |
| Appearance | List: Layout, Density, Preview · Style, Font · Mode, Light colors, Dark colors · Motion and mail: Animations, HTML mail · Sender pictures: Website icons, Forget saved icons · Custom themes |
| Accounts | Show unread counts on accounts · Your Terno account · Mail accounts, each opening to 15–19 rows in one flat list: Name, Sender name, Color, Signature, Use AI, Show in What matters, Writing instructions, Prepare replies, Also use my general instructions, Sync window, Show in all-accounts Inbox, Separate Promotions and Social / Other, Track follow-ups, Connection, Messages needing repair, (IMAP: Sent-copy recovery, Recipient outcomes), Remove · Add account |
| Categories | Smart categorization, Ask AI for help · the categories (Auto-add on the row; Name, Show in Inbox, Order, Color, Delete inside) · New category · senders Terno asks about |
| Rules | Your rules |
| Snippets | Snippets |
| AI | Provider (service, endpoint, key, model, test) · Drafting: Draft with AI, Instructions, Learn from my sent mail, Prepare a reply, Writing style · Summaries · Ask your mail · Follow-ups: Keep track of promises, Bring it back after · Categories: JEV API key · AI use this month, Monthly limit |
| Agents | Access: Allow agents, What agents can do, Access token · Connect: Claude Code, Codex, Other apps, Skill |
| Data | Backup: Export, Import |
| Storage | Mail by mailbox · Free up space · AI data · (web) Engine |
| About | Version, links, (desktop) Updates |

## 3. Findings

### 3.1 Bugs and unclear words (no decision needed)

| # | Where | Problem | Fix |
|---|---|---|---|
| 1 | Storage → AI data | "The summaries and writing style kept on this this Mac." `storage.clearAi.hint` says "this {device}" and `device()` is already "this Mac" / "this browser" | "kept on {device}" (en, es) |
| 2 | AI → Provider | Hint "AI builds rules from your description and, if you like, suggests categories." dates from plan 05: AI now drafts, summarizes, answers Ask, finds what matters and tracks follow-ups | "Runs drafts, summaries, Ask and “What matters”. Each feature below says what it sends." |
| 3 | General | Group title "Notification settings": every other title is a noun ("Sync", "Writing", "Keyboard") and we are already in Settings | "Notifications" |
| 4 | Accounts → an account → Connection | A connected Gmail account offers "Connect with Google" beside "Up to date": reads as if it isn't connected | "Sign in again with Google" / "…with Microsoft" (the password kind keeps "Change password…") |
| 5 | Accounts → an account | "Messages needing repair" shows in every account as a closed disclosure that opens on "No messages need repair." | show the row only when the account has messages to repair (it loads on open today: needs a count from the backend, or the row stays and says "None" without a disclosure) |
| 6 | Snippets, AI | A one-row group titled as its own row or section: "Snippets" over Snippets, "Summaries" over "Summarize new mail", "Ask your mail" over "Ask your mail" | drop a group title that repeats its section's or its only row's name (search already skips the first case, plan 203) |
| 7 | AI | Each AI switch's hint is the full privacy disclosure: "Prepare a reply…" is 5 lines, "Ask your mail" 4; the controls get lost in text | one plain sentence of what it does, then the "what is sent" line in the muted Privacy style What matters already uses under "In your words" (the shield line) |
| 8 | Categories | The disclosure chevron sits between the name and the Auto-add switch; in Accounts it is at the right edge | dropped after the Codex critique (§8 #11): the chevron is inside the disclosure's button and the switch is its sibling; moving it would nest controls |

### 3.2 Placement (decisions in §4)

| # | Setting | Now | Problem | Proposed |
|---|---|---|---|---|
| P1 | Always load remote images | General, alone in its own box at the top | A reading/privacy choice about how mail looks, far from HTML mail and Website icons, which are the same kind of choice | Appearance → a **Messages** group: HTML mail, Always load remote images, Website icons (+ Forget saved icons). Each keeps its privacy hint |
| P2 | Animations | Appearance → "Motion and mail" with HTML mail | "Motion and mail" is two unrelated things glued together | Animations joins Mode (the look); "Motion and mail" goes away with P1 |
| P3 | Sync window (default) | General → Sync, one row, whose hint says "each account can have its own in Accounts" | The default and its per-account overrides live in two sections | Accounts → above Mail accounts: "Sync window for new accounts"… or simply "Sync window" as the default, the accounts' rows under it |
| P4 | Writing: Suggest text, Undo send, Time to undo, Send sound | General | They are about composing, like Snippets, which has a section of its own | A **Writing** section (replaces Snippets): Suggest text, Undo send, Send sound, then Snippets' list. Signatures stay per account |
| P5 | Undo send + Time to undo | Two rows, the second disabled while the first is off (plan 188) | Two controls for one choice | One select: Off · 5 · 10 · 20 · 30 seconds. Reverses plan 188's two-row form |
| P6 | Follow-ups switch, Bring it back after | AI → Follow-ups | What it finds shows in What matters and People; its sibling detector "Find dates and requests" already sits in What matters → What it looks for. Two detectors, two sections | What matters → What it looks for: "Keep track of promises…" beside "Find dates and requests". AI keeps provider, drafting, summaries, Ask, usage |
| P7 | Diagnostics: Error reports, What a report contains, Logs, build line | General | Support material at the bottom of General; About has the version too, so the build appears twice | About → **Diagnostics** under the version (one build line) |
| P8 | Data: Export, Import | Its own section with one group of two buttons | A section for two buttons, next to Storage, which is also "your data on this device" | Storage → a **Backup** group at the top; section named "Storage" still (or "Data and storage") |
| P9 | Accounts' rows | One flat list of up to 19 rows per account, AI rows split by Sync window and Promotions (Track follow-ups sits after them) | Hard to scan; the AI rows aren't together | Sub-groups inside the account, small muted titles: **Identity** (Name, Sender name, Color, Signature) · **Mailbox** (Sync window, All-accounts Inbox, Separate Promotions/Other) · **AI** (Use AI, Show in What matters, Track follow-ups, Writing instructions, Also use general, Prepare replies) · **Connection** (Connection, repair, sent copies, outcomes, Remove) |
| P10 | Accounts: Show unread counts, Your Terno account | Above the mail accounts (counts first by the owner, plan 207) | The section's main thing, the accounts, comes third | Mail accounts first; the counts row and the Terno account under them. Reverses plan 207's placement |
| P11 | Sidebar order | General, What matters, Appearance, Accounts, Categories, Rules, Snippets, AI, Agents, Data, Storage, About | Accounts, the first thing set up, is fourth; Data and Storage split | General, Accounts, Appearance, Writing, What matters, Categories, Rules, AI, Agents, Storage, About (12 → 11, or 10 with P4 and P8) |

Kept as they are, on purpose:

- What matters → Accounts duplicates each account's "Show in What matters" (plan 247: one list where What matters is set, and the account's own switch). Both write the same field.
- The JEV key in AI → Categories (the owner's move today).
- "Who counts as a person" in General: it governs the From people filter and What matters alike, so no single feature section owns it.
- Light and dark color grids: long, but they are the choice itself.

## 4. Decisions for the owner (2026-11-27)

- **Taken:** P1 + P2 (Messages group), P3 (sync window to Accounts), P7 (Diagnostics to About), P8 (Data into Storage), P9 (each account's rows grouped), P10 (mail accounts first), P11 (sidebar order).
- **Declined:** P4 (a Writing section), P5 (Undo send as one select: plan 188's two rows stay), P6 (Follow-ups stay in AI).
- §3.1 goes ahead, but for #5 and #7 (§5.7) and #8 (§8).

## 5. Design

### 5.1 Mechanics

- A move is the row's JSX going to its new section plus its `SETTINGS_INDEX` entry moving with it (tab, group, order), so Settings search and the palette's "Settings → …" follow. `settings-search.test.ts` keeps the index and the rows in step. Moved entries take their new section's prefix: `general.remoteImages` → `appearance.remoteImages`, `general.syncWindow` → `accounts.syncWindow`, `general.reports|reportContents|logs` → `about.*`, `data.export|import` → `storage.export|import`.
- The `data` section goes from `SettingsTab` outright. Plan 246's place is this window's memory only (never stored), and every caller of `openSettings`/`settingsTab` is typed, so the type check finds any that named it; no alias is needed.
- No stored field changes its name or meaning. No migration.

### 5.2 Sidebar (P11)

General, Accounts, Appearance, What matters (where it can exist), Categories, Rules, Snippets, AI, Agents, Storage, About (+ Dev mode), the order the owner chose with Snippets where it was. Accounts, the first thing set up, moves up from fourth. Data is gone (P8): 11 entries, 12 with Dev mode.

### 5.3 General

Language · People (Who counts as a person) · Notifications (renamed from "Notification settings", §3.1 #3) · Writing · Keyboard. Remote images (P1), Sync window (P3) and Diagnostics (P7) leave. The People list's last Reset puts focus on the Language select (it went to the sync window's field, which has left).

### 5.4 Appearance (P1, P2)

List (Layout, Density, Preview) · Style, Font, **Animations** · Mode, Light colors, Dark colors · **Messages**: HTML mail, Always load remote images, Website icons, Forget saved icons, the icons' footer · Custom themes. The "Motion and mail" and "Sender pictures" titles go. `SenderPictures` becomes rows for the Messages group instead of a group of its own; its footer starts "Website icons are kept…" so that under a group of four it says which row it means.

### 5.5 Accounts (P3, P9, P10)

- **Mail accounts** first (the list, Add account). Then a group **All accounts**: Sync window (the default, `settings.syncWindowDays`; hint: every account downloads this many days unless it has its own) and Show unread counts on accounts. Then Your Terno account.
- Inside an open account, four sub-groups, each a `<section>` with a small muted `h5` title (the account's name is the `h4`), rows split by hairlines as now:
  - **Name and signature**: Name, Sender name, Color, Signature
  - **Mailbox**: Sync window, Show in all-accounts Inbox, Separate Promotions and Social / Separate Other
  - **AI** (while it has any row: AI offered, or the account's AI on): Use AI, Show in "What matters", Track follow-ups, Writing instructions, Prepare replies, Also use my general instructions
  - **Connection**: Connection, Messages needing repair, Sent-copy recovery and Recipient outcomes (IMAP), Remove account
- The account's Sync window hint names the new default's place ("Empty: the All accounts setting (180)").

### 5.6 Storage (P8) and About (P7)

- Storage: the usage, Mail by mailbox, Free up space, AI data, then **Backup** (Export, Import; its footer as now), then the web build's engine. The backup group shows when the storage report fails too.
- About: the card (version, update status), Updates (desktop), **Diagnostics** (Error reports, What a report contains, Logs), the links. The Diagnostics footer's build line goes: the card's version line already says it, and gains the build line's copy button and channel (its test id `build-copy` moves with it), so support's line is still one click.

### 5.7 Words (§3.1)

#1 "kept on {device}"; #2 the provider's hint; #3 "Notifications"; #4 "Sign in again with Google/Microsoft" for a connected account, and the row is "Status" under the Connection part; #6 the repeats named apart rather than dropped, so every group keeps a title like its neighbours: "Your snippets" over Snippets' list (as Rules has "Your rules"), and Ask's switch "Answer questions about my mail" under "Ask your mail". Each in en and es.

#5 (repair row only when needed) and #7 (AI hints shortened behind a Privacy line) are left for a later pass: #5 needs a count the backend doesn't serve today, and #7 rewrites every AI disclosure, which plan 97 and the CASA review read word for word.

## 6. Tests

- `settings-search.test.ts` (index ↔ rows), the tabs' unit tests, `settings-pass.spec.ts` and `settings-search.spec.ts` (TABS list and each moved row's new home), the axe sweep over every section in light and dark.
- Screenshots of every changed section, light and dark, looked at.
- `pnpm ui:rate` / `ui:gate` on Settings if it is a rated screen.

## 7. Out of scope

- New settings; changing what any setting does.
- The web build's Storage engine row (web is low priority).

## 8. Revisions after the Codex review (of the plan)

Codex (`codex exec -s read-only`) gave 12 points; what each changed:

1. Search index out of step while half-built → the index was rewritten in the new order with the new ids; an e2e scenario finds remote images, the default sync window, Export and Error reports and checks each opens in its new section.
2. Specs enumerating `data` or the old order (`i18n`, `design-axe`, `settings-pass` keyboard walk, `storage`'s detour, the palette's `settings data`) → all updated; Storage's backup words gain "data"/"datos" so search still finds it by that word.
3. `local-ai.spec` and `e2e-web/web.spec` look for remote images right after opening Settings → they open Appearance first.
4. Two rows named "Sync window" → the default is "Default sync window", its hint says it holds for every account without its own; the account's hint says "Empty: the default sync window (N)". The People list's last Reset now lands on the Language select, asserted in `person-rules.spec`.
5. Backup must not depend on the storage report → it renders outside the report's branch.
6. Plan 106/246 hooks on the account disclosure → untouched (`account-toggle`, `data-setting-scope`, the accordion's seeding); `account-menu.spec` passes.
7. Scoped search breadcrumbs → the account parts are not index groups: a result reads "Accounts · <account>"; the sync-window scenario checks an account's own result names its account.
8. Headings → each part is a `<section>` named by its `h5`, under the account's `h4`; asserted in `settings-pass`'s accessibility test. Titles weren't dropped (§5.7 #6), so no group lost its name.
9. Diagnostics' tests and support line → `diagnostics.spec`, `diagnostics.web.spec` and the desktop smoke open About; the build line's copy moved to About's version line and still copies the full commit and channel (checked from the clipboard).
10. Other places naming the old homes → the diagnostics README (en, es) and its desktop test, `docs/DIAGNOSTICS.md`; the site's privacy copy also sent people to General for updates (About since plan 190), fixed while here.
11. The category chevron is inside its button → §3.1 #8 dropped.
12. §3.1 promised #5 and #7 → deferred in §4; the provider hint no longer claims every disclosure sits below it.

## 9. What was built

- Sidebar: General, Accounts, Appearance, What matters, Categories, Rules, Snippets, AI, Agents, Storage, About (+ Dev mode). `data` left `SettingsTab`.
- General: Language, People, Notifications, Writing, Keyboard.
- Accounts: Mail accounts (each open account in four parts: Name and signature, Mailbox, AI, Connection), All accounts (Default sync window, Show unread counts), Your Terno account. `DaysField` moved to `days-field.tsx`.
- Appearance: List; Style, Font, Animations; Mode and colors; Messages (HTML mail, Always load remote images, Website icons, Forget saved icons); Custom themes. `SenderPictures` became `SiteIconRows`.
- Storage: … AI data, Backup (`data-tab.tsx` became `backup-group.tsx`), the web's engine. About: the card with the copy beside the version, Updates, Diagnostics, the links.
- Words: §5.7, en and es; unused keys removed (`settings.tab.data`, `settings.general.sync`, `settings.appearance.motionMail`, `settings.appearance.senderPictures`).
- Tests run: typecheck, lint, unit (settings, i18n, diag, settings-values, outlook-account), e2e (`settings-pass`, `settings-search`, `settings`, `storage`, `person-rules`, `account-folders`, `diagnostics`, `i18n`, `local-ai`, `icons`, `account-menu`, `first-sync`, `settings-toggles`, `motion-switch`, `summaries`, `design-axe` in macOS and Lumen), web (`web.spec`, `diagnostics.web`). Not run: the packaged desktop smoke (`diagnostics.smoke.ts` only changes which tab it opens).
- Not rated with `ui:rate`: Settings' sections aren't among the rated screens except AI's Writing style, which didn't change.

## 10. Codex code review (of 7a80c15ed..3d85b66c9)

Eight findings; what each changed:

1. "sync window" ranked an account's override above the default (a name starting with the query scores higher) → the pair is named alike, "Sync window for all accounts" and "Sync window for this account", and All accounts' entries come first among Accounts' in the index, so the tie keeps the default first. `settings-search.spec` checks the order.
2. Visual baselines → the seven Settings screenshots in `visual.spec` regenerated and looked at (every one shows the sidebar); the others passed unchanged.
3. Two open accounts gave two "Mailbox" landmarks → each part is named by its title and its account ("Mailbox Personal"); `settings-pass` opens two accounts and checks each name.
4. Search's Export opens Storage, which reads the storage report → **kept**: the report is Storage's own first screen, read on every visit to the section; Backup sitting in it is the owner's merge (P8). It is one backend read, sliced, the same a visit to Storage always cost.
5. The moved-rows scenario could pass on a tab switch alone → it checks each row's `data-found` mark and the sync window's focus.
6. About was missing from `settings-pass`'s tab list → added (reachability, axe, names, contrast, minimum size).
7. The clipboard check accepted a short commit and no channel → it now requires the card's commit and more, and the test channel.
8. Spanish footer "las muestra" after "iconos" → "los muestra"; `docs/WEB.md` sent people to Data → Storage's Backup.

