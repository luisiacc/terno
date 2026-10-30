# 78. Send error reports, even in local mode, without the Sentry SDK

## The request

> here we show this and let them download it, but why though? wouldn't it be better to send it to us somehow? they're not gonna do anything if its downloaded

> yes even in local mode thebuttons should say 'send' instead of export, now, where is this sent?

> go with option one [hosted Sentry, our own envelope POST, no SDK in the app] … create the tokens if you need to, proceed, also verify that sentry receives error from this project, the project in sentry must be called 'terno'

And the earlier queue item (2026-10-26): "remove sentry completely … build some way of sending us a report automatically, maybe to sentry, but remove sentry automatic events sending like replays, we only want it for bugs and should not send email data".

## What exists (plan 10)

- Records, breadcrumbs, the allowlisted report (`packages/core/src/diag/report.ts`): no free text, codes and typed fields only. "What gets sent" shows exactly that object.
- `consent.ts`: `mayReport` refuses everything in local mode or without a DSN. `reportOffer` is `local` (Export) in local mode, so in the default configuration the row says "The details were saved on this computer. You can export them" with **Export diagnostics…**. Nobody acts on a downloaded file.
- The pipe (`packages/core/src/diag/sentry.ts`): a bare `@sentry/core` client whose transport asks the live policy per envelope. Desktop main sends through `net.fetch` on the default session (`apps/desktop/src/diag/reporter.ts`, its own `reporter.cjs` bundle); the web build through `@sentry/browser`'s `makeFetchTransport` (`apps/web/src/lib/diag-sentry.ts`).
- In local mode the default session's backstop (`network-backstop.ts`) cancels every non-loopback request but mail images, so a send from main would be cancelled there anyway.
- The DSN is baked from `TERNO_SENTRY_DSN` at build time (desktop `scripts/build.mjs`, web `vite.config.ts`); nothing sets it, so every build so far reports nowhere.
- Source maps: `scripts/sourcemaps.mjs` injects debug ids and archives the maps; `package.mjs` uploads them with `@sentry/cli` when `SENTRY_AUTH_TOKEN` is set.

## Sentry

Org `luisiaccorg`, one project `terno` (platform javascript) for desktop and web; the `proc` tag and the release name tell them apart. Server side: data scrubber with defaults, IP addresses scrubbed, extra sensitive field names (subject, body, from, to, cc, bcc, email, address, name, filename, query, prompt), no crash-report storage. DSN (public by design: it can only submit events):

`https://94ef4113e2c6f556c30c47b6533c43d7@o4505891924738048.ingest.us.sentry.io/4512346705166336`

## Design

### Consent

The user's click is the consent; local mode no longer decides it.

- `mayReport(p, approved)`: no DSN → no. `always` → yes. `ask` → only the approved report. `never` → no. Local mode is no longer an input.
- `reportOffer`: no DSN or `never` → `local` (Export, as today). `always` → `sent`. `ask` → `ask` (Send, Always send, What gets sent, Not now). So the default configuration (local mode, `ask`) now offers **Send**.
- Local mode's promise becomes "your mail servers, plus what you explicitly ask for": a report you clicked Send on, or chose to send always. Nothing leaves without that choice. Settings → Diagnostics' select is enabled in local mode; its hints and the preview's notes drop the "local mode sends no reports" lines.
- Plan 10's in-place row for ordinary errors appears only under `ask`, as before; it now also appears in local mode. Crashes and unclean exits get the row whatever the setting.
- A send that fails keeps the record pending (it is not marked seen), so the row stays with Send to try again; the snackbar says it couldn't be sent.

### The pipe, without the SDK

`packages/core/src/diag/envelope.ts` (replaces `sentry.ts`, export `@terno/core/diag/envelope`):

- `parseDsn(dsn)` → `{ url: <scheme>://<host>/api/<project>/envelope/, key }`, or null.
- `serializeEnvelope(event, dsn)`: three lines, `{"event_id","sent_at","dsn"}`, `{"type":"event","length":<bytes>}`, the event JSON. Exactly the object the preview shows.
- `createReporter({ dsn, fetch, allow, onResult })`: `send(event)` asks `allow(eventId)` at send time (the consent boundary, unchanged), then POSTs with `Content-Type: application/x-sentry-envelope` and `X-Sentry-Auth: Sentry sentry_version=7, sentry_key=<key>, sentry_client=terno/<version>`. 2xx → sent. 429 (or an `X-Sentry-Rate-Limits` covering `error`/default) → `rate`, and every send until the retry-after passes is refused without a request (no timer: a stored deadline). Other status → `error`; a throw → `error`; 30 s without an answer → `timeout` (an AbortController, so nothing keeps running).
- No queue, no flush on quit, no integrations, no sessions, no client reports. Same `SendResult` shape as today, so hosts barely change.

Desktop main: `reporter.ts` keeps its own bundle, now a few lines over a dedicated `session.fromPartition("terno-reports", { cache: false })` whose `onBeforeRequest` allows only the DSN's envelope URL (the updater's pattern, plan 41's engine). The default session's backstop stays as it is: the renderer still can't reach Sentry.

Web: `diag-sentry.ts` becomes `diag-report.ts`, the same reporter over `fetch` (with `keepalive: false`, `credentials: "omit"`, `referrerPolicy: "no-referrer"`). CSP `connect-src https:` already covers it.

