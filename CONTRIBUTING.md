# Contributing to Terno

Thanks for wanting to help! Bug reports, fixes and ideas all make Terno better. This guide explains
how to make a contribution easy to review and likely to land.

## Before you start

Review time is limited, so not every pull request can be reviewed or merged. Some may be closed,
deferred, or reworked in a different way later. Following this guide gives yours the best chance.

What tends to land:

- Focused bug fixes, especially anything that loses mail, drafts, position or focus.
- Performance and resource improvements (with numbers).
- Accessibility fixes, and translations (see [Adding a language](README.md#adding-a-language)).
- Small maintenance: dependency bumps that pass every check, broken docs.

Big unplanned features, redesigns, rewrites and new dependencies are much harder to take on, so
please open an issue first for those.

Bugs and ideas go in [issues](https://github.com/luisiacc/terno/issues). It's worth searching
existing issues and the [plans](docs/plans/) first: a lot of decisions (why dragging moves a thread,
why compose is inline, why mail frames never scroll) are written down there.

## Developer setup

[Quick start](README.md#quick-start) and [Tests](README.md#tests) in the README cover the checkout,
the dev commands and the test suites. [AGENTS.md](AGENTS.md) is the working agreement (principles,
non-negotiables, how a feature is built) for people and agents alike, and it's a good read before
changing anything.

## Talk about it first

For a new feature or a change in how something behaves, open an issue and agree on the direction
before writing the code, then link that conversation in your pull request. This saves you from
building something that turns out not to fit.

Small fixes for obvious bugs don't need an issue. Just explain what was broken and how you fixed it.

If something already does what you need but was hard to find, that's worth an issue too.

## One thing per pull request

Keep each pull request to one problem. Two unrelated fixes are easier to review as two pull
requests, even when both are good.

Do include everything that one problem needs: backend, both stores (SQLite in `packages/db` and
IndexedDB in `packages/idb`), the desktop and web clients, tests, the `en` and `es` strings, and the
plan or README when behavior changes.

## House rules

These come from [AGENTS.md](AGENTS.md), and every change needs to keep them:

- **Privacy.** Mail content, addresses, names, subjects, tokens and keys never leave the machine
  except to the user's own mail and AI providers. No analytics, telemetry or new third-party
  services. In local mode the only traffic is to the mail servers.
- **Performance.** No regressions against the perf gates, lists stay virtualized, queries hold at
  50k+ threads in both stores, and new heavy UI is lazy-loaded.
- **Idle means idle.** No polling where an event exists, no timers spinning, no work until a feature
  is opened.
- **Strings.** Every user-visible string goes through the i18n catalog, in English and Spanish
  together.
- **Design.** No literal colors or durations, text only on contrast-checked pairs, motion within the
  `--motion` cap, and every control reachable by keyboard and named for screen readers.

## Show that it works

In the pull request, describe how you found the problem, how you checked the fix, and what you saw.
Mention anything you couldn't check. Depending on the change:

- **Behavior:** a test that fails without your change.
- **Hot paths** (lists, search, sync, the stores): `pnpm test:perf` or `pnpm test:ui-perf` results,
  before and after.
- **UI:** before/after screenshots in light and dark, plus a short recording when motion or
  interaction matters. Attach them to the pull request rather than committing them.
- **Desktop-only paths:** `pnpm dist:mac` and `pnpm --filter @terno/desktop test:smoke`.

Please use the demo mailbox (`pnpm dev`, `pnpm dev:desktop:demo`) for screenshots and reports, and
redact anything personal from logs.

## Using AI tools

AI-assisted code is welcome. Terno is built that way, and AGENTS.md is written for agents as much
as for people. Just make sure you've read and run what you send, can answer questions about it, and
mention which tools you used.

## If a pull request is closed

It's not the end of the road. The closing note will say why and what would help, like splitting it
up or adding evidence. Feel free to update it and ask again, or open a smaller pull request.

## Contributor License Agreement

Terno is source-available under the Business Source License 1.1 (see
[LICENSE](LICENSE)), each version becomes AGPL-3.0 three years after its
release, and the author can grant other licenses (for example, permission
to sell). So that contributed code can ship under all of them, every contributor signs the
[Contributor License Agreement](CLA.md) once. You keep the copyright in your
work.

When you open your first pull request, a bot asks you to sign. Reply on the
pull request with:

> I have read the CLA Document and I hereby sign the CLA

The pull request can be merged once that check passes. If your employer has
rights in your work, make sure they agree before you sign.
