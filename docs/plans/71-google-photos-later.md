# 71 · Photos from Google, on without signing in now

## Request

> allow to toggle this on without signing with google, it will just turn on whenever they connect a google account

(The screenshot: Settings → Appearance → Sender pictures, the two "Photos from Google" switches of the Gmail accounts, off.)

## What exists (plan 22)

- A new Gmail account asks Google for the two contacts scopes beside mail's, and photos come on with it (`accounts.connectGmail`, web `connectGmailWeb`).
- An existing account's switch runs Google's consent at once (`icons.googlePhotos` on: the desktop loopback flow with every scope; web `authorizeGooglePhotosWeb` then `icons.authorizeGoogle`). Turning it on means a Google window now.
- State: `settings.googlePhotos[accountId]` (presence = on), read by the icon service, the renderer and the web flow.

## Design

- **Pending, kept apart.** `AppSettings.googlePhotosPending: number[]`, the accounts whose switch is on but whose Google consent hasn't happened. `googlePhotos` keeps meaning "on", so the icon service and every other reader stay as they are.
- **Turning it on** (`icons.googlePhotos` with `later: true`, desktop and web): checks it's a Gmail account and adds it to the pending list. No window. The row's switch is on; its hint says photos come with the account's next sign-in with Google, when Google asks, and a "Sign in now" button runs today's consent for anyone who wants it now.
- **The next sign-in:** reconnecting a Gmail account (desktop `reconnectAccount`: Settings → Accounts, or after its session expired; web `connectGmailWeb` with the account) asks for the contacts scopes too when the account is pending. Whatever Google granted becomes its photo state and the people sync starts, as a new account's does. If the user unticks the boxes, the pending mark goes (no asking at every sign-in).
- **Clearing:** any write of an account's photo state (on through any flow, or off) removes it from the pending list (`setGooglePhotoState`). Turning the switch off while pending just clears it. A removed account's stale id is ignored (only listed accounts are shown).
- Not touched: the owner change flow (it isn't connecting mail).

## Tests

- Backend: on with `later` → pending, no Google call; reconnect of a pending account asks the photo scopes and saves the state, clears pending; unticked → pending cleared, no state; off while pending → cleared; a reconnect of a non-pending account asks mail scopes only.
- Web unit/e2e: the switch turns on with no consent call; its hint and "Sign in now"; off clears it.

## Out of scope

A global switch for accounts not yet added (new accounts already ask, plan 22).

## Revisions after the Codex review

Eleven points, against the code:

1. Activation finishes inside `reconnectAccount`'s own credential flow (`credentialWrite`, `assertSignIn`); nothing starts another sign-in.
2. When Google keeps the old grant (no new refresh token), the contacts scopes are proven on it (`provePhotos`), as the switch's consent does. Unproven: mail is signed in all the same, and photos keep waiting.
3. Turned off while Google's window is open: pending is read again before anything is applied (desktop in the flow, web after the popup), so a late consent turns nothing on.
4. Web: `icons.authorizeGoogle` is called only if the account still waits after the popup.
5. Re-adding an already connected mailbox on the web asks for photos anyway (the "adding" path, plan 22).
6. Scope choice and pending use live in `reconnectAccount` only; the owner change still calls `connectExistingGoogle` with mail's scopes.
7. Deferred consent with both contacts boxes unticked is off: the wait ends, no own-photo state (unlike the immediate switch, which keeps the own photo).
8. Desktop reconnect returns an account, not settings: after it, the renderer reads the settings (an empty `settings.update`) when the account was waiting, so the switch and hint update at once.
9. The icon service's own state writes (scopes or the API changed) pass `clearPending = false`: only consent, off and removal end a wait.
10. Turning it on is inert: no OAuth, People API, photo fetch or GIS load (tested). Removal clears the id. Imports don't carry it (not in `import.ts`'s list).
11. Tests: below. Web's "Sign in now" loads Google's script on pointer-enter and focus, so the popup opens in the click.

## Tests (as built)

- `icons/google.test.ts`: `later` asks and fetches nothing; the next reconnect asks the contacts scopes and turns photos on; unticked ends the wait; a non-waiting account signs in with mail's scopes only; off and removal clear it; the service's writes don't; IMAP is refused.
- `google-photos-later.spec.ts` (`@design`, light and dark): the switch turns on with no popup or Google request, the hint and "Sign in now", axe, and off clears it.

## What the code review changed

Codex found five problems; each now has a test that fails without the fix.

1. **Hovering or focusing "Sign in now" (web) loaded Google's script**, reaching Google before the user chose to sign in. The preload is gone: the click loads it, as the switch always did (`google-pending.test.tsx`).
2. **A late web consent could turn photos back on after off.** The web's sign-in passes `ifPending`, and `icons.authorizeGoogle` reads the wait again before turning anything on (`google.test.ts`).
3. **Off cancelled a reconnect under way** (off starts its own sign-in flow, which supersedes). A reconnect asking for photos marks its flow (`photoReconnects`); off during it only ends the wait, and the reconnect, reading it again, turns nothing on. The check is synchronous: anything else supersedes older flows exactly as before (the renewal suite's ordering tests rely on it, and a first attempt that read settings first broke one under IndexedDB).
4. **Web Add account reaching a waiting mailbox and declining the contacts** left it waiting. The wait is read for the account the sign-in returns (`google-pending.test.tsx`).
5. **The reconnect answered before the people were listed**, so a People API that was off never showed. The listing runs inside the flow, as the switch's consent does (`google.test.ts`).

### Round 2

Three races, all "switched off at some moment": each has a test that fails without the fix (the reconnect ones in `explicit-renewal.test.ts`, under SQLite and IndexedDB).

1. **Off during the reconnect's photo proof** (Google kept the old grant) was undone when the proof came back.
2. **Off while the reconnect listed the people** cleared an already-empty wait and left photos on.
3. **Web Add account for a waiting mailbox, switched off with the popup open**, sent the consent without `ifPending`.

Fixes: a sign-in's consent turns photos on through `consumeGooglePhotosPending`, which reads the wait and writes the state in one settings transaction, so an earlier off always wins (the desktop reconnect and `icons.authorizeGoogle` with `ifPending` both use it). Off during a reconnect asking for photos now writes them off and drops their photos, wherever that reconnect has got to. The web remembers which accounts waited before Google's popup and sends `ifPending` for those, Add account included.
