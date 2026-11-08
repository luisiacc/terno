# Independent UI and UX rating of a desktop email client's AI features

You are an outside senior product designer rating this app. Be honest and specific. The owner wants a true reading, not encouragement. Everything you need is in this folder; don't look anywhere else on this machine.

## What you're looking at

Terno is a minimalist macOS email client (Electron) with AI features: summaries, drafting, questions about your mail, actions described in plain English, a daily digest, follow-ups and prepared replies. The app offers several visual styles; **you are rating the style called "{{DESIGN}}"**. The screenshots come from the real build, in a 1440x900 window on a Retina display (the `-small` ones in 1100x700), with a fictional demo mailbox. The demo text is generated and partly repetitive, and mixes Spanish and English: don't rate the wording of the fake mail. App copy (labels, buttons, hints) is in scope.

**You are rating only the AI parts of each screen**: the region each row of the table below names. The rest of the window is context, not rated. The AI here is a local stand-in model that gives the same answers every time: rate how the app presents, explains and lets you act on what the model wrote, not the model's words themselves.

Screenshots are in `shots/`, each as `-light.png` and `-dark.png`:

| Files | Screen | What's rated | Rated under |
|---|---|---|---|
| `a01-summary`, `a01-summary-small` | A conversation with its summary card open | the summary card: its header, text, items and controls | `summary` |
| `a02-draft-prompt`, `a02-draft-prompt-small` | ⌘J in a reply: an instruction typed | the AI row in the composer and its states, not the ordinary composer around it | `ai_draft` |
| `a03-draft-written`, `a03-draft-written-small` | The draft ⌘J wrote | the AI row's strip and actions, and the draft as the AI left it | `ai_draft` |
| `a04-ask-answer`, `a04-ask-answer-small` | Ask your mail (⇧⌘K): an answer and its sources | the Ask panel: question, answer, citations, sources and actions | `ask` |
| `a05-actions-preview`, `a05-actions-preview-small` | An action described in plain English, before Apply | the preview: what it will do, the rule, the rows and the controls | `actions` |
| `a06-actions-undo` | The same action applied, with undo offered | the confirmation and its undo | `actions` |
| `a07-today` | Today: what needs you, and the newsletters | the Today list and its sections, including the digest row | `today` |
| `a08-today-digest` | Today's newsletter digest | the digest page | `today` |
| `a09-followup` | A sent question waiting for an answer | the follow-up line and its actions (Nudge, Dismiss, Later) | `followups_replies` |
| `a10-reply-ready` | A reply prepared for mail waiting on you | the prepared reply and its actions (Use, Dismiss) | `followups_replies` |
| `a11-filter-ai` | Create a filter with AI: the rule it wrote, before saving | the AI box and the rule it filled in | `ai_settings` |
| `a12-writing-style` | Settings → AI → Writing style, learned from sent mail | the Writing style page | `ai_settings` |

**Look at every screenshot, in both modes, at full resolution** (open each image with your image-viewing tool). If you can't view images, stop and say so in your report: don't score from file names.

## Try it yourself

Static shots can't show flow. `harness.mjs` in this folder launches the real app on a throwaway demo profile, behind the owner's windows, with AI on the local stand-in (`ai: true`; nothing leaves the machine):

```js
import { launch, shot } from "./harness.mjs";
const { page, close } = await launch({ design: "{{DESIGN_ID}}", dark: false, width: 1440, height: 900, ai: true }); // page is a Playwright Page
try {
  await shot(page, "my-probe", "probes");
} finally { await close(); }
```

`capture-example.mjs` shows how each screen above was reached (its `aiPass`). Put your scripts in this folder, your extra shots in `probes/`, and run them with `node`. Read element test ids off the page, not from any source code. Judge what a flow feels like: focus, position kept or lost, number of steps, what the app tells you while the AI works and after. Don't time anything: speed is measured elsewhere.

{{HANDS_ON}}

## Rules

- Write only inside this folder. Only close apps you launched; other processes may belong to someone else.
- Don't read the app's source or documents, and don't look for other ratings.
- Scope: the AI parts named in the table. Everything else on screen is context; settings and onboarding outside Writing style and the AI filter aren't being rated, even if you pass through them.

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

Score each of the 7 screens on all 11 facets, plus an overall. Each facet has a score and `improve`: **the specific change that would raise that score**, naming what you saw. If you can't support a specific change, say so there rather than inventing one. Only a 10 may leave `improve` empty.

**UI facets**
- `typography`: typeface, scale, weights, line length, rhythm
- `contrast`: color, legibility and accents, in light and in dark
- `placement`: layout, grid, margins, spacing, alignment to a shared line
- `hierarchy`: what draws the eye first, and whether it should
- `controls`: icons, buttons, chips, menus and their states
- `density`: how much useful content fits, and how fast it can be scanned

**UX facets**
- `efficiency`: steps and effort for the job on this screen, keyboard flow
- `clarity`: can a new user tell what things do and what the AI did; is the copy plain
- `feedback`: what the app tells you; working, ready, error and undo states
- `consistency`: the same thing looks and behaves the same across the AI surfaces, and each fits the screen it sits on
- `accessibility`: legibility, target size, focus, as far as you can judge

Also give the AI features in this style, taken together, a `ui` score, a `ux` score and an `overall`, each with one or two sentences.

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
    "summary": {
      "overall": 0,
      "facets": { "typography": { "score": 0, "improve": "" } }
    }
  },
  "strengths": [{ "title": "", "evidence": "" }],
  "issues": [{ "rank": 1, "severity": "high|medium|low", "facet": "typography", "screen": "summary", "title": "", "where": "screenshot or flow", "evidence": "", "fix": "" }]
}
```

Screens are `summary`, `ai_draft`, `ask`, `actions`, `today`, `followups_replies`, `ai_settings`. Give up to 5 strengths and up to 15 issues, the most damaging first. List only real ones: fewer is fine. Mark anything you saw only in one mode.

2. `report.md`, a short critique: your verdict, how it compares to the benchmarks by name, and what you'd change first.

Your final message is only the word `done`, or the reason you couldn't finish.
