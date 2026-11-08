# The UI rating

How Terno's everyday screens are scored, and the bar they have to hold (plan 158); the AI screens are a set of their own (plan 161).

## The rule

**Every score, on every rated screen, in every rated style, from both raters, is at least 9 out of 10, on one commit, in two whole rounds in a row.** The second round confirms the first, so a lucky pass can't count; if it falls short, the commit hasn't passed. A series that changes how a rated screen looks or behaves re-rates the styles it touches before it's done, and all of them before a release.

## The screens and styles

Styles: Lumen, Atelier, macOS and Graphite.

Screens: `split_inbox`, `conversation`, `reply_draft`, `new_message`, `list_layout_inbox`, `search`, `command_palette`, `multi_select`, `row_menu`. `scripts/ui-rating/capture.mjs` holds exactly which states are shot, in light and dark, including a 1100x700 window.

Most flows are shared between styles, so raters don't repeat them. Lumen, the default, gets the full hands-on pass. The other styles are rated hands-on only on what they change (where new message lives, the list header, search, the quick filters, the row, category suggestions, the reader's header, the reply controls), with particular care on contrast.

## The AI set (plan 161)

A second set rates the AI features on their own, with AI on a local model stand-in (`scripts/ui-rating/model-stub.mjs`): no keys, no cloud, the same answers every round, nothing leaving the Mac. Rounds of this set run only these screens, and raters score only the AI part of each (the brief names the region); the rest of the window is context. The model's words are fixed and out of scope: what's rated is how the app presents them and lets you act on them.

| Screen | Shots | Rated region |
|---|---|---|
| `summary` | `a01-summary` ◆ | the summary card |
| `ai_draft` | `a02-draft-prompt` ◆, `a03-draft-written` ◆ | ⌘J's row, its strip and the draft it wrote |
| `ask` | `a04-ask-answer` ◆ | the Ask panel: answer, citations, sources |
| `actions` | `a05-actions-preview` ◆, `a06-actions-undo` | an action's preview, then its undo |
| `today` | `a07-today`, `a08-today-digest` | Today and the newsletter digest |
| `followups_replies` | `a09-followup`, `a10-reply-ready` | the follow-up line with Nudge; Reply ready with Use |
| `ai_settings` | `a11-filter-ai`, `a12-writing-style` | Create a filter with AI; Writing style |

◆ also at 1100x700 (`-small`). `scripts/ui-rating/capture.mjs` (`aiPass`) holds the states; each waits for its real ready state, and a state the app can't reach fails the capture.

How it runs:

- `launch({ ai: true })` starts the stub on a free loopback port. Its first launch sets AI up in Settings as a person would (Ollama at the stub, its model, Test, Summarize new mail, follow-ups, Prepare a reply, the daily digest), and turns sender icons and automatic updates off; the rated launch checks those settings survived.
- The clock: the backend starts at the demo's own instant, 22 October 2026 16:00 UTC, and runs on (`TERNO_TEST_NOW`, honored only in the demo mailbox); the window reads the same fixed instant, in UTC. Every round sees the same days.
- Nothing leaves loopback: the backend logs every network decision (`TERNO_TEST_NET_LOG`, demo mailbox only), and the capture fails on any request off loopback, any AI request not to the stub, any request the window's fence refused, or a task the stub doesn't know.
- The demo mailbox is unchanged: every AI screen reaches its state on the mail the everyday set already rates.

```sh
pnpm ui:rate --screens ai --out /tmp/terno-scratch/rating/ai-r00   # the AI set, with brief-ai.md
pnpm ui:gate /tmp/terno-scratch/rating/ai-r00
node scripts/ui-rating/capture.mjs lumen /tmp/shots --screens ai   # the shots alone
```

Without `--screens`, everything is the everyday set, as before. A round's `round.json` freezes its set, screens, shots and the hashes of its brief, capture, stub and demo; the gate checks reports and evidence against it, never against a report's own list. AI scores compare only with AI scores.

## What's scored

Each screen gets an overall and eleven facets. Each facet has a score and `improve`, the specific change that would raise it, so a low number always says what to do.

| | Facet | What it covers |
|---|---|---|
| UI | `typography` | typeface, scale, weights, line length, rhythm |
| UI | `contrast` | color, legibility and accents, in light and in dark |
| UI | `placement` | layout, grid, margins, spacing, alignment to a shared line |
| UI | `hierarchy` | what draws the eye first, and whether it should |
| UI | `controls` | icons, buttons, chips, menus and their states |
| UI | `density` | how much useful content fits, how fast it scans |
| UX | `efficiency` | steps and effort for the job, keyboard flow |
| UX | `clarity` | can a new user tell what things do; is the copy plain |
| UX | `feedback` | selection, draft, error and undo states |
| UX | `consistency` | same thing looks and behaves the same everywhere |
| UX | `accessibility` | legibility, target size, focus |

The scale is in `scripts/ui-rating/brief.md`: 10 is best in class, 8 to 9 stands beside Apple Mail, Mimestream, Superhuman, Spark, Notion Mail and Linear, 7 is a solid product with clear rough edges. **Don't change the scale or the brief to reach the bar.** A rewording that moves scores makes every earlier number meaningless.

## Running a round

```sh
git commit ...                                     # a score belongs to a commit
pnpm ui:rate --out /tmp/terno-scratch/rating/<id>  # about 30 minutes, four raters at a time
pnpm ui:gate /tmp/terno-scratch/rating/<id>        # writes summary.md; exit 1 below the bar
```

`--designs lumen,macos` and `--raters codex` narrow a round while working. Only whole rounds pass the rule. Styles are rated in their own colors ("Style colors"), even where a new install starts Lumen in plan 98's GitHub palettes.

## Keeping the raters independent

The scores mean something only if the raters can't be led. `rate.mjs` holds this:

- Each rater starts in a new session in an empty, randomly named folder outside the repo, with only a shell's environment: no `AGENTS.md`, no memory, no user settings, hooks or MCP servers, nothing kept afterwards.
- It sees only the brief, that round's screenshots and a harness to run a frozen copy of the build, also outside the repo. It never sees an earlier score, how many rounds there have been, what changed or what the bar is.
- Raters have shell access for the app's sake, so the brief also tells them to stay in their folder. That's an instruction, not a wall.
- Claude and Codex rate at the same time and never see each other's work.

Rules for whoever runs it:

- **Never tell a rater** the target, the last score or what you fixed, and never send it back to reconsider.
- **A new round needs a code change,** apart from the confirming round. Re-rolling an unchanged commit until the numbers land proves nothing. Keep every round, and log it in the plan.
- **Fix the app, not the evidence.** Don't change the demo data or what's captured to flatter a screen, and don't drop a feature to raise a score without the owner's say.
- **Raters can be wrong.** A finding that contradicts a product rule (`AGENTS.md`) goes to the owner rather than into the code. It stays in the numbers until then.
- **Report the numbers as they are,** including what stayed under the bar.
