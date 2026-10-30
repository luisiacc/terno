# 69 · Verification codes

## Request

> lets impement a recognizance of verification codes, lets try to make it work for all configures languages, so there is a way to do it with new languages too that are added translations.
>
> lets have a blue mini chip button in the thread of the messag with the verification code with the code and a copy icon, nicely premium ui and simple, upon clicking it it copies to the clipboard and animates the copy icon into a checkmark for 5 seconds , then goes back to being the checkmark, after being copied once after the 5s finish, it goes from being blue to transparent with a border, the transition must be nice and smooth.
>
> we only show the code on messages that from 2 hour or less ago.
>
> make the algorithm to detect the code simple but reliable, for example initially i think if it says the word "code"(that's not html tag) and there is a six digit code we can trigger it, show me pictures when this is done in light mode and in dark mode

("goes back to being the checkmark" reads as "goes back to being the copy icon": the check shows for 5 s, then the copy icon returns.)

## What exists

- The categorizer already knows an `otp` intent (`packages/core/src/categorize/features.ts`): keyword phrases, no code extraction.
- The reader renders each message (`Message` in `apps/web/src/components/reader.tsx`) with its header as one `<button>` (so nothing interactive can go inside it) and its body below (`HtmlBody` or `TextBody`).
- `MessageDetail` carries `subject`, `date`, `bodyText` (null for IMAP until known, and for HTML-only mail) and `bodyHtml`.
- `@terno/core` already depends on `@terno/i18n`. Only English is bundled into the renderer; other catalogs load when chosen.
- Copying elsewhere uses `navigator.clipboard.writeText` and `t("threadMenu.copyFailed")` on failure.
- `primary` is each palette's blue (or its accent hue), with `primary-foreground` on it.

## Design

### Words per language

`packages/i18n/src/code-words.ts` exports `CODE_WORDS: Record<LocaleId, readonly string[]>`, the words that announce a code in each shipped language (`en`: code, passcode, OTP; `es`: código, clave). The `Record<LocaleId, …>` type makes the type check fail until a new language adds its words, and the README's "Adding a language" step mentions it. Detection always uses the words of **every** language, not just the UI's: a Spanish speaker using Terno in English still gets codes from Spanish mail. The list is tiny and bundled eagerly (catalogs stay lazy).

### Detection

`findCode(subject, body): string | null` in `packages/core/src/codes.ts` (pure, text only), and `mailText(html)` in `apps/web/src/lib/mail-text.ts`, which gives an HTML body's visible text.

1. Text: the body the reader shows. For HTML, the browser's `DOMParser` reads it (so markup means what it means in the reader) and a tree walk keeps the text: `head`, `style`, `script`, `template`, `blockquote` (quoted mail), and elements hidden by their `hidden` attribute or an inline `display:none`, `visibility:hidden` or zero size/opacity are skipped whole. Cells and images become spaces, inline tags join digits ("<b>12</b>3456") and are spaces elsewhere, other tags line breaks; tags are never text, so `<code>` never counts. The HTML is capped at 200 kB and the text at 20 000 characters. Quoted lines and "On … wrote:" history are dropped, as are URLs (`?code=123456` in a link is not shown to the reader).
2. Normalized like search (`normalizeText`: NFKD, marks stripped, lower case), so "Código" matches "codigo".
3. Keywords: every language's words, normalized, whole words for scripts that space words (`\p{L}` lookarounds), plain substrings for Han, Kana, Thai, Lao, Khmer and Myanmar.
4. Candidates: six digits, optionally split 3+3 by one space or hyphen (`123 456`, `123-456`) or one per box (`1 2 3 4 5 6`), not part of something larger: no digit, letter or `#$€£¥+/@=` before it, no letter, digit or `%` after it, no decimal or reference (`.5`, `,00`, `/789`) after it, no `letter.`/`digit.` before it, and no `digit[ -]` before or `[ -]digit` after it (phone numbers like `650 253 0000`).
5. A candidate counts only within 120 characters of a keyword. The candidate closest to any keyword wins (one pass: both lists are in order). The subject is checked first, unless it is a reply's or forward's (`Re:`, `Fwd:`…), so "123456 is your code" wins over the body; a subject that announces a code takes the body's only candidate.

Simple on purpose: it misses alphanumeric and 4/8-digit codes (out of scope) rather than guessing.

### When it shows

- Only on received messages (`!isSent`) whose `date` is at most 2 hours before now. The age is checked before any detection, so older messages cost one subtraction.
- The detection runs once per message and body (memoized on id, `bodyText`, `bodyHtml`).
- When the 2 hours run out while the message is on screen, one `setTimeout` (set to the exact expiry, cleared on unmount) removes the chip. No interval, nothing while idle.

### The chip (`apps/web/src/components/code-chip.tsx`)

- A small pill button at the top of the message body (above the HTML frame or text, aligned with it): the code in tabular figures with slight tracking, then a copy icon. `h-7`, `rounded-full`, `px-2.5`, `text-sm font-medium`.
- **Fresh:** `bg-primary text-primary-foreground` with a `border-primary` hairline (the border is always there, so nothing shifts later).
- **Click:** writes the code to the clipboard. The copy icon crossfades and scales into a check (both icons stacked; opacity plus scale `0.6 → 1`, `duration-base`, spring ease). An `aria-live="polite"` region says "Copied". If the clipboard refuses, the snack says "Couldn't copy" (existing string) and nothing animates.
- **After 5 s:** the check turns back into the copy icon, and the chip settles from blue into `bg-transparent text-foreground border-border` (background, text and border colors transition together, `duration-slow`). It stays outlined from then on: copying again shows the check for 5 s and returns to outlined. The 5 s timer is the only timer; a second click restarts it; unmount clears it.
- "Copied once" is remembered per message for the session (a bounded set of the last 200 message ids), so switching threads and back keeps the outlined state.
- Motion stays within the `--motion` cap (≤ 100 ms) and disappears when motion is off or reduced, like everything else; the 5 s hold is a state, not an animation.
- Accessible name: "Copy verification code 123456" (`codes.copy`); the live region: "Copied" (`codes.copied`). Keyboard-reachable; focus ring via `focus-visible:`.
- Strings in `en` and `es`.

## Tests

- Unit (`codes.test.ts`): English and Spanish positives (subject, body, `code: 123456`, `123 456`, `123-456`, accented and capitalized "Código"), the HTML path (a `<code>` tag alone doesn't trigger; `<style>` hex colors and link query strings don't), negatives (no keyword, keyword too far, 5/7 digits, prices `$123,456.00`, phone numbers, `#123456`, dates `2026/10/29`, order ids `A123456`), subject wins, closest wins, every locale has at least one word.
- Unit (`code-chip.test.tsx`): fresh → copied (check shown, clipboard called) → 5 s later outlined with the copy icon (fake timers); clipboard failure shows the snack and stays fresh; the session memory keeps "used" across remounts; a message older than 2 h shows nothing; expiry removes the chip.
- e2e (`codes.spec.ts`, `@design`): a just-received code mail shows the chip with its code; clicking copies it (clipboard read) and shows the check; after 5 s the chip is outlined; a 3-hour-old one shows nothing; light and dark screenshots; axe clean.

## Perf

One subtraction per message render for old mail. Fresh mail: one regex pass over at most ~20 kB, memoized. Nothing in the list or the backend. The chip is a few elements; not lazy-loaded (it is tiny and in the reader chunk).

## Out of scope

Codes in the thread list or notifications, alphanumeric codes, 4- and 8-digit codes, auto-fill into other apps.

## Revisions after the Codex review

The plan review made twelve points:

1. Bare words are broad, so Spanish uses phrases (`clave de verificación`, `clave de acceso`, `clave dinámica`) rather than bare `clave`; `code` stays, as asked, with the 120-character proximity and the 2-hour window bounding the damage.
2. Quoted mail is ignored: lines starting with `>`, everything after an "On … wrote:" / "El … escribió:" header (the categorizer's `QUOTE_HEADER`, now exported), and `<blockquote>` content.
3. Per-digit layouts read as codes (`\d(\s\d){5}`, cells become spaces); inline tags between digits don't split them.
4. The body read is the one shown: HTML when there is one.
5. `12.123456` and `123456/789` are rejected (tests added).
6. The match policy is per script: whole words in spaced scripts, substrings in Han, Kana, Thai, Lao, Khmer and Myanmar. Words and text go through the same normalization.
7. Fresh means `−5 min ≤ now − date ≤ 2 h` and a finite date; `subject` is a memo dependency.
8. The chip mounts inside the open body only; the HTML is capped before any work.
9. "Blue" is the palette's `primary` (blue in the default macOS palettes; the theme's own accent elsewhere). `primary-foreground` on `primary` is already a 4.5:1 `CONTRAST_PAIRS` entry; the outlined state is foreground on background. axe passes in every design, light and dark.
10. A focused chip outlives its expiry until it loses focus. The live region sits outside the button, always mounted, and clears when the check goes so the next copy is announced.
11. Lifecycle tests cover a second click restarting the 5 s, clipboard failure, remounts and expiry. The code is passed to `t()` as a string, so leading zeros stay.
12. Motion uses `duration-base`/`duration-slow` with the spring and standard eases, which the global motion setting scales and turns off.

## What the code review changed

Codex's code review found six problems, each now covered by a test that fails without the fix:

1. **Hostile HTML froze the reader** (200 000 spaces took 31 s, 200 000 `<` took 19 s; the regex pipeline was quadratic). `htmlText` is now one forward scan: every search moves on, a `<` that can't start a tag is text before any `>` is sought, and whitespace collapses per line. A test bounds nine hostile inputs at 250 ms each.
2. **Hidden HTML won over the visible code.** Elements hidden by `display:none`, `visibility:hidden`, a zero `font-size`, `max-height` or `opacity`, or the `hidden` attribute are skipped with their content.
3. **Nested blockquotes leaked quoted codes.** Skipped elements are skipped to their matching close, counting nesting.
4. **Named entities weren't decoded:** `c&oacute;digo` missed and `&pound;123456` passed. Common named entities (spaces, punctuation, currencies, accented letters) are decoded before matching.
5. **A reply's subject brought back the original's code.** Subjects with a `Re:`/`Fwd:` prefix (any language `baseSubject` knows) aren't read.
6. **A clipboard answer after the chip unmounted** started an uncancelled timer, or showed "Couldn't copy" over another thread. Late answers now only remember the copy.

### Round 2

Codex's second review found nine more, each now covered by a failing-without-the-fix test:

1. **Matching was still quadratic:** every code was measured against every word (`"code 123456;"` × 16 000 took 530 ms). The closest word is now found in one pass over both ordered lists, and the subject is capped at 1 000 characters.
2.–8. **The hand-written HTML scanner disagreed with the reader's parser:** a quoted `>` in an attribute, `İ` changing offsets when lowercased, a fake `</blockquote>` inside a comment, `<div hidden/>` (not self-closing in HTML), an unfinished tag, `</stylesheet>` ending a `<style>`, and `hidden` or `display:none` inside an unrelated attribute. The scanner is gone: the renderer parses with `DOMParser`, the same parser that decides what the reader shows, and hiding is read from the `hidden` attribute and the style attribute only. `findCode` takes text, so core stays parser-free.
9. **A chip shown again before the clipboard answered stayed blue.** "Copied" is a small store the chips subscribe to (`useSyncExternalStore`), written when the check goes, or at once when the chip is already gone.

### Round 3

1. **Leaving an element didn't separate text** (`<div>Your code</div>482913` read "Your code482913"; `<div>code 123</div>456` read one code). The walk now uses an explicit stack with an exit marker per element, so separators come on the way in and out (and deep nesting can't overflow).
2. **Hiding was matched as text, not resolved** (`display:none;display:block` is shown). Hiding now reads the browser's resolved inline style (`el.style`), where the last declaration wins.

