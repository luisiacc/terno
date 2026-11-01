# Plan 97: local mode means your mail is stored only here

- **Status:** shipped (see "What the Codex code review changed").
- **Changes:** plan 11 (updates in local mode), plan 22 (sender icons in local mode), plan 5 (AI in local mode), plan 37 (the renderer fence), plan 95 (restore turned local mode on), and the privacy paragraph in AGENTS.md.

## Request

> "local mode is the default, it should just mean that emails are not stored on servers, everything else should be able to use itnernet, like checking for updates"

Asked whether cloud AI (which sends a mail's text to the provider) and website icons (which send the sender's domain to an icon service) should then be allowed in local mode, the answer was: **"Allow both."**

## What exists

Local mode (`settings.localMode`, default `true`) is a network switch today:

- **Backend network policy** (`packages/backend/src/net-policy.ts`):
  - every purpose but `mail`, `unsubscribe` and `icons` is refused
  - AI must be a local provider on a loopback address (pinned)
  - icons follow their own setting
- **Settings** (`packages/backend/src/settings.ts`): choosing a cloud AI provider is refused in local mode.
- **AI tab:** cloud providers are disabled; a cloud choice made earlier shows as paused.
- **Updates** (plan 11): no automatic check or download. A manual check and download are one grant each.
- **Renderer fence** (`apps/desktop/src/network-backstop.ts`):
  - in local mode, only loopback, plus images a mail frame loads (plan 37)
  - with local mode off, anything goes
- **Copy:**
  - the Settings switch, its hints and the "Turn off local mode?" confirmation
  - the sidebar's Local / Cloud AI pill
  - the update popover and settings lines
  - the sender-pictures hint
  - the AI tab's notes
- **Restore** (plan 95) turns local mode on in the restored copy.
- **Error reports** are already independent of local mode (plan 78).

Terno has no server that stores mail. Nothing in the code would store mail anywhere but this Mac, or this browser in the web build, with local mode on or off.

## Design

1. **What local mode means.** "Your mail is stored only on this Mac" (web: "in this browser"). Since Terno has no mail server, that is simply true, so local mode is no longer a switch.
   - `settings.localMode` stays in the stored settings (imports and older copies read it), but nothing reads it for a decision.
   - The Settings switch becomes a statement row:
     - title: **Local**
     - Mac: "Your mail is stored only on this Mac. Terno has no server that keeps it."
     - web: "Your mail is stored only in this browser. Terno has no server that keeps it."
   - The "Turn off local mode?" dialog goes.
2. **Network: each feature decides for itself**, by its own setting and the user's choices:
   - **mail:** the user's servers
   - **AI:** the provider the user picked (a cloud provider needs their key)
   - **icons:** the Appearance setting
   - **updates:** the Updates setting (automatic or manual)
   - **error reports:** their consent (plan 78)
   - **remote content:** per message, or the setting (plan 37)
   - **unsubscribe:** the user's click

   In `net-policy.ts`, the local-mode branch goes.
   - A provider declared local still has its loopback address pinned (that's about the provider's honesty, not local mode). A local provider whose host doesn't resolve to loopback is refused with the existing "isn't a local address" error, reworded so it doesn't mention local mode.
   - `isLocalMode()` is removed from the policy surface.
3. **AI:** cloud providers can be chosen. The AI tab loses its local-mode note and pause. The first-run "use the model already running on this Mac" keeps working, and no longer looks at local mode.
4. **Updates:** automatic checks and downloads follow the Updates setting only.
   - The controller's local-mode branches go: no revocation, no schedule change. `UpdateState.localMode` is removed.
   - The disclosure stays in Settings ("Updates come from GitHub (github.com) and nowhere else").
   - The required update (plan 95) is now learned by the automatic check.
5. **Renderer fence (desktop):** always the strict fence that local mode had.
   - Nothing the user can do needs the renderer itself on the internet: mail, AI, icons, updates and reports go through the backend, the updater's session or the reporter's session.
   - That is defense in depth against a page or frame reaching out, and it now holds for everyone instead of only in local mode.
   - Main's `localMode` variable and the backstop's `localMode` option go.
6. **Sidebar pill:**
   - **Local** (mail on this Mac) by default
   - **Cloud AI: {provider}** while a cloud provider is chosen, the disclosure that matters now
7. **Restore** no longer turns local mode on. Its quarantine of ops and scheduled sends stays, and its copy drops "local mode is on".
8. **AGENTS.md:** the privacy paragraph says what local mode means now, and that each outbound feature is its own explicit choice or setting. Mail content still never leaves except to the user's mail servers and the AI provider they picked. The memory file is updated to match.

## Tests

- **Unit:**
  - the network policy: cloud AI allowed with `localMode: true` stored; a "local" provider off loopback still refused; icons still follow their setting; no purpose refused for local mode
  - settings: a cloud provider can be chosen
  - updates: the controller and policy run automatic checks and downloads by mode alone
  - the backstop: strict, and needs no `localMode`
  - restore: the quarantine doesn't touch `localMode`
