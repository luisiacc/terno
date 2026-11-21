# Plan 233: AI is off on a fresh install

## Request (verbatim)

> when the users opens the app, we are auto-selecting ollama for them if they have it, lets not do this, when they open it for the first time, ai should be totally OFF, we can do theollama things detection if they select ollama manually, otherwise not.

## What existed

- The backend's default AI provider is `none` (`packages/backend/src/settings.ts`).
- First run (plan 98, `apps/web/src/components/first-run.tsx`) asked Ollama and LM Studio for their models as it opened (`ai.listModels`, once per setup session) and made the first one that answered the AI, unless a provider had been chosen meanwhile.
- Settings → AI lists a local server's models only once that provider is chosen (`ai-tab.tsx`; `ai-tab.test.tsx` asserts no `ai.listModels` otherwise).

## Design

Remove the first-run discovery. A fresh install keeps `ai.provider: "none"`: nothing is chosen for the user and nothing probes the loopback servers. Choosing Ollama or LM Studio in Settings → AI is unchanged: that is where models are found.

The e2e helper `isolateLocalDiscovery` existed only to keep the discovery away from a real Ollama on the test machine, so it goes with it, as does the test that the detour back from Settings doesn't rerun the discovery.

## Tests

- `identity.spec.ts` "fresh install": Ollama (the stub) answers where Terno would look; after the whole setup, Settings → AI reads Off and the stub got no request. It fails on the old code (the provider read "Ollama").
- `first-run.spec.ts`, `brand.spec.ts` run without the helper.

## Perf and resources

Less work at first launch: two loopback requests fewer.

## Out of scope

The AI features' gate (plans 147, 150) and the per-account switches (plan 211) are unchanged; with no provider, nothing runs.

## What the Codex code review changed

- The regression test points LM Studio at the stub too, so neither local server can be probed unseen.
- The helper's orphaned doc comment in `e2e/fixtures.ts` is gone.
- Left as is: `apps/backend-dev` seeds its development mailbox with the `fake` provider. That is the dev server's sample data, not an install.
