# Plan 244: finished items in What matters read faded

## Request (verbatim)

> on the 'what matters' section the things that are done alreayd like these [screenshot of Earlier: "Done today", "Removed today"] should be kind of faded i think, that would be a good ui

And, after a first pass that held the fade to AA:

> it needs to be a bit more faded so the user can clearly see the difference between the active things and the done things, we don't care about color accesibility here

## What exists

- `apps/web/src/components/what-matters/feed.tsx` `Item`: a history row (`past`, Earlier: done, removed, settled, over) draws its sentence, who and when in `text-muted-foreground`, no gutter mark. Its avatar (`SenderAvatar`, a brand icon or coloured initials) is drawn as on any other row.
- `muted-foreground` is each palette's quiet ink, well above AA in most (≈ 6–7:1 on the light panes), so Earlier reads only a little lighter than Today, and its coloured avatars (Azure, Google) pull the eye as much as Today's.

## Design

- **The owner's call: finished items are faded below AA.** A finished row's contents (its sentence, who with the face, when) are drawn at 55% opacity, on the quiet ink they already had; the face is also grey (`grayscale`), so a brand's colour no longer competes with what's left to do. Clearly apart from active rows in light and dark, still legible.
- **Where**: the opacity sits on the row button's children (`data-faded:*:opacity-55`), never on the button, so the focus ring stays whole. `data-faded` is set while the row is finished and not open; the open one, as every open row, is in the selection's ink and in full. Under the pointer it stays faded (the hover fill says it's live).
- **Axe**: `axeBothModes` reads `[data-faded]` for everything but contrast (a second pass with `color-contrast` off), so names, roles and the rest stay checked. `data-faded` is for what the owner chose to fade; never a way around a contrast failure.
- `no-hardcoded.test.ts` bans a bare `opacity-N` on text and glyphs; this one is a state variant (`data-faded:`), the same allowance as `disabled:`, and the plan records why.
- No change to Missed, Today, Waiting on you, Coming up or the digest; no motion.

## Tests

- `what-matters-feed.spec.ts` (Earlier's scenario): the newest finished row has `data-faded`, its sentence and who under 0.7 opacity, the button itself at 1 (focus ring whole), its face grey; axe in light and dark; opened, it is in full (no `data-faded`, opacity 1, face in colour); put away, faded again.
- Visual: Earlier under active rows in Lumen (faces) and macOS (classic rows), light and dark, and a hovered finished row.

## Perf

Class names and one attribute: nothing on a hot path.

## Out of scope

- A check mark or strike-through on done items; changing what Earlier holds or its words.

## Revisions after the Codex review

The first pass (an AA-bound `row-faded` token, the quiet ink stepped toward the ground until 4.5:1) went to Codex's critique; its points on custom palettes and translucent hovers were about that token, which the owner's second message replaced (too subtle: "we don't care about color accessibility here"). Points that still apply and were taken:

- **The face is faded on the `wm-face` wrapper**, so initials, logo plates, photos and icons that arrive late all fade, and `SenderAvatar` elsewhere is untouched.
- **Open and put away** are checked by computed style, not class names: open is in full, put away is faded again.
- **The focus ring stays whole** (the fade is on the children, not the button).
- **Visual check in a design with faces and a classic one**, light and dark.