The perf gates: `pnpm test:ui-perf` passes except "a 2 MB draft of short lines", which fails the same way on the base commit (109–119 ms against 100 ms).

## Moved to the thread list

> they should show in the thread list , not in the email body

The chip now lives in the list row, not the message body.

- **What it reads:** the row's subject and snippet (`findCode(subject, snippet)`), for threads whose newest message is at most 2 hours old. The snippet is the newest message's first 200 visible characters, made by the backend from the body's visible text (`htmlToText`: hidden elements, styles and scripts left out) with quoted lines removed. So the list needs no new data, and the renderer parses no HTML: `mail-text.ts` and the reader's chip are gone. A code past the first 200 characters isn't offered; codes sit near the top in practice.
- **Where:** on the row's top line, just before the date (and the marks), in every layout. There the subject and snippet keep their room. `-my-0.5` keeps the row's line height.
- **What it is:** a row is an `option` of the list, which can't contain a button (axe `nested-interactive`). So the chip is a pointer target (`aria-hidden`, `data-row-control`). Pressing it neither selects the row nor moves focus (mouse down is stopped and its default prevented), and it never starts a drag (`drag-install` ignores presses on `[data-row-control]`). Keyboards and screen readers get the code in the row's name ("Verification code 048291") and copy it from the thread menu ("Copy verification code 048291"; a snack confirms).
- **State:** copying lives in `apps/web/src/lib/codes.ts`, keyed by thread and code (a newer code in the same thread is a new one), with the 5 s timer in the store. Rows come and go as the list scrolls, and the chip and the menu share one state. The earlier unmount and late-answer races can't happen: no row owns a timer or a promise. Each fresh row with a code has one timer, to its expiry.
- **Perf:** an older thread costs one subtraction per row render; a fresh one, one memoized regex pass over at most ~1.2 kB. No extra row renders, except the one at expiry.

