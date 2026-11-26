# Independent UI and UX rating of a desktop email client's "People" screens

You are an outside senior product designer rating this app. Be honest and specific. The owner wants a true reading, not encouragement. Everything you need is in this folder; don't look anywhere else on this machine.

## What you're looking at

Terno is a minimalist macOS email client (Electron). **People** is a view of its own, in the sidebar under the Inbox: a list of the people you deal with, those you have something open with first (a promise you made them, their conversation waiting on your reply, a reply they owe you, something they asked of you), then everyone you've written to, with a search that finds people by name or address. Selecting someone shows their page: who they are, what's open between you (each item with Done and Later), and your recent conversations. In a conversation, each person's chip under the subject opens a menu whose head is that person's card: what's open with them and the last time you wrote each other. The app offers several visual styles; **you are rating the style called "{{DESIGN}}"**. The screenshots come from the real build, in a 1440x900 window on a Retina display (`p07` in 1100x700), with a fictional demo mailbox. The demo text is generated and partly repetitive, and mixes Spanish and English: don't rate the wording of the fake mail. App copy (labels, headings, buttons, hints) is in scope.

**You are rating only People**: the People list (its header, search and rows), a person's page, and the person card in a chip's menu. The sidebar, the reader and the rest of the window are context, not rated. The AI here is a local stand-in model that gives the same answers every time: rate how the app presents, explains and lets you act on what the model wrote, not the model's words themselves.

Screenshots are in `shots/`, each as `-light.png` and `-dark.png`:

| Files | State | Screen |
|---|---|---|
| `p01-people` | People: the list beside a person's page | `people_list`, `person_page` |
| `p02-person-hover` | the first item on the page hovered: its Done and Later | `person_page` |
| `p03-people-search` | the list searched for "an", its matches marked | `people_list` |
| `p04-people-everyone` | the list further down: Everyone | `people_list` |
| `p05-person-card` | a conversation's people chip open: the person card at the head of its menu | `person_card` |
| `p06-people-list-layout` | the List layout: a person's page in the list's pane, with its way back | `person_page` |
| `p07-people-small` | a 1100x700 window, a person open | `people_list`, `person_page` |

**Look at every screenshot, in both modes, at full resolution** (open each image with your image-viewing tool). If you can't view images, stop and say so in your report: don't score from file names.

## Try it yourself

Static shots can't show flow. `harness.mjs` in this folder launches the real app on a throwaway demo profile, behind the owner's windows, with AI on the local stand-in (`ai: "stub"`; nothing leaves the machine):

```js
import { launch, shot } from "./harness.mjs";
const { page, close } = await launch({ design: "{{DESIGN_ID}}", dark: false, width: 1440, height: 900, ai: "stub" }); // page is a Playwright Page
try {
  await shot(page, "my-probe", "probes");
} finally { await close(); }
```

People fills in over the first seconds after a launch, as the app reads the mail. `capture-example.mjs` shows how each state above was reached (its `peoplePass`). Put your scripts in this folder, your extra shots in `probes/`, and run them with `node`. Read element test ids off the page, not from any source code. Judge what a flow feels like: focus, position kept or lost, number of steps, what the app tells you. Don't time anything: speed is measured elsewhere.

{{HANDS_ON}}

## Rules

- Write only inside this folder. Only close apps you launched; other processes may belong to someone else.
- Don't read the app's source or documents, and don't look for other ratings.
- Scope: People's list, a person's page and the person card. Everything else on screen is context, even if you pass through it.

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

Score each of the screens `people_list`, `person_page` and `person_card` on all 11 facets, plus an overall. Each facet has a score and `improve`: **the specific change that would raise that score**, naming what you saw. If you can't support a specific change, say so there rather than inventing one. Only a 10 may leave `improve` empty.

**UI facets**
- `typography`: typeface, scale, weights, line length, rhythm
- `contrast`: color, legibility and accents, in light and in dark
- `placement`: layout, grid, margins, spacing, alignment to a shared line
- `hierarchy`: what draws the eye first, and whether it should; can you tell where each person or item stands and where to look
- `controls`: icons, buttons, chips, menus and their states
- `density`: how much useful content fits, and how fast it can be scanned

**UX facets**
- `efficiency`: steps and effort for the job on this screen, keyboard flow
- `clarity`: can a new user tell what each person, item and control is, why it's here and what to do about it; is the copy plain
- `feedback`: hover, selection, open, done and undo states; what the app tells you
- `consistency`: the same thing looks and behaves the same across People, and People fits the app around it
- `accessibility`: legibility, target size, focus, as far as you can judge

Also give People in this style a `ui` score, a `ux` score and an `overall`, each with one or two sentences.

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
    "people_list": {
      "overall": 0,
      "facets": { "typography": { "score": 0, "improve": "" } }
    }
  },
  "strengths": [{ "title": "", "evidence": "" }],
  "issues": [{ "rank": 1, "severity": "high|medium|low", "facet": "typography", "screen": "people_list", "title": "", "where": "screenshot or flow", "evidence": "", "fix": "" }]
}
```

Every one of the three screens, each with all 11 facets. Give up to 5 strengths and up to 15 issues, the most damaging first. List only real ones: fewer is fine. Mark anything you saw only in one mode.

2. `report.md`, a short critique: your verdict, how it compares to the benchmarks by name, and what you'd change first.

Your final message is only the word `done`, or the reason you couldn't finish.
