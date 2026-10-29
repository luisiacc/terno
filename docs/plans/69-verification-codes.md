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

### Detection (`packages/core/src/codes.ts`, pure)

`findCode(subject, bodyText, bodyHtml): string | null`

1. Text: the subject plus the body text, or, when there is none, the HTML reduced to text (drop `head`/`style`/`script` with their content, tags become spaces, entities for spaces and numbers decoded). Tags are gone before matching, so `<code>` never counts. URLs are removed too (`?code=123456` in a link is not shown to the reader). The body is capped at 20 000 characters.
2. Normalized like search (`normalizeText`: NFKD, marks stripped, lower case), so "Código" matches "codigo".
3. Keywords: every language's words, normalized, whole words for scripts that space words (`\p{L}` lookarounds), plain substrings otherwise.
4. Candidates: six digits, optionally split 3+3 by one space or hyphen (`123 456`, `123-456`), not part of something larger: no digit, letter or `#$€£+/` before it, no letter or digit after it, no decimal (`.5`, `,00`) after it, and no `digit[ -]` before or `[ -]digit` after it (phone numbers like `650 253 0000`).
5. A candidate counts only within 120 characters of a keyword. The candidate closest to any keyword wins; the subject is checked first, so "123456 is your code" in the subject wins over the body. The result is the six digits without separators.

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
