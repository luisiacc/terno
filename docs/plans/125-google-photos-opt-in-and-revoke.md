# 125: Contacts asked only for photos, and Remove account withdraws Google's grant

## Request (verbatim)

> yes

That was the reply to plan 124's two follow-ups: "Ask for the contacts permission only when the user turns on photos. Today a new Gmail account asks for it at sign-up, which reviewers tend to flag" and "Withdraw Terno's access at Google when an account is removed. Today the policy tells users to do that by hand."

## What exists

- `accounts.connectGmail` (`packages/backend/src/handlers.ts:921`) asks a new account for `GMAIL_SCOPES` plus `PHOTO_SCOPES` (contacts and other contacts) and turns photos on with whatever the user granted. The web's `connectGmailWeb` (`apps/web/src/web/google.ts:110-126`) does the same when `adding`.
- Photos have their own opt-in already (plans 22 and 74):
  - the Settings → Appearance switch (`icons.googlePhotos`) runs Google's consent for mail and contacts on desktop, or `authorizeGooglePhotosWeb` on the web;
  - "later" (`googlePhotosPending`) waits for the account's next sign-in, which then asks for them (`identity.ts:238`).
- `accounts.remove` deletes the account's rows and its `account:<id>:*` secrets, but Google keeps the grant. On the web, the access token lives only in the worker's memory (`gmail-web.ts`), and `accountRemoved` forgets it.

## Design

### 1. Contacts only when photos are turned on

- Desktop: `accounts.connectGmail` asks for `GMAIL_SCOPES` only. The `photoStateFrom(result.grantedScopes)` block goes: a new account starts with photos off.
- Web: `connectGmailWeb` asks for the photo scopes only while the account waits for them (`pending`); `adding` no longer adds them.
- Turning photos on is unchanged: the switch, or "later" with the next sign-in.

### 2. Removing a Gmail account withdraws Terno's grant

- `@terno/mail`: `revokeGoogleToken(token, fetch, signal)` POSTs `token=<token>` (form-encoded) to `https://oauth2.googleapis.com/revoke`.
  - 200 → `"revoked"`. A 400 `invalid_token` → `"revoked"` too: the grant was already gone.
  - Anything else, including a network error or the timeout → `"failed"`.
- `accounts.remove` on a Gmail account:
  - **Before** removing, it reads the token it can revoke: on desktop the refresh token (`getSecret`); on the web the broker's live access token (new optional `GmailTokenBroker.current(accountId)`). An unreadable secret means no token.
  - It removes locally exactly as today. The local removal never waits on Google and never fails because of it.
  - **After** the rows are gone, it revokes with a 5 s timeout through `b.net.fetchFor("mail")`. It doesn't try when offline (`connectivity.online` false) or when there's no token: then `"failed"`.
  - The result gains `google?: "revoked" | "failed"`, absent for IMAP.
- Revoking a Google grant withdraws Terno's access for that Google account everywhere: Terno on another computer, signed in to the same account with the same client, has to sign in again. The dialog says so.
- **UI** (`account-remove-dialog.tsx`):
  - For a Gmail account the description adds "Terno’s access to your Google Account is withdrawn too, so Terno on another computer will need to connect it again."
  - `"failed"` shows a warning snack in place of "Account removed": "Account removed. Terno couldn’t reach Google to withdraw its access: remove Terno at myaccount.google.com/permissions."
  - New strings go in `en` and `es`.
- **Privacy page** (plan 124): the Google section and "Removing your data" say removal withdraws the grant, with the manual page as the fallback, and that contacts are asked only when photos are turned on.

## Tests

- `revokeGoogleToken`: 200, 400 `invalid_token`, 503 and a network error. The body is form-encoded and the token never goes in the URL.
- Backend: `accounts.connectGmail` asks without the contacts scopes and doesn't turn photos on. `accounts.remove` on a Gmail account:
  - revokes the stored refresh token after the rows are gone;
  - a revoke failure still removes the account and answers `google: "failed"`;
  - offline doesn't fetch;
  - an IMAP account never revokes.