Dependencies: `@sentry/core`, `@sentry/browser`, `@sentry/cli` leave every package.json and the catalog.

### The DSN in releases

`scripts/release-env.mjs` holds `TERNO_DSN`. A release build gets it unless `TERNO_SENTRY_DSN` overrides it (an empty string turns reports off):

- desktop: `build.mjs` uses it when `TERNO_RELEASE=1`; root `dist:mac` sets that. Dev (`dev.mjs`), smoke and test builds don't.
- web: `build:web` sets `TERNO_RELEASE=1`; the demo and test builds (`dev:web`, `test:web`) don't.

Forks that build a release would report to us; they can set `TERNO_SENTRY_DSN=` (documented in the README's build section).

### Source maps

`package.mjs` uploads the archive with the `sentry` CLI (`sentry sourcemap upload <archive> --release <name>`, org/project `luisiaccorg/terno` through `SENTRY_ORG`/`SENTRY_PROJECT` defaults) when `sentry` is on PATH and authenticated, or `SENTRY_AUTH_TOKEN` is set; otherwise it prints that it skipped. Debug ids already match (`sourcemaps.mjs`). A failed upload doesn't fail packaging (the maps stay archived; `pnpm diag:symbolicate` still works) but is printed loudly.

### Copy (en + es)

- `diag.row.ask`: "Send an anonymous report? It never includes your mail." (unchanged).
- `diag.row.local` only for `never`/no DSN: "The details were saved on this computer."
- Settings hints: the two local-mode hints go; `ask`/`always`/`never` stay.
- Preview: `diag.preview.localMode` goes.
- Export stays in Settings → Diagnostics → Logs.

## Tests

- Unit, `envelope.test.ts`: DSN parsing (https, port, path prefix, garbage); the serialized envelope is the preview event byte for byte; headers; refusal never calls fetch; 429 + Retry-After refuses the next send without a request and allows after the deadline; `X-Sentry-Rate-Limits` for error/default; 500 → error; throw → error; timeout aborts. The fake fetch decodes envelopes like the old sink.
- Unit, consent matrix: local mode × setting × DSN × approved.
- Unit, desktop `diag.test.ts` and web `diag-local.test.ts`: local mode + ask + approve sends; a failed send leaves the record pending; local mode + ask without approval sends nothing.
- Unit, desktop: the reports session allows only the envelope URL.
- E2E (`apps/web/e2e/diagnostics.spec.ts`): in local mode the row shows Send; with no DSN it still shows Export.
- Packaged smoke (`diagnostics.smoke.ts`, local sink DSN): local mode + ask + Send delivers one envelope equal to the preview; local mode without a click sends nothing (counted at the sink); `never` sends nothing.
- No `@sentry` import anywhere (a source scan test).
- Real check: a release-configured build sends one report to `terno` and `sentry issue list luisiaccorg/terno` shows it.

## Perf and resources

Smaller bundles (no SDK); the reporter chunk loads only on the first send. No timers at idle (rate limits are a stored deadline). One request per report.

## Out of scope

An offline retry queue across launches; attaching logs to a report; user feedback text with a report.

## Revisions after the Codex review (plan critique, 11 points)

1. **A test run could report to production.** The smoke copies the release app, which now carries Terno's DSN. Main in test mode uses only `TERNO_TEST_SENTRY_DSN`, and only when it is loopback (`loopbackDsn`, `report-fence.ts`); never the built DSN.
2. **`release:mac` missed the flag.** `release.mjs` builds with `TERNO_RELEASE=1`, like `dist:mac`.
3. **Old profiles with local mode + "always"** (which sent nothing) would start sending silently. The backend migrates them to "ask" (`migrateErrorReports`, `errorReportsVersion`), and main's cached policy does the same until the backend publishes (`keptPolicy`, `policyVersion`).
4. **"Always" from the row could send a report twice** (the policy change and the explicit send). The reporter keeps one request per event id in flight, and hosts skip ids already sent.
5. **A failed report must keep a way to send it.** Under "always", a report that didn't go now shows a `retry` offer (Send, What gets sent) instead of Export; the preview offers Send whenever the offer isn't `local`.
6. **Rate limits** follow Sentry's rules: `X-Sentry-Rate-Limits` wins (any status; no categories = all; only `error`/`default` count; the longest item), else a 429's `Retry-After` (seconds or HTTP date), else 60 s.
7. **Redirects** can't carry a report elsewhere: `redirect: "error"` on both hosts.
8. **Cookies:** the reports session strips `Cookie` going out and `Set-Cookie` coming in (the updater's filters); the web sends `credentials: "omit"` and no referrer.
9. **The web flow needed a real browser test:** the `test:web` build gets a DSN at `reports.invalid`, and `diagnostics.web.spec.ts` routes it (Send, retry, Never). The page sends a simple request (key in the URL, text body, no preflight), as Sentry's browser SDK does.
10. **Web source maps** had no upload path: the web build writes `apps/web/.maps/LATEST`, and `pnpm upload:web-maps` uploads it with the same script as desktop (`scripts/upload-maps.mjs`).
11. **The local-mode switch's explanation** now names "the error reports you choose to send" (Mac, with icons, and web; en + es).

Also found while building: the architecture scan didn't recognise a session's own `fetch` (the new desktop path), so it gained an "Electron session fetch" pattern, and the reporter and the web pipe are allowlisted with their reasons.
