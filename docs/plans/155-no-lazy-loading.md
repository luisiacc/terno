# 155 · No lazy loading

## The request

"When I click either of those buttons for the first time, there is a very slight hiccup … it should just show instantly." (the reader's bell, the composer's Send later)

Then: "What is the point of lazy loading in a desktop application?"

Then: "Remove lazy loading completely. Just remove it entirely. We're never gonna do that. So remove it also from the AGENTS.md file. This is a desktop app. It doesn't make sense to do that."

## Why

The first open took 306 ms every time and later opens 3 ms. The popover came in 7 ms, empty, and its choices 300 ms later: React holds a Suspense reveal until `FALLBACK_THROTTLE_MS` (300) after its fallback committed, however soon the code is in. So everything behind `lazy` paid 300 ms on first use, reading a file from the same disk as the app. Lazy loading exists to save a download, and a desktop app has none to save.

## What changed

- **The renderer is one file.** No `React.lazy`, no `Suspense`, no dynamic `import()`, no preloads and no `manualChunks`. Every dialog, the composer, AI drafting, the pickers, the print sheet, the sign-in panel and the Spanish catalog are plain imports.
- **The composer's stand-in is gone,** which was the most machinery lazy loading had bought: an editable box taking keys while the editor's chunk loaded, handing its text and focus over (`takeEarly`, `takeStandInFocus`, `compose-body-loading`, `appendTyped`). `composer/lazy.tsx` is `composer/controls.tsx`.
- **The backend** imports the AI SDKs, the suffix list (`tldts`) and the MIME parser up front.
- **Main** has no `updater.cjs` or `reporter.cjs` of its own: they are part of `main.cjs`. The reporter's session is still only made when a report goes, and the updater's engine when it first checks: what stayed on demand is the work, not the code.
- **`architecture.test.ts` holds it:** a `lazy(`, a `<Suspense` or a dynamic `import(` in the app's source fails.

## What stays, on purpose

- **Web-only code** (`~/web/*`), behind `VITE_TARGET === "web"`, so the desktop bundle holds none of it (`desktopGuard` fails the build otherwise). `lib/web-parts.ts` is all null, and only the web build swaps in `web-parts.web.tsx` through an alias. Five `import()` calls remain behind the constant (the worker connection, Google's sign-in on three paths, tab lifecycle) and the web workers load their demo data and SQLite on demand. None of it reaches the desktop: its bundle has no `import(` at all.
- **`require("./app")` in `main.ts`:** that is order, not laziness: the profile is prepared first.
- **Work on demand:** the incoming worker thread starts when mail needs it, photos are listed when asked, and so on. Principle 4 ("no work until a feature is opened") is about running things, not about loading code.

## Tests

- Removed, as what they tested no longer exists: the stand-in's unit tests and e2e, "stays out of the startup bundle" (editor, React Aria, print), "doesn't load the editor", the sign-in panel's late arrival and `sign-in-marker-open`.
- `watchWhole` (`e2e/fixtures.ts`) checks a picker's first open holds its choices from its first mutation, and Custom's holds its time field, with no clock in it. It fails with the pickers lazy.
- Unit tests that load the app import it in a `beforeAll` with a long timeout: `await import("~/app")` is now the whole app, and a first one inside a test can run out its 20 s on a full machine. A few `lib` tests moved from Node with a fake `<html>` to jsdom, since those modules reach the UI directly now.

## What it measured

**The first open** of the bell and Send later: 306 ms to 8 ms, the choices in the popover's first frame.

**The renderer** is one 2.9 MB file (900 KB gzipped), with no `import(` in it. It was 420 KB (134 KB gzipped) at startup, with the rest in chunks.

**A warm start of the packaged app** (`startup.perf.ts`, its gate is the best of three under 1,500 ms) got slower, and it still passes:

| | to first rows |
|---|---|
| Before | 833 to 876 ms, steady |
| After | 947 to 1,539 ms; many runs near 950 or near 1,400 |

The script is not the cost: it runs by 116 to 190 ms and the first paint is at 244 to 312 ms. The difference comes after the first paint: the rows land at about 480 or about 920 ms on the renderer's clock, so what's waited for is the backend. Evaluating the AI SDKs alone takes about 130 ms each in Node (`openai`, `@anthropic-ai/sdk`), at every launch, for people with no AI set up as well. Why it is two values and not one wasn't looked into. `v8CacheOptions` (`bypassHeatCheck`, with and without eager compile) didn't help, so it isn't set.

## What the Codex review changed

No runtime regression. The guard could pass falsely, as it skipped whole files and missed `require()`: it now exempts only the web host's exact expressions and `require("./app")`, and checks its own pattern against samples of each.

## Onto main's AI round two

Rebasing brought 116 commits that had kept to the old rule. What they loaded on demand became plain imports the same way: Ask's pages, the action preview's header, Today's tip, settings and digest, the follow-ups and their tip, the prepared reply, copying a conversation as text, and the imports inside `lib/ask.ts`, `lib/replies.ts`, `lib/summaries.ts` and `lib/followup-nudge.ts`.

- **`canDraft` stays with the state.** Plan 147's gate moved with `openAiDraft` into `lib/ai-draft.ts`: main had put it in `ai-draft-state.ts`, which the send path imports, and `ai-draft.ts` imports the send path.
- **`lib/ask.ts` and `lib/action-preview.ts` subscribed as they loaded,** which now means at every import, test mocks of the client included. They subscribe from `boot.ts` like every other module (`installAsk`, `installActionPreview`). Subscribing does nothing until an event arrives; the features' own gates are unchanged.

## What it measured

**The first open** of the bell and Send later: 306 ms to 8 ms, the choices in the popover's first frame.

**The renderer** is one 2.9 MB file (900 KB gzipped), with no `import(` in it. It was 420 KB (134 KB gzipped) at startup, with the rest in chunks.

**A warm start of the packaged app** (`startup.perf.ts`, its gate is the best of three under 1,500 ms) got slower, and it still passes:

| | to first rows |
|---|---|
| Before | 833 to 876 ms, steady |
| After | 947 to 1,539 ms; many runs near 950 or near 1,400 |

The script is not the cost: it runs by 116 to 190 ms and the first paint is at 244 to 312 ms. The difference comes after the first paint: the rows land at about 480 or about 920 ms on the renderer's clock, so what's waited for is the backend. Evaluating the AI SDKs alone takes about 130 ms each in Node (`openai`, `@anthropic-ai/sdk`), at every launch, for people with no AI set up as well. Why it is two values and not one wasn't looked into. `v8CacheOptions` (`bypassHeatCheck`, with and without eager compile) didn't help, so it isn't set.

## What the Codex review changed

No runtime regression. The guard could pass falsely, as it skipped whole files and missed `require()`: it now exempts only the web host's exact expressions and `require("./app")`, and checks its own pattern against samples of each.
