# Plan 247: What matters gets its own section in Settings

## Request (verbatim)

> when 'what matters' is shown to the user, lets have a section on settings for that alone, so we'd move it out from the 'general' tab.
>
> lets also improve the ui of that settings so its extremely clear what you can do and the ui/ux is clean and intuitive.

## What exists

What matters' settings are spread over three sections, under names that don't say what they do:

- **General**, top: *Open at launch* (Inbox | What matters, `FirstScreenGroup`, only while What matters shows) and *Show the unread count on the Inbox* (only while it opens first).
- **General → What matters** (`today-settings.tsx`, while `aiFeaturesAvailable`): *Show “What matters”*, *Show finished items*, *Always shown in “What matters”* (a list), *Hidden from “What matters”* (a list and *Hide a kind from every sender…*), *Prepare at* (a time with no word on what is prepared), *Notify me when it's ready* (ready: what?), the reader's privacy line as the footer; on a local build with Dev mode's Pro AI off, a note with *Open Dev mode*.
- **AI → Newsletter digest** (`DigestGroup`: *Prepare a digest each day*, *Senders left out*) and **AI → What matters** (`DatedGroup`: *Find dates and requests in new mail*, with a paused status). The digest is the newsletters side of What matters, and *Prepare at* is the digest's time and the morning notice's (`packages/backend/src/today.ts` `arm`: no timer unless one of them is on), but they sit two sections apart.
- **Accounts → each account**: *Show in “What matters”* (plan 211).
- The gear on What matters (`what-matters/options.tsx`) opens *More settings…* at General's finished row; the first-launch question says “You can change this anytime in Settings → General”.
- Settings' search (plan 203, `search-index.ts`) lists each row by id (`general.today*`, `general.firstScreen`, `general.keepInboxCount`, `ai.digest`, `ai.digestExcluded`, `ai.dated`); `settings-search.test.ts` keeps rows and index in step (each id drawn in one place).
- `SETTINGS_TABS` (`tabs.ts`) is a fixed list; Dev mode's tab is appended where it exists (`settings-dialog.tsx`, `command-palette.tsx`).

## Design

### The section

