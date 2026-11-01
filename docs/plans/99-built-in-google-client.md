# Plan 99: Terno's own Google client

## Request (verbatim)

> when clicking to connecta google account it brings mehere, what the hell is this, it should ask me for hte screen to connect google account, not this

"Here" is Settings → Accounts → Google (Gmail): the OAuth client ID and secret fields.

## What exists

- Gmail is bring-your-own-client (plan 04 §5: "a user-supplied Web client ID (bring-your-own, like desktop)"). `settings.gmailClientId` defaults to `""`.
- `accounts.connectGmail` (`handlers.ts`) and `connectExistingGoogle` (`identity.ts`) throw `errors.gmailClientIdMissing` without one; the add-account form catches that key and opens Settings → Accounts (plan 98 §9 keeps the setup's draft across that detour).
- The access-token refresh (`packages/mail/src/gmail.ts`) and the renewal exchange (`identity.ts`) read the same app-wide `gmailClientId` + `gmailClientSecret`.
- Terno now has its own Google Cloud project with Desktop (dev, prod) and Web (dev, prod) clients. Nothing uses them.

## Design

1. **A build carries Terno's Desktop client.** `scripts/release-env.mjs` gains `buildGoogleClient(env)`: `TERNO_GOOGLE_CLIENT_ID`/`TERNO_GOOGLE_CLIENT_SECRET` when set (empty = none, e.g. a fork), else the JSON in `TERNO_GOOGLE_DIR` (default `~/.config/terno-google`): `desktop-prod.json` for a release (`TERNO_RELEASE=1`), `desktop-dev.json` otherwise. Test builds never get one (the smoke and e2e keep today's paths). `build.mjs` defines both into the bundles. The values never enter git. Google treats an installed app's secret as non-confidential (PKCE + loopback already protect the flow), so baking it in is the standard practice (Thunderbird, gcloud).
2. **The backend takes it as an option** (`BackendCoreOptions.googleClient`), passed by `backend-entry.ts`.
3. **One resolver** (`packages/backend/src/google-client.ts`): `googleClientFor(b, accountClientId?)`.
   - An account remembers the client that issued its refresh token (`GmailAccountConfig.googleClientId`, written at connect). A refresh token only works with that client, so refresh, renewal and reconnect use it: the built-in secret when it is the built-in id, the user's saved secret otherwise.
   - No remembered client (a new connect, or an account from before this plan): the user's `gmailClientId` if set, else the built-in. Old accounts were connected with the user's client, which is still in settings.
   - Neither: `null` → `errors.gmailClientIdMissing`, today's behavior.
4. **Providers ask, not read settings.** The provider context gains `googleClient()`; `gmail.ts` uses it (falling back to today's reads when absent, so other contexts keep compiling).
5. **Settings.** `AppSettings.googleBuiltIn?: boolean` (derived, like `gmailClientSecretSet`). When true and the user has no client of their own, the Google group shows one quiet disclosure row, "Use your own Google client", that reveals today's fields; otherwise the fields show as now. The footer says the client is optional.
6. **Web.** `vite.config.ts` defines `import.meta.env.VITE_TERNO_GOOGLE_CLIENT_ID` from `TERNO_GOOGLE_WEB_CLIENT_ID` (web target only; the ID is public). `web/google.ts` uses the user's ID, else that one. The web Settings group treats it like the desktop built-in.

## Tests

- `release-env.test`: env override, empty override, dev vs release file, missing/invalid file → none.
- `google-client.test`: remembered built-in id → built-in secret; remembered other id → user secret; none → user id → built-in → null.
- Backend: `accounts.connectGmail` with no settings client and a built-in connects with the built-in id and stores `googleClientId`; without a built-in it still throws `gmailClientIdMissing`.
- `gmail.ts` refresh uses `ctx.googleClient()` when present.
- Settings UI unit/e2e: disclosure shown with a built-in, fields shown when a user client is set.

## Perf and resources

None: one settings read per connect/refresh, as today. No network until the user connects.

## Out of scope

- Google verification of `gmail.modify` (the consent screen is in Testing: only listed test users can connect, and Testing refresh tokens last 7 days).
- Moving accounts between clients.

## Revisions after the Codex review

The critique (10 points) changed the design:

1. **A remembered client gets only its own secret.** A remembered ID resolves to a baked Terno client with that ID, or to the user's client only while `gmailClientId` still equals it. Anything else is *unavailable*: refresh asks to reconnect (`errors.gmail.reconnect`), and a reconnect says the account must be removed and added again (`errors.google.clientGone`). Unrelated credentials are never paired.
2. **Legacy accounts are backfilled.** On `start()`, before any account syncs, a Gmail account with no `googleClientId` gets the user's `gmailClientId` (the only client it can have been connected with). Clearing the setting later no longer moves it to the built-in.
3. **Dev and release share a profile** (`pnpm dev:desktop` uses the real one), so a build bakes every Terno Desktop client it has (dev and prod) and prefers prod in a release, dev otherwise. An account made in dev keeps refreshing in a release.
4. **Reconnect keeps the account's client.** `connectExistingGoogle` and the renewal branch of `googleCredentialIntent` both resolve from the account's remembered ID, not from settings, so a settings change mid-consent can't split them (at worst it makes the client unavailable, which fails closed).
5. **No derived settings field.** Whether a build has a client is a property of the build: the desktop preload exposes `ternoDesktop.googleBuiltIn` (a build-time define); the web reads its `VITE_` define. Settings objects are untouched.
6. **Web photos too.** `authorizeGooglePhotosWeb` and `connectGmailWeb` share one `webClientId()`.
7. **Resolver failures are auth errors.** In `gmail.ts`, a missing/unavailable client or an unreadable secret becomes `ProviderAuthError` (reconnect), never the retryable `replaceFailed`.
8. **The packaged smoke** runs the release build in demo mode, which never opens Google; the Settings disclosure has no smoke assertions. Updater test builds (`TERNO_TEST_BUILD`) get no client.
9. **A release without its client fails the build** (sanitized message), unless `TERNO_GOOGLE_DESKTOP_ID=""` says so on purpose (a fork).
10. **Wiring tests:** `release-env.test` covers `.env` loading, precedence and the release guard; the backend tests drive `accounts.connectGmail` through `BackendCoreOptions.googleClients`.

Where the values live: the repo's git-ignored `.env` (`TERNO_GOOGLE_DESKTOP_DEV_ID/SECRET`, `TERNO_GOOGLE_DESKTOP_ID/SECRET`, `TERNO_GOOGLE_WEB_DEV_ID`, `TERNO_GOOGLE_WEB_ID`); the process environment wins over it. The web build reads only the process environment, so the e2e builds keep today's bring-your-own path.

## What the Codex code review changed

One finding: an account from before this plan whose Settings client was already cleared stays unbound, so a reconnect with the build's client and a Settings client added later would pair them wrongly. Now an existing account that remembers no client resolves to the build's client before Settings', and the legacy backfill runs once (a `googleClientBackfill` flag), so a later start never binds an account to a client it didn't sign in with. Regression: `google-client.test.ts` ("an account the backfill couldn't bind…").

Verified: the desktop build bakes the clients into `backend.cjs` only; the preload carries just `googleBuiltIn`. Screenshots of the Settings group checked in light and dark.
