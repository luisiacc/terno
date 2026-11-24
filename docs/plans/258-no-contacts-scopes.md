# Plan 258: no contacts permissions, and no Photos from Google

## Request

> ok i removed them, lets also remove them from the code and remove the 'photos from google' thing then

Google's OAuth verification (plan 124) rejected the two contacts scopes: the demo video couldn't show them doing anything, because the mailbox has no sender with a contacts photo. The owner removed `https://www.googleapis.com/auth/contacts.readonly` and `https://www.googleapis.com/auth/contacts.other.readonly` from the Cloud Console. Terno must now ask Google for exactly `openid email profile https://www.googleapis.com/auth/gmail.modify`, in every build, and the feature built on the contacts scopes (plans 22 §6, 74 and part of 125) goes.

## What exists

- **Scopes.** `GMAIL_SCOPES` (`packages/mail/src/gmail-api.ts:31`) is the four. `connectGmail` (`gmail.ts`) takes an optional `scopes` list; `connectExistingGoogle` (`identity.ts`) passes one through. `CONTACTS_SCOPE` and `OTHER_CONTACTS_SCOPE` live in `google-photos.ts`. The web copies both lists (`apps/web/src/web/google.ts`: `GMAIL_SCOPES`, `PHOTO_SCOPES`) and asks with `include_granted_scopes: true`.
- **Turning photos on** (plan 22, 74):
  - Settings → Appearance → Sender pictures has a "Photos from Google" row per Gmail account (`sender-pictures.tsx`): a switch (`icons.googlePhotos`, `later: true` marks the account pending) and "Sign in now" (desktop: `icons.googlePhotos` on, a full consent with the contacts scopes, `icons/google.ts`; web: `authorizeGooglePhotosWeb` then `icons.authorizeGoogle`).
  - A pending account's next sign-in asks for the contacts scopes too: desktop `reconnectAccount` (`identity.ts`, `photoReconnects`, `provePhotos` on a kept grant, `consumeGooglePhotosPending`), web `connectGmailWeb` plus the renderer's settings re-read in `lib/sign-in.ts`.
  - `GmailRenewalProof.provePhotos` (`gmail-renewal.ts`) proves the contacts scopes on a kept grant through the People API.
- **State.** `AppSettings.googlePhotos` (per account `GooglePhotoState`) and `googlePhotosPending`, written by `settings.ts`'s `setGooglePhotoState`, `consumeGooglePhotosPending`, `setGooglePhotosPending`; `accounts.remove` clears them (plan 22).
- **Listing and showing.** `MailProvider.photos` (`gmail-api.ts`) runs `collectGooglePhotos`: the userinfo `picture` (the account's own picture) and the People API lists. The icon service (`icons/service.ts`) keeps them in memory and in `<db>.icons-people.json`, fetches the images from `googleusercontent.com` as `p:` cache keys, and answers `IconRef { kind: "photo" }`. The renderer draws a photo full-bleed (`sender-avatar.tsx`), and plan 158's `person` rule shows a person their photo or initials, never a site icon (`iconStandsFor`). Freemail senders and addresses with no usable domain are `photo-only` (`icons/domain.ts`).
- **The account's own picture comes only through this feature.** It is read by `collectGooglePhotos`, which runs only for an account in `settings.googlePhotos`. Sign-in reads userinfo for identity (`sub`, `email`) but keeps no picture.
- **Elsewhere.** The HTTP request contexts `google-people` (`photos`, `grant-proof`) and `google-userinfo`/`photos`; the cooldown store's `COOLDOWN_SERVICES` includes `"google-people"` and refuses a stored ledger row whose service it doesn't know (`packages/store/src/provider-cooldown.ts:70`). The Add account dialog re-reads settings after a desktop sign-up "because photos came on with the account". The site's privacy policy describes Photos from Google and the contacts permission (plan 124's test pins that wording).

## Design

### 1. One list of scopes

