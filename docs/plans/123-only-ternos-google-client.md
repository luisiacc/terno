# Plan 123: Gmail only through Terno's own Google client

## Request (verbatim)

> lets also remove on settings the google oauth client id that we ask somehwere, just completely remove that as we will depend on our own google key always, if no google key set up, there is no other way to set up google.

## What exists

Plan 99 baked Terno's Desktop clients into builds (`BackendCoreOptions.googleClients`) and the web's ID (`VITE_TERNO_GOOGLE_CLIENT_ID`). Bring-your-own stayed:

- `AppSettings.gmailClientId` (+ derived `gmailClientSecretSet`, `gmailClientSecretUnreadable`), `settings.update({ gmailClientId })`, `settings.setSecret({ name: "gmailClientSecret" })`, the export/import list.
- Settings → Accounts → "Google (Gmail)": the ID and secret fields, shown only in a build without Terno's client (`googleBuiltIn()`, the desktop preload's `googleBuiltIn`).
- `googleClientFor`: a new connection takes Settings' client before the build's; a remembered client may be Settings' (with the saved secret); `rememberLegacyGoogleClients` bound pre-99 accounts to Settings' client once.
- `gmail.ts`: without `ctx.googleClient` it reads `gmailClientId` + `gmailClientSecret` itself.
- The add-account form catches `errors.gmailClientIdMissing` and sends the user to Settings → Accounts (first run too).
- Web: `webClientId(settings.gmailClientId)` falls back to the build's ID.
- Tests (backend, mail, e2e, e2e-web) reach their fake Google by setting a client ID in Settings.

## Design

1. **One source of clients: the build.** `googleClientFor(b, remembered?)` returns the build's client with the remembered ID, else (a new connection, or an account that remembers none) the build's preferred one; otherwise `null`. Settings are never read.
2. **The setting is gone.** `gmailClientId`, `gmailClientSecretSet`, `gmailClientSecretUnreadable` leave `AppSettings`; `gmailClientId` leaves the update schema and the export/import list; `settings.setSecret` is removed (it had no other name). `readSettings` drops a stored `gmailClientId`, so it never reaches the renderer. An import carrying it ignores it.
3. **A saved client secret is deleted** on start (once, idempotent), replacing the plan 99 backfill.
4. **`gmail.ts`** has no settings fallback: no `ctx.googleClient` (or none returned) is a `ProviderAuthError` (reconnect), as an unavailable client already is.
5. **UI.** The "Google (Gmail)" group, the add-account `onNeedsClientId` detour and the renderer's `googleBuiltIn()` (and the preload's flag) go. A build without a client (forks, test builds; a release build already fails without one) fails a Google connect with `errors.google.noClient`: "This copy of Terno can't connect Google accounts. Add the account with IMAP instead." shown inline like any connect error.
6. **Web** signs in with the build's ID only (`webBuiltInClientId()`).
7. **Accounts connected with someone's own client** (before plan 99) can't refresh any more: they're asked to reconnect, and a reconnect says to remove the account and add it again (`errors.google.clientGone`, today's path for a missing client). Terno isn't released; only developer profiles can have these.

## Tests

- `google-client.test`: remembered build ID → its secret; unknown remembered ID → null; no remembered → preferred; no build clients → null; Settings never consulted; the stored secret is deleted on start.
- Backend/mail tests that set a client ID pass `googleClients` (or `ctx.googleClient`) instead.
- `settings-edits`/`export`: `gmailClientId` is neither returned nor exported nor imported.
- e2e: the dev server takes `googleClients` (the fixtures give a test client); the "no client" cases start a server without one and expect the inline error; e2e-web dev configs build with `TERNO_GOOGLE_WEB_DEV_ID`.
- Visual: Settings → Accounts without the group (light and dark).

## Perf and resources

Less work: no settings read per connect or refresh.

## Out of scope

Moving accounts between clients; Google verification.

## Revisions after the Codex review

The critique (12 points) changed:

1. **Accounts that remember no client** (connected before plan 99, never backfilled) now resolve to the build's client: their old refresh token fails, they're asked to sign in again, and that sign-in uses Terno's client. Accounts that remember a client of the user's own end at `errors.google.clientGone` (remove and add again). Switching a remembered client during a reconnect would rework the credential commit plan 99 locked down, so it isn't done.
2. **A web release needs its client too.** `buildWebGoogleClientId` (`scripts/release-env.mjs`, reads `.env` under the environment) fails a release without `TERNO_GOOGLE_WEB_ID`, unless it is set empty on purpose; `vite.config.ts` uses it.
3. **The web's copy has no IMAP advice** (IMAP isn't available in the browser): `errors.google.noClientWeb`, for mail and photos.
4. All three resolver callers (refresh, renewal, reconnect) keep the remembered client.
5. `googleClient` stays optional in the provider context; a context without it asks to sign in again and never reads Settings (`gmail-refresh.test`).
6. A stored `gmailClientId` (SQLite or IndexedDB `settings.app` JSON) is dropped on read, so bootstrap and export never carry it; an old export's is ignored on import (`export.test`).
7. `settings.setSecret` is gone (`ai-backend.test` asserts it); MCP's allowlist needed no change.
8. The e2e dev server takes `googleClients` (`backendOptions.noGoogle` for a build without one); web-build configs set a synthetic `TERNO_GOOGLE_WEB_DEV_ID`.
9. Tests that leaned on the removed setting for other reasons were moved to their own triggers (the categorize race, keychain fixtures).
10. The secret is deleted before the Única keychain migration (which would otherwise open and seal it again), with no "once" marker; the preload's flag and its build define are gone.
