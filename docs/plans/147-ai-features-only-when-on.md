# Plan 147: AI features show only when they can run

- **Status:** built. "Revisions after the Codex review" overrides the sections before it.
- **Builds on:** plan 146 (Dev mode), plan 85 (decision 9), plans 132, 133, 141 and 142 (the features).

## The request

> i'm seeing this locally, i have all env keys set, but i shouldn't be able to see this at all, this needs to respect the toggle for the dev mode to show the ai pro plan features, otherwise it shouldn't show, and it should not show at all for free normal accounts

The screenshot's arrow points at the reader toolbar's Sparkles (Summarize).

## What the words mean here

- **"The toggle":** Settings → Dev mode → Pro AI (`settings.devAi`). On a local build it alone decides whether the features show, whatever the profile has saved. A saved key or the demo model doesn't bring them back while it's off.
- **"Free normal accounts":** someone with no AI set up. **Decision 9 stands:** a user's own key or local model still runs every AI feature without Pro, so they see them. The request doesn't name that case, and decision 9 is the user's own words from a day earlier. This is the one reading to confirm; changing it is one line in `aiAllowed`, once there is an entitlement to read.
- **"The ai pro plan features":** the four that exist: summaries, drafting, Ask (with Actions, on its page) and follow-ups. AI filters and categorization are Free in plan 85 and stay as they are.

## What exists

| Surface | Today's gate |
| --- | --- |
| Reader's Summarize, palette's Summarize | not in spam or trash; nothing about AI |
| Sparkles in a draft and on the reply bar, palette's two draft rows, ⌘J | `useAiDraftUi.enabled` (the feature's own switch, on by default) |
| Palette's Ask, Ask history and "Ask AI:" rows, ⇧⌘K | `settings.ask.enabled` (on by default) |
| Follow-ups row, palette row, lines in the reader, the Inbox's top | `settings.followups.enabled` (off by default; can't be turned on without a provider) |
| Summary block | shows what's stored (plan 132: reading is never gated) |

So a fresh install sees Sparkles everywhere, and each opens a "needs an AI provider" message. Plan 85 decision 9 chose that ("offers both ways") and plan 141 said "there with or without a provider". This request replaces it: nothing shows until it can run, and Settings → AI stays the way in. `backend-entry.ts`' demo seed already said so ("the AI features show only once a real model is set up"), and later plans didn't hold to it.

## Design

One place decides, in `lib/ai.ts`, next to `aiReady`. The selectors take app state, so `useApp(summariesOffered)` and `getApp()` read the same rule.

```ts
/** A local build: Dev mode's switch, whatever is saved. Any other build: nothing to ask here. */
aiAllowed(s) = s.devAi === null || s.settings?.devAi === true

summariesOffered(s) = aiAllowed(s) && summaryReady(s.settings?.ai)
draftingOffered(s)  = aiAllowed(s) && writingTarget(s.settings?.ai).ready
askOffered(s)       = aiAllowed(s) && s.settings?.ask?.enabled !== false && askReady(s.settings?.ai)
followupsOffered(s) = aiAllowed(s) && s.settings?.followups?.enabled === true
```

- `summaryReady(ai)` is new, by the backend's rule as `summaryTarget` reads it: the task's own choice if its provider can run; else an OpenAI key; else `aiReady`. "Another cloud provider set up" counts, since the block then asks where it should go.
- `followupsOffered` doesn't ask for a provider: the switch already needs one to turn on, and what was found stays readable when a key goes (plan 142).
- Followups read `settings.ai` through the overlay, so Dev mode with only `JEV_API_KEY` (`provider: "none"`) shows none of the writing features, as it should.

### The gates

