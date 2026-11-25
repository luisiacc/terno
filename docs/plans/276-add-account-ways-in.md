# Plan 276: Add account's three ways in, IMAP a step of its own, the marks in their colors

## The request

> lets change this design a bit [the Add account dialog], lets have the smtp direct connection be a 3rd option and the
> form shows after you click that, with an ice [nice] animation transitioning to that step.
>
> also can we make that 'add account' ui more lively? maybe adding the colors of microsoft and google in the icons

(The screenshot: Add account with the sync window, Continue with Google, Continue with Microsoft, a rule "or with
IMAP/SMTP", then the whole IMAP form: email, name, app password, both servers and ports, Connect account. Both marks in
the muted ink.)

## What exists

`apps/web/src/components/add-account-dialog.tsx`: `AddAccountForm` is the dialog's body and the first-run setup's last
step (plan 98). It draws the sync window, the browser ways in (`BROWSER_METHODS`: Google, and on the desktop Microsoft,
plan 259), a rule, then the IMAP form, all at once. What's typed lives in `AccountDraft`, held by the host (the dialog per
opening; the first run across its Back and a detour to Settings, `kept.draft`). One connection at a time (`busy`), its
failure shown where it was started (under the buttons, under the address for the Outlook.com hint, under the form).
Where the host can't do IMAP (the web without it), `DesktopOnly` stands in the form's place.

The marks are Hugeicons' `GoogleIcon` (a ring and a G) and `MicrosoftIcon` (four rounded squares, four paths), drawn by
`iconset/render.tsx` in `currentColor` (muted until hover, as every icon beside a label).

The first run already moves between steps with one `--motion-base` fade and a 6 px slide from the side it came from,
nothing fading out (`first-run.tsx`, keyed by step).

## Design

### Two steps inside the form

`AccountDraft` gains `way: "choose" | "imap"` (the host keeps it with the rest, so the first run's Back and its detour to
Settings come back to the IMAP form with what was typed; the dialog starts at `choose` each time it opens, as its draft
does).

