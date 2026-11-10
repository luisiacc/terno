# Plan 170: a sound when a message is sent

## Request (verbatim)

> find me nice good soundbits that will simulate a send email sound, needs to be clear and nice to hear
>
> ok lets use terno-airy-whoosh when they click the send button to send an email

## What exists

- Every send goes through `sendDraft` → `send` (`apps/web/src/lib/compose.ts`): the button, ⌘↩, the palette, the AI draft's Send. It ends in one of three ways that take the message away: `compose.send` (sent now), `compose.hold` (plan 158's Undo window) or `compose.schedule` (Send later, plan 89/94). Anything else (a refused recipient, the empty-message question, a failure) returns `false` and the draft stays.
- Settings are backend-held (`General` in `packages/core/src/rpc/contract.ts`, defaults in `packages/backend/src/settings.ts`); Settings → General → Writing holds the send-related switches (Suggestions, Undo send).
- The app plays no sound anywhere today.

## Design

- **The sound:** `terno-airy-whoosh`, synthesized for Terno (band-passed noise swept up from 350 Hz to 2.8 kHz over 340 ms, a soft swell), so it's ours outright, with no licence to track. It ships as `apps/web/src/assets/sent.wav`: 16-bit mono PCM at 44.1 kHz, 30 KB, about −28 LUFS. That is between macOS's Pop (−29) and Mail's own sent sound (−32): clear without being loud. It is WAV because every engine (Electron's Chromium, Safari, Firefox) plays PCM without a codec question.
- **When:** once the message has left the composer to go now: `compose.send` resolved, or `compose.hold` resolved (held or not). Both the click and ⌘↩ count, since they are the same Send. So does a scheduled message's **Send now** (`rescheduleScheduled(…, true)`). The sound marks "it's on its way", as the button's click would: the backend has queued it durably. Delivery is reported later and on its own, by "Message sent" or the failure (`send-warning.ts`). Nothing plays when preparing or queuing fails: a refusal, the empty-message question, an RPC error. **Send later doesn't play it either:** nothing went yet, and its snack already says when it will.
- **Undo send:** the sound plays when the message is held. That's when it leaves the composer, as Mail does. Undo puts the draft back silently.
- **Setting:** `sendSound: boolean`, on by default, shown as "Send sound" in Settings → General → Writing, after Undo send. Someone in a quiet office, or with no taste for UI sounds, turns it off there. It is a backend setting like Undo send, so desktop and web read it the same way.
- **Playing:** `apps/web/src/lib/sounds.ts` has `primeSendSound()` and `playSendSound()`. The prime runs in the click or key itself, before `send` awaits anything. It creates the one `HTMLAudioElement` and calls `load()`: WebKit lets an element play later only if it was touched in a gesture, and the file is then read while the send is prepared. The play rewinds that element and plays it. It never waits on the sound, and a failed `play()` (no audio device, autoplay refused) is ignored. A sound is only a nicety and never gets in the way of a send.
- **Assets and the fence:** Vite emits the file into the renderer bundle (30 KB is over its 4 KB inline limit, so it's never a `data:` URL). Electron serves it from `app://terno/assets/…` under the existing CSP (`media-src` falls back to `default-src 'self'`). `app.ts` gains `.wav → audio/wav` in its MIME map, because `X-Content-Type-Options: nosniff` is set, and the `app` scheme gains `stream: true`, which Electron needs for media on a custom scheme. On the web, the service worker precaches it with the rest of the bundle (30 KB, once), so the first send's sound works offline too. Nothing new is reached.
- **Smoke runs:** a background test run (`TERNO_TEST_BACKGROUND=1`) mutes its windows, so a smoke that sends mail never whooshes at the person at the machine. Playwright's own browsers are muted already.
- **Accessibility:** the sound is extra feedback on top of what already shows a send (the composer closes, and the Undo snack when it applies). Nobody relies on hearing it.

## Tests

- `sounds.test.ts`: plays with the setting on. Doesn't with it off, or before settings load. One element is reused and rewound. A rejected or throwing `play()` doesn't throw. The prime makes and loads the element that the play then uses.
- `compose.test.ts`: primed before anything is awaited. A send now plays it once, only after the backend has it. A held send (Undo send on) plays it, and so does a hold the backend sent at once. Send later, a failed send and a refused recipient don't.
- `scheduled.test.ts`: Send now on a scheduled message plays it. A new time or a failed reschedule doesn't.
- `settings-edits.test.ts`: the switch travels through export and import both ways (a web storage switch).
- Packaged smoke (`packaged.smoke.ts`, plan 16's send): the real element plays `app://terno/assets/sent-….wav` to the end of a resolved `play()`, with its 0.34 s duration read. That proves MIME, CSP and the scheme together.

## Perf

Nothing on a hot path. The first play reads a 30 KB file from the app bundle. Idle stays idle: there's no `AudioContext` and no timer, and the element holds no audio session between plays.

## Out of scope

- Sounds for other actions (archive, new mail).
- A choice of sounds, or a volume slider.
- Following macOS's "Play user interface sound effects" (that preference isn't documented for apps to read).

## Revisions after the Codex review

Codex's critique of the plan (six points), all taken:

1. **Import dropped the setting.** A web storage switch exports and imports settings, and `GENERAL_KEYS` (`packages/backend/src/import.ts`) had no `sendSound`, so a sound turned off came back on. It's in the list now, with a test both ways.
2. **WebKit's gesture rule.** Playing only after awaited RPCs could be refused on every send in Safari. `primeSendSound()` now makes and loads the element in the gesture.
3. **Media over `app://`.** MIME and CSP alone don't prove playback. The scheme gets `stream: true`, and the packaged smoke plays the real file.
4. **Scheduled Send now** bypasses `sendDraft`. It plays the sound too (primed in its click).
5. **What the sound means** is now stated precisely: queued to go, not delivered. Delivery has its own snack.
6. **The web's service worker** precaches every emitted asset, so the WAV is fetched at install (30 KB). That's accepted and stated, and it lets the first send play offline.
