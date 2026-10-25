# Terno: working agreement for agents

Terno is a minimalist, fast email client: Electron (macOS first) plus a web build with parity, in a pnpm monorepo (`apps/desktop`, `apps/web`, `apps/backend-dev`, `packages/*`). The plans in `docs/plans/` record why things are the way they are. Read the relevant one before changing a feature.

## Principles (every change upholds all four)

1. **UX first.** Every flow should feel obvious and calm. Never lose the user's work or position: drafts autosave, undo is exact, and focus and scroll survive navigation. Errors say what happened and what to do next, in plain English.
2. **Intuitive, premium UI.** Minimal, Apple Mail and t3code inspired:
   - hairlines rather than boxes, quiet controls, SF on macOS
   - motion within the `--motion` cap (≤ 100 ms), and none when motion is reduced or off
   - every control keyboard-reachable and named for screen readers (axe-clean in light and dark, AA contrast in all themes)

   **All copy is English** (UI, errors, notifications, docs). Never Spanish.
3. **Performance.**
   - No regressions against the perf gates (`pnpm test:perf`, `pnpm test:ui-perf`, `load.perf.test.ts`).
   - Lists are virtualized, and render counts are asserted.
   - Nothing blocks the backend event loop beyond the slicer's budget. Queries must hold at 50k+ threads in both stores: SQLite in `packages/db`, IndexedDB in `packages/idb`.
   - New heavy UI is lazy-loaded and kept out of the entry chunk.
4. **Low resource usage.**
   - No polling where an event exists, and no work until a feature is opened.
   - Memory, disk and log files are bounded.
   - Idle means idle: no timers spinning, and no network outside what the user's mail and explicit choices need.

## Non-negotiables

- **Privacy.** Mail content, addresses, names, subjects, tokens and keys never leave the machine except to the user's own mail and AI providers. **Local mode** (the default) means traffic to the mail servers only. Diagnostics follow plan 10.
- **Never** read or print the user's real secrets, and never touch real profiles (`~/Library/Application Support/Terno*`): use temp profiles and copies.
- **Process safety.** Only kill processes you started, by the PID you captured. Ports 5173/5174 and other vite/node processes may belong to the user. Unset `ELECTRON_RUN_AS_NODE` when launching Electron.

## How a feature is built

1. **Plan.** Write `docs/plans/NN-<name>.md`: the request verbatim, what exists, design, tests, perf and out of scope.
2. **Codex critique of the plan.** Run `codex exec -s read-only -C <checkout> - < prompt` and ask for at most 12 concrete points against the code. Append "Revisions after the Codex review".
3. **Implement** in atomic commits, with tests for every behavior:
   - unit tests and e2e (`apps/web/e2e`)
   - the packaged smoke for desktop-only paths
   - perf gates for anything on a hot path

   Visually verify UI changes: take screenshots in light and dark and look at them.
4. **Codex code review: always, for every feature and fix series.** Run `/tmp/unica-scratch/codex-review.sh <base> <name> <plan> <out>`, or the same prompt with `-C <worktree>`. **Fix every finding** with a regression test that fails without the fix. Record what the review changed in the plan.
5. **Before calling it done,** these all pass: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:e2e`, `pnpm test:web`, `pnpm test:ui-perf`. Desktop changes also need `pnpm dist:mac` plus `pnpm --filter @terno/desktop test:smoke`, and hot paths need `pnpm test:perf`. Report failures honestly.

## Conventions

- Read the surrounding code first and match its idiom, naming and comment density (terse comments that explain why).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit only; never push unless asked.
- Product rules worth knowing:
  - Dragging threads onto a category *moves* them; multi-category only through the right-click menu.
  - Composing is inline, never a modal.
  - HTML mail frames never scroll inside.
- **Parallel checkouts.** Run e2e with `E2E_PORT=<free port>` (it builds to `dist-e2e-<port>`) so two checkouts never share a server. On macOS there is no `timeout`. In zsh, quote globs.