- Web unit (google.ts): adding asks for `GMAIL_SCOPES` only; a pending account still asks for photos.
- e2e: the remove dialog shows the Google line for a Gmail account and not for IMAP.

## Perf and resources

One request per removed Gmail account, bounded at 5 s; nothing on any hot path.

## Out of scope

- Narrowing an existing grant when photos are turned off. Google has no per-scope revoke, and revoking everything would sign the mail out.
- A choice to keep the grant (multi-Mac users): if anyone asks, a checkbox in the dialog.

## Revisions after the Codex review

Codex critiqued the plan in 12 points. These replace the sections above where they differ:

1. **Revoking is project-wide.** Google withdraws the user's authorization for every client in the Cloud project, so desktop dev, desktop prod and the web all lose it. The dialog says so: "anywhere else Terno uses this account (another computer, the browser) will need to connect it again".
2. **The web doesn't revoke.** Google's revoke endpoint has no CORS, so the worker couldn't read the answer. The web registry has no `revokeGoogle`, and the broker gained no `current()`. The web dialog tells the user to remove Terno at myaccount.google.com/permissions instead.
3. **The token is read after `dropAccount`.** That fence ends the account's sign-ins and renewals and drains their writes, so nothing replaces the token after it's read.
4. Removal during a consent or renewal could leave a just-issued token uncommitted. That token still dies with the grant, since revocation is grant-wide. A rotated stored token that comes back `invalid_token` is reported as unconfirmed (see 7).
5. and 6. **A late revoke would end a re-add's new grant.** A desktop `accounts.connectGmail` now waits for any revoke still in flight (`revokesSettled`, at most 5 s) before opening Google's consent.
7. **Only a 200 confirms.** `invalid_token` means expired *or* revoked, so it counts as `"failed"`. The snack says Google *didn't confirm*, not that Terno couldn't reach it.
8. **`include_granted_scopes` can return an older contacts grant.** Add account never turns photos on, whatever Google returns. A waiting mailbox that Add account reaches keeps waiting for its own sign-in instead of being read as "declined".
9. **Demo accounts never revoke.** Neither do registries without `revokeGoogle` (tests, demo, a synthetic Google with moved endpoints).
10. **The dialog has full descriptions for Gmail,** so "nothing changes on the server" and "access withdrawn" never sit side by side. The owner line is appended separately.
11. **The local removal still answers after the revoke.** The revoke takes 5 s at most, and offline is decided at once. The snack is short: "Account removed. Google didn't confirm Terno lost access." with a "Check at Google" button.
12. **The transport is bounded:**
    - `redirect: "error"`, so the token is never forwarded;
    - the body is never read, only cancelled;
    - a race against the signal for a fetch that ignores it;
    - tests for each.

Also fixed on the way: plan 124's `sections([…])` helper hid the site's copy from the i18n scanner's catalog check (`scan.test.ts`). The sections' type is inferred again.

## What the Codex code review changed

Codex reviewed `a0deacdb` and raised 2 points, both fixed with regression tests:

1. **The backend's `fetchFor` followed redirects itself** and ignored the caller's `redirect: "error"`, so a cross-origin 307 could carry the token in the form body to another host. `fetchFor` now honors `redirect: "error"` on every hop, in Node and the browser (`net-policy.test.ts`: "a request that refuses redirects gets none"; it fails without the fix).
2. **The re-add barrier started only with the revoke,** after the local cleanup and the account events. Now:
   - it starts at the removal's first step (`beginGoogleRemoval`);
   - a desktop sign-in whose consent was already open when a removal of the same address began is refused with "{email} was removed while you were signing in…", because the revoke ended the grant it made;
   - other addresses are unaffected.

   Tests: "waits for a removal still running, from its first step…" and "a sign-in whose consent was open… is refused".
