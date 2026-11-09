# Diagnostics and error reports

Every process logs structured lines (a dotted code plus typed, allowlisted fields; never free text, not even error messages), leaves breadcrumbs, and records unexpected errors and crashes. A report goes to Sentry (the `terno` project) only from a build given a DSN, and only as the user chose (Settings → General → Diagnostics: Ask, Always or Never): clicking Send is their choice ([plan 78](plans/78-send-error-reports.md)). No Sentry SDK ships: the app posts its own envelope. [Plan 10](plans/10-observability.md) has the design and the privacy rules.

## How Sentry is used

Terno uses Sentry only to receive the error reports a user chooses to send. Nothing is collected automatically:

- Errors are recorded on the user's machine first. Terno then shows a row ("Terno ran into a problem") with **Send** and **What gets sent**.
- By default (Ask), nothing leaves the machine until the user clicks Send. "Always" sends a report on its own only for someone who picks that setting, and "Never" sends nothing.
- A report contains:
  - the error: its class, its code (never its message), and stack frames (function, file inside the app, line and column);
  - breadcrumbs: up to the last 100 things the app logged before the error, such as "opened settings", "sync started" or "connection refused". Each is a code with typed fields from a fixed list (a dialog's name, an error number, a count, a duration);
  - context: the app version and release channel, the OS and its version, the CPU architecture and memory, the language, which part of the app failed, how long it had been running, how many IMAP and Gmail accounts there are, and a random install id kept on the machine.

  A report never includes mail content, addresses, names, subjects, file paths, URLs or tokens. There is no free text in it, because only declared fields of known codes survive. "What gets sent" shows the exact event before it goes.
- Terno does not use Sentry for session replays, performance tracing, usage analytics, or anything that runs in the background. No Sentry SDK ships, so nothing can start sending by itself.

## Where things live

On the desktop, under the profile (`~/Library/Application Support/Terno`):

| Path | What |
|---|---|
| `logs/{main,backend,renderer,mcp}.jsonl` (+ `.1`…`.4`) | one JSON line per entry: `{ts, level, proc, code, fields, session, version, build, err?}` (`err`: class, code, status, frames); 2 MB × 5 per process (UTF-8 bytes), 0600 |
| `crashes/<ts>-<proc>-<id>.json` | records of unexpected errors, crashes, dead renderers/backends and unclean exits (64 KB each, 20 at most, 30 days) |
| `crashes/rings.json` | the last breadcrumbs of every live process (so a hard crash still has its trail) |
| `crashes/native/` | Electron crash dumps; never uploaded, exported only when ticked |
| `diag/state.json`, `diag/running` | install id, reports seen/sent, last policy; the run marker |

Help → Show Logs opens the folder; Help → Export Diagnostics… (or the Settings row) writes a validated `.zip`. The web build keeps a 2,000-entry ring in IndexedDB (`terno-diag`) and exports JSON.

## Configuring Sentry

```bash
# a release carries Terno's DSN (scripts/release-env.mjs; public by design: it can only submit events)
pnpm dist:mac                                # TERNO_RELEASE=1: reports on, source maps uploaded
pnpm build:web && pnpm upload:web-maps       # the web build reports from the page
TERNO_SENTRY_DSN= pnpm dist:mac              # a fork, or reports off: no DSN, the reporter is never loaded
TERNO_SENTRY_DSN=https://<key>@<host>/<project> pnpm dist:mac   # another project

# source maps: every bundle gets a debug id; maps are archived outside the app in
# apps/desktop/.maps/<version>-<sha>/ (web: apps/web/.maps/<build>/) and uploaded with the
# sentry CLI (https://cli.sentry.dev: its own login, or SENTRY_AUTH_TOKEN; SENTRY_ORG/SENTRY_PROJECT override)

# a local crash record (or one from a user's export) back to source lines, offline
pnpm diag:symbolicate path/to/crashes/<record>.json [--maps <archive dir>]
```

Dev, demo and test builds never get a DSN (a test run only ever reports to a loopback sink). Release names are `terno@<version>+<sha>`, taken from the record (a crash kept across an upgrade reports the build that crashed). The `terno` project also scrubs server side, but nothing in a report needs it: there is no message, no address and no path in one ("What gets sent" shows the exact event).
