# Plan 25: signing in again, gently

- **Status:** done (see "Implementation notes" and "What the Codex code review changed").
- **Builds on:** `5548ae9` (main after plan 24).
- **Request (verbatim):** "lets make sure we handle re sign-in gracefully on our app, not forcing the user, but letting them know for a particular email account that it needs to sign in, subtly and nice with a premium feeling"
- **Why now.** The Google Cloud OAuth app is in "Testing", so a Gmail refresh token dies after 7 days (`invalid_grant`): with ~6 accounts, signing in again is a weekly event. IMAP accounts hit it when a password changes or an app password is revoked. On the web a Gmail token lasts an hour and isn't stored, so there it's every load.

## 1. What exists

- **Backend state.** `syncAccount()` (`packages/backend/src/core.ts`) sets `syncState.authRequired = error instanceof ProviderAuthError` on a non-retryable failure (`status: "error"`) and clears it on a success, which also calls `resumeAuth()` (ops parked by `store.ops.awaitAuth` go again).
- **Who raises `ProviderAuthError`:**
  - Gmail desktop: `refresh()` on `invalid_grant` (`errors.gmail.revoked`), no refresh token (`errors.gmail.reconnect`); the API's second 401 in a row (`gmail-api.ts`).
  - Gmail web: no live token (`gmail-web.ts`, `errors.gmail.reconnectWeb`).
  - Any account whose secret the keychain won't open (`SecretUnreadableError`, `core.ts` `provider()`).
  - **Not IMAP.** `toProviderError()` (`imap.ts`) turns `authenticationFailed` into a plain non-retryable `ProviderError` (`errors.imap.loginFailed`), and SMTP's `EAUTH` is the same (`smtp.ts`). So an IMAP account with a changed password shows a red "Error: IMAP login failed…" in Settings only, never `authRequired`, and a queued **send fails for good** instead of waiting.
- **Ops.** `executeOp()` parks an op on `ProviderAuthError` (`awaitAuth`: attempt given back, `next_attempt_at = AWAITING_AUTH`), but doesn't mark the account. `OpInfo` doesn't say an op is waiting for a sign-in, so the renderer shows nothing when a send parks.
- **The poll.** `tick()` syncs every account every 120 s, auth-required ones included: a refused login (IMAP) or a dead grant (Gmail) every two minutes, forever. Each pass also flips the row to `syncing` (the sidebar dot pings) and back to `error`.
- **IMAP push.** `watch()`'s reconnect loop retries a failed connect with backoff capped at 60 s, whatever the reason: with a wrong password that's another failed login every minute. Servers lock accounts out for that (iCloud, Yahoo, Fastmail do).
- **Signing in again.** `accounts.reconnect {id, password?}` → `reconnectAccount()` (`identity.ts`):
  - IMAP: a live login (`verifyImap`) with the typed password.
  - Gmail desktop: the browser OAuth with `login_hint` = the account; a different Google account is refused (`errors.googleConnectedOther`, which names both).
  - Then: same mailbox checked by stamp, `dropAccount`, new secret, `setSyncState({status: "idle", lastError: null})`, `emitAccounts`, `resumeAuth`, `startAccount` (watch + sync). **It leaves `authRequired: true`** until that sync succeeds.
  - Web Gmail: the page gets a token from Google Identity Services (`connectGmailWeb(email)` in `web/google.ts`) and calls `accounts.connectGmailToken`, which renews an existing account's token *by the address Google returned*. **If the user picks another Google account in the popup, it silently adds that one as a new account** (or renews a different one). It too leaves `authRequired` until the sync.
- **UI.**
  - Settings → Accounts: per account a status line (`Error: Gmail access was revoked; reconnect the account.` in destructive ink) and `Reconnect` (Gmail: "Connect with Google"; IMAP: "Change password…" → an inline password form).
  - Web only: `GmailReconnect` (`web/gmail-reconnect.tsx`, lazy, mounted at the top of the thread list): a boxed accent banner (`border-primary/25 bg-accent/50`) with one row per account and a primary button.
  - Desktop: **nothing outside Settings.** The sidebar's account rows show only the syncing ping. The `ConnectionPill` (plan 20) deliberately ignores auth problems.
