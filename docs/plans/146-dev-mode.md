# Plan 146: Dev mode in Settings

- **Status:** built.
- **Builds on:** plan 85 (Free and Pro; decisions 9, 10 and 11), plan 131 (`AiService.forTask`), plan 97 (`localMode` decides nothing).

## The request

> we need a 'dev mode' section on settings, that only shows when in local mode, for now lets have the ability to activaste ai features like in pro mode, indicate the env variables that are needed

## What the words mean here

- **"Local mode" is a local dev build, not the `localMode` setting.** That setting is on for every install, decides nothing and is never shown (plan 97), so it can't be what hides a section from users. The section shows when Terno runs from `pnpm dev:desktop` (or `pnpm dev`), never in a packaged app or the web build.
- **"Like in pro mode" is Pro's routing on the developer's keys.** Hosted AI isn't built (plan 85, order of work, steps 3 to 7): no relay, no entitlement, no `aiExecution`. What Pro will run is already decided: Sonnet 5.5 for drafting, GPT Luna for summaries (decision 11), JEV for categorizing (decision 8). `AiService.targetFor` already routes that way given an Anthropic provider and OpenAI and JEV keys. Dev mode gives it those without any setup, from the environment.

## What exists

- `AiService.forTask` is the one place that picks a target, and `config()` the one place that reads its key. `readSettings(store)` is what both the backend's workers and the renderer's gates (`aiReady`, `summaryTarget`, `noAi`) read; it has 26 callers.
- `dev.mjs` starts Electron with `TERNO_DEV_URL`; main's `isDev` follows it and goes to the backend as `dev` in `init`. It doesn't read `.env`. `scripts/release-env.mjs` has `withDotEnv`, "what is already set wins".
- The repo's `.env` already holds `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `JEV_API_KEY`.

## Design

### 1. An overlay, not a copy