- A **What matters** section in Settings' sidebar, second, after General (it is a main screen, not an AI preference), with the sidebar's own What matters glyph (`Sun`). `SettingsTab` gains `"whatMatters"`.
- **When it exists**: where What matters can exist, the rule its group has today (`aiFeaturesAvailable(settings)`): a free install with no AI has no What matters and no section. It stays while *Show in the sidebar* is off, since that switch is how it comes back. On a local build with Dev mode's Pro AI off the section is there with its note on top, as the group has now.
- One function in `tabs.ts` says which sections exist (`settingsTabs({ whatMatters, dev })`); the dialog's sidebar and the palette's *Settings → …* commands use it, so they can't disagree. Settings asked to open a section that doesn't exist here (What matters after AI was removed, an old `settingsTab`) shows General, as it shows the first section.
- **General** keeps what is general: remote images, language, sync, notifications, writing, keyboard, diagnostics. Nothing of What matters stays there (the app icon's badge still says which number it shows, from the first screen).
- **AI** loses the digest's and the reader's groups; each AI switch in What matters still names in its hint where the mail goes, as it does now.

### The page, by what you can do

Group titles say what's in them; every row says what it does in its label and what happens in its hint, in plain words.

1. **The view** (no title, the section's first card):
   - *Show in the sidebar* (switch), hint: “A view of only what needs you: replies you owe, bills, deadlines and what you said you’d do. Your Inbox keeps everything.”
   - *Open at launch* (Inbox | What matters), only while it's shown (unchanged rule, plan 207).
   - *Show the unread count on the Inbox*, only while What matters opens first (unchanged).
   - *Show finished items* (switch, unchanged words).
2. **What it looks for**:
   - *Find dates and requests in new mail* (switch), hint: “Bills, renewals, trips, other deadlines and what people ask of you. Read by {provider}.” The paused note stays under it.
   - Footer: who reads the mail (`datedReaderLine`), as General's group has it now, with the shield (`PrivacyNote` look) so it reads as the privacy line it is.
3. **Shown and hidden**:
   - *Always shown* (list with Stop; empty: how one comes to be shown).
   - *Hidden* (list with Show again, *Hide a kind from every sender…*; empty: how hiding comes about).
   Labels drop the repeated “in “What matters”” (the section says it); the hints keep saying what each does.
4. **Each morning**:
   - *Newsletter digest* (switch), the digest's hint (where its mail goes, the cost).
   - *Senders left out* (the list, when there is one), unchanged.
   - *Morning notification* (switch), hint: “How many things need you, never who or what.”
   - *Time* (the time field), hint: “When the digest is made and the notification comes. If Terno is closed then, at the next open.” With both off it is disabled and says so: “Turn on the digest or the notification to choose a time.” (the pattern of Undo send's window, plan 188).
5. **Accounts**, with two accounts or more: one row per account (its name, its address as the hint) with its *Show in “What matters”* switch, the same setting as Accounts' row (both save through `accounts.update`). Footer: “Off, nothing from that account appears here.” One account: no group (turning it off would empty the view; Accounts still has the switch).

### Search, links and words

- Index ids move to the section: `whatMatters.show`, `.firstScreen`, `.keepInboxCount`, `.finished`, `.dated`, `.shown`, `.muted`, `.digest`, `.digestExcluded`, `.notify`, `.time`, `.accounts` (the group), each `tab: "whatMatters"`, each with the rule it has now; in the section's order, after General's.
- The gear's *More settings…* opens the section at *Show finished items* (`whatMatters.finished`), the first-launch question says “Settings → What matters”.
- Every new or changed string in `en` and `es` together.
- Test ids of the moved controls stay (`today-*`, `first-screen-*`, `ai-digest-*`, `ai-dated-*`): they name the control, not where it sits; the group around them gets the section's (`wm-settings-*`).

## Tests

- `tabs.test.ts`: `settingsTabs` lists What matters second only where it exists, Dev mode last; names in English and Spanish.
- `settings-search.test.ts` (unchanged) keeps the moved rows and the index in step; a search for “digest”, “finished” and “launch” finds them in What matters (unit, `findEntries`).
- A unit test of the section (`what-matters-tab.test.tsx`): the groups in order; Time disabled with both switches off and its reason as its description, enabled with either; the Accounts group with two accounts, none with one; the reader names who reads its mail beside the switch and in the footer.
- e2e, moved to the new section (`first-screen.spec.ts`, `what-matters-feed.spec.ts` More settings, `what-matters-show-sender.spec.ts`, `what-matters-mute.spec.ts`, `today.spec.ts` digest and dated groups, `dev-mode.spec.ts` Pro note, `design-axe.spec.ts`): the section's tab is there with AI and not without; General has no What matters row; axe in light and dark on the section. One new scenario in `what-matters-feed.spec.ts`: the Accounts group's switch and Accounts' own stay in step.
- Site and demo scripts (`apps/site/shots/ai-shots.ts`, `apps/desktop/scripts/demo-ai-prepare.mjs`) open the section for the digest switch.
- Visual: the section in light and dark, looked at; `pnpm ui:rate` is for main screens, Settings is not one of the rated screens (`docs/ui-rating.md`), so not run.

## Perf

Settings only, nothing on a hot path; no new reads beyond what the moved groups did (the digest's left-out senders, the reader's status, read when the section is open). The accounts list comes from app state.

## Out of scope

- What `show` does in the backend (the digest and notification run with the view hidden: unchanged).
- The gear's popover on What matters.
- Accounts' own switch (stays where it is).

## Revisions after the Codex review

Codex's critique (12 points) changed:

- **No “Open AI” button** (#1): the section exists only where AI can run (`aiReady`), and that already means the reader has a route, so a missing provider can't be reached from here. The reader's switch keeps its rule (`!ready && !enabled` disabled: on, it can still go off) and its no-route hint, defensively.
- **The section going away while asked for** (#2): the stored section is set back to General (an effect: the store is outside React), so a search waiting for a row there stops (`find-open` cancels on a section change); focus lost with its tab goes to General's tab; opening Settings on a section that isn't here focuses General's tab.
- **The time field** (#3): takes the row's description too, and `isDisabled` with both off.
- **No promise the backend doesn't keep** (#4): the notification comes only within two hours of the time and only when something needs you, so the time's hint says the *digest* is made at the next open, and the notification's says “only when something does”.
- **The accounts' switch** (#5): one save (`setAccountFeed` in `lib/accounts.ts`, a refusal said in a snack) used by Accounts and the new group; the group is its own setting (`whatMatters.accounts`, rows `find={false}`), `account.feed` stays Accounts'. The group shows wherever the section does (Accounts' switch keeps its own rule, `aiFeaturesOffered`).
- **The reader still names where its mail goes, beside its switch** (#6): “… Read by {provider}.”, with the full privacy line as the group's footer.
- **“Senders” → “Shown and hidden”** (#7): what's hidden can be a kind from any sender. Settings has its own short labels; `dated.mute.title`, shared with the gear's popover, is unchanged.
- **Search tests** (#8): `settings-search.test.ts` gets an AI-enabled context: the moved rows are found in What matters, in order, with the rows' own rules (launch only while it shows, Dev mode's switch, the accounts group with several accounts).
- **Navigation tests** (#9, #10): `settings.spec.ts`, `settings-pass.spec.ts` (tab order, ArrowDown from General), `first-screen.spec.ts` (the badge row is General's: switch sections between), `design-axe.spec.ts`, `today.spec.ts` move with the rows.
- **Scripts** (#11): the rating harness (`backgroundSwitches`, `checkAi`), the site's shots (setup and retry) and the demo's preparation open What matters for the digest switch.
- **The palette** (#12): it gains one command, *Settings → What matters*, in its Settings group at the foot of the list; the rated palette shot (its root, `08-command-palette`) is checked to look the same. A full rating round is not run for this.

## Revisions after the Codex code review

Codex's review (3 findings) changed:

- **The digest page's “Newsletter digest settings”** opened AI, where the switch no longer is: it opens What matters at the digest's switch (`openFound`, as the gear's More settings does). `today.spec.ts` follows the link and finds the switch focused.
- **“Let them back in from Settings → AI → Newsletter digest”** (the Hide sender help, en and es, both plural forms) names Settings → What matters → Each morning; `digest-page.test.tsx` and `today.spec.ts` read it.
- **The left-out senders' search entry** lost its `under` when it moved: with nobody left out its row isn't drawn, so a search for it opens the digest's switch again (`under: "whatMatters.digest"`, asserted in `settings-search.test.ts`).

Also found while testing: Settings learns of settings only from its own calls (no event from another window), so the section can only go while Settings is on another section (AI's provider set to None). The e2e takes that path; the fallback to General stays for a stored section that isn't there any more.
