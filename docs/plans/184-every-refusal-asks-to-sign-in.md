# Plan 184: every refusal a sign-in fixes asks for one

- **Status:** done (the owner approved the §2.0 refactor on 2026-11-11; see "Implementation notes" and "What the Codex code review changed").
- **Builds on:** `e2e69fec3` (main), plan 25 (signing in again, gently).
- **Request (verbatim):** "lets make sure whe na sign-in fails for whatever reason, for any email providern ow and in the future, we mark it somehow as needing a new signing or something also on settings, so the user can reconnect it easiliy"

## 1. What exists

Plan 25 built the whole path, and it is already provider-agnostic:

- **One signal.** A provider throws `ProviderAuthError` (`packages/mail/src/types.ts`). The backend treats it the same for every kind: the sync's catch and `tokenResult` call `AccountStatus.refuse()` (`account-status.ts`), which projects `syncState.authRequired` (with `authScope: "send"` for an SMTP-only refusal). Ops park (`awaitAuth`), the poll and IMAP push stop knocking, and `accounts.reconnect` clears it at once.
- **The UI reads only `authRequired`:** the sidebar row's key marker (`SignInMarker`), the sidebar notice (`SignInNotice`), the sign-in panel (`SignInPanel`), the account menu's "Sign In Again…" (plan 106), the parked-send snack, and Settings → Accounts' status line ("Needs you to sign in again") and its "Sign in again" button.

Who raises `ProviderAuthError` today: IMAP `authenticationFailed` (not `[UNAVAILABLE]`) and a missing password; SMTP `EAUTH` (not 4xx); Gmail `invalid_grant`, a second 401 in a row, no refresh token or no Google client; web Gmail without a live token; any keychain secret that won't open.

### The gaps

