# 252: Sender icons sized by their shape

## Request (verbatim)

> i think w ecan do better with the icons, i think they can be bigger, can we detect if its a circle or a square and if they are use it close to their size so it looks bigger, if not then we make it bigger like figma icon

(With a screenshot of the Inbox: LinkedIn's square, Coinbase's circle, Sentry's rounded square, Google's G, OpenAI's knot and GitHub's cat all drawn as small marks, about half the avatar, on a muted plate.)

## What exists

- Plan 22 fetches a sender's website icon (or Google photo) in the backend, which only parses headers (`packages/backend/src/icons/image.ts`): format, `px` (smaller side) and `full` (touch icon). It never decodes pixels; there is no decoder in the backend.
- Plan 158 (`bcceb9df0`) made every website icon a mark on a muted plate at `min(max(50%, 14px), 2 × px)`, so names lead; a photo fills the disc (`sender-avatar.tsx`).
- The renderer's store (`apps/web/src/lib/sender-icons.ts`) receives icons' bytes as `data:` URLs (`icons.data`, chunks of 50) into an LRU of 400.

So a circle logo becomes a circle inside a circle, a full-bleed square a small tile on a plate, and a favicon's own transparent padding shrinks its mark further.

## Design

**Measure once, in the renderer, when the bytes arrive.** `apps/web/src/lib/icon-fit.ts`:

- `classify(rgba, n)`: pure, on an n × n RGBA buffer (the image drawn *contain* into a square):
  - the **content box**: the bounding box of pixels with alpha > 32 (a favicon's transparent padding is trimmed);
  - **fill**: the box is square (within 8 %), opaque inside its inscribed circle (mean alpha ≥ 0.97 for d ≤ 0.92 r), and what a circle crop would cut (opaque pixels outside the inscribed circle that differ from the tile's background, its border pixels' most common color) is at most 4 % of the cut area. That's a circle (nothing outside), a square or rounded square whose mark sits inside the circle (LinkedIn, Sentry, touch icons);
  - **ring**: a filled icon whose edge is near white or near black gets a hairline, so a white disc keeps its edge on a white card (and a black one in dark).
- `measureIcon(url)`: decodes the `data:` URL (`Image.decode`, off the main thread), draws it into one shared 48 × 48 canvas (`willReadFrequently`) and classifies. Anything that fails (no DOM, decode error, a tainted canvas) is the default: a mark, the whole image as its box (today's look, at the new size).

**The store keeps the fit beside the bytes.** A website icon's bytes are measured before they're stored and announced, so it's drawn at its final size the first time (no jump). `fits` is keyed like `data` and evicted with it; `ShownIcon` gains `fit`. Nothing is persisted: a measurement is a few microseconds per icon per session, and the backend stays decoder-free.

**Drawing** (`SenderIcon`): the image is placed so its content box is centered on the disc, by size and a `translate` in its own percentages (so a size cap needs no other arithmetic):

- **fill** (and `px ≥ 32`, so a 16 px favicon isn't blown up): the content box spans a disc of 74 % of the avatar, inset on the plate (see the revision below; first built edge to edge).
- **mark**: the content box's longer side is 48 % of the disc (first built at 62 %) (was 50 % of the whole image, padding included), at least 14 px, on the muted plate, still at most twice the image's own pixels, with the dark-mode halo.
- photos: unchanged.

Every surface with a `SenderAvatar` gets this (rows, reader, What matters), since all share the component.

## Tests

- `icon-fit.test.ts`: circle, padded circle (box trimmed), square, rounded square, square with its mark in the corners (→ mark), transparent glyph (→ mark, trimmed box), wide logo (→ mark), white tile (→ ring), empty image (→ default).
- `sender-icons.test.ts`: the measured fit arrives with the icon, is dropped with its bytes, and the default stands where nothing can measure.
- e2e `icons.spec.ts`: the stub's solid touch icons draw as a filled disc (`data-icon-fit="fill"`), a transparent-glyph favicon as a mark whose box is 62 % of the avatar, in every design (the existing test's own load; no new backend).

## Perf

One `Image.decode` and one 48 × 48 `getImageData` per icon, once per session, at most 50 per data chunk, already batched by visibility. No re-render beyond the icon's own child. `test:ui-perf` (every site has an icon there) is the gate.

## Out of scope

- Detecting shapes in the backend (would need image decoders there; revisit if it ever decodes for another reason).
- Recoloring or inverting dark logos in dark mode.
- UI rating: `ui:rate` turns sender icons off, so the rated screens don't change.

## Revisions after the Codex review

The plan critique didn't run (Codex hung at startup and was stopped); the code review did, and changed:

- **Measuring is off the request's slot.** Awaiting fifty decodes inside `fetchData` held one of the two RPC slots until the slowest finished and widened its race windows. The bytes now free the slot at once; a queue measures four at a time (`measuring`, by `id:v`), each icon lands (`landed`) when measured, and bytes being measured are never asked for again. A reset drops what's being measured. Tests: the slot is free and nothing is asked twice during a slow measurement; a reset mid-measurement never lands the old one and the held icon stays until the new bytes do.
- **A fill's shorter side spans the disc**, so a near square leaves no crescent (it's the crop the classifier approved).
- **A gradient tile fills.** What a crop would cut is compared with the tile's edge beside it (along its row and column) as well as its commonest border color; a mark in a corner still keeps the icon a mark. Test: a rounded gradient tile.
- **The resolution guard counts the drawn part**: a small circle in a padded 32 px favicon doesn't fill.
- **Marks keep the 14 px floor** on the smallest avatars.
- **E2E** picks each sender's row by name after the search settles, and Figma's ring is off center, so a wrong offset can't pass.

Not taken: a tiny contrasting badge in a tile's corner (rare in fetched icons), a per-segment ring sample (a white rim on a colored disc reads fine as is), real ICO/SVG fixtures (Chromium keeps a viewBox-only SVG's aspect, checked).

## Revision: the owner's sizes (variant E)

The first build (circles and squares filling the whole avatar, marks at 62 %) looked too big to the owner. Six variants were compared on real icons (LinkedIn, Coinbase, Google, Sentry, OpenAI, GitHub, Figma, Stripe, Airbnb, Notion, Rappi) in light and dark; the owner chose **E**:

- a circle or a square whose mark sits inside the circle is **a disc of its own at 74 % of the avatar, inset on the muted plate** (cropped as before, its hairline on that disc), so every avatar keeps the plate's edge and a brand's color doesn't outweigh the names;
- a mark's drawn part is **48 %** of the avatar (padding trimmed; the 14 px floor and two-times cap stay).

Not taken: full-bleed discs (B, C), 84 / 52 (D), each logo in its own shape at 64 % (F), and plan 158's untrimmed 50 % (A).
