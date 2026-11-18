# Independent UI and UX rating of a desktop email client's "What matters" screen

You are an outside senior product designer rating this app. Be honest and specific. The owner wants a true reading, not encouragement. Everything you need is in this folder; don't look anywhere else on this machine.

## What you're looking at

Terno is a minimalist macOS email client (Electron). **What matters** is its first screen: a feed of what needs you, built from your mail by AI models (things you missed, things due today, people waiting on your reply, promises you made, what's coming up, and below that what you already handled). Each item is one sentence, who it's from or for, and when; clicking one opens its conversation beside the feed. The app offers several visual styles; **you are rating the style called "{{DESIGN}}"**. The screenshots come from the real build, in a 1440x900 window on a Retina display (`w05` in 1100x700), with a fictional demo mailbox. The demo text is generated and partly repetitive, and mixes Spanish and English: don't rate the wording of the fake mail. App copy (labels, headings, buttons, hints) is in scope.

**You are rating only the What matters feed**: its header (title, counts, options) and its list, in every state below. The sidebar and the reader beside it are context, not rated. The app is running real AI models, so their words can differ from one run to the next: rate how the app presents, explains and lets you act on what the model wrote. The words themselves are in scope only where the app could have shown them better. Which items appear can differ too.

Screenshots are in `shots/`, each as `-light.png` and `-dark.png`:

| Files | State |
|---|---|
| `w01-feed` | the feed at rest, from its top |
| `w02-feed-hover` | the second item hovered: its Done and Later |
| `w03-feed-reader` | the second item open beside the reader (the feed narrows), the third hovered |
| `w04-feed-further` | further down: the automated mail's row, then Coming up opened |
| `w05-feed-small` | a 1100x700 window, the first item open beside the reader |
| `w06-feed-earlier` | Earlier: what you already handled, newest first |

All of them are rated under the one screen `what_matters`.

**Look at every screenshot, in both modes, at full resolution** (open each image with your image-viewing tool). If you can't view images, stop and say so in your report: don't score from file names.

## Try it yourself

Static shots can't show flow. `harness.mjs` in this folder launches the real app on a throwaway demo profile, behind the owner's windows, with AI on the same real models as the screenshots (`ai: true`):

```js
import { launch, shot } from "./harness.mjs";
const { page, close } = await launch({ design: "{{DESIGN_ID}}", dark: false, width: 1440, height: 900, ai: true }); // page is a Playwright Page
try {
  await shot(page, "my-probe", "probes");
} finally { await close(); }
```

What matters fills in over the first several minutes after a launch, as the app reads the mail. `capture-example.mjs` shows how each state above was reached (its `wmPass`). Put your scripts in this folder, your extra shots in `probes/`, and run them with `node`. Read element test ids off the page, not from any source code. Judge what a flow feels like: focus, position kept or lost, number of steps, what the app tells you. Don't time anything: speed is measured elsewhere.

{{HANDS_ON}}

## Rules

- Write only inside this folder. Only close apps you launched; other processes may belong to someone else.
- Don't read the app's source or documents, and don't look for other ratings.
- Scope: the What matters feed. Everything else on screen is context, even if you pass through it.

## The scale

Benchmark against the best of the category: Apple Mail, Mimestream, Superhuman, Spark, Notion Mail, and for craft, Linear.

- **10** best in class, nothing to take away or add
- **8–9** would stand beside those products; small flaws only
- **7** a solid, shipping product with clear rough edges
- **5–6** works, but looks or feels ordinary, or has real problems
- **3–4** problems a user notices every day
- **1–2** broken

Use the whole range and half points. Give equal scores only where quality really is equal. Every claim must point at something you saw, in a named screenshot or a flow you ran.

**A cell's score is its weakest case:** when a screen differs between light and dark, between window sizes or between its shots, score the worst of them and say which.

## What to score

Score the screen `what_matters` on all 11 facets, plus an overall. Each facet has a score and `improve`: **the specific change that would raise that score**, naming what you saw. If you can't support a specific change, say so there rather than inventing one. Only a 10 may leave `improve` empty.

**UI facets**
- `typography`: typeface, scale, weights, line length, rhythm
- `contrast`: color, legibility and accents, in light and in dark
- `placement`: layout, grid, margins, spacing, alignment to a shared line
- `hierarchy`: what draws the eye first, and whether it should; can you tell where each item stands and where to look
- `controls`: icons, buttons, chips, menus and their states
- `density`: how much useful content fits, and how fast it can be scanned

**UX facets**
- `efficiency`: steps and effort for the job on this screen, keyboard flow
- `clarity`: can a new user tell what each item is, why it's here and what to do about it; is the copy plain
- `feedback`: hover, selection, open, done and undo states; what the app tells you
- `consistency`: the same thing looks and behaves the same across the feed, and the feed fits the app around it
- `accessibility`: legibility, target size, focus, as far as you can judge

Also give the screen in this style a `ui` score, a `ux` score and an `overall`, each with one or two sentences.

## Deliverables

Write both files in this folder:

1. `report.json`, valid JSON, exactly this shape:

```json
{
  "viewed_all_images": true,
  "hands_on": ["what you actually tried, one line each"],
  "overall": { "score": 0, "why": "" },
  "ui": { "score": 0, "why": "" },
  "ux": { "score": 0, "why": "" },
  "screens": {
    "what_matters": {
      "overall": 0,
      "facets": { "typography": { "score": 0, "improve": "" } }
    }
  },
  "strengths": [{ "title": "", "evidence": "" }],
  "issues": [{ "rank": 1, "severity": "high|medium|low", "facet": "typography", "screen": "what_matters", "title": "", "where": "screenshot or flow", "evidence": "", "fix": "" }]
}
```

Give up to 5 strengths and up to 15 issues, the most damaging first. List only real ones: fewer is fine. Mark anything you saw only in one mode.

2. `report.md`, a short critique: your verdict, how it compares to the benchmarks by name, and what you'd change first.

Your final message is only the word `done`, or the reason you couldn't finish.
