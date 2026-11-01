# Plan 97: local mode means your mail is stored only here

- **Status:** planned.
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
