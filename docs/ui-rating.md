# The UI rating

How Terno's everyday screens are scored, and the bar they have to hold (plan 158).

## The rule

**Every score, on every rated screen, in every rated style, from both raters, is at least 9 out of 10, on one commit.** A series that changes how a rated screen looks or behaves re-rates the styles it touches before it's done, and all of them before a release.

## The screens and styles

Styles: Lumen, Atelier, macOS and Graphite.

Screens: `split_inbox`, `conversation`, `reply_draft`, `new_message`, `list_layout_inbox`, `search`, `command_palette`, `multi_select`, `row_menu`. `scripts/ui-rating/capture.mjs` holds exactly which states are shot, in light and dark, including a 1100x700 window.

Most flows are shared between styles, so raters don't repeat them. Lumen, the default, gets the full hands-on pass. The other styles are rated hands-on only on what they change (where new message lives, the list header, search, the quick filters, the row, category suggestions, the reader's header, the reply controls), with particular care on contrast.

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

`--designs lumen,macos` and `--raters codex` narrow a round while working. Only a whole round passes the rule.

## Keeping the raters independent

The scores mean something only if the raters can't be led. `rate.mjs` holds this:

- Each rater starts in a new session in an empty, randomly named folder outside the repo: no `AGENTS.md`, no memory, no MCP servers, nothing kept afterwards.
- It sees only the brief, that round's screenshots and a harness to run the frozen build. It never sees an earlier score, how many rounds there have been, what changed or what the bar is.
- Claude and Codex rate at the same time and never see each other's work.

Rules for whoever runs it:

- **Never tell a rater** the target, the last score or what you fixed, and never send it back to reconsider. A score you disagree with gets a new round.
- **Fix the app, not the evidence.** Don't change the demo data or what's captured to flatter a screen, and don't drop a feature to raise a score without the owner's say.
- **Raters can be wrong.** A finding that contradicts a product rule (`AGENTS.md`) goes to the owner rather than into the code. It stays in the numbers until then.
- **Report the numbers as they are,** including what stayed under the bar.