Tests: `lib/codes.test.tsx` covers copy, check, outlined, restart, shared state across remounts, a new code in the same thread, clipboard refusal, the 2-hour window and the single expiry timer. `codes.spec.ts` (`@design`) covers the chip on a plain and a selected row, copying without opening the thread, the 5 s settle, axe on the list in light and dark, the thread menu's copy, no drag from the chip (fails without the `drag-install` guard), and nothing for 3-hour-old mail.

### Codex review of the move (round 4)

1. **A row on screen for a while saw new mail as old:** its clock was read at mount. The clock is read again whenever the thread's date changes.
2. **The subject is the thread's first message's**, while the snippet and date are the newest's, so a reply could bring back (and make fresh again) the original's code. The subject counts only while the thread has one message.
3. **A snippet runs the body's lines together,** so "On … wrote:" no longer started a line and a quoted code came through. The quote header is now found anywhere in a line (`codes.ts` keeps its own pattern; the categorizer's is untouched).

Each has a test that fails without the fix. The list e2e (codes, layout, drag and drop, selection, triage: 183) and the list perf gates (`j` at key repeat, scrolling, render counts: 36) pass.

### Placement, decided

Shown in the inbox with ordinary rows around it, the chip stays on the top line before the date (option A). A line of its own below the preview (B, prototyped) kept the subject's room but made that row taller and the list jump when the code expired. In the full-width list (one-line rows) the chip sits right after the sender, in the sender column, so the subject and preview keep their room; a long name truncates first. An e2e test checks it sits between the sender and the subject.

## Trying it: `pnpm dev:demo`

The demo mailbox is seeded once and dated in the past, so it never has a code under 2 hours old. `seedDemoCode` (`packages/backend/src/demo.ts`) adds "Your Acme sign-in code" from Acme, dated now, unread, to the first account's inbox on every dev demo launch. Each launch adds a message with a new code to the same thread, so the inbox doesn't fill with copies. It runs only with `demo && dev` (`backend-entry.ts`), so the packaged demo smokes keep their mailbox. `demo-code.test.ts` checks two launches: one thread at the top of the inbox whose row offers the newest code. A real `dev:demo` launch on a temp profile seeded it (checked in its database).