- **choose**: the sync window (unchanged, asked once for every way), then the ways in as one column of equal buttons, centred
  as BoardUI's are: Continue with Google, Continue with Microsoft (desktop), and **Other mail account**, its quiet
  "IMAP/SMTP" after the words so nobody looking for IMAP misses it. Failures from Google or Microsoft show under the
  buttons, as today. Where IMAP isn't here, `DesktopOnly` takes the third button's place (as it took the form's).
- **imap**: the sync window stays where it was (it doesn't move), then a `link-secondary` button "Choose another way" with
  the left arrow, on the content's left edge, then the form exactly as today (presets, the Outlook.com hint and its
  Continue with Microsoft, Connect account, the failure under it).
- Focus, only on a move inside the form (never on mount, so the first run's heading focus and a remount keep theirs):
  entering the IMAP step puts the caret in Email (a text field: its ring is the caret's, as everywhere); Choose another
  way puts focus back on Other mail account after `hideFocusRing()` (programmatic: no ring, plan 54, even when Enter
  chose it). Escape still closes the dialog.
- Busy: while a connection is in flight the step can't change (Choose another way is disabled like every other control).
  A Microsoft sign-in started from the Outlook.com hint keeps the hint (and its spinner, and its failure) under Email
  until it settles, even if the address is edited away meanwhile: the chooser's button isn't on screen to take the
  spinner over.
- Where it sits: the dialog stays centred (plan 129's move is a translate over the centring), so a taller step grows it
  about its centre; the first run's body scrolls as it does today, and the focus move keeps Email in view.

### The transition

The part under the sync window is keyed by `way`; after a move inside the form (not on mount or restore) the new step
comes in with the first run's move, one `--motion-base`
fade and a 6 px slide (`slide-in-from-right-1.5` into IMAP, `-from-left-1.5` back), nothing fading out. Inside the motion
cap; `--motion-base` is 0 when motion is reduced or off, so it's a cut there. The dialog's height follows the content at
once (a 100 ms height tween on a centred dialog would move its top edge twice).

### The marks in their colors: BoardUI's Social Button

BoardUI's catalog has a **Social Button** (free, "port on first use" in `BOARDUI.md`): sign-in buttons that name their
brand, whose outlined `white` appearance is "the one that shows each provider's real multi-colour mark" and the one it
recommends for a stack. So the marks come with that control, ported, not painted onto Hugeicons' line drawings:

- `packages/ui/src/components/social-button.tsx` (new): `SocialButton` with `brand: "google" | "microsoft"` (the two we
  use; another is one entry), the `white` appearance only, on our `Button` as `variant="outline"` (BoardUI's white
  "matches the system's secondary button", which our outline is), `size="lg"` (BoardUI's medium is the base button's
  medium, 36 px), full width (the column decides). Its label is the caller's (`t()`), never a built-in English default.
- The marks are BoardUI's (SVG Logos, CC0) in a `brand-marks.ts` beside it, drawn as React elements (no
  `dangerouslySetInnerHTML`), 18 px as BoardUI's glyph, `aria-hidden`, the same in every palette, light and dark (the
  companies' colors; not text, so no `CONTRAST_PAIRS` question). The mark is a named component, so `Button`'s `loading`
  puts its spinner in the mark's place and the label stays (`isIcon`, by `displayName`).
- **Deviation recorded in `BOARDUI.md` and `AGENTS.md`'s icon rule**: a provider's own mark is not an icon. It lives in
  `SocialButton`, never in `@terno/ui/icons`; everything else still draws only Hugeicons. Only the white appearance is
  ported (no colorful/black, no icon-only, no `href`: our sign-ins are calls, not navigations).

"Other mail account" is the same outline button and size with the plain Mail icon (muted until hover, the rule for an
icon beside a label): it isn't anyone's brand.

### Copy

New keys, en and es: `account.otherMail` ("Other mail account" / "Otra cuenta de correo"), `account.otherMailKind`
("IMAP/SMTP" / "IMAP/SMTP"), `account.chooseAnother` ("Choose another way" / "Elegir otra forma"). `account.orImap` goes.

## Tests

- Unit (`add-account-web.test.tsx`, `outlook-account.test.tsx`): choose shows the buttons and no form; Other mail account
  shows the form with the draft's values and puts the caret in Email; Choose another way goes back with the draft kept
  and focus on Other mail account; a hint-started Microsoft sign-in keeps its spinner under Email after the address is
  edited away; the web build with and without IMAP (Google and Other mail account; Google and `DesktopOnly`).
- Unit (`social-button.test.tsx`): each brand's mark is the named first child (loading swaps it for the spinner, the
  label stays); the mark is `aria-hidden`; the button is the outline one.
- e2e: helpers `imapForm(scope)` / `waysIn(scope)` (fixtures) move between the steps; every spec that types into the form
  uses them (`account-errors`, `first-sync`, `identity`, `settings`, `first-run`, `google-client`, `outlook-connect`,
  `dialog-move`, `visual`), and those that go from the form to Google or Microsoft go back first. `account-errors`
  checks what was typed by value after the steps remount the form. `first-run`: the IMAP step and its fields survive the
  setup's Back. A move runs one entrance each way and none on open; none with motion off.
- The packaged smoke (`notify.smoke.ts`) opens Other mail account before filling the form.
- axe in light and dark on both steps (`design-axe`, `outlook-connect`, the first run's account pass).
- Screenshots of both steps, light and dark, in English and Spanish at the first run's width, looked at;
  `visual.spec.ts`' baselines updated.

## Perf and resources

No new work: one more state in a dialog's memory, the marks are static SVG. No lazy loading.

## Out of scope

The web's Microsoft (plan 259 stage 4). Autodiscovery of servers. Changing the first run's own Back.

## Revisions after the Codex review

Codex's critique (12 points) changed the plan:

1. Social Button is in BoardUI's catalog ("port on first use"): the marks come with its port, not painted Hugeicons.
2. The colored marks therefore live in that component, not `@terno/ui/icons`; the icon rule records the exception.
3. (Moot with 1: no SVG mask on a Hugeicons stroke.)
4. The mark is the button's named first child, so `loading` keeps the label.
5. A hint-started Microsoft sign-in keeps its hint and spinner while the address is edited.
6. Focus moves only on a move inside the form, after `hideFocusRing()` for the button.
7. Where the dialog sits is stated (centred, grows about its centre).
8. The web build is tested with and without IMAP.
9. The e2e helpers go both ways; specs that leave the form for Google or Microsoft go back first.
10. The packaged smoke opens the IMAP step.
11. The first run's axe and baselines cover both steps; Spanish at the first run's width is looked at.
12. The entrance runs only on a move, never on mount or restore; tested both ways and with motion off.

## The owner's pick: rounder marks

Built, the owner asked for "more rounded-like" marks. Four were shown (A the official marks as built, B Google's G with
Microsoft's squares softened, C our line icons painted in the brands' colors, D B's marks in rounded tiles); the owner
picked **B**: Microsoft's four squares with soft corners (34 of 118 units) and a wider gap, Google's G as Google draws it.

## What the Codex code review changed

1. The token gate (`no-hardcoded.test.ts`) flagged the marks' colors: `brand/provider-marks.tsx` is exempt by name, the one
   place beside the palettes where colors live.
2. (Not taken) A connection in flight across the first run's detour to Settings loses its busy state on remount: so it
   did before this plan; rare.
3. A Microsoft sign-in started from the hint, the address edited away, focus on the hint's button: when it settles the
   button goes with the hint, and focus goes back to Email (unit test, fails without the fix).
4. (Not taken) A cleared port reads 0 after the form is drawn again: so it did after the first run's Back; rare.
5. The suite reduces motion by default, so the entrance test proved nothing: it now runs with motion, records each
   `animationstart` on the steps' container (none on open, exactly one each way, ≤ 100 ms), and the cut is checked with
   the system's reduced motion and with Terno's motion setting at 0.
6. `design-axe` scans the IMAP step too, in every design.
7. The loading test checks the spinner is the first child, hidden, and the words stay, for both brands.

## Tests run

Unit: `social-button`, `outlook-account`, `add-account-web`, `icons`, `source-scan`, `no-hardcoded` (one hit left, the
DEV badge's colors in `brand/generate.ts`, on main since commit 565e586, not this plan’s), `architecture`. e2e (macOS):
`add-account-ways`, `account-errors`, `first-sync`, `identity`, `settings`, `first-run`, `google-client`,
`outlook-connect`, `dialog-move`, `design-axe`, `visual` (baselines `add-account`, `add-account-imap`,
`first-run-account[-imap][-dark]` updated and looked at). `account-errors` and `first-sync` start their own server and
now answer the first-screen question as the fixture does (it covered the page, unrelated to this plan). Not run: the
web build's `e2e-web` (one added assertion) and the packaged smoke (one added click).