1. **Gmail without mail permission is a policy pause, not a sign-in.** A 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT` / `insufficientPermissions` / `SCOPE_INSUFFICIENT` (`googleFailureReason`, `gmail-api.ts`) settles as `"policy"`, so `AccountStatus.forbid()` pauses the account. The message itself says "…sign in again with mail permission, then choose Retry now", but no marker, notice or panel appears; only "Retry now" (which can't fix it) is offered. Google documents this reason as "the access token lacks the scope", whose remedy is a new authorization. An administrator's block is a different reason (`domainPolicy`, which stays a policy pause) and shows at consent as `admin_policy_enforced` (`errors.google.adminPolicy`, already handled).
2. **A refreshed token without the mail scope reads as a bad response.** `exchangeGmailRefresh` (`gmail-refresh.ts`) throws `invalid()` ("Gmail returned an incomplete response.", non-retryable) when Google's `scope` lacks `gmail.modify` and `mail.google.com`. With granular consent (documented by Google) a grant can lack a scope; the remedy is the same sign-in. Connect already refuses this case (`errors.google.mailScopeRequired`).
3. **Nothing makes a future provider kind supply its sign-in.** `accounts.reconnect` (`identity.ts`), `signInAgain` (`lib/sign-in.ts`), the panel and Settings branch on `kind === "imap"` and treat everything else as Gmail. A third kind would compile and offer Google's sign-in for it.
4. **Refusals are reported at three call sites, not at the provider's boundary** (found by the Codex review, checked in the code). Only the sync's catch (`core.ts` ~2148), the op worker (`needsSignIn`, ~2755) and Gmail's `tokenResult` call `status.refuse`. A `ProviderAuthError` from anywhere else is rethrown or swallowed and the account is never marked:
   - `runForAccount` (`core.ts` ~2310) rethrows: server search (`ask.ts` 447), fetched search results and folder changes. An IMAP password refused during a search, or web Gmail without a token, only fails that search.
   - IMAP push (`imap.ts` ~2714) sets a private `refusedLogin` and stops. If sync's connection is still logged in, the account stays unmarked while new mail never arrives.
   - The Sent copy (`imap.ts` ~1740) turns every `append` failure into a copy outcome, a refused login included.
   A new provider kind would have to find all of these again.
5. **In Settings the fix is behind a disclosure.** The collapsed account row says "Needs you to sign in again", but "Sign in again" is inside the account's section, under seven other rows. The Settings nav doesn't say any account needs attention.

## 2. Design

### 2.0 One boundary reports every refusal (the refactor)

The rule becomes: **a provider only throws (or reports) `ProviderAuthError`; the backend marks the account, wherever it came from.**

1. **The backend wraps the provider it creates** (`core.ts` `provider()`, ~1666): every method that returns a promise is observed. A rejection that is a `ProviderAuthError` calls one private `refused(accountId, error, { generation, life, scope })` before it propagates. The generation is read when the call starts (`credentialsOf`), so a refusal of credentials a sign-in has since replaced marks nothing (plan 25's fence, now in one place). Scope: an IMAP account's `send` → `"send"`; any other IMAP call → whole account with source `"incoming"`; Gmail → whole account (as `needsSignIn` decides today, moved here).
2. **Work a provider does on its own reports through its context.** `ProviderContext` gets `refused(error: ProviderAuthError, protocol: "incoming" | "outgoing")`, wired to the same `refused()` with the provider's generation. IMAP push calls it where it sets `refusedLogin` (and still stops knocking). The Sent copy calls it when `connection()` or the password read fails as a sign-in, then keeps its copy outcome (SMTP's acceptance is never retried, so nothing is sent twice). Gmail's `tokenResult(…, error)` becomes this same callback.
3. **The three call sites keep only what is theirs.** The sync keeps `syncAgain` and its status run's end; the op worker keeps parking (`awaitAuth`, `parkedAcrossSignIn`, `release`); both stop deciding scope or calling `refuse` themselves. `AccountStatus.refuse` is already idempotent per state (it re-publishes only on change).
4. **Why a wrapper and not more catches:** the call sites that exist today, and every future method or provider kind, get it without remembering to; the provider package stays free of account status.

### 2.1 Mail (`packages/mail`)

1. **Missing mail permission is a sign-in.** In `gmail-api.ts`'s `!res.ok` branch, a 403 on the `gmail-api` endpoint only (People and userinfo keep their own handling: an optional photo permission never stops mail), not a quota 403 (quota keeps precedence when a body carries both), whose reason is `ACCESS_TOKEN_SCOPE_INSUFFICIENT`: reports the refusal **before** the forbidden ticket is settled as `"none"` (so no sibling request is admitted in between), then throws `ProviderAuthError(errors.gmail.permissionRequired, httpResponse)` (the evidence kept, as the final 401's is). `DOMAIN_POLICY` and `SERVICE_DISABLED` are unchanged (signing in doesn't fix them).
2. **A refresh without the mail scope is a sign-in.** `exchangeGmailRefresh` throws `ProviderAuthError(errors.gmail.permissionRequired)` instead of `invalid()` for that one check.
3. **The contract is written down where a provider author reads it.** `ProviderAuthError`'s doc and `MailProvider`'s say: a refusal the user fixes by signing in again (bad or expired credentials, a revoked or under-scoped grant, an unreadable secret) must be a `ProviderAuthError`, and nothing else must be (a temporary refusal is retryable; a server or policy that signing in can't fix is a plain `ProviderError`). The backend and UI do the rest for every kind.

Copy: `errors.gmail.permissionRequired` changes from "Gmail needs mail permission. Ask your administrator to allow access or sign in again with mail permission, then choose Retry now." to **"Google’s sign-in for this account doesn’t allow mail. Sign in again and allow access to your mail."** (es: "El inicio de sesión de Google de esta cuenta no permite el correo. Vuelve a iniciar sesión y permite el acceso a tu correo.").

### 2.2 Every kind supplies its sign-in (type-checked)

`AccountKind` gets one table of how each kind signs in again, in `packages/core` (shared by backend and renderer):

```ts
export const SIGN_IN: Record<AccountKind, "password" | "google"> = { imap: "password", gmail: "google" };
```

`reconnectAccount` (backend), `signInAgain`, `canStart`, `prepareGoogle`'s callers (the notice, the marker, the account menu), `SignInPanel` and Settings' `Reconnect` switch on `SIGN_IN[account.kind]` with an exhaustive `switch` (`never` default) instead of `kind === "imap" ? … : …`. Adding a kind to `AccountKind` fails the type check until it names its sign-in, and a new method fails it until every switch handles it.

### 2.3 Settings (renderer)

1. **The action on the row.** (The panel takes an explicit place to return focus to and looks for "the next account's action" only inside itself, so in Settings focus never leaves the dialog. Its password field is read-only while a sign-in is checked, as Settings' is today.) A collapsed account row that needs a sign-in ends with a small outline "Sign in again" button (`size="sm"`, `KeyRound` at 1.15em, muted), a sibling of the accordion trigger (never inside it: no nested buttons). It opens the same popover the sidebar marker opens (`SignInPanel` for that one account, `side="bottom"`, `align="end"`), so Google's flow, the password field, busy state, inline errors and success are one component everywhere. On success the row's button disappears with the marker; focus goes to the account's row trigger (the panel's existing rule: focus returns only if it was inside what disappears).
   - The trigger's content keeps its line: the button sits outside the trigger's hover shape, vertically centred on the two-line text, with the chevron before it unchanged.
   - The status line inside the open section and its "Sign in again" stay (an open section shows the same action where its other controls are).
2. **The nav says so.** The Settings nav's "Accounts" entry ends with a muted `KeyRound` (16 px glyph rule: beside a label it's 1.15em) while any account needs a sign-in; its accessible name adds ", needs a sign-in" (one) / ", # need a sign-in" (several) via an sr-only span.
3. **Opening Settings from the sidebar notice** is unchanged (the notice opens its panel in place; Settings is the second place, not the first).

Copy (en / es): `settings.accounts.needsSignIn` "{count, plural, one {needs a sign-in} other {# need a sign-in}}" / "{count, plural, one {pide iniciar sesión} other {# piden iniciar sesión}}". The row button reuses `account.signInAgain`.

### 2.4 Not doing

- **Marking every non-network error as a sign-in.** A server outage, an admin block or Gmail disabled for the account would then offer a sign-in that cannot work. Errors are classified at their source instead (§2.1), and the Settings section still offers "Connect with Google" / "Change password…" for any account.
- **Token-endpoint errors other than `invalid_grant`** (`invalid_client`, `unauthorized_client`): RFC 6749 §5.2 describes them as problems with the app's client, not the user's grant; Google doesn't document a sign-in as their fix (memory: no undocumented provider behaviour). They stay "Couldn’t renew Gmail access (status)".

## 3. Tests

- **The boundary** (`resign-in.test.ts`, scripted provider): a refusal from a search (`runForAccount`), from IMAP push alone while sync works, and from a Sent copy after SMTP accepted (the account is marked, the message is not sent again, copy repair works after the sign-in); a refusal of replaced credentials marks nothing; an IMAP `send` refusal is send-scoped.

- **Mail unit** (`gmail-net.test.ts` / `gmail-http-evidence.test.ts`): 403 `insufficientPermissions` and `ACCESS_TOKEN_SCOPE_INSUFFICIENT` → `ProviderAuthError` with `tokenResult` called once and the forbidden ticket settled `"none"`; `domainPolicy` / `SERVICE_DISABLED` unchanged. `gmail-refresh.test.ts`: a refresh whose `scope` lacks mail → `ProviderAuthError`.
- **Scope refusal races** (`gmail-policy-admission.int.test.ts`): delayed across a sign-in (old generation never re-latches), after a sibling download failed first, scope and policy in both orders (an independent policy hold survives), a body with both scope and quota reasons (quota wins), People/userinfo 403 scope (mail unaffected), and a sibling request at the settle boundary (not admitted).
- **Backend integration** (`gmail-policy-admission.int.test.ts`): the `insufficientPermissions` cases move from "policy pause, Retry now" to "authRequired, no policy pause, queued ops parked; `accounts.reconnect` clears it and the ops run". The other reasons keep their cases. `onboarding-quota-recovery.int.test.ts` is left alone (its scope refusal is public identity inspection, `gmail-web.ts`, before any account exists).
- **Types**: the exhaustive switches are their own test (a `@ts-expect-error` fixture is not needed: `never` fails the build).
- **e2e** (`resign-in.spec.ts`, merged into an existing `scenario()`): Settings → Accounts with one refused account: the collapsed row shows "Sign in again"; it opens the panel; signing in removes it and focus lands on the row; the nav's Accounts entry has the key and its accessible name. axe light and dark on the Settings tab with the button. Screenshots light and dark in each design (element baseline of the accounts list).
- **i18n**: the type check covers en/es.

## 4. Performance and resources

No new requests, timers or listeners: a scope refusal now stops the account (sign-in required) instead of pausing it, which is the same zero-traffic state. The Settings additions read `accounts` already in the store; nothing renders outside Settings.

## 5. Out of scope

- Moving the Google Cloud app out of Testing (the weekly `invalid_grant`).
- Microsoft or other OAuth providers (§2.2 makes their sign-in a type error to forget).

## Revisions after the Codex review

Codex (read-only, against `e2e69fec3`) made 12 points; all were checked against the code and all are taken.

1. The scope rule is for the `gmail-api` endpoint only (People/userinfo 403s are photos' business). §2.1.1.
2. `runForAccount` rethrows refusals unmarked (search, fetched results, folder changes); web Gmail's missing token too. → the boundary, §2.0.
3. IMAP push swallows its refused login. → `ctx.refused`, §2.0.2.
4. The Sent copy swallows a refused login. → `ctx.refused`, outcome kept, never re-sent. §2.0.2.
5. The panel's focus rule searched the whole document and fell back to the sidebar row. → explicit return target, search scoped to the panel. §2.3.1.
6. The panel's password stayed editable while checked (Settings' was read-only). → read-only in the shared form. §2.3.1.
7. Quota keeps precedence over scope in one body. §2.1.1.
8. The refusal is published before the forbidden ticket is released. §2.1.1.
9. The scope error keeps its HTTP evidence. §2.1.1.
10. Race tests for the new branch. §3.
11. Readiness and preparation go through the sign-in table too. §2.2.
12. The onboarding test exercises public identity inspection, not this path: left unchanged. §3.

## Implementation notes

- **Commits:** the plan and critique; the boundary (`feat(backend)`: `refusals.ts`, `ProviderContext.refused`, Gmail's scope); the sign-in table (`feat(core)`); Settings (`feat(settings)`); the code review's fixes (`fix(sign-in)`).
- **The boundary is a Proxy** around what `providers.create` returns (`observeRefusals`): a method's rejection is looked at and passed on unchanged; values, getters and synchronous results pass through. `backend.provider()` returns the wrapper, so a test comparing it with the registry's object compares a property instead (`account-lifecycle.test.ts`).
- **A sync still fails when its refusal couldn't be saved** (`gmail-policy-admission`, "one failed auth persistence write"): each reported refusal keeps the account's write of it, and the sync awaits that one. Callers that only need the hold (an action, a search) don't.
- **Scope-insufficient tests moved, not dropped:** the policy-pause case that used `insufficientPermissions` uses `SERVICE_DISABLED` (still a pause); the parallel-download case expects a sign-in for it; new cases cover sign-in vs Retry now, quota precedence, a stale body after a sign-in, and the hold landing before a sibling request is admitted (checked to fail with the order reversed).
- **Settings, as built:** the row's "Sign in again" sits under the account's text at the text column (`pl-5`, the open section's inset), opens the sidebar's panel (`side="bottom"`), and hides while the section is open. The nav entry's name is set with `aria-label` ("Accounts, 1 needs a sign-in"): an sr-only span read as "Accounts , 1…".
- **Checked visually** in macOS, Lumen, Atelier, Luma and Graphite, light and dark: the row, the nav key and the open panel. Element baselines `e2e/__screenshots__/{,lumen/,atelier/,luma/,graphite/}resign-in.spec.ts/settings-row-{light,dark}.png`.
- **Not from this series:** `scan.test.ts` (hard-coded strings in `apps/site/src/parts/agents.tsx`) and `settings-pass.spec.ts` ("Allow agents to send mail", a switch plan 183 removed) fail on main from other work.

## What the Codex code review changed

Codex reviewed `3a3761ea3..a39c7f72c` and made 3 findings; each is fixed with a regression test that fails without the fix (`14291edcf`).

1. **Medium: a recheck lifting a refusal while the refused action was being parked left it parked.** The refusal is now published before the park; a saved-password recheck in between cleared it and resumed nothing, and the park's own check (`parkedAcrossSignIn`) only looks at a changed generation. After the park the action goes if the account no longer holds it. To keep that from looping, the boundary reports every refusal with its call's generation again (it had skipped one `tokenResult` already reported, possibly fenced out as stale). Test: `resign-in.test.ts`, "a recheck lifting the refusal while the refused action is still being parked" (the recheck's sync held, so only the fix lets it go).
2. **Medium: web Gmail's photos swallowed a missing token.** `collectGooglePhotos` catches the token error and carries on, so no method rejected. The broker reports it where the token is looked for (`ctx.refused`), and the context's refusals use the account's current generation (a web renewal keeps the provider; a sign-in that replaces it ends its lifetime). Test: `gmail-token-lifecycle.test.ts`.
3. **Medium: a sign-in finishing after its panel closed took focus from another panel.** Focus settles only from body or from inside its own panel. Test: `sign-in-focus.test.tsx` (two keyed popovers; fails with the old rule).

**Second round** (`14291edcf`, the fixes only): one finding. Focus that Base UI restores to the popup when a focused section goes (several accounts, one signed in) was refused by the new "inside this panel" rule, so it stayed on the popup. Focus on this panel's own popup counts as fallen too (the panel's ancestors and descendants, never another panel). Test: `sign-in-focus.test.tsx`, "a section gone with focus on its popup" (fails without it). Nothing else substantiated; review rounds stop here (memory: bounded rounds).