Turning it on writes one flag. Env keys are never saved, and the provider, saved keys, endpoints and per-task choices stay as they are, so turning it off is an exact return (principle 1, and decision 10's "switching never touches the saved provider config"). Copying keys into the keychain was the other way: it would overwrite a saved key, and go stale.

```ts
// @terno/core
DEV_AI_ENV = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", jev: "JEV_API_KEY" }
devAiKeys(env): DevAiKeys // the non-empty ones
```

- **`BackendOptions.devAi?: DevAiKeys`**: present only on a local build. Absent, nothing below runs, a stored flag is inert, and `settings.update` refuses to turn it on.
- **`readSettings(store)` applies the overlay** when this backend has `devAi` and the stored flag is on, since it is what every gate reads. The keys are registered against the store (`WeakMap`) so no caller can miss it. It sets:
  - `provider`: Anthropic if its key is set, else OpenAI, else what was stored (JEV alone can't write).
  - `model`: the profile's model, or the default (`DEFAULT_ANTHROPIC_MODEL`, `SUMMARY_DEFAULT_MODEL`). `hasKey`, `keyConfirmed` true; `keyUnreadable`, `local` false; `keyHint`, `keyOrigin`, `baseURL`, `preset` empty.
  - `keys`: what the environment has and nothing else. A saved JEV key doesn't quietly run.
  - `profiles`: the three providers lose any custom `baseURL`, so an env key goes only to the provider's own endpoint.
  - `tasks`: only the choices on a provider the environment has a key for, so Settings → AI's per-task rows still work and a stale one can't send mail to another provider.
- **`AiService.config()`** takes the key from `devAi` for those three providers while the flag is on, ignores any `baseURL` on the target, and doesn't touch key origins.
- **`readStoredSettings(store)`** is the same read without the overlay, for export and import: an export never records the overlay as the user's own choice. The flag isn't exported.
- `settings.update` with a changed `devAi` does what `ai.setKey` does: `configChanged()` (nothing more goes where the developer just left), then the summaries, follow-ups, ask and categorization workers hear of it.
- The monthly limit still applies to everything, so a loop can't spend without bound.

### 2. Who gets `devAi`

- Desktop: main sends `devMode: isDev && !app.isPackaged`, as a pure `devModeOf({ devUrl, packaged })`. `backend-entry` turns it into `devAiKeys(process.env)`. A packaged app given `TERNO_DEV_URL` stays out.
- `dev.mjs` adds those three names from `.env` through `withDotEnv`, what's already set winning, and only those three: the rest of `.env` (Sentry, Google secrets) doesn't reach Electron's environment.
- `pnpm dev`: `backend-dev/main.ts` does the same, for parity. `startDevServer` takes `devAi`, so an e2e passes invented keys and a fake model. Tests don't get it from the environment.
- The web build's worker never passes it.
- Key values stay in the backend. The renderer gets `Bootstrap.devAi: { anthropic: boolean; openai: boolean; jev: boolean } | null`. `null` hides the section.

### 3. Settings → Dev mode

A last section in the sidebar and palette (`SETTINGS_TABS` plus `DEV_TAB`, only when `devAi` isn't null):

- **Pro AI** (`dev-ai-switch`): "Run AI features the way Pro will, on the keys below. Your provider and saved keys stay as they are." Disabled with none of the keys set. A line under it when on: each feature's own switch stays in Settings → AI, since summaries and follow-ups read mail in the background only after a yes.
- **Environment variables**: a row each, the name in mono (not translated), what it runs, and **Set** or **Missing** as text with its icon. Footer: "Add them to the repo's .env or your shell, then restart `pnpm dev:desktop`. Terno reads them at launch and never saves them."

While it's on, the controls that would write settings the overlay hides say so instead of looking stuck:

- Settings → AI's provider, key and endpoint group is replaced by one note and a button to Dev mode.
- Settings → Categories' JEV key row is hidden.

The AI features below them work as usual.

### 4. Copy

`settings.tab.dev`, `settings.dev.*` in `en` and `es`.

## Tests

- **Unit, `@terno/core`:** `devAiKeys` drops empty values.
- **Backend (`dev-ai.test.ts`):** without `devAi` a stored flag does nothing and turning it on is refused. With it: the overlay's fields; off gives back exactly what was stored; a saved key isn't overwritten; targets per task (writing on Sonnet, summary on Luna, categorize on JEV) reach the factory with the env key and no custom endpoint; missing keys route as designed; a stale task on another provider is dropped; export holds the stored settings, not the overlay; toggling aborts what's in flight.
- **Desktop unit:** `devModeOf`, packaged never.
- **e2e (`settings-pass.spec.ts`):** the section is absent without `devAi`; present with it, naming the three variables with Set and Missing; switching on makes the AI tab's note appear and the composer's AI offer usable on a fake model; off restores; no key value appears anywhere in the renderer's bootstrap.
- Light and dark screenshots of the section, the switch on and off.

## Perf and resources

One boolean read and a `WeakMap` lookup in `readSettings`. Nothing runs until it's switched on, and then the same paths as a saved key. No timers, no new chunk: Settings is already lazy.

## Out of scope

Entitlements, `requirePro()`, the relay, `aiExecution` (plan 85). Other developer tools in this section, for later. Picking up env changes without a restart.

## Revisions after the Codex review

Codex (read-only, against `82e4116e`) raised 6 points; all are accepted. Each replaces what the sections above say.

1. **What "exact return" covers.** Provider, saved keys and endpoints come back exactly. Settings → AI's per-task rows stay editable while it's on, and those edits are ordinary settings that stay after it's off: a task row is the developer's own choice either way.
2. **No key can be saved around the overlay.** `ai.setKey` for the three providers is refused while it's on, and Summaries' "Add OpenAI key" form says which variable to set instead. `profileOrigin` reads the stored settings, so a saved key is never rebound from an overlaid profile.
3. **Toggling revokes everything.** `configChanged()` doesn't reach filter generation or transports workers already hold. A toggle also aborts `generating` and revokes every key lease.
4. **The monthly limit is background only** (`ai-limiter.ts`: foreground requests are exempt). §1's sentence is wrong and goes; no new ceiling is added. The section says so, since these are the developer's own keys and their own bill.
5. **JEV alone sets `provider: "none"`.** Keeping the stored provider while marking it ready would pass `aiReady` with no permitted key, and misstate a local provider as cloud. With no writing key the overlay is `none`, with `keys.jev` on, so only categorizing runs.
6. **The e2e fakes discovery too.** `ai.listModels` bypasses `aiFactory`. `DevServerOptions` gets the existing test network's stub for model lists, and the spec asserts nothing reaches the outside.
