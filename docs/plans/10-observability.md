# Plan 10: diagnosing user errors (logs, breadcrumbs, crash reports, Sentry)

- **Status:** proposed.
- **Builds on:** plan 09 as shipped (f7d2957).
- **Request:** "Primitives for good debuggability of user errors later. We can use Sentry, plus good structured logs with breadcrumbs, so we get clear information on errors for any downloaded version of the app. The goal is to debug errors from users and not be blind to them. Check what T3 Code does. Do whatever is best for this kind of Electron desktop app."

## 1. What T3 Code does (pingdotgg/t3code, read 2026-10-24)

- No Sentry or other error SaaS.
- Rotating local log files per process (`makeRotatingLogFileWriter`, size-capped, N files), with component loggers that carry annotations.
- An optional OpenTelemetry export: traces, metrics and logs over OTLP, but only when the endpoint env vars are set.
- A renderer-history recorder for its own telemetry.
- Takeaway: local structured logs are the base layer and remote export is optional and configured at build/run time. We do the same, with Sentry as the remote sink, because it gives native crash minidumps, symbolication and release grouping out of the box for Electron (`@sentry/electron`).

## 2. What Terno has today

- `console.*` scattered through the code.
- The backend `utilityProcess` forwards `uncaughtException` as a "log" message. Nothing else.
- No log files, no breadcrumbs, no crash detection, no build id in any report.
- A renderer crash or a backend crash is invisible after the fact.

## 3. Constraints that shape everything

- **Terno is an email client.** No subject, body, address, name, file name, search query, AI prompt, token or key may ever leave the machine in a report.
  - Scrubbing is done by construction: logs take a message code and *typed, allowlisted* fields. Free-form strings are dropped or reduced to a length and hash.
  - A regex scrubber (emails, bearer tokens, `?query`, long base64) is a second line of defence on everything, including stack-trace messages.
- **Local mode** (the default) promises that Terno talks only to the user's mail servers. In local mode nothing is ever sent to Sentry, whatever the other settings say. Diagnostics stay on disk, and the user can export them by hand.
- **Consent.** Setting `errorReports: "ask" | "always" | "never"`, default `"ask"`.
  - **ask:** nothing is sent automatically. After a crash or an unexpected error, Terno shows a quiet row on the next start (or in place, for non-fatal errors): "Terno tuvo un problema. ¿Enviar un informe anónimo?" with **Enviar**, **Siempre**, **Ver qué se envía** (the exact JSON) and **Ahora no**.
  - **always:** reports are sent automatically.
  - **never:** reports are never sent.
  - In local mode the control is disabled and explains why; the row then offers **Exportar diagnóstico** instead.
- **Builds without a DSN** (dev, forks): the Sentry code is inert. Everything local still works.

## 4. Primitives (`packages/core/src/diag/`, shared by every process)

- **`log`.** `log.info|warn|error(code, fields?)`.
  - `code` is a dotted constant: `sync.imap.connect_failed`, `rpc.handler_threw`, `print.load_timeout`.
  - `fields` is a typed record of allowlisted keys: `accountKind`, `provider`, `op`, `durationMs`, `count`, `status`, `errno`, `attempt`, `engine`, `view`, and so on. An unknown key is a type error, and the value is dropped at runtime.
  - Each entry is one JSON line: `{ ts, level, proc, code, fields, session, version, build }`.
  - `proc` is `main | backend | renderer | worker | mcp`.
- **`breadcrumb`.** `breadcrumb(category, code, fields?)` goes into a per-process ring buffer (last 100). Categories: `nav` (view changes, thread open, *ids only*), `action` (archive, move, send: the command, the counts), `sync`, `rpc` (method name, duration, ok/err), `lifecycle`, `ui` (dialog open, settings tab).
  - Breadcrumbs are cheap: no I/O, a fixed array, O(1).
  - Info-level logs also become breadcrumbs.
- **`captureError(err, { code, fields, fatal? })`.** Normalizes any thrown value: name, scrubbed message, and the stack with absolute paths reduced to the app-relative path. It attaches the breadcrumbs and context (version, build sha, OS, arch, locale, engine, account kinds and counts, uptime, memory). It logs at error level, writes a **crash record** when fatal, and hands the event to the reporter (Sentry or nothing) under the consent rules.
- **`expected` vs unexpected.** User errors (a wrong IMAP password, offline, a 401 needing reconnect, validation) are typed `UserFacingError`s. They are logged at `warn` with their code and never reported. Everything else is reported. This keeps the Sentry signal clean.
- **Scrubber.** It is one function used by the logger, the breadcrumbs and Sentry's `beforeSend`/`beforeBreadcrumb`. There are unit tests with a corpus of hostile strings (addresses, subjects, OAuth tokens, URLs with tokens, IMAP greetings with user names).

## 5. Where each process plugs in

