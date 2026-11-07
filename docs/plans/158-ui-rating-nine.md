# Plan 158: A rated UI, and every style at nine

- **Status:** in progress on `ui-9-hill-climb`.
- **Builds on:** plan 15 (designs), plans 118 to 122 and 125 (base controls), plan 139 (what runs where). The rule itself is `docs/ui-rating.md`.

## The request

> Okay, I want you to open up a work tree. In that work tree. You're gonna make a new assessment of each of the designs, meaning each of the styles, lumen, atlier, macOS, and graphite. And you're gonna, there are things that are going to be similar, that are going to be repeated in most of them, but I mean, what changes the most is basically the contrast of things, and some buttons that are to a bit differently, and in the thread leaf. There is the buttons are different, but I think that's pretty much it. There is not a lot of change. So when changing the palette, just judge the contrast. And those new buttons that show, the other things are probably gonna be used the same across everything. And once you do the adjustments and this numeric assessment that we did, let's keep this numeric assessment that we did, and that as a rule here. When we make that as a rule, let's differentiate what can they improve on actually, like, typography contrast placing, things like that, UI ux, and then you're going to make a score, again, from one to 10. And the goal here is to get it to be at least a 9 out of 10 on everything, and every screen needs to be at least 9 out of 10 in both codex and cloth. When you run those analysis. Make sure those analysis run independently. So they don't get history or get corrupted. And your goal will be to improve the UI, like hill climbing it, improving the UI until it gets to at least 9 out of 10 for the screens that you tested and in the style, in all of the styles. Okay. That is the goal. And in both UI and UX. Do that, take as long as you need, get the style and design, on that, on minimum 9 out of 10 evaluation, to make this app, a really great app.

## What exists

An ad hoc rating of Lumen on `ce79d18f` gave 7 (Claude) and 7.5 (Codex), with no screen above 8.5. Its scripts lived in `/tmp`, and its raters ran inside the repo, so they could see `AGENTS.md`.

The styles differ more than palette and a few buttons: plan 15's variants also change the row, compose's place, the list header, search, the quick filters, the reader's header and the type scale. So the shortcut in the request holds for flows, and not for how a style's own screens look.

## Design

### The rule, as tooling

- `docs/ui-rating.md`: the rule, the facets (UI: typography, contrast, placement, hierarchy, controls, density; UX: efficiency, clarity, feedback, consistency, accessibility), how to run a round, and how to keep raters independent. `AGENTS.md` points at it.
- `scripts/ui-rating/`: `harness.mjs` (the real Electron build on a throwaway demo profile), `capture.mjs` (the fixed evidence), `brief.md` (what a rater reads), `rate.mjs` (a round), `gate.mjs` (the bar), `gate.test.ts`.

The scale's words are the ones the first rating used, so its numbers stay comparable.

### Independence

Subagents load `AGENTS.md` and the owner's memory, so raters don't run as subagents. `rate.mjs` starts each as a new CLI process, `claude -p` or `codex exec`, in an empty random folder under `/tmp`, with sessions not kept, no MCP servers and no project docs. The folder holds the brief, one round's shots and a one-line re-export of the harness. A rater isn't told the bar, the round, an earlier score or what changed. Checked by asking both in a clean room what they had loaded: neither had any project context.

A round freezes one commit's build, so an edit mid-round can't reach a rater.

### The climb

1. **Baseline:** a full round on this commit (tooling only).
2. Read every `improve` and issue, sort by how many cells it would lift, and fix in atomic commits. Findings both raters make come first; a finding only one makes is judged on its evidence.
3. Re-rate in a fresh round. Narrow rounds while working, and one whole round on one commit to finish.
4. Stop at a pass, or when rounds stop moving: report honestly what's under the bar and why rather than wearing the raters down.

### Guardrails

- The product rules in `AGENTS.md` hold: inline compose, drag is a move, no lazy loading, motion within `--motion`, BoardUI controls, AA contrast in every palette, i18n in `en` and `es`, no new icons outside the catalog.
- Only `e2e` flows and baselines that a change really moves are updated, and looked at.
- A finding that contradicts a product decision goes to the owner, not into the code.

## Revisions after the Codex review

The plan's critique found twelve holes, all taken:

- **Raters could still inherit context:** user config, hooks and MCP servers are now off, and the environment is an allowlist.
- **Raters could find the repo and other ratings by path:** a round runs from a frozen copy in a random folder (build, Electron, Playwright, harness, brief). Raters still have a shell, so staying out is an instruction, not a wall.
- **A reused folder could pass falsely:** every round gets a new folder, and the runner refuses one that's in use. Untracked files count as dirty.
- **A report could pass without the evaluation:** no hands-on list, no reasons or no issues list makes it incomplete. A narrowed round can't pass.
- **Modes could hide each other:** a cell's score is its weakest case, across light and dark, layouts and window sizes.
- **Non-Lumen raters were told flows were "rated elsewhere":** gone. They try what the style changes, and whatever else a score needs.
- **The brief pushed raters to invent findings:** fewer issues are allowed, "nothing I can support" is a valid `improve`, and equal scores are fine.
- **Native appearance:** the harness sets `nativeTheme` too. macOS's translucent sidebar can't be captured behind other windows without Screen Recording permission, so it stays flattened, and that rater is told.
- **A lucky pass:** the rule needs two whole rounds in a row on one commit, every round is kept, and an unchanged commit doesn't get re-rolled.

The brief changed after the baseline, so round 0 is slightly less strict than later rounds on the weakest-case rule.

## Tests

- `gate.test.ts`: the bar, and a report can't pass by omission.
- Each behavior fix gets a regression test at the lowest level that catches it. Look-only changes are held by the designs' baselines and `contrast.test.ts`.
- `pnpm test:all` before calling it done, and the Codex code review of the series.

## Perf

Nothing here may cost a perf gate. Compact rows and header changes go through the virtualizer's existing row heights. A round costs tokens and about 30 minutes, not runtime.

## Out of scope

- **Luma:** not one of the four named, and not rated. Shared changes reach it, and its baselines and contrast tests keep passing.
- Settings and onboarding: not rated.
- New features: a fix may rearrange what exists, not add a product area.