- **e2e:**
  - Settings shows the statement row, not a switch, light and dark
  - the AI tab offers cloud providers
  - the sidebar pill
  - the existing specs that toggled local mode are updated
- **Packaged smoke:** the update smoke's "no request at launch" relies on the test build's baked one-hour check delay, so it stays true. The required-update smoke is unchanged.

## Out of scope

- A Terno server or sync: if one ever exists, local mode becomes a switch again.
- Removing `localMode` from the stored settings schema.

## Revisions after the Codex review

These override the design above where they conflict. The full critique is in `/tmp/terno-p95/p97-review.txt`.

1. **The network behaves exactly as with local mode off today**, which is already shipped and tested.
   - AI endpoints are not pinned to loopback, redirects are handled as they are with local mode off (a request carrying a key never follows one), and custom compatible endpoints work wherever they are.
   - There is no new "declared local" rule (review points 3, 4, 10).
   - The AI tab's endpoint check that existed only in local mode goes with it.
2. **The AI service's own gate** (`ai-service.ts` `isLocalMode()`, `errors.ai.pausedByLocalMode`) goes, and so does `isLocalMode` on the policy (point 1).
3. **A paused cloud choice doesn't resume on its own** (point 2).
   - A one-time settings migration (`localModeMeansLocalMail`, versioned like the others) does this for a profile whose local mode was on and whose AI provider is a cloud one, i.e. one that was paused: the provider becomes "none" and the categorizer's AI use goes off.
   - Saved keys and profiles stay.
   - The AI tab shows the providers as usual, so choosing one again is one click.
4. **Imports and restore keep the user's own settings as written** (points 5, 6). A cloud provider in an export or a backup was the user's choice. An import that brings one in still needs its key on this Mac (key-origin binding unchanged), and the restored copy's quarantine keeps covering ops and scheduled sends.
5. **The old flag's existing readers keep reading it** (points 7, 8):
   - the historical migrations (remote images, error reports, `keptPolicy`)
   - the policy message (`localMode` stays in the contract, and diagnostics still validates it)

   Only enforcement goes.
6. **First run** writes the discovered local model only while AI is still unset when discovery answers (point 9).
7. **The copy says what's true** (point 11):
   - "Terno keeps its copy of your mail on this Mac. It has no server of its own that stores your mail." (web: "in this browser")
   - cloud AI is disclosed where it's chosen and by the sidebar pill ("Cloud AI: {provider}")
8. **The full copy and test inventory** (point 12): `settings.categories.askAi.hint`, `ai.help.blocked` and `sidebar.cloudTip`, in en and es; `local-ai.spec.ts`, `identity.spec.ts`, `visual.spec.ts`, `settings-pass.spec.ts`, `icons.spec.ts`, `updates.spec.ts` and `mailbox-gate.spec.ts`.
   - **No new packaged coverage for the fence:** the strict fence is what every default profile already runs (local mode was on by default), so the existing packaged smokes for remote content, print, avatars and reports already exercise it. Only profiles that had turned local mode off see a change.

## What the Codex code review changed

The review is in `/tmp/terno-p95/p97-code-review.txt`. Each fix has a regression test that fails without it.

1. **The migration clears everything local mode had blocked, whatever its kind** (`migrateLocalMail`): a remote Ollama, LM Studio or custom endpoint, as well as cloud providers. Endpoints on loopback stay. A custom name that resolved to loopback can't be told apart without DNS and is cleared; that is the safe side.
2. **"Local" now means the endpoint is on this machine** (`isLocalProvider`): a local kind pointed at another machine is disclosed like a cloud one, in the sidebar pill, the AI tab's privacy footer, error help and categorizer reasons.

## Verification

- **Unit:**
  - the network policy: every purpose passes with no lookups or pinning; a keyed AI request still follows no redirect; unsubscribe never follows one
  - the AI backend: a cloud provider can be chosen and used with local mode on; the migration's cases; `ai.local` by endpoint
  - the updater runs automatically by mode alone
  - the renderer fence is strict for everyone
- **e2e:** Settings shows the statement row in light and dark, which I looked at; every provider can be chosen; a remote Ollama shows in the pill; the visual baselines for the AI tab were updated.
- **Packaged** (fresh build): the packaged, mailbox, update, print and diagnostics smokes.

## Follow-up: no local-mode wording at all

> "just remove the wording of local mode as a sidebar pill even, it means nothing"

- **Removed:**
  - the General row ("Local mode", with its statement)
  - the sidebar's "Local" pill
  - their strings, in en and es
- **What remains** in the sidebar is `CloudAiPill`, shown only while the chosen AI runs off this machine (a cloud service, or a server elsewhere). It names that service and opens Settings → AI; that is the one thing about where mail text goes that a user needs to see.
- **The stored setting:** `settings.localMode` stays stored and decides nothing.
- **Tests:** the specs and smokes that looked for the pill or the row now assert that neither exists. The General baselines (en and es) were updated and looked at.