| Process | Log sink | Fatal hooks |
|---|---|---|
| main | Rotating JSONL `userData/logs/main.jsonl`: 2 MB × 5 files, written asynchronously and flushed synchronously on fatal | `uncaughtException`, `unhandledRejection`, `render-process-gone`, `child-process-gone`, the backend `utilityProcess` `exit` with a non-zero code, `gpu-process-crashed`. Electron `crashReporter` collects native minidumps (`uploadToServer: false` unless Sentry is active and consented; dumps are kept in `crashDumps`) |
| backend (utilityProcess) | Batched over its parent port to main, which writes `backend.jsonl` | Its own `uncaughtException`/`unhandledRejection`. RPC handler throws are logged as `rpc.handler_threw` with the method and the error class, never the params |
| renderer | Batched over IPC to main (`renderer.jsonl`); on the web build, an IndexedDB ring of 2,000 entries | `window.onerror`, `unhandledrejection`, a top-level React error boundary that shows a calm "Algo salió mal · Recargar" screen with **Exportar diagnóstico**, plus boundaries around the reader and the settings sheet so one broken mail can't take down the app |
| web worker (web build) | posted to the page | `error`, `unhandledrejection` |
| mcp | stderr JSON lines (its host captures them) and the file when run under the app | the same |

- **Crash records:** `userData/crashes/<ts>-<proc>.json` holds the error, breadcrumbs and context. They are capped at 20, oldest first.
- **On start:** main checks for records newer than the last-seen marker, and for an unclean-exit marker (a `running` file removed on a clean quit). If it finds either, it tells the renderer, which shows the row from §3.

## 6. Sentry

- `@sentry/electron` (main and renderer) and `@sentry/browser` for the web build. Both are lazily initialised only when there is a DSN and reporting is allowed; consent changes apply live through `Sentry.close()`/`init`.
- **DSN:** baked in at build time from `TERNO_SENTRY_DSN`. It is public by design.
- **Release:** `terno@<version>+<sha>`. Environment: `production | dev | test`.
- **Privacy configuration:**
  - `sendDefaultPii: false`
  - no Replay and no tracing
  - default integrations trimmed: no console breadcrumbs, no DOM-text breadcrumbs, no fetch/XHR breadcrumbs (our own `rpc`/`sync` breadcrumbs replace them), no request bodies
  - `beforeSend` runs the scrubber over the whole event and drops events whose code is in the expected list
  - the user id is the random install id, a UUID in settings that is never tied to an address
- **Source maps:** builds emit hidden source maps. `pnpm dist:mac` uploads them with `@sentry/cli` only when `SENTRY_AUTH_TOKEN` is set, then deletes the `.map` files from the bundle. A local `pnpm diag:symbolicate <crash.json>` resolves stack frames against the build's maps, which are kept in `release/maps-<sha>/`, so local crash records are readable too.
- **Native crashes:** minidumps go to Sentry through `@sentry/electron`'s native integration when consented.

## 7. User-facing surfaces

- **Ajustes → General → "Diagnóstico":**
  - Informes de errores: Preguntar / Siempre / Nunca. Disabled in local mode, with an explanation.
  - "Exportar diagnóstico…" writes a `.zip` (desktop) or `.json` (web) of the logs, crash records and system info, already scrubbed, plus a README telling the user what's inside.
  - "Mostrar registros" (desktop) opens the logs folder.
  - The build line shows version, build sha and channel, copyable.
- **Help menu (desktop):** "Exportar diagnóstico…" and "Mostrar registros".
- **Error boundaries and the post-crash row**, as above.

## 8. Tests

- **Unit:** the scrubber corpus, the field allowlist (type tests plus runtime drops), the ring buffer, `captureError` normalization, the consent matrix (local mode × setting × DSN present → send or not), the expected/unexpected classification, log rotation, and crash-record capping.
- **e2e (web fixture):**
  - throwing in a test-only hook shows the boundary screen
  - the post-crash row appears after a simulated unclean exit
  - "Ver qué se envía" shows scrubbed JSON with no fixture address or subject in it
  - the export contains no fixture addresses or subjects (grep over the export)
- **Desktop/packaged smoke:**
  - kill the backend utility process: the crash is recorded, the app recovers, and the next start shows the row
  - force a renderer crash (`process.crash()` via a test hook): a record is written and a minidump is present
  - with a fake DSN pointing at a local HTTP sink, `always` sends one scrubbed event and `never` and local mode send none (the sink counts requests)
- **Perf:**
  - logging and breadcrumbs add under 1% to the existing perf gates
  - a log call is under 5 µs on the hot path
  - the renderer IPC batches every 500 ms, or 100 entries
  - nothing synchronous touches the disk on the main thread except the fatal flush

## 9. Out of scope

- Analytics and usage telemetry.
- Session replay.
- Performance tracing.
- A remote log stream.

## 10. Revisions after the Codex plan review

These revisions override the sections above. The full critique is in `/tmp/unica-scratch/plan-10-codex.txt`.

