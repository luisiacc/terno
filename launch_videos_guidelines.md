# Launch videos: guidelines

> The films and their tools live outside this repo, in `~/projects/terno-launch-films`. Every path below is relative to that folder. Its `STYLE.md` holds the same text: when you change one, change the other.

This guide is how Terno makes its launch and feature videos. Read it before you plan any new film, cut or feature clip. Three films set the standard, and the owner signed them off on 2026-11-23:

| Film | Spine | Length | What it's best for |
| --- | --- | --- | --- |
| `film-a-morning` | **One morning**: one continuous camera take through the real app, light | 77.4 s | Website, pinned post, the honest product tour |
| `film-b-keys` | **Keys**: giant keycaps drop on the beat, and each press becomes the UI it triggers. Blue and white | 73.0 s | The X feed: it reads muted and on a phone |
| `film-c-pile` | **The pile**: a wall of real mail that every action bites into. Dark | 72.0 s | A second post aimed at overloaded inboxes |

The renders are in `renders/`: `Terno - <film> - 4K.mp4`, plus `1080p/` for posting. Each film's `SPEC.md`, `CUES.md` and `REVIEW.md` give its exact numbers. This file gives the rules they share. When the two disagree, the film's own spec wins for that film, and this file wins for new work.

---

## 1. The formula

1. **One spine per film.** Pick one visual idea that carries the whole film, and never mix two:
   - a continuous camera (A)
   - an object that becomes the UI (B: the keycap turns into the search field)
   - a physical metaphor that keeps rebuilding (C: the pile)

   For a new feature, either reuse one of these three or invent a fourth. `STORYLINES.md` lists two unbuilt ideas: kinetic type, and an endless zoom.
