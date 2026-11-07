# Independent UI and UX rating of a desktop email client

You are an outside senior product designer rating this app. Be honest and specific. The owner wants a true reading, not encouragement. Everything you need is in this folder; don't look anywhere else on this machine.

## What you're looking at

Terno is a minimalist macOS email client (Electron). The app offers several visual styles; **you are rating the style called "{{DESIGN}}"**. The screenshots come from the real build, in a 1440x900 window on a Retina display, with a fictional demo mailbox. The demo text is generated and partly repetitive, and mixes Spanish and English: don't rate the wording of the fake mail. App copy (labels, buttons, hints) is in scope.

Screenshots are in `shots/`, each as `-light.png` and `-dark.png`:

| Files | Screen | Rated under |
|---|---|---|
| `01-split-inbox` | Split view: sidebar, list, reader. The default layout | `split_inbox` |
| `16-small-split-inbox` | The same in a 1100x700 window | `split_inbox` |
| `15-filtered-unread` | The list with the Unread quick filter on | `split_inbox` |
| `02-split-conversation`, `12-list-conversation` | A conversation of several messages | `conversation` |
| `03-split-draft-open`, `13-list-draft-open`, `17-small-draft-open` | A reply draft open | `reply_draft` |
| `04-split-draft-collapsed` | The same draft put away with Esc | `reply_draft` |
| `05-new-message-empty`, `06-new-message-filled` | New message | `new_message` |
| `11-list-inbox` | List layout: the list at full width, nothing open | `list_layout_inbox` |
| `07-search-results` | Search | `search` |
| `08-command-palette` | Command palette (⌘K) | `command_palette` |
| `09-multi-select`, `14-archive-undo` | Several conversations selected; then archived, with undo offered | `multi_select` |
| `10-row-menu` | Right-click menu on a row | `row_menu` |

**Look at every screenshot, in both modes, at full resolution** (open each image with your image-viewing tool). If you can't view images, stop and say so in your report: don't score from file names.

## Try it yourself

Static shots can't show flow. `harness.mjs` in this folder launches the real app on a throwaway demo profile, behind the owner's windows:

```js
import { launch, setLayout, shot } from "./harness.mjs";
const { page, close } = await launch({ design: "{{DESIGN_ID}}", dark: false, width: 1440, height: 900 }); // page is a Playwright Page
try {
  await shot(page, "my-probe", "probes");
} finally { await close(); }
```

`capture-example.mjs` shows how each screen above was reached. Put your scripts in this folder, your extra shots in `probes/`, and run them with `node`. Read element test ids off the page, not from any source code. Judge what a flow feels like: focus, position kept or lost, number of steps, what the app tells you. Don't time anything: speed is measured elsewhere.

{{HANDS_ON}}

## Rules

- Write only inside this folder. Only close apps you launched; other processes may belong to someone else.
- Don't read the app's source or documents, and don't look for other ratings.
- Scope: everyday mail screens. Settings and onboarding aren't being rated, even if you pass through them.

## The scale

Benchmark against the best of the category: Apple Mail, Mimestream, Superhuman, Spark, Notion Mail, and for craft, Linear.

- **10** best in class, nothing to take away or add
- **8–9** would stand beside those products; small flaws only
- **7** a solid, shipping product with clear rough edges
- **5–6** works, but looks or feels ordinary, or has real problems
- **3–4** problems a user notices every day
- **1–2** broken

Use the whole range and half points. Give equal scores only where quality really is equal. Every claim must point at something you saw, in a named screenshot or a flow you ran.

**A cell's score is its weakest case:** when a screen differs between light and dark, between layouts or between window sizes, score the worst of them and say which.

## What to score

Score each of the 9 screens on all 11 facets, plus an overall. Each facet has a score and `improve`: **the specific change that would raise that score**, naming what you saw. If you can't support a specific change, say so there rather than inventing one. Only a 10 may leave `improve` empty.

**UI facets**
- `typography`: typeface, scale, weights, line length, rhythm
- `contrast`: color, legibility and accents, in light and in dark
- `placement`: layout, grid, margins, spacing, alignment to a shared line
- `hierarchy`: what draws the eye first, and whether it should
- `controls`: icons, buttons, chips, menus and their states
- `density`: how much useful content fits, and how fast it can be scanned

**UX facets**
- `efficiency`: steps and effort for the job on this screen, keyboard flow
- `clarity`: can a new user tell what things do; is the copy plain
- `feedback`: what the app tells you; selection, draft, error and undo states
- `consistency`: same thing looks and behaves the same across screens and layouts
- `accessibility`: legibility, target size, focus, as far as you can judge

Also give the whole app in this style a `ui` score, a `ux` score and an `overall`, each with one or two sentences.

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
    "split_inbox": {
      "overall": 0,
      "facets": { "typography": { "score": 0, "improve": "" } }
    }
  },
  "strengths": [{ "title": "", "evidence": "" }],
  "issues": [{ "rank": 1, "severity": "high|medium|low", "facet": "typography", "screen": "split_inbox", "title": "", "where": "screenshot or flow", "evidence": "", "fix": "" }]
}
```

Screens are `split_inbox`, `conversation`, `reply_draft`, `new_message`, `list_layout_inbox`, `search`, `command_palette`, `multi_select`, `row_menu`. Give up to 5 strengths and up to 15 issues, the most damaging first. List only real ones: fewer is fine. Mark anything you saw only in one mode.

2. `report.md`, a short critique: your verdict, how it compares to the benchmarks by name, and what you'd change first.

Your final message is only the word `done`, or the reason you couldn't finish.