- `GMAIL_SCOPES` is the only list Terno ever asks Google for. `connectGmail` loses its `scopes` option and always asks for it; `connectExistingGoogle` loses its `scopes` parameter. The web's `accessToken` loses its `scopes` and `photo` parameters and asks for its `GMAIL_SCOPES`.
- The web stops sending `include_granted_scopes`: it existed so a photos grant carried over (plan 22), and with it a token could still name a contacts grant made before this plan.
- **Pinned by a test** (`packages/mail/src/google-scopes.test.ts`): `GMAIL_SCOPES` is exactly the four; the desktop consent URL's `scope` is exactly those; and a scan of the shipped source (`apps/*/src`, `packages/*/src`, tests and the site excluded) finds no `https://www.googleapis.com/auth/` URL other than `gmail.modify`. The web's own list is pinned in `apps/web/src/web/google.test.ts` (the token client is created with exactly those scopes and no `include_granted_scopes`).

### 2. Photos from Google removed

- **`@terno/mail`:** `google-photos.ts` and its test go, with `MailProvider.photos`, `GmailRenewalProof.provePhotos` and the `google-people` request context and userinfo's `photos` purpose. The `"google-people"` string stays in the cooldown store's `COOLDOWN_SERVICES` with a comment: a ledger written before this plan may hold a row for it, and an unknown service makes the whole ledger fail to decode. Nothing requests it any more.
- **Backend:** `icons/google.ts` and its test go, with `icons.googlePhotos` and `icons.authorizeGoogle` (contract and handlers). `reconnectAccount` loses the photos branch (`photoReconnects`, the pending check, the proof, the state write). `accounts.remove` no longer clears photo state. `settings.ts` loses `readGooglePhotos`, `setGooglePhotoState`, `consumeGooglePhotosPending`, `setGooglePhotosPending`, `googlePhotosPending` and the two defaults.
- **Icon service:** website icons only. The people map, its file, the listing, `photoFetch`, `fetchPhoto`, `syncPeople`, `dropPhotos`, `googlePhotos` and `setGooglePhotoState` options go. `IconRef` loses `kind` (every icon is a website's). `iconSubject` answers null where it answered `photo-only` (freemail, no usable domain), so those senders get initials, as they did without photos. Turning website icons off now means no source at all: lookups answer null at once, as they did with both off.
- **Renderer:**
  - Settings → Appearance → Sender pictures keeps "Website icons" and "Forget saved icons"; the per-account rows go, and so does their settings-search entry (`appearance.googlePhotos`).
  - `iconsEnabled` is the website-icons switch on a host that can fetch them.
  - `SenderAvatar` mounts its icon layer only when the avatar isn't a person's (`icon && !person`): plan 158's rule was "their photo or their initials", and with no photo a person's avatar has nothing to look up. `iconStandsFor` goes, and so do the photo branches in `SenderIcon` (full-bleed `object-cover`) and in the byte loader (every icon is measured, plan 252).
  - `lib/sign-in.ts` and `add-account-dialog.tsx` drop their photo-driven settings re-reads; `web/google.ts` drops `PHOTO_SCOPES`, `authorizeGooglePhotosWeb` and the pending logic in `connectGmailWeb`.
- **i18n:** the `settings.appearance.googlePhotos*` keys and `errors.icons.notGmail` / `errors.icons.mailScopeLost` go from `en` and `es`, with any other key only this feature used. The Sender pictures footer and the website-icons hint are checked for wording that names photos.

### 3. The account's own picture

It was only reachable through Photos from Google (§ What exists), and it goes with it. Keeping it would mean a new piece: storing the userinfo `picture` at sign-in (or listing it per account on a timer) and fetching it from Google's image host, gated by a new rule since the old switch is gone. That is a feature of its own, not part of a removal; it's listed for the owner below. The account's avatar shows its initials, as every person's now does.

### 4. Leftover data (no users yet: harmless, not migrated)

- **Settings:** `googlePhotos` and `googlePhotosPending` stay in a stored `settings.app` if they were ever written. `StoredSettings` names them as retired and `readStoredSettings` drops them (the `gmailClientId` idiom, plan 123), so they never reach the renderer, an export or a gate.
- **`<db>.icons-people.json`** (contacts' addresses and photo URLs) is no longer read or written. It is left on disk: no users yet, and a deletion would be code kept forever for nobody. The owner's own test profiles can delete it by hand.
- **Cached `p:` photo bytes** are never looked up again; the cache's own bounds (32 MB, 4,000 entries, LRU) evict them, and "Forget saved icons" clears them.
- **The cooldown ledger:** see §2.
- No SQLite or IndexedDB change: nothing of this lived in either.

### 5. Site and docs

- **Privacy policy** (`apps/site/src/copy/en.ts`, `es.ts`): the "Photos from Google" item and the contacts permission go; the profile item says the picture isn't used ("to identify the account in Terno; Terno uses your name and address"); "your contacts" in the on-your-computer section becomes wording that doesn't suggest Google contacts. The updated date moves to November 24, 2026. `render.test.ts` pins the new wording and that no "contacts" permission, "People API" or "Photos from Google" appears.
- **Plan 124:** a dated note: the contacts scopes were dropped (Google's verification rejected them: the demo couldn't show them doing anything), the Data Access list is now the four, and the demo's contacts step (step 3) is gone.
- **Plans 22, 74, 125:** a one-line note at the top that plan 258 removed Photos from Google (and, for 125, that §1 no longer applies).

## Tests

- New: `google-scopes.test.ts` (§1); `google.test.ts` (web) pins the token client's scopes and the absence of `include_granted_scopes`.
- `gmail-auth.test.ts`: the "exact requested custom scopes" case uses the default list (the option is gone).
- Settings: a stored `settings.app` holding `googlePhotos` and `googlePhotosPending` reads back without them (`settings-edits.test.ts` or the settings unit file that already covers retired keys).
- Icon service (`service.test.ts`): a freemail sender answers null with website icons on, and nothing is fetched for it; with website icons off nothing is fetched at all (existing).
- Renderer: `SenderAvatar` with `person` mounts no icon layer (unit, beside `sender-icons-person.test.ts`, which goes).
- Removed with the code: `google-photos.test.ts`, `icons/google.test.ts`, `google-photos-later.spec.ts`, `google-pending.test.tsx`, the photo cases in `explicit-renewal.test.ts`, `gmail-renewal.test.ts`, `gmail-http-evidence.test.ts`, `gmail-cooldown.int.test.ts` and the web `google.test.ts`.
- Run: typecheck, lint, the unit files touched, `pnpm --filter @terno/site test`, and the e2e specs for Settings → Appearance and icons (`icons.spec.ts`, `settings-search.spec.ts`).

## Perf and resources

Less work: no People API listing, no people file, no photo downloads, and person avatars stop looking anything up (fewer `icons.lookup` entries per frame). The `icons` perf assertions (`perf.spec.ts`'s SenderIcon renders) are checked against rows whose senders are companies.

## Out of scope

- Showing the account's own Google picture without the setting (§3).
- Deleting `<db>.icons-people.json` and old `p:` cache entries (§4).
- Narrowing grants users already gave: Google has no per-scope revoke; a removed account's grant is still revoked whole (plan 125).

## Revisions after the Codex review

Codex critiqued the plan in 12 points. These replace the sections above where they differ:

1. **The web sets `include_granted_scopes: false`.** Leaving it out isn't enough: Google's default is `true`, which would carry an older contacts grant into a new token. `google.test.ts` checks `false` for Add account and for a reconnect.
2. **One list, pinned rather than shared.** The web keeps its own four-item copy (importing `@terno/mail` into the renderer for one constant would drag the mail package into every window's bundle); `google.test.ts` compares it with `GMAIL_SCOPES`, and `google-scopes.test.ts` scans every shipped source for any other `googleapis.com/auth/` permission. The desktop Add account no longer passes `scopes` (the option is gone).
3. **An older grant that still carries contacts.** Reconnect and Change owner may keep the stored grant when Google sends no new refresh token; Terno can't narrow it (Google has no per-scope revoke) and never uses its contacts part. Decided: left as is, and said in plan 124's update (the user can remove Terno at Google, or remove the account, which revokes the whole grant).
4. **The people file goes.** It holds the contacts' addresses and photo URLs in plain JSON, and account removal no longer cleans it. `IconService.forgetGooglePhotos()` removes `<db>.icons-people.json` at each backend start (one removal of a missing file afterwards), on both hosts through `PlatformFiles` (`service.test.ts`). This replaces §4's "left on disk".
5. **Old photos are dropped, not left for the LRU.** `icons.data` would still serve a `p:` id, and the LRU never deletes slot files. The cache now keeps website icons only: at its first read, any `p:` entry leaves the index and its slot file is removed, before any later write can reuse the slot (`cache.test.ts`). This replaces §4's "evicted by the cache's bounds".
6. **Retired cooldown rows are dropped at decode.** `"google-people"` leaves `COOLDOWN_SERVICES` for a `RETIRED_SERVICES` list: a stored row for it still validates (the ledger doesn't fail to read), and `decodeCooldown` returns the ledger without it, so startup and the wake scheduler never see it (`provider-cooldown.test.ts`: a ledger with both rows keeps Gmail's cooldown exactly).
7. **The renewal validator** no longer requires `provePhotos` (done with the removal; the cold-proof tests for reconnect and Change owner stay).
8. **Mail's own 403 reasons** move into `gmail-api.ts` (`GmailFailureReason`), and the provider's photo path (userinfo and People URLs) goes; sign-in's own userinfo request (`identity-proof`) stays.
9. **Tests the plan missed:** `google-connection.test.ts`, `gmail-policy-admission.int.test.ts`, `gmail-token-lifecycle.test.ts`, `gmail-transport.test.ts`, `provider-http.test.ts`, `provider-cooldown-store.int.test.ts` and `gmail-cooldown.int.test.ts`. Generic cases move to `identity-proof`; photo-only cases go. In `explicit-renewal.test.ts`, "photos off" was the newer sign-in flow that superseded an older one; a declined reconnect (`supersede()`) now plays that part.
10. **More tests:** `domain.test.ts` (`iconDomain` answers null for freemail), `service.test.ts`, `sender-icons.test.ts` (the replacement case uses a refreshed website icon), the typed settings fixtures, and `settings-search.spec.ts`'s photos scenario (deleted: the i18n key and the search entry are gone, and the type check rejects either coming back).
11. **Copy that still promised photos:** `docs/FEATURES.md`, the settings-search synonyms ("profile pictures" → "company icons", es "fotos de perfil" → "iconos de empresas"), and plan 124's demo step 4.
12. **UI gates.** Thread rows and the reader look the same as before in every e2e fixture: a person's avatar was already initials there (plan 158 never showed them a site's icon, and the stub has no Google photos), and company rows keep their icons, so `perf.spec.ts`'s positive `SenderIcon` count holds. The one visible change is Settings → Appearance losing the per-account rows: checked in light and dark screenshots; not a main screen in `docs/ui-rating.md`, so no `ui:rate`.

## What the Codex code review changed

Codex reviewed `680c7f48d..88a790347` and raised 8 points, all fixed; each behaviour has a test that fails without the fix.

1. and 2. **The photo bytes could outlive the cleanup.** The cache dropped `p:` slots only when something loaded it, which never happens on the web or with website icons off. It also missed a photo the LRU had already dropped from the index (its slot file stays), and a failed removal lost the pointer to retry. Now `IconService.forgetGooglePhotos()` runs at every start on both hosts. While the contacts' list (`<db>.icons-people.json`) exists, it calls `IconCache.sweep()`, which removes every slot file no website icon holds and writes the index without the `p:` entries, and it removes the list only after the sweep succeeds. A failure keeps the list, and the next start tries again. Loading still never serves a `p:` entry, and an index of photo misses only is rewritten too. Tests: `cache.test.ts` (an evicted photo's file, a misses-only index) and `service.test.ts` (start with website icons off and no transport; a failed sweep is retried).
3. **`sync-failure-detail.test.ts`** expected a People API route the diagnostics no longer know; it uses the userinfo URL now.
4. **Plan 124's update** said removing the account revokes the grant. On the desktop, removal tries to revoke it and says so if Google doesn't confirm (plan 125); the web never revokes. The update now says that.
5. **A reconnect with plan 74's leftover wait** (`googlePhotosPending` still stored) asks Google for mail's scopes only, and the stored key never reaches the renderer (`explicit-renewal.test.ts`).
6. **The Gmail API helper** still took absolute URLs (the People API's and userinfo's) under the mail token, unpaced. It now takes Gmail paths only, and `gmailUnits` loses the absolute-URL case.
7. **`sender-icons.test.ts`** still had a `p:` answer; the offscreen-replacement case uses a refreshed website icon.
8. **The home page** still said Terno keeps "your contacts". It now says "the addresses you write to" (es: "las direcciones con las que te escribes"), and Midnight's map labels them "Addresses" / "Direcciones".
