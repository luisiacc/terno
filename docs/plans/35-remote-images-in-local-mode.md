# Plan 35: remote images in local mode

- **Status:** proposed.
- **Builds on:** `6403163` (main after plan 34).
- **Request (verbatim):** "the meaning of local is too local, we should be able to load remote images by default with the setting, and it should not block the 'load remove content' button."

## 1. What it means

Local mode stops governing remote images in mail. In local mode:

- **"Always load remote images"** works: the switch is live, and its hint no longer says local mode blocks them.
- The reader's per-message **"Load content"** button works. Today local mode swaps it for a popover that only explains and points to Settings.

Defaults stay: `remoteImages` is `"ask"` and `localMode` is on for new installs. Everything else local mode means (no cloud AI, website icons off until turned on, automatic update checks off, no error reports, the backend's network policy) is unchanged.

**The new meaning of local mode:** Terno talks to the user's mail servers (and AI on this Mac), plus what the user explicitly asks for: remote images they load (per message, or with the setting), website icons they turned on (plan 22), an update check they started (plan 11). Plans 11 and 22 already set this precedent of "an explicit choice", and principle 4 admits network that "explicit choices need".

## 2. What exists

- `apps/web/src/lib/remote-consent.ts`: `remoteAllowed(id, { remoteImages, localMode }, allowed)` returns `!localMode && (always || allowed.has(id))`. The reader (`HtmlBody`) and printing (`print-sheet.tsx` `printMessages`) both use it, so a print never loads what the reader didn't.
- `apps/web/src/components/mail-body.tsx`:
  - `HtmlBody` builds the srcdoc iframe (`sandbox="allow-same-origin allow-popups"`, no scripts) with `csp(allowRemote)`: `img-src data: cid:` plus `https: http:` when allowed (also `style-src`/`font-src`, but see below).
  - `RemoteBlocked` shows "Remote content blocked by local mode." and a `remote-why` popover ("Load content…" → explanation + Open Settings) instead of `remote-load`.
- The app's own CSP is inherited by the srcdoc frame: desktop `app://` (`app.ts` `CSP`) has `img-src … https: http:` but `style-src 'self' 'unsafe-inline'` and `font-src 'self' data:`; the web (`vite.config.ts` `WEB_CSP`) has `img-src … https:` and the same style/font limits. **So a mail can only ever load remote images**; remote stylesheets and fonts are refused by the parent policy in both builds.
- `settings/general-tab.tsx`: `remote-images-switch` is `disabled={settings.localMode}`, checked only when local mode is off, hint `settings.general.remoteImages.local` in local mode.
- `settings-dialog.tsx`: the "Turn off local mode?" confirmation lists `settings.localOff.cloudAi` and `settings.localOff.remoteImages`.
- `print-sheet.tsx`: in local mode the blocked-images note is `print.note.remoteLocal`.
- **Desktop main, two fences:**
  - `app.ts` `installNetworkBackstop()`: `defaultSession.webRequest.onBeforeRequest` on http(s)/ws(s) cancels everything non-loopback while `localMode` (fail closed: true until the backend's first `policy` message).
  - `print.ts` + `print-policy.ts` `requestAllowed(req, job, localMode)`: the print window's partition loads its job's document, and outside local mode the job's `remote` list (images the renderer kept from approved messages) as `image` requests only. `printLocalModeChanged` stops a loading print window when local mode turns on.
- **Web build:** no main process. The fence is the iframe CSP plus `WEB_CSP`; nothing else reads `localMode` for images (the service worker only precaches the build).
- **Settings migration/import** (`packages/backend/src/settings.ts`, `import.ts`): `migrateAppearance` is the pattern for a pure read-time migration persisted on the next write. Import copies `remoteImages` as is (the other privacy settings only ever tighten: "a file never makes this install less private").
- **Tests that encode the old rule:** `remote-consent.test.ts`; `e2e/local-ai.spec.ts` ("local mode blocks remote images … with no way to load them"); `e2e/print.spec.ts` ("… local mode never"); `print-policy.test.ts`; the packaged smokes `print.smoke.ts` ("main enforces local mode on the print window") and `packaged.smoke.ts` (main cancels a main-frame remote `<img>`; still true after this plan). Visual baselines showing the reader's remote row in local mode (the e2e profile is in local mode): `visual.spec.ts` `reader-html`, the `@design` reader shots, `themes.spec.ts` readers.
- **Docs that define local mode:** `AGENTS.md` (Non-negotiables), `README.md`, `docs/PLAN.md`, plan 05 §B (the "show images button is hidden" rule), plan 09 §9.1, plan 10 §1, plan 22 §1.

## 3. Design

### 3.1 Consent (renderer)

`remoteAllowed(id, { remoteImages }, allowed) = remoteImages === "always" || allowed.has(id)`. The `localMode` parameter goes; `HtmlBody`, `reader.tsx` and `print-sheet.tsx` stop passing it. The per-message set stays session-only, as now.

### 3.2 Reader

`RemoteBlocked` always renders "Remote content blocked to protect your privacy." with the **Load content** button (`remote-load`). The local-mode branch, the popover, and the `localMode` prop go.

### 3.3 Settings

- The switch is enabled in both modes and shows `remoteImages === "always"`. Hint: `settings.general.remoteImages.hint` in both modes.
- **One-time migration (privacy):** a profile in local mode that stored `remoteImages: "always"` (set while connected, then local mode turned on) saw the switch off and no images. Without care it would start loading every image after this update. A pure read-time migration, `migrateRemoteImages` (beside `migrateAppearance`, with a `remoteImagesVersion: 1` marker persisted on the next write), reads `"always"` as `"ask"` when local mode is on and the marker is absent. Connected profiles keep `"always"`. New installs never had it.
- **Import:** `remoteImages` leaves the free-copy list. A file can turn it to `"ask"`, never to `"always"` (the same rule as `senderIcons` and `allowAgentSend`).

### 3.4 Desktop backstop (`app.ts`)

Two options were considered:

- **(a)** In local mode, let through only `resourceType === "image"` requests whose requesting frame is a **mail frame**: a direct child of the window's top frame, on `about:srcdoc`, whose top frame is the app's own page (`app://terno/`, or the dev URL). The per-message gate is the iframe CSP, which the renderer already builds from `remoteAllowed`.
- **(b)** The renderer tells main which messages or URLs it approved.

**Chosen: (a).** (b) adds IPC and state, and still trusts the renderer: whatever a compromised renderer can do to the CSP, it can do to the list. A URL allowlist would also break images that redirect (most tracking-wrapped newsletter images do), unless main followed redirect chains per frame. (a) keeps main's fence meaningful against everything the backstop was for: the app's own frame, scripts, XHR/fetch, websockets, stylesheets, fonts, media, pings and CSP reports from anywhere, and any image outside a mail frame stay cancelled in local mode. A frame main can't identify (navigated or destroyed: `details.frame` null) is cancelled.

The decision moves into a pure module, `apps/desktop/src/network-backstop.ts`:

```ts
export interface RequestFrame { url: string; parentIsTop: boolean; topUrl: string }
export function backstopAllows(req: { url: string; resourceType: string; frame: RequestFrame | null }, o: { localMode: boolean; appOrigins: readonly string[] }): boolean
```

Rules: an unparsable URL → cancel. Loopback → allow. Not local mode → allow. Local mode → allow only `image` from a mail frame. `isLoopbackHost` moves there too. `app.ts` maps `details.frame` (`url`, `parent`, `top`, compared by `frameTreeNodeId`) into `RequestFrame`.

The print preview iframe in the renderer is also a srcdoc child of the app page. It holds only approved messages' images (the print builder strips the rest, and its CSP opens `img-src` only when some message is allowed), which is exactly what printing should load.

### 3.5 Print window (`print-policy.ts`, `print.ts`)

`requestAllowed(req, job)` loses its `localMode` argument: the document, then `image` requests for URLs in the job's `remote` list, whatever the mode. The list is still exactly the images of messages approved in the reader. `PrintDeps.localMode` and `printLocalModeChanged` go (local mode turning on no longer changes what a print may load).

### 3.6 Copy (`en` and `es` together)

Deleted (unused after the change): `reader.remote.blockedLocal`, `reader.remote.loadMore`, `reader.remote.why`, `reader.remote.openSettings`, `settings.general.remoteImages.local`, `settings.localOff.remoteImages`, `print.note.remoteLocal`.

Rewritten so the local-mode promise stays exact:

| key | en |
|---|---|
| `settings.general.localMode.hint` | Nothing leaves this Mac except mail with your servers and the remote images you load. AI can only use models on this Mac. |
| `settings.general.localMode.hintIcons` | Nothing leaves this Mac except mail with your servers, the remote images you load, and the website icons you turned on (Appearance). AI can only use models on this Mac. |
| `settings.general.localMode.hintWeb` | Terno only connects to Google (your mail) and to AI on this computer (localhost), plus the remote images you load. In a browser it can’t pin DNS addresses or control other tabs or extensions. |
| `firstRun.local.desktop` | Nothing leaves this Mac except mail with your servers and the remote images you load. AI uses models on this Mac. |
| `firstRun.local.web` | Terno only connects to Google (your mail) and to AI on this computer, plus the remote images you load. |
| `firstRun.connected.body` | You can also use cloud AI (Claude, OpenAI…) with your own API key. |
| `sidebar.localTip.desktop` | Nothing leaves this Mac except mail with your servers and the images you load |
| `sidebar.localTip.web` | Terno only connects to Google (your mail) and to AI on this computer, plus the images you load |
| `settings.appearance.siteIcons.hintLocal` | Off in local mode. Turn it on to load each company’s icon from its own website anyway; nothing else changes. |

"The remote images you load" covers both the button and the setting (turning the setting on is loading them all). The "Turn off local mode?" dialog keeps its list with the cloud-AI item only.

### 3.7 Docs

- `AGENTS.md`: "**Local mode** (the default) means traffic to the mail servers only, plus remote mail content only when the user loads it (per message, or with the setting), and the other explicit choices plans 11 and 22 allow."
- `README.md`, `docs/PLAN.md`, plan 05 §B.3, plan 09 §9.1, plan 10 §1, plan 22 §1: one-line updates pointing here.

## 4. Tests

- **Unit:**
  - `remote-consent.test.ts`: per message, follows the setting; no local-mode override.
  - `network-backstop.test.ts` (Node): loopback always; connected mode everything; local mode: an image from a mail frame passes; the same image from the top frame, from a nested frame, from a non-srcdoc child, from a frame under a foreign top, or with no frame is cancelled; `script`, `xhr`, `webSocket`, `stylesheet`, `font`, `media`, `ping`, `cspReport`, `subFrame`, `mainFrame`, `object`, `other` from a mail frame are cancelled; an unparsable URL is cancelled.
  - `print-policy.test.ts`: approved images load whatever the mode; unlisted URLs and non-image types never.
  - `settings` tests: the migration (local + always → ask, persisted with the marker on the next write; connected keeps always; the marker stops it re-applying after the user turns the switch on in local mode); import never turns `remoteImages` to always.
- **E2E (`apps/web/e2e`):**
  - `local-ai.spec.ts` replaces the old test: in local mode the row says "blocked to protect your privacy", **Load content** loads the message's images (routed and counted), another message stays blocked; and with the setting on in local mode, a message's images load without a click (the switch enabled, its hint the normal one).
  - `print.spec.ts`: in local mode, an image loaded in the reader prints; the blocked note is the normal one.
  - Settings: the switch is enabled in local mode.
- **Packaged smoke:**
  - `print.smoke.ts`: in local mode, a listed image passes the print fence and an unlisted one is cancelled (observed in main without real network: requests that pass `onBeforeRequest` are recorded and cancelled in `onBeforeSendHeaders`).
  - `packaged.smoke.ts`: in local mode, an image in a mail srcdoc frame passes the backstop (same no-network observation), while a main-frame image and a `fetch` are still cancelled.
- **Visual:** baselines that show the reader's remote row in local mode are updated (macOS, Lumen, Atelier; light and dark) and looked at.

## 5. Performance and resources

No hot path changes: one more branch per renderer request in main (frame lookups only in local mode, for non-loopback requests). No new timers, IPC or state.

## 6. Out of scope

- The backend's `remote-content` purpose in `net-policy.ts` stays denied in local mode: the backend never fetches mail content from the web; the renderer does, behind the CSP and main's fence.
- Website icons, updates, diagnostics and AI rules under local mode.
- Remote stylesheets and fonts in mail (blocked by the app CSP in both modes today).

## 7. Revisions after the Codex review

These override the sections above where they conflict. The full review is in `/tmp/unica-scratch/remote-local/plan-35-codex.txt`.

1. **The backstop's claim, narrowed.** Rule (a) identifies a frame's *shape* (a direct srcdoc child of the app's page), not consent: any renderer code could make such a frame. Consent stays renderer and CSP enforced, as it was outside local mode; a renderer-supplied URL list (b) would share the limitation. What main still guarantees in local mode: nothing but images, and nothing from the app's own frame, nested frames or unknown frames.
2. **The adapter fails closed, and is tested.** Reading Electron's frame (`requestFrame`) moves into `network-backstop.ts` behind a `FrameLike` interface: a missing, detached, parentless or topless frame, or one that throws on access (disposed), is `null`, so cancelled. The app's page is matched by **exact origin** (`app://terno`, the dev URL's origin), never by prefix.
3. **Print redirects (documented, unchanged).** The print window only loads the exact URLs the renderer listed; an approved image that redirects shows in the reader and the preview but prints as its description. That is plan 09's rule in connected mode today and stays out of scope here (§6).
4. **"Load content" for remote content the reader didn't notice.** `hasRemoteContent` now also sees SVG `<image>`/`<use>`/`<feImage>` hrefs and `poster`, and, in the browser build only, protocol-relative URLs (`//host/…`, which the desktop resolves to `app://` and never fetches). Links (`<a href>`) still don't count.
5. **Migration ordering.** `migrate()` (appearance, then remote images) runs on the stored value before any patch, in every writer (`updateSettings`, `saveCapabilities`, `setGooglePhotoState`) and every read; a missing `localMode` reads as on; connected profiles get the marker too, so turning local mode on later never resets their "always". The marker is stripped from what the renderer sees.
6. **Import matrix.** A file's `"ask"` turns this install's "always" off; a file's `"always"`, a missing value or garbage leave this install's choice alone.
7. **Diagnostics copy.** `diag.preview.localMode`, `diag.settings.hint.localMac` and `diag.settings.hint.localWeb` said nothing leaves the computer in local mode; they now say local mode sends no error reports.
8. **The switch's hint when on.** New `settings.general.remoteImages.hintOn`: "Every message loads its remote images, so senders can tell when you open their mail." The off hint stays.
9. **Tests the plan missed:** `local-ai.spec.ts` (the local-mode confirmation listed images), `settings-pass.spec.ts` (turning local mode on disabled the switch: now it stays live and on across a reload).
10. **Baselines:** also `settings-general.png`, `es-settings-general.png` and `first-run.png` (copy and the live switch).
11. **Web build coverage and honest smokes.** An `e2e-web` test covers the button and the setting in the browser build (its own CSP). The packaged checks observe main's fence itself: requests that pass `onBeforeRequest` are recorded in `onBeforeSendHeaders` and cancelled there (no network), so a CSP refusal can't pass for a backstop cancel. The newsletter flow runs in `print.smoke.ts`, which already seeds the print fixtures.
12. **Images only, in the mail's own CSP.** `csp(true)` no longer opens `style-src` or `font-src` to the web (the web build's parent CSP allows one Google stylesheet origin, so relying on the parent wasn't enough). Nothing else in local mode changes.