- **No native notifications** exist anywhere in Terno.

## 2. Design

### 2.1 Principles for this feature

- **Never forced.** No modal, no blocking, no browser opened on its own. Mail already synced stays readable, searchable and actionable; changes and sends queue and go out after the sign-in (already true for Gmail; §2.4 makes it true for IMAP), and the UI says so.
- **Two layers, both quiet.** A persistent but tiny marker on the account's own row (always there while it's needed), plus one calm sidebar notice in the `ConnectionPill` family that can be put off with "Later".
- **One component on desktop and web.** The web banner goes; the web passes its Google popup flow into the same panel.

### 2.2 What the user sees

**The account's row** (sidebar → Accounts). At the row's end, where an unread count sits, a small `KeyRound` icon button in `text-muted-foreground` (hover: `sidebar-foreground`; no red, no fill). It's a sibling of the row's button (like the review badge), so the row still navigates. Name and tooltip: "Sign in to keep {email} up to date". It opens the sign-in panel for that account, beside the row (`side="right"`). The unread count stays, left of the icon (`reserveEnd` gets an icon size).

**The sidebar notice** (`SignInNotice`), above the `ConnectionPill` and the `UpdatePill`, in their style: a hairline-bordered capsule (`border-sidebar-border`, `rounded-lg`, `text-xs`), a muted `KeyRound` glyph, two lines and one icon button.

| needs sign-in | title (`role="status"`) | second line (muted) |
|---|---|---|
| one account | "Personal needs a sign-in" (its display name) | "Sign in to catch up" |
| several | "2 accounts need a sign-in" | "Sign in to catch up" |