- `SummarizeButton` renders nothing unless offered (inside the button, so the reader doesn't render again on a change of settings). Palette's `thread.summarize` too.
- `AiDraftButton`, the palette's `draft.ai` and `compose.ai`, `openAiDraft` (⌘J) and `preloadAiDraft`.
- `toggleAsk` (⇧⌘K), the palette's `ask.open`, `ask.history` and `palette-ask-row`.
- Sidebar's and palette's follow-ups rows, `ThreadFollowups`, `on()` and the list's top in `state/list.ts`. The `useApp.subscribe` in `followups.ts` follows `followupsOffered`, so turning Dev mode's switch off leaves the Follow-ups list the way the feature's own switch does.
- **`ThreadSummary` renders nothing when `!aiAllowed`.** On a local build the switch hides what's stored too, and turning it back on shows it. On any other build reading stays ungated (plan 132), so someone whose key went keeps what they have.
- The shortcuts sheet leaves out ⌘J and ⇧⌘K while not offered: a row with nothing behind it.

### What stays

- **The messages stay** (`ai-no-provider`, `summary-block` no-provider, `ask-no-provider`): each is still reached when the provider goes while the surface is open, or the backend answers `not_configured`.
- **Settings → AI stays as it is**, on every build. It's how someone sets up their own key.
- **The backend doesn't change.** Workers and RPCs run on what's configured, by decision 9. On a local build with the switch off and a saved key, a background summary still runs if that profile turned summaries on: this hides, it doesn't change who may run what. The overlay (`readSettings`) keeps its "off is an exact return".
- **Plan 85's Pro tags and popover** aren't built; that part of §7 and decision 9 is replaced here, and a note goes there.

## Tests

- **Unit (`ai.test.ts`):** each selector: no provider off; own key on; own local model on; local build with the switch off hides even with a saved key; on shows; JEV alone shows no writing feature; a task's own target; Ask's switch; follow-ups' switch.
- **e2e (`dev-mode.spec.ts`), the regression:** a local build with the demo model saved and the switch off: no Summarize, no reply-bar Sparkles, no palette rows, ⌘J and ⇧⌘K do nothing, a stored summary is hidden. Switch on: all there. Off again: gone.
- **e2e, no provider (a normal free install):** `summaries.spec`, `ai-draft.spec` and `ask.spec`'s "no provider" flows now hold that nothing shows. Each message is still reached the way it can be: the provider going while the row or page is open, a retry after it went.

## Perf and resources

Selectors are a few field reads. Nothing new loads; a free install now preloads nothing and renders one button less per toolbar. The entry chunk grows by four one-liners.

## Out of scope

Entitlements, `requirePro()` (plan 85). Stopping background workers on a local build with the switch off. AI filters and categorization.

## Revisions after the Codex review

Codex (read-only, against `684d28c4`) raised 10 points. Seven are accepted, in whole or in part:

1. **Prepared replies (plan 144) landed while this was being written.** They're a fifth feature: `repliesOffered`, on the reader's block and `replies.ts`' `on()`, so nothing is prepared while hidden.
2. **A task's own choice never falls back.** `AiService.targetFor` uses an explicit target and fails if it can't run, so `summaryReady` doesn't try the OpenAI key or the main provider after one. §Design's sentence is wrong and goes.
3. **Drafting's own switch stays in the gate.** It isn't in app settings, so `useCanDraft()` (and `canDraft()` in `ai-draft-state.ts`) read both: every surface, the shortcuts sheet too.
4. **A row already up can't run after the switch went off (part of point 5).** `submit` and the row's opening read `draftingOffered`, so it says what it needs. The row isn't hidden: a preview it holds guards the send (`blocksSend`).
5. **Nudge is a draft.** A follow-up stays readable when a key goes, and its Nudge doesn't: `canNudge`.
6. **A follow-up that's hidden isn't seen.** `followups.ts`' `opened` reads `on()`, so opening a thread with the switch off doesn't end its Inbox row.
7. **`ThreadSummary` isn't mounted, rather than rendering nothing,** so its effect can't carry on a summary waiting for a body. The gate is in the reader.

8. **Today (plan 145) landed before this did.** It already had its rule (`aiFeaturesAvailable`, where Pro's entitlement joins); `todayAvailable` and `todayOffered` add the switch to it, on the sidebar's and palette's rows, the brief's notice and leaving the list.

Not taken:

- **Stricter readiness for an explicit target (`compatible` without an endpoint, a key confirmed for another origin).** These are the helpers the features already use. A rare broken setup shows the button and the error says what's wrong, which is the better failure.
- **The preferences read at boot.** Drafting's switch defaults to on until it's read, as it has since plan 133: a brief state for someone who turned it off.
- **An Ask page open when the switch goes off, and other windows hearing of it.** Settings can't be open over the palette, so this needs a second window, and `settings.update` isn't broadcast for any setting. A window takes the change on reload; the backend's `not_configured` covers anything sent before. Worth its own plan if a settings event is ever added.

## What the code review changed

Codex (read-only, on the fix) raised 1 point, fixed with a test that fails without it:

1. **A strip already up could still run.** Regenerate, Shorter, Warmer, Try again and an answered question go to `startRun` without passing `submit`, so turning the switch off left them running on a saved provider. The check now sits in `startRun`, and the strip stays with its Undo.