2. **The product is the real app.** Every UI frame shows the real app. Each one is a capture of the showcase mailbox, one frame per keystroke, at 4×. Never draw or mock app UI. The AI scenes are the one exception: they are rebuilt from the real components in `shared/kit/`, filled with real model output (the site's pictures) or the site's own example lines.
3. **Every change has a visible cause.** A key press or a cursor click causes each state change, and the key on screen is the real shortcut (`/`, `E`, `1`, `L`, `⌘K`, `⌘;`, `⌘⇧K`). Nothing changes by itself.
4. **No AI first, then AI.** AI is off by default, so the films earn trust without it:
   - Show what's fast without AI.
   - Then land the hinge line: "All of that. No AI." / "No AI yet." / "No AI. Just fast."
   - Then a switch is pressed, the frame floods with colour, and the AI world begins.

   A feature film follows the same rule: if the feature works without AI, never mention AI.
5. **The first 2 seconds hook.** The thumbnail frame (0.0 s) is never blank, and something big moves within 0.5 s. Examples: four inbox names falling into one window, a giant `/` keycap slamming down, a wall of mail racing upward.
6. **Titles carry the story, and the UI proves it.** A viewer with the sound off must follow every beat from the titles alone. Titles sit on flat ground beside the UI, never over it.
7. **It ends on the mark.** The last beat folds into the Terno mark and wordmark, then "The last email client you'll try." and then `Free · Mac and Linux · terno.app`. Hold it for at least 2 s.

### Story order

**A full launch film** (60–78 s):
1. Hook (4–5 s)
2. Unified inbox, kept short
3. Instant search
4. Bulk actions with the "and future mail" offer (archive, then file)
5. Snippets
6. The no-AI hinge
7. The switch
8. What matters
9. Follow-up reminders
10. Summary
11. Drafted reply
12. Ask your mail
13. Agents over MCP
14. End card

**A single-feature film** (20–40 s):
1. Hook: the problem in one frame (2–3 s)
2. The feature acting in the real app, caused by its key (8–20 s)
3. A payoff close-up with an underline on the line that matters (3–5 s)
4. One title pair that names the win
5. End card (4–5 s)

If the feature has an AI variant, it comes after the no-AI version, behind its own switch beat.

---

## 2. Copy

- **Title pairs**: 2–4 words each, full stops, no exclamation marks. The second line turns the first:
  - "Archive one." → "They all go." → "And never come back."
  - "Say it once." → "Reuse it forever."
  - "Same reply again?" → "One keystroke."
  - "Ask your mail." → "Answers, cited."
  - "No answer? It comes back."
- **Sub-lines**: one sentence of concrete fact, in the app's own words. Examples: "100+ conversations in all your accounts", "They fill in the name, too.", "With links to the emails it came from."
- **Underline the proof.** When the app shows the line that makes the claim, underline it in accent for about 1 s. Examples: "Future mail like this is archived too.", or "Priya" filled in by a snippet.
- **Feature names follow the app**: Snippets, What matters (quoted mid-sentence), Ask your mail, Follow-ups.
- **The CTA**: `Free · Mac and Linux · terno.app`. Pricing details stay on the site.
- **Privacy**: only the showcase mailbox and its fictional people (Priya, Isabella Grant, Jonah, Outfitter Co., Fieldnotes Weekly). Never real mail, names or addresses.

---

## 3. Look

These rules hold in every film:
- The authored frame is **1920×1080**, rendered at **3840×2160** (4K) and 30 fps. Use `data-motion-blur="on"` on the root.
- **Type**: SF Pro Display only, from `shared/fonts/`.
  - Titles: Semibold or Bold, 80–112 px, tracking −0.025em, line height about 1.02, left-aligned at x 120–140, two lines at most.
  - Sub-lines: Medium, 30–38 px, muted (white 78–82% on blue).
- **Terno blue `#2F5BFF`** is rationed. Use it for the switch, the flood into the AI world, one accent word or underline per shot, and the end-card mark. Film C uses the app's dark accent `#0084FF` the same way.
- **Ink** `#14161A`, muted `#5B6472`, paper `#F7F8FA`.
- **The window** is the real 1280×800 app at 0.96–1.25×, with a 12–14 px radius and one soft shadow, for example `0 24px 60px rgba(25,35,70,.18)`. Show the traffic lights. It is at least 64% of the frame width, or it bleeds off an edge. Never show a small window floating in a void.
- **AI cards** are white kit components on the blue ground, radius 28, shadow `0 40px 100px rgba(8,20,90,.35)`. Use `--u` 1.7–2.0, so card body text renders at 26 px or more at 1080.

### Per-spine looks
- **A**: ground `#EEF1F6` before the switch, `#2F5BFF` after it, `#F7F8FA` on the end card. Titles 92 px, weight 600.
- **B**: the ground alternates between blue and paper every bar group.
  - Keycaps: white face, gradient `#FFF → #F0F2F7`, radius 30, a 14 px lip `#C3CBE0`, legend at 42% of the cap, shadow `0 26px 50px rgba(10,20,60,.30)`.
  - UI crops sit in white panels, radius 28, shown at 2.0–2.4×.
- **C**: ground `#080D13` (the app's own sidebar), with the AI world on `#121826`. A scrim keeps titles on flat ground. The pile rows sit at 20–35% behind the action.

### Banned in every film
- A dark void with small floating UI.
- Glow, particles, mesh or purple gradients, glass, or a cream-and-serif look.
- Three cards in a row.
- A title over UI or over a dimmed screenshot.
- Fade-and-slide-up on every element.
- Titles that drift after they land.
- A logo docked in a corner.
- Click rings, breathing loops, or bounce on UI panels (springs are for keycaps and the mark only).
- Invented UI.

---

## 4. Motion vocabulary

| Move | Values |
| --- | --- |
| Camera push, pull or travel | `power2.inOut`, 0.6–0.8 s. Clip-path isolation eases with it |
| Arrivals | `expo.out`, 0.5–0.7 s |
| Exits | `power3.in`, 0.22–0.45 s, 40–50% shorter than the arrival, with blur 12 → 0 |
| Title words | per word: opacity 0 → 1 and blur 8 → 0 px in 0.14–0.16 s, 0.07 s apart, **no translate**. Out: reverse, 0.22 s, 0.03 s apart |
| Frame swaps | **hard cuts** (`tl.set` opacity). The app is acting, so never crossfade two captures |
| Key press | face down 5–12 px in 0.07 s `power2.in`, back in 0.14–0.18 s `power2.out`. The shadow shrinks while it's down |
| Keycap landing (B) | y −900 → 0, `elastic.out(1, 0.55)`, 0.7 s. Opacity never bounces |
| Small key appearing (A) | scale 0.6 → 1, `back.out(1.7)`, 0.42 s |
| Panel whip (B) | from 260 px off with blur 14 → 0, 0.3 s `expo.out` |
| Colour flood | clip-path circle from the switch, 0.45 s `power2.inOut` |
| Cursor | macOS arrow, 54–58 px. Moves `power3.inOut`. A click is scale 0.82 for 0.06 s, then back in 0.14 s. No rings |
| Streaming AI text | per word, 0.026–0.034 s apart. Citation chips pop or pulse a ring (never scale a chip inside text: it pushes the full stop) |
| Bites (C) | rows tear out with `power3.in`, 0.03 s stagger |
| The mark | `back.out(1.25)`. Nothing else bounces |

**Rhythm.** A scene runs 4–8 s, and something lands about every 0.5 s. Every key press lands on a music beat. B's whole grid is 120 bpm: 15 frames a beat, 60 frames a bar.

---

## 5. Crispness

The owner's rule: zoom in so the letters look crisp. Sharp UI text is what sells "premium", so follow all of this:

- **Capture at 4×** (DPR 4, 5120×3200 for the 1280×800 window). Films show whole-window frames from the 3200 px copies (`shared/ui3200/`).
- **Punch-ins use 6× crops** (DPR 6), cut to fixed regions in `shared/crops6x/` (see its `REGIONS.md`). A crop placed at the region's CSS box lines up exactly with the 3200 frame. Overlay the crop on whatever you zoom into, and keep the zoom at K ≤ 2.4 on 6× crops.
- **The camera helper** is `cam(fx, fy, px, py, K)`: it puts the window's CSS point (fx, fy) at frame point (px, py), at K frame px per CSS px. `clip(l, t, r, b)` isolates a pane with an inset clip-path in window CSS px.
- **Text floor**: 26 px or more at 1080 for anything meant to be read. Small meta lines may break this; `text_below_floor` is an accepted warning there.
- **Deliver 1080p for phones and X.** Players downscale 4K with a cheap filter, which makes small text shimmer. Run `tools/export-1080p.sh`: a Lanczos downscale, x264 CRF 15, `-tune animation`.

---

## 6. Sound

- **Effects**: from the media-use library (Pixabay licence, `CREDITS.md` in each film's `assets/sfx/`). The families are `key-press`, `click`, `whoosh` (normal, `-low`, `-high` pitch variants), `typing`, `pop`, `riser`, `impact-bass-1` and `whoosh-cinematic`. Alternate the variants so repeats don't sound mechanical.
- **Place by peak, not by start.** Each cue is (scene, picture time, file, volume), and it is placed at `scene start + picture time + 1 frame − PEAK[file]`, so the transient lands one frame after the picture. `build.py` computes this from its `PEAK` and `DUR` tables and writes `CUES.md`.
- **What gets a sound**:
  - a key press, a click, a pop for every panel or offer that appears
  - typing under typed text
  - one whoosh for each camera travel or exit
  - a cinematic whoosh on the flood
  - a riser and a bass impact into the lockup
- **Music**: from the HeyGen catalog via `tools/music-search.mjs`, which works with the HyperFrames sign-in alone.
  - Use only tracks of 60 s or more.
  - Character: "building", confident, light electronic, 100–128 bpm.
  - Run `npx hyperframes beats` on candidates, then run `tools/music-fit.py` to trim and tempo-match (atempo 0.95–1.05) so a beat lands on **the AI switch** and **the lockup**.
  - Put it at `assets/bgm/track.mp3`; `build.py` adds it when the file exists.
  - Volume is 0.55–1.0 under the effects, with a 1.5 s fade-out.
- **Master after rendering**: `tools/norm.sh raw.mp4 final.mp4` runs a two-pass loudnorm to −14.5 LUFS and −1 dBTP, with the video copied.
- **A person must listen before release.** The placement uses measured peaks and beats, but no one has heard the mix until a person plays it.

---

## 7. Pipeline

### Capture the real app
Use `tools/video-shots.mts`. It drives the site's shot pipeline (showcase mailbox, real backend, production web build, network fenced off, a fresh temp profile per sequence). It never touches real profiles.

```bash
cd ~/projects/emailclient/apps/site && unset ELECTRON_RUN_AS_NODE
DPR=4 TZ=America/Los_Angeles ./node_modules/.bin/tsx ~/projects/terno-launch-films/tools/video-shots.mts /tmp/cap4 light,dark snippets
DPR=6 TZ=America/Los_Angeles ./node_modules/.bin/tsx ~/projects/terno-launch-films/tools/video-shots.mts /tmp/cap6 light,dark snippets
```

To add a feature, add a new entry to `SEQUENCES`:
1. Open the right showcase thread and call `blur()` and `still()`.
2. Press the real keys, wait for the real test ids, and call `shot()` after each visible change: one frame per typed character.
3. Add any test id you need to frame to `boxes()`. They land in `rects-*.json`.

### Build the frame library
`tools/frames.sh /tmp/cap4 /tmp/cap6 <region> x y w h …` writes `shared/ui`, `shared/ui3200` and `shared/crops6x/<region>`, and merges the rects. Add the new region to `shared/crops6x/REGIONS.md`, then copy the files into each film's `assets/` (`ui/`, `ui4x/`, `crops6x/`).

### AI scenes
Use the kit (`shared/kit/`): `ai-kit.css` plus `part-*.html` (switch, follow-up, summary, draft, ask, terminal, wordmark). To check a part, open `preview-light.html`, `preview-dark.html` or `preview-ask.html`. When you add a part, prefix its classes (`.tk-ask …`) and avoid generic names: the kit's `.sub` once clashed with a film's `.sub` and broke the layout.

### Author
Each film is generated by its **`build.py`**: `python3 build.py` writes `index.html` and `compositions/*.html`. **Never hand-edit the generated HTML.**

A `build.py` holds:
- one function per scene, returning (id, name, duration, html), appended to `SCENES` in order
- a `TL` helper that collects GSAP calls: `camera`, `clip`, `show_frame`, `words_in`/`words_out`, `key_press`, `cursor`
- `ai_scene()` for the card scenes
- `CUES` for sound
- the music tag

Scene starts are cumulative, so changing one duration shifts every later scene and its cues. Film C's `remap()` shows how to insert scenes without retiming old ones.

### Check
```bash
npx hyperframes lint && npx hyperframes check     # 0 errors
npx hyperframes snapshot --at 0,2.4,7.5,… --no-end --keep   # the QA times in SPEC.md
npx hyperframes snapshot --at 7.5 --zoom "x,y,w,h"          # pixel-check text crispness
```
Look at every snapshot. Check the thumbnail frame, every title landing, every seam between scenes, and the text at 100% zoom.

Accepted warnings:
- `text_below_floor` on small meta text
- `line_unread` on AI answers and agent output, which are shown whole on purpose while the title carries the meaning
- `duplicate_media_discovery_risk` from crops reusing a source

### Render and deliver
```bash
npx hyperframes render --resolution 4k --quality delivery --crf 14 --output raw.mp4
tools/norm.sh raw.mp4 "renders/Terno - <film> - 4K.mp4"
tools/export-1080p.sh "renders/Terno - <film> - 4K.mp4" "renders/1080p/Terno - <film> - 1080p.mp4"
```
**Never delete or overwrite a delivered render.** Before you replace one, move it to `renders/previous/` with a `(v1, …)` note in its name.

### Document
Each film keeps three files:
- **`SPEC.md`** has these fields: GOAL (what the viewer feels or remembers), OUTPUT, TIME (length, frames, music and where its beats land), LOOK, OBJECTS, MOTION, SHOTS (absolute times), BANNED and QA (the times to snapshot).
- **`CUES.md`** is the sound table, generated.
- **`REVIEW.md`** records:
  - the creative calls
  - the measurements
  - the weakest shot
  - the warnings kept, and why
  - what is illustrative and not real output
  - what each round changed

---

## 8. Posting on X

- Post the **1080p** file. X transcodes everything to 1080p or lower anyway.
- **Lead with the B style** in the feed: big keys and titles work muted and on a phone. Use A for the pinned post or the site, and save C for a later post.
- Many viewers leave after 15–20 s. Put the pitch and `terno.app` in the post text. For ads or a main post, cut a 30–40 s version: hook, search, archive, one AI beat, end card.
- The first frame is the thumbnail. Check it at phone size.

---

## 9. Checklist for a new film or clip

- [ ] One spine, named in SPEC.md, with a GOAL in one sentence.
- [ ] A hook in 2 s, and a frame at 0.0 s that is not blank.
- [ ] Every UI frame is a real 4×/6× capture of the showcase mailbox. AI scenes use the kit and real output.
- [ ] Every state change is caused by a real key or a click.
- [ ] Title pairs that read with the sound off, never over UI. The proof line is underlined.
- [ ] No AI shown before the hinge and the switch (unless the film is about an AI feature).
- [ ] Motion follows §4. Nothing that is banned in §3.
- [ ] Sound peaks are aligned; music beats land on the switch and the lockup; the mix is mastered to −14.5 LUFS; someone has listened to it.
- [ ] lint and check are clean; the QA snapshots have been looked at, including at phone size.
- [ ] Rendered in 4K and as a 1080p export; old renders moved to `previous/`, never deleted.
- [ ] SPEC, CUES and REVIEW are up to date.