- The text block is the popover trigger (a `<button>`, so the whole capsule but the dismiss is one target): it opens the panel above the notice (`side="top"`, like the update popover).
- An `X` icon button named "Later" (tooltip "Later") hides the notice. **Later lasts until that account needs a sign-in anew** (it signs in, or works again, and later fails again) **or until Terno restarts.** It never hides the row's marker. Why: with a weekly expiry, one reminder per launch is the right volume; the row marker is the quiet reminder in between. It's renderer memory (a zustand store, not persisted): a second window or a reload asks again, which is what a reload means on the web.
- An account that comes back on its own (a network change's retry, a restart) disappears from both without a word.
- The status region's text changes only when the set changes (1 → 2 accounts, a different account), so a screen reader hears it once, not on every account event. The backend emits accounts on every pass; the text stays the same, so nothing is re-announced.

**The sign-in panel** (`SignInPanel`, lazy: §2.6). A popover, `w-80`, the popover's own surface and `shadow-popover` (as the update popover), focus moves into it, Escape closes it and gives focus back.

- **Header.** One account: its dot, "Sign in to {name}" (`PopoverTitle`), and its address muted under it. Several: "2 accounts need you to sign in".
- **Reassurance** (one muted line): "Your mail stays here. New mail, and anything you send or change, waits until you sign in." Web Gmail adds "In the browser, Google’s access lasts an hour and isn’t saved."
- **Per account** (several accounts: one section each, hairline-separated, dot + name + address on the left, the action on the right):
  - **Gmail:** "Continue with Google". Desktop: `accounts.reconnect` (the browser opens Google with the address chosen). While it waits: a spinner and "Finish in your browser" (`aria-live="polite"`), and the button reads "Open again" (a fresh flow; the older one's late error is dropped, §2.5). Web: `connectGmailWeb` with the account (Google's popup, which needs the click's activation: the script is preloaded when the panel mounts).
  - **IMAP:** a password field ("Password for {email}", visually labeled by its placeholder "Password", `autoComplete="current-password"`), "Sign in" submits. Several accounts: "Enter password" first, which reveals that account's field (so a panel of four accounts isn't four fields).
  - **Errors** show inline under that account, in plain English, `role="alert"`, in `text-destructive-ink` (the one place a warm color is right: the user just acted). They're the backend's words: a wrong Google account says which was expected (`errors.googleConnectedOther`), a wrong password says the login failed. The field keeps its value and focus.
- **Footer:** "Later" (ghost), which closes the panel (and, from the notice, hides the notice as above).
- **Success:** the existing snack "{email} is connected again" (`account.reconnected`), that account leaves the panel, the marker and the notice; with none left the panel closes and focus goes to that account's sidebar row (never to `<body>`). Sync for it starts at once and its parked actions go (§2.4).

**A send that parks.** When an op waits for a sign-in (`OpInfo.awaitingAuth`), and it's a send: one snack per account (`id: auth-send-<accountId>`): "Your message will go out once you sign in to {email}", action "Sign in" (opens the panel for it, even after "Later"). Other ops (archive, flags) say nothing: the notice already covers them.

**Settings → Accounts.** An account that needs a sign-in reads "Needs you to sign in again" (`account.status.signIn`) in `text-muted-foreground`, not destructive ink (an expired grant isn't an error the user made). Its button reads "Sign in again" for both kinds, and runs the same action as the panel (§2.5), so the busy and late-error rules hold there too.

**Every design** (macOS, Atelier, Lumen) uses the same `NavItem` and sidebar footer stack, so all of this is one component with the same roles, names and test ids. It's checked in all three, light and dark (§4).

**Motion.** The popover's existing `duration-base` (within `--motion`); the notice appears without animation (like the `ConnectionPill`); the spinner is `motion-reduce:animate-none`.

### 2.3 Not doing (and why)

- **No native notification.** Terno has none today; the first one shouldn't be "please sign in", and a weekly OS notification is the opposite of subtle. Mail that waits says so the next time the user looks.
- **No auto-opened browser**, no modal, no badge on the Dock.
- **No cancel RPC for the Google flow.** It times out by itself in 5 minutes (`errors.google.timedOut`); "Open again" covers an abandoned tab.

### 2.4 Backend

1. **IMAP and SMTP refusals are sign-ins.** `toProviderError`: `authenticationFailed` → `ProviderAuthError(errors.imap.loginFailed)`, except a response code that says it's temporary (`UNAVAILABLE`, RFC 5530), which stays retryable. The missing password (`errors.imap.noPassword`) → `ProviderAuthError`. SMTP `EAUTH` → `ProviderAuthError(errors.smtp.authFailed)`: a send waits for the sign-in instead of failing (EAUTH is before DATA: never ambiguous). `withConnection` already doesn't retry a non-retryable error.
2. **IMAP push stops knocking.** `watch()`'s loop: a connect that fails as a sign-in schedules nothing (no reconnect every minute with a refused password). `restart()` (a network change) tries once more; the account's sign-in drops and re-creates the provider (and with it the watch).
3. **The poll skips accounts that need a sign-in.** `tick()` doesn't sync an account whose `syncState.authRequired` is set. They're still tried at start, and once per network change (both are events, so a refusal stays rare; a server that refused by mistake gets those chances). No retry timer, nothing new.
4. **An op refused for a sign-in marks the account.** `executeOp()`: after `awaitAuth`, `setSyncState({ status: "error", authRequired: true, lastError, lastErrorI18n, connection: null })` and `emitAccounts()`, once (only if it wasn't set). So a send that parks lights the marker even if no sync ran.
5. **`OpInfo.awaitingAuth`.** `opInfo()` sets `awaitingAuth: true` for a queued op at `AWAITING_AUTH`.
6. **Signing in clears it at once.** `reconnectAccount()` and `connectGmailToken`'s renew path write `authRequired: false` (and `status: "idle"`, `lastError: null`) before `emitAccounts()`: the credentials were just proven (a live IMAP login, Google's answer, the token's profile call), so the marker goes now, not after the sync. Then `resumeAuth` and a sync, as today (the renew path already calls both).
7. **The web refuses the wrong Google account.** `accounts.connectGmailToken` gets an optional `accountId`: when given, the token must belong to that account's address, else `errors.googleConnectedOther` (no account is created or renewed). `connectGmailWeb(email, accountId)` passes it. Adding a new Gmail account (no `accountId`) is unchanged.

### 2.5 Renderer

- **`lib/sign-in.ts`** (entry chunk, tiny, no React): a zustand store `{ dismissed: Map<accountId, true>, pending: Map<accountId, number /* attempt */>, errors: Map<accountId, string>, openFor: number | "all" | null }` and:
  - `needsSignIn(accounts)`: those with `syncState.authRequired`.
  - `noticeAccounts(accounts, dismissed)`: those not dismissed.
  - `forget(accounts)`: called from the `accounts` event: drops dismissal, pending and error for accounts that no longer need a sign-in (so the next failure is "anew").
  - `signInAgain(account, password?)`: bumps the attempt, runs the kind's flow (desktop `accounts.reconnect`; web Gmail `connectGmailWeb(email, id)`), on success `snack.success(account.reconnected)`; on failure stores the error **only if it's still the latest attempt and the account still needs a sign-in** (an abandoned flow's timeout five minutes later says nothing).
- **`components/sign-in-notice.tsx`** (entry chunk: it's in the sidebar): the notice, and the row's `SignInMarker`. Both open `SignInPanel` in a `Popover`; the panel's content is `lazy()`.
- **`components/sign-in-panel.tsx`** (lazy chunk): the panel. Preloaded on the trigger's pointer-enter/focus, and on web also preloads Google's script.
- **Removed:** `web/gmail-reconnect.tsx`, its `web-parts` export, its mount in `thread-list.tsx`, and `web.reconnect.*` (en, es).

### 2.6 Copy (en / es)

| key | en | es |
|---|---|---|
| `signIn.notice.one` | {name} needs a sign-in | {name} pide iniciar sesión |
| `signIn.notice.many` | # accounts need a sign-in (plural) | # cuentas piden iniciar sesión |
| `signIn.notice.waits` | Sign in to catch up | Inicia sesión y ponte al día |
| `signIn.later` | Later | Más tarde |
| `signIn.marker` | Sign in to keep {email} up to date | Inicia sesión para mantener {email} al día |
| `signIn.title.one` | Sign in to {name} | Inicia sesión en {name} |
| `signIn.title.many` | # accounts need you to sign in (plural) | # cuentas necesitan que inicies sesión |
| `signIn.reassure` | Your mail stays here. New mail, and anything you send or change, waits until you sign in. | Tu correo sigue aquí. El correo nuevo, y lo que envíes o cambies, espera a que inicies sesión. |
| `signIn.webGmail` | In the browser, Google’s access lasts an hour and isn’t saved. | En el navegador, el acceso de Google dura una hora y no se guarda. |
| `signIn.google` | Continue with Google | Continuar con Google |
| `signIn.google.waiting` | Finish in your browser | Termina en tu navegador |
| `signIn.google.again` | Open again | Abrir de nuevo |
| `signIn.password.reveal` | Enter password | Escribir contraseña |
| `signIn.submit` | Sign in | Iniciar sesión |
| `signIn.sendWaits` | Your message will go out once you sign in to {email} | Tu mensaje saldrá en cuanto inicies sesión en {email} |
| `account.status.signIn` | Needs you to sign in again | Necesita que vuelvas a iniciar sesión |
| `account.signInAgain` | Sign in again | Volver a iniciar sesión |

Changed: `errors.gmail.revoked` → "Google’s sign-in for this account expired or was revoked." (es likewise): with a Testing app it usually expired. Removed: `web.reconnect.waiting`, `web.reconnect.action`.

### 2.7 Privacy and diagnostics (plan 10)

Nothing new is logged. The existing `sync.failed` / `ops.failed` codes carry no address. The snack and panel show the user's own addresses on their own screen.

## 3. Tests

- **Unit, backend (`resign-in.test.ts`, scripted provider as in `network.test.ts`):**
  1. the poll doesn't sync an account that needs a sign-in (its sync count stays; the other account's grows); a network change still tries it once
  2. an op refused for a sign-in parks (attempt given back), marks the account `authRequired` with `status: "error"` and emits accounts; `ops.list` reports `awaitingAuth: true`
  3. `accounts.reconnect` (IMAP) clears `authRequired` before the sync runs (gate the sync, read the state), resumes the parked op and syncs
- **Unit, mail:** `toProviderError` (auth → `ProviderAuthError`, `UNAVAILABLE` → retryable, `NO`/`BAD` unchanged); SMTP `EAUTH` → `ProviderAuthError`.
- **Integration, IMAP (`network.int.test.ts` harness, real imapflow ↔ ImapKit):** with a refused password, `watch()` makes one login attempt and none more across several reconnect periods; a `restart()` makes exactly one more.
- **Integration, Gmail (`gmail.int.test.ts`, FakeGoogle):** `invalid_grant` → `authRequired`; `accounts.reconnect` with another Google account → `errors.googleConnectedOther`, still `authRequired`, secret unchanged; with the right one → cleared at once, the parked op runs. `connectGmailToken` with `accountId` and another mailbox's token → refused, no account created.
- **Unit, renderer (`lib/sign-in.test.ts`):** `forget` clears dismissal only for accounts that recovered; a late failure of a superseded attempt, or for an account that no longer needs a sign-in, stores no error.
- **e2e (`apps/web/e2e/resign-in.spec.ts`, backend-dev with an auth knob: the scripted registry refuses an account until it signs in; a fake `connectGmail` returns the Google account the test chooses; `openExternal` is a no-op), tagged `@design`:**
  1. one Gmail account refused: the row's marker (name, tooltip), the notice ("Personal needs a sign-in"), mail still listed and readable; "Continue with Google" → the snack, marker and notice gone, the row focused
  2. the wrong Google account: the inline error names the expected address; still needs a sign-in
  3. two accounts (Gmail + IMAP): "2 accounts need you to sign in", the panel lists both; a wrong password → inline error, the field keeps focus; the right one → that section goes, one remains, the notice reads the other's name
  4. Later hides the notice, not the marker; a recovery and a new failure bring it back
  5. a send while refused: the snack "Your message will go out once you sign in…"; its "Sign in" opens the panel; after the sign-in the message is sent
  6. keyboard: Tab reaches the marker after its row; Enter opens the panel with focus inside; Escape returns focus
  7. axe on the notice and the open panel, light and dark
  8. Settings: "Needs you to sign in again", muted; Spanish strings
  9. screenshots (light, dark): the sidebar with one and two accounts, and the open panel; baselines per design
- **Web e2e (`e2e-web/web.spec.ts`):** a web Gmail account without a token shows the notice (not the old banner).
- **Packaged smoke:** the backend changes (IMAP/SMTP classification, the poll) run in the packaged backend; `pnpm dist:mac` + `test:smoke` must stay green. No new desktop-only UI path.

## 4. Performance and resources

- Fewer network calls: an account that needs a sign-in no longer logs in every 2 minutes (poll) and every minute (IDLE).
- No timers, no polling: everything reacts to the `accounts` event. The notice reads `accounts` (already in the sidebar's store); the row marker is a sibling element, so `NavItem` render counts don't change.
- The panel (forms, Google glue) is a lazy chunk, kept out of the entry chunk; the web banner's chunk goes away.
- `pnpm test:ui-perf` and `pnpm test:perf` must stay green; no perf gate files are touched.

## 5. Out of scope

- Moving the Google Cloud app to "In production" (removes the 7-day expiry; the user's call in Google's console).
- A cancel for the desktop Google flow; native notifications; a count of the waiting actions in the panel.

## Revisions after the Codex review

Codex (read-only, against `5548ae9`) made 11 points; all were checked against the code and all are taken.

1. **SMTP precedence.** `classifySmtpError` checks numeric replies before `EAUTH`, so `EAUTH` + 535 never reached the auth branch. Now `EAUTH` comes first, except a 4xx reply (454 "temporary authentication failure" stays retryable). Tests: `EAUTH`+535, `EAUTH`+454, `EAUTH` with no code, post-DATA ambiguity unchanged.
2. **An IMAP success doesn't prove SMTP.** A send refused by SMTP on an IMAP account sets `authRequired` with `authScope: "send"`. For that scope a sync success doesn't clear it or resume the parked sends (it does clear `status`), the poll keeps syncing (incoming mail works), and only sends are held (7). The notice's second line reads "Sign in to send". A refusal by the sync itself (or any Gmail refusal) has no scope: the whole account. Signing in again clears both; if SMTP still refuses, the next send parks again (one attempt per sign-in). Test: "IMAP works, SMTP refuses".
3. **An op in flight across a sign-in.** `dropAccount` waits for the sync, not for ops. The backend keeps a per-account credential generation (memory), bumped when a sign-in stores new credentials. An op or a sync that started on an older generation and is refused doesn't park or mark the account: the op is released (attempt given back) and runs again on the new credentials; the sync counts as cut short and runs again. Test: a gated op refused after the sign-in.
4. **One Google flow per account.** A new `accounts.reconnect` for a Gmail account aborts the previous flow for it (its listener closes, its timer is cleared: `connectGmail` now clears the timer on abort too). The aborted call fails with `errors.google.cancelled`, which the renderer drops as superseded. So "Open again" can't leave two flows racing to write the secret. Test: two flows, the first aborted, only the second's token stored.
5. **A late 401 must not delete the new token.** `tokens.invalidate()` now takes the token that was refused and drops the stored one only if it's the same (web broker and desktop alike). Test: a request with the old token answered 401 after a renew keeps the new token.
6. **Queued actions mustn't knock either.** `executeOp` checks the account before dispatch: if it needs a sign-in (for a `send` scope, only sends), the op parks at once (`awaitAuth`, attempt given back, no provider call). Test: several queued ops and a new one after the first refusal: one provider call in all.
7. **No probes for a refused account.** Offline, `Connectivity` schedules a probe per account, and a non-retryable failure offline asked for another. An account waiting for a sign-in is now marked in `Connectivity` (`waitForSignIn`): no offline probe, no `probeLater`, not in "Retry now" (that's for the network). Start, a network change (`reconnectNow` syncs every account) and signing in still try it. Test: offline, the refused account has no timer.
8. **Settings' credential changes on a healthy account.** The renderer's attempt state (busy, error) is separate from the incident state (dismissed, send notice): an error is kept whenever it's the latest attempt for that account, whether or not the account needed a sign-in. Recovery clears only the incident state. Test: a wrong password typed in Settings for a healthy IMAP account shows its error.
9. **The Google popup needs the click's activation.** On the web the panel's and Settings' "Continue with Google" stay `aria-disabled` (with a spinner) until Google's script has loaded (preloaded when the panel or the account editor mounts); then the click calls Google directly. A failed load says so inline ("Couldn’t load Google sign-in (are you offline?)") with the button as retry. Settings no longer imports `web/google` during the click.
10. **Focus after success.** Focus moves to the account's row only if it was inside what disappears (the panel, the notice, the marker) or fell to `<body>`; a user who went back to the composer keeps their place. Tests: success while typing elsewhere; one section of several removed (focus goes to the next section's action).
11. **One send notice per account per incident.** Tracked in the renderer's incident state (not by snack id), reset on recovery; on recovery a queued or shown notice for that account is dismissed. Test: two parked sends → one snack; recovery → the snack goes; a new incident → a new one.

Also from reading the code for these: `errors.gmail.revoked`'s English is asserted in `core/src/localized.test.ts` (updated with the copy).

## Implementation notes

- **Commits:** the plan and its critique; the backend (`feat(backend)`); the renderer (`feat(web)`); the code review's fixes (`fix(sign-in)`).
- **The notice's copy got shorter after looking at it.** "Freelance needs you to sign in" over "New mail waits until you do" truncated in the sidebar's ~230 px (the problem plan 20's pill had), and wrapped into four lines with widows when allowed to wrap. Now: "Freelance needs a sign-in" over "Sign in to catch up" ("Sign in to send" for a refused SMTP), `text-balance`, wrapping only for a long account name. Spanish: "{name} pide iniciar sesión" / "Inicia sesión y ponte al día" / "Inicia sesión para enviar". The panel keeps the longer, reassuring sentence.
- **One more string:** `signIn.passwordRefused` ("That password didn’t work. Check it, or create a new app password."), shown over the server's own words when an IMAP login is refused; `signIn.google.loading`; `errors.waitingForSignIn` (an op parked before dispatch).
- **The panel's chunk renders at once once loaded.** `React.lazy` suspends on its first render even when the chunk was preloaded, so Base UI focused the empty popup. The notice keeps the loaded module and renders it directly (lazy only before it's in), so the first tabbable control gets focus. Focus after a success is settled one frame later, once the account's event has redrawn the panel.
- **`withdrawSnack(id)`** (snack lib): a send notice whose account signed in leaves the dock, and the queue if it waits there.
- **Checked visually** in macOS, Atelier and Lumen, light and dark: the sidebar with one and two accounts, and the open panel (one account with its password field; two with a section each). Each design's own tokens carry it (Lumen's black primary and gold focus ring, Atelier's blue on dark). Element baselines: `e2e/__screenshots__/{,lumen/,atelier/}resign-in.spec.ts/sidebar-{one,two}-{light,dark}.png`.
- **The desktop bundle** has no Google Identity Services code (the web glue stays behind the compile-time target); the panel is its own chunk (`sign-in-panel-*.js`).

## What the Codex code review changed

Codex reviewed `5548ae9..a4cf60c` and made 4 findings; each is fixed with a regression test that fails without the fix.

1. **High: an old refusal could undo a sign-in.** The generation was checked before the awaited park and mark: a sign-in landing during them resumed nothing (the op wasn't parked yet) and was then marked as needing a sign-in again. Now the generation is taken before the provider is fetched (sync and ops), every park re-checks it after its await and, if a sign-in landed, resumes instead of marking (`parkedAcrossSignIn`), and `needsSignIn` checks it before writing. Test: `resign-in.test.ts`, "a sign-in landing while an old refusal is being parked".
2. **Medium: an older Google flow could overwrite a newer token.** Ownership ended when Google answered; two answered flows both waiting on a sync's drop could both write. Ownership (either kind of sign-in) now lasts until the credentials are written, and the attempt stops (`errors.google.cancelled`) after every await once superseded. FakeGoogle now grants a distinct refresh token per consent. Test: `gmail.int.test.ts`, "two flows Google answered, both waiting on a sync".
3. **Medium: a password being typed could be emptied.** The panel switched between a single layout and a list as the count changed, remounting the field. It's one list keyed by account for any count. Test: `resign-in.spec.ts`, "another account failing or coming back while you type a password" (fails when the field remounts).
4. **Medium: Google's script failing left the button inert.** A failed load now says so inline ("Couldn’t load Google sign-in (are you offline?)") in the panel and Settings, and the button tries again. Test: `e2e-web/web.spec.ts`, "Google's script failing to load says so, and the button tries again".

**Second round** (`a4cf60c..10ef014`, the fixes only): one finding. A field shown because the panel went down to one account was not latched open, so a second failure (back to two) hid it with what was typed. It now latches as it renders. Test: `resign-in.spec.ts`, "two, then one (its field appears), type, then two again" (fails without the latch). Nothing else substantiated.

## Suite results

- `pnpm typecheck`, `pnpm lint`: pass.
- `pnpm test`: pass. Two one-off timing failures under load in untouched tests (`facts.test.ts`, `idb/ops-scale.test.ts`) passed alone (3 of 3).
- `pnpm test:e2e` (macOS, Lumen, Atelier): 880 of 880. The plan 25 spec alone: 32 of 32 in all three designs.
- `pnpm test:web`: 31 of 31.
- `pnpm test:ui-perf`: the "2 MB draft of short lines" gate fails on this machine on `main` too (interleaved runs: main 104.8 and 57.4 ms, this branch 49.7 and 54.7 ms, against 50), as plan 16 records. The "10 MB draft" autocomplete gate failed once under load and passed alone. One run had a 66.7 ms dropped frame in the sender-icons scroll gate with no long animation frame behind it; interleaved with `main` the two were the same (max 16.8 ms, 4 of 4 each). No gate file was touched.
- `pnpm dist:mac` and `pnpm --filter @terno/desktop test:smoke`: 52 of 52.
