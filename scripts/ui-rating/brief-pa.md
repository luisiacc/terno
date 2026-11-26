# Independent UI and UX rating of a desktop email client's "Put away" view

You are an outside senior product designer rating this app. Be honest and specific. The owner wants a true reading, not encouragement. Everything you need is in this folder; don't look anywhere else on this machine.

## What you're looking at

Terno is a minimalist macOS email client (Electron). **Put away** lists what the user's rules and Terno's own filing moved out of the Inbox in the last 7 days, and why each one went, so nothing is hidden without a trail. It lives under More in the sidebar. Opening a conversation from it shows the reason in a box under the subject, with one-step fixes (Back to Inbox, and for Terno's filing, Not {category} and Don't file {sender} automatically; for a rule, Edit rule, or Stop this rule when Terno made it). When mail from someone you've written to is put away, the Inbox shows one line about it. The app offers several visual styles; **you are rating the style called "{{DESIGN}}"**. The screenshots come from the real build, in a 1440x900 window on a Retina display (`p05` in 1100x700), with a fictional demo mailbox. The demo text is generated and partly repetitive, and mixes Spanish and English: don't rate the wording of the fake mail. App copy (labels, headings, buttons, hints) is in scope.

**You are rating only Put away**: the Inbox's line about it, the view (its title and help, its sections, each row's reason, the note at its end), and the reason box in the reader with its actions. The rest of the sidebar, the Inbox's other rows and the conversation's own messages are context, not rated.

Screenshots are in `shots/`, each as `-light.png` and `-dark.png`:

| Files | State |
|---|---|
| `p01-inbox-line` | the Inbox, with its one line about mail put away from someone you've written to |
| `p02-put-away` | Put away, opened from that line's Review |
| `p03-box-rule` | a conversation your own rule archived, open with its reason box |
| `p04-box-terno` | a conversation Terno filed into a category kept out of the Inbox, open with its reason box |
| `p05-small` | the same in a 1100x700 window |

All of them are rated under the one screen `put_away`.

**Look at every screenshot, in both modes, at full resolution** (open each image with your image-viewing tool). If you can't view images, stop and say so in your report: don't score from file names.

## Try it yourself

Static shots can't show flow. `harness.mjs` in this folder launches the real app on a throwaway copy of the same mailbox, behind the owner's windows:

```js
import { launch, shot } from "./harness.mjs";
const { page, close } = await launch({ design: "{{DESIGN_ID}}", dark: false, width: 1440, height: 900 }); // page is a Playwright Page
try {
  await shot(page, "my-probe", "probes");
} finally { await close(); }
```

`capture-example.mjs` shows how each state above was reached (its `paPass`). Put your scripts in this folder, your extra shots in `probes/`, and run them with `node`. Read element test ids off the page, not from any source code. Judge what a flow feels like: focus, position kept or lost, number of steps, what the app tells you. Don't time anything: speed is measured elsewhere.

{{HANDS_ON}}

## Rules

- Write only inside this folder. Only close apps you launched; other processes may belong to someone else.
- Don't read the app's source or documents, and don't look for other ratings.
- Scope: Put away (the view, its rows, the reason box in the reader, the Inbox's line about it). Everything else on screen is context, even if you pass through it.

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

Score the screen `put_away` on all 11 facets, plus an overall. Each facet has a score and `improve`: **the specific change that would raise that score**, naming what you saw. If you can't support a specific change, say so there rather than inventing one. Only a 10 may leave `improve` empty.

**UI facets**
- `typography`: typeface, scale, weights, line length, rhythm
- `contrast`: color, legibility and accents, in light and in dark
- `placement`: layout, grid, margins, spacing, alignment to a shared line
- `hierarchy`: what draws the eye first, and whether it should; can you tell why each conversation is here and where to look
- `controls`: icons, buttons, chips, menus and their states
- `density`: how much useful content fits, and how fast it can be scanned

**UX facets**
- `efficiency`: steps and effort for the job on this screen, keyboard flow
- `clarity`: can a new user tell what this view is, why each conversation left the Inbox and how to undo it; is the copy plain
- `feedback`: hover, selection, open and undo states; what the app tells you after each fix
- `consistency`: the same thing looks and behaves the same across the view, and the view fits the app around it
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
    "put_away": {
      "overall": 0,
      "facets": { "typography": { "score": 0, "improve": "" } }
    }
  },
  "strengths": [{ "title": "", "evidence": "" }],
  "issues": [{ "rank": 1, "severity": "high|medium|low", "facet": "typography", "screen": "put_away", "title": "", "where": "screenshot or flow", "evidence": "", "fix": "" }]
}
```

Give up to 5 strengths and up to 15 issues, the most damaging first. List only real ones: fewer is fine. Mark anything you saw only in one mode.

2. `report.md`, a short critique: your verdict, how it compares to the benchmarks by name, and what you'd change first.

Your final message is only the word `done`, or the reason you couldn't finish.
