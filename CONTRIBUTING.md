# Contributing to Terno

## Read this first

Terno has one maintainer, and review time is the scarcest thing in the project. Outside
contributions are welcome but not actively sought. Opening a pull request does not oblige anyone to
review or merge it: it may be closed, deferred, sent back for a smaller scope, or the idea may be
reimplemented later. Meeting this guide makes a pull request eligible for review; it does not
guarantee that it lands.

This applies to every open pull request, drafts included. A draft can be closed for the same reasons
as a ready one.

The most likely to be accepted, in order:

1. Focused bug fixes, especially ones that lose mail, drafts, position or focus.
2. Performance and resource fixes (with numbers).
3. Accessibility fixes, and translations (see [Adding a language](README.md#adding-a-language)).
4. Small maintenance: dependency bumps that pass every check, broken docs.

Unsolicited features, redesigns, opinionated rewrites, new dependencies and unrelated cleanup are
the least likely, and are usually closed.

Report bugs and propose ideas in [issues](https://github.com/luisiacc/terno/issues). Search existing
issues and the [plans](docs/plans/) first: many decisions (why drag moves rather than copies, why
compose is inline, why mail frames never scroll) are recorded there on purpose.

## Developer setup

[Quick start](README.md#quick-start) and [Tests](README.md#tests) in the README cover the checkout,
the dev commands and the test suites. [AGENTS.md](AGENTS.md) is the working agreement (principles,
non-negotiables, how a feature is built) for people and agents alike. Read it before you change
anything.

<a id="prior-approval"></a>

## Agree on the problem and scope first

Features and intentional changes to behavior need an issue where the maintainer has explicitly agreed
to the direction and scope. Link that comment in your pull request; a linked issue on its own is not
enough. Calling a behavior change a bug fix does not exempt it. Agreement on a problem does not
approve every way of solving it.

For a substantial bug fix, link an issue that establishes the failure and the intended behavior.

A small, focused fix for an obvious bug can be sent without an issue. Say what the defect is and why
the fix qualifies. What counts is the purpose and the effect on behavior, not the size of the diff:
a fix may touch the backend, both stores and the renderer, while a two-line change to a default may
still need an issue.

If something already does what you need but was hard to find, that is worth an issue too (a
discoverability or onboarding problem). The maintainer decides the response; it does not by itself
justify a new feature.

<a id="one-problem"></a>

## One problem per pull request

A pull request that solves several independent problems will be asked to split, even when each fix
is good. Count the underlying problems, not the issues: several reports can describe one defect.

Include everything that one problem needs: backend, both stores (SQLite in `packages/db` and
IndexedDB in `packages/idb`), the desktop and web clients, tests, the `en` and `es` strings, and the
plan or README when behavior changes. Explain how the pieces relate when it isn't obvious. A
neighboring cleanup, refactor or second fix goes in its own pull request.

<a id="house-rules"></a>

## House rules that are not up for debate

A pull request that breaks one of these is closed, however good the rest is. They are spelled out
in [AGENTS.md](AGENTS.md):

- **Privacy.** Mail content, addresses, names, subjects, tokens and keys never leave the machine
  except to the user's own mail and AI providers. No analytics, no telemetry, no new third-party
  services. In local mode the only traffic is to the mail servers.
- **Performance.** No regression against the perf gates, lists stay virtualized, queries hold at
  50k+ threads in both stores, and new heavy UI is lazy-loaded.
- **Idle means idle.** No polling where an event exists, no timers spinning, no work until a feature
  is opened.
- **Strings.** Every user-visible string goes through the i18n catalog, in English and Spanish
  together.
- **Design.** No literal colors or durations, text only on contrast-checked pairs, motion within the
  `--motion` cap, every control reachable by keyboard and named for screen readers.

<a id="verification"></a>

## Show that it works

Say how you established the problem, how you checked the change, and what you saw: reproduction
steps, macOS version or browser, the focused test commands or manual checks, and their results. Say
what you could not check. A checkbox or "tests pass" on its own does not show that the change works.

- **Behavior** needs a test that fails without your change.
- **Hot paths** (lists, search, sync, the stores) need `pnpm test:perf` or `pnpm test:ui-perf`
  results, before and after.
- **UI changes** need before/after screenshots in light and dark, and a short recording when motion,
  timing or interaction matter. If a visual baseline changes, say which and why. Attach them to the
  pull request; don't commit them.
- **Desktop-only paths** need `pnpm dist:mac` and `pnpm --filter @terno/desktop test:smoke`.
- **Never** use a real profile or real mail in a report. Use the demo mailbox (`pnpm dev`,
  `pnpm dev:desktop:demo`) and redact anything personal from logs and screenshots.

Missing or clearly inadequate evidence is reason enough to close a pull request.

<a id="ai"></a>

## AI-written code

Code written with AI tools is fine. Terno is built that way, and [AGENTS.md](AGENTS.md) is written for
agents as much as for people. But you are the author: read every line, run it, and be able to answer
questions about it. Say which tools you used in the pull request. Pull requests that look generated
and unreviewed (unrelated churn, invented APIs, tests that don't test the change, descriptions that
don't match the diff) are closed without detailed review.

<a id="closure"></a>

## When a pull request is closed

A closure for one of these rules names the rule, points at what broke it, and says how to fix it:
which fixes to split, which evidence is missing, which issue to open. Fix it and ask for a
reconsideration on the same pull request, or open the focused replacements and link them. If the
solution is declined but the report shows a real problem, the issue stays open.

## Contributor License Agreement

Terno is source-available under the AGPL-3.0 with additional conditions (see
[LICENSE](LICENSE)), and commercial licenses are sold alongside it. So that
contributed code can ship under both, every contributor signs the
[Contributor License Agreement](CLA.md) once. You keep the copyright in your
work.

When you open your first pull request, a bot asks you to sign. Reply on the
pull request with:

> I have read the CLA Document and I hereby sign the CLA

The pull request can be merged once that check passes. If your employer has
rights in your work, make sure they agree before you sign.
