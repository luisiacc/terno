# 242. Dev mode: the summary button summarizes again

## Request

> when on dev mode locally, lets make it so when i click on the ai summary button, it redoes the summary instead of doing nothing

## What exists

- The reader's toolbar button (`SummarizeButton`, `apps/web/src/components/reader.tsx`) calls `summarize(threadId)` in `apps/web/src/lib/summaries.ts`. With a summary already shown it only opens the block (`open: true`), so on an open block a click does nothing.
- Asked anyway, the backend's `SummaryWorker.request` (`packages/backend/src/summaries.ts`) would hand back the stored summary: `reusable()` keeps it while the text, prompt version, language and target are the same.
- Dev mode (plan 146) is a local build: `devAi` is set in the backend's options, and the window's `devAi` is non-null. Working on the prompt (plans 151–241), the only way to see a new prompt's card on a conversation was waiting for the conversation to change.

## Design

- **RPC.** `ai.summarize` takes an optional `again: true`. The handler refuses it (`BAD_REQUEST`, "Dev mode is only for a local build", as the `devAi` setting does) unless the backend was started with `devAi`. Everywhere else nothing changes.
- **Backend.** `request(threadId, requestId, clientId, { again })` passes it to `run`, which skips `reusable()` and asks the model. Everything else stands: the gates (spam, trash, the account's AI, Dev mode's switch), joining a run already on the thread, cancel, and the write re-checking what moved. A run already in flight is joined, as now: its answer is new anyway.
- **Store of the window.** `summarize(threadId, { again })`: with `again`, a shown summary doesn't stop it. Its running and error states carry `again`, so:
  - Stop, or a cancel, goes back to the stored summary (a `loadSummary` after), not to an empty block.
  - Try again on its error summarizes again, rather than handing back the stored one.
  - Dismissing its error brings the stored one back too.
- **Button.** On a local build (`devAi !== null`) with a summary shown, the button says "Summarize again" ("Volver a resumir") and asks with `again`. Otherwise it is what it was. The palette's command stays as it is: the request is the button.

## Tests

- `packages/backend/src/summaries.test.ts`: on a local build with the switch on, `again` asks the model although the stored summary is reusable, and writes the new one; without `again` it's reused. Started without `devAi`, `again` is refused and nothing is asked.
- `apps/web/src/lib/summaries.test.ts` (new): the window's store, with the RPC scripted (see the revisions).
- `apps/web/e2e/dev-mode.spec.ts` (plan 147's test already stores a summary and turns the switch on): the button is named "Summarize again"; a click asks the model, which no host can reach there, so it fails; leaving that error by AI settings brings the stored summary back.

## Perf

Nothing on a hot path: one flag on a request made by hand.

## Out of scope

- The palette's Summarize, and a redo outside Dev mode.
- Regenerating every stored card after a prompt change (plan 241's follow-up).

## Revisions after the Codex review

1. **A joined run isn't fresh.** A run already on the thread (the reader's own request, or the worker) may have reused what's stored. With `again`, `request` waits for it, takes nothing from it, and goes round once more to ask itself. Test: an ordinary request held at the model, Summarize again behind it, two answers.
2. **`again` survives every state on the way.** `waitingBody`, `noProvider` and `error` carry it with `was` (one `Asked` shape): the text arriving asks again with it, Try again passes it, and leaving any of them (Stop, a cancel, dismissing, AI settings) reads the stored summary back.
3. **A late read can't put the old summary back.** Starting a request forgets the reads already sent (a sequence the reads already had), so a read of the stored one that lands after the new summary is dropped. Test: a held read, released after Try again's answer.
4. **The block opens.** A collapsed card opens when the button is pressed, as it did, and then the summary is written again.
5. **The e2e proves the request, not reuse.** Its stored row is from an old prompt, so reuse is proven in the backend's tests (asked although `reusable()` holds), and the e2e shows the click asks and the stored one comes back.
6. **Recovery is tested.** Stop, a cancel, an error and its dismissal, starting from a shown summary, in the window's store; in the backend, a cancelled Summarize again leaves the stored summary as it was.

## Revisions after the Codex code review

1. **The toolbar's button on a failed Summarize again handed back the stored summary.** `again` was read only off a shown summary, so pressing the button on the error (rather than Try again) asked without it, and the backend reused what's stored. A request now keeps the `again` of the state it starts from, whichever control asks, and the button is named Summarize again there too. Test: the window's store, the button pressed on the error, both requests carry `again`.