1. **Native minidumps never leave the machine.** They hold process memory, which can contain mail and secrets.
   - Electron's `crashReporter` is the single native owner, started locally before any child process with `uploadToServer: false`.
   - The `@sentry/electron` native/minidump integration is off.
   - Dumps are not in the default diagnostic export. The export dialog has a separate, clearly worded checkbox: "Incluir volcados nativos (pueden contener fragmentos de tus correos)".
2. **There is one remote sender: main.** The renderer, the backend and the MCP host forward *already structured* events to main over validated IPC/ports. Main builds the Sentry event from an allowlist.
   - Sentry runs in main only. Use `@sentry/electron/main` or `@sentry/node`, whichever bundles cleanly with esbuild into the standalone `main.cjs`; prove it in the packaged app first.
   - There is no renderer SDK and no preload injection.
   - The web build uses `@sentry/browser` in the page, with the same event builder and the same rules.
3. **Consent is enforced at the transport.**
   - A custom transport wrapper checks the live policy (local mode, setting, DSN, one-time approval) for each envelope at send time.
   - There is no offline queue: an event not sendable now is dropped, while the local crash record remains.
   - Revoking consent takes effect for the next envelope. `close()` is never used as the switch.
   - Auto sessions, release health, tracing, source context, local variables, the context-lines integration and every breadcrumb integration are explicitly disabled.
   - The only breadcrumbs are ours.
4. **Schemas per event code, not just a key allowlist.**
   - Every log/breadcrumb/error code declares its fields with types: enums, bounded ints, booleans, and short ids matching `/^[a-z0-9_.-]{1,40}$/`.
   - Strings that don't match are replaced with `"<redacted>"`.
   - Remote events carry no exception message at all: only the error class name, our code, and validated stack frames (function name, app-relative file, line, column).
   - Local logs may keep a scrubbed message for the user's own export.
   - Local ids are numeric db ids only. RFC Message-IDs and provider ids are never logged.
   - Reports carry no permanent user id. Each report has a random event id; a random per-launch session id groups events from one run.
   - The install id is random, kept, disclosed as such in "Ver qué se envía", and resettable by the user.
5. **Source maps.**
   - All bundles (main, backend, preload, renderer, worker, mcp) are built with external maps and Sentry debug ids injected *before* packaging and signing.
   - The maps are moved out of the app tree before signing, into `apps/desktop/.maps/<version>-<sha>/` outside `release/`.
   - They are uploaded with `sentry-cli` only when `SENTRY_AUTH_TOKEN` is set.
   - `pnpm diag:symbolicate` uses the archived maps.
6. **Fatal policy.**
   - An uncaught exception or unhandled rejection in the backend is recorded, then the backend exits.
   - Main restarts it with a bounded backoff: 0.5, 1, 2, 4, 8 s, then it stops and shows a visible "El motor de correo se detuvo · Reintentar" state.
   - Main deduplicates overlapping exit and crash notifications, and ignores deliberate shutdowns.
   - GPU failures are caught through `child-process-gone`, since `gpu-process-crashed` is gone.
   - A send in flight when the backend dies is never retried automatically: its op stays `unknown`, as today.
7. **Breadcrumbs survive hard crashes, with a bounded loss window.**
   - Each process mirrors its ring to main every 2 s, or every 20 crumbs.
   - Main keeps the last ring per process instance, and persists rings on fatal events and every 10 s to `crashes/rings.json`.
   - The run marker is created after the single-instance lock and removed on a clean quit. A leftover marker with no crash record is reported as "cierre inesperado", which could also be a Force Quit or a power loss.
8. **Bounds on IPC and disk.**
   - Diagnostics IPC: sender and frame validation as in printing, a schema check in main, 256 KB per batch, 200 entries/s per process, and a counter of dropped entries.
   - Crash records: 64 KB each, 20 at most, 30 days.
   - Logs: 2 MB × 5 per process, mode 0600.
   - The export reads only Terno's diagnostics directories and doesn't follow symlinks.
   - A logging failure never throws and never reports itself.
9. **Expected vs unexpected errors survive RPC.** `RpcErrorPayload` gains `code` and `expected: boolean`, set where the error is classified (at the provider or backend boundary), and the client keeps them. Existing catch sites that swallow unexpected failures as warnings are instrumented with `captureError`. 401/offline errors count as expected only when the provider layer classified them.
10. **Web lifecycle.**
    - Run markers are per tab and per worker, so a closed sibling tab isn't a crash.
    - Diagnostics fall back to memory when IndexedDB fails.
    - The worker installs its own `error`/`unhandledrejection` handlers.
    - Capture is installed before boot (an inline-safe module first in `main.tsx`), so module-load failures are caught.
11. **Tests.**
    - Use Electron's `webContents.forcefullyCrashRenderer()` and a test-only main hook, not `process.crash()` in the page.
    - The local sink decodes full envelopes and asserts on every item.
    - Local mode is proven by a counter at the transport, not by loopback.
    - Cover: a backend crash with backoff; consent revoked while an event is pending; a restart into local mode; a full disk (a log write fails silently); a production-build artifact.
    - A known minified exception must resolve to the right source line through the archived maps.
