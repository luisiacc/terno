# Plan 257: a nightly that arrives every night

## Request

> can we have a nightly release channel that i can use ? so the official releases are the stable channel, and i want to use the nightly

## What exists

- **The app already has the channel** (plan 11). Settings → About → Updates offers Stable or Nightly. On Nightly, `engine.ts` sets electron-updater's `channel = "nightly"` and `allowPrerelease`, and its GitHub provider takes the newest release in the Atom feed whose tag is `-nightly.N` (stable tags are skipped), reading `nightly-mac.yml`. `allowDowngrade` is off, so going back to Stable waits for the next stable release.
- **Releases can be nightlies** (plans 11, 126, 189). `TERNO_VERSION=1.4.0-nightly.1 pnpm release` dispatches `release.yml`, which builds main's tip on macOS (signed, notarized) and Linux, and the `draft` job creates a **draft** prerelease that the maintainer must publish.
- **Stable users never see a prerelease.** Stable checks `/releases/latest`, and so does the site's download worker (`apps/site/src/worker/download.ts`). GitHub never makes a prerelease "Latest".
- No nightly has ever been published (`gh release list`: v0.1.0 to v0.1.5, all stable).

So the channel works, but nothing feeds it. A nightly made by hand, then published by hand, isn't a nightly. And electron-updater on Nightly never offers a stable release, so a Nightly copy stays on its last nightly until the next one.

## Design

1. **`.github/workflows/nightly.yml`, the scheduler.** `schedule` (daily, 08:00 UTC, the small hours in the Americas) and `workflow_dispatch` (a nightly now). One job on Ubuntu, `permissions: contents: read, actions: write`, no environment and no secret: it checks out main, then runs `node apps/desktop/scripts/release-ci.mjs nightly`, which decides and, if there is something to build, dispatches `release.yml` exactly as `pnpm release` does (`dispatchArgs`). A `workflow_dispatch` started with the job's `GITHUB_TOKEN` does start a run (GitHub's exception to "a token's events start no workflow"). `release.yml` keeps `workflow_dispatch` as its only trigger: the secrets stay behind a dispatch on `main`, in the `release` environment.
2. **What gets built, decided in `release-ci.mjs`** (pure `nightlyPlan`, with the GitHub reads injected):
   - **Skip** when main's tip is the commit the newest nightly was built from (its tag's commit): idle means idle, and a quiet day costs no Mac runner.
   - **Version:** `<base>-nightly.<YYYYMMDDHHmm>` in UTC, from the run's start. `<base>` is `apps/desktop/package.json`'s version if it isn't released yet (`v<version>` has no tag), else the next patch. So a nightly always sorts above the last stable and below the next one, and nightlies sort by time (semver compares numeric identifiers as numbers; 12 digits are well inside a safe integer). Linux records `0.1.6~nightly.202611250800`, which `packageVersion` already handles.
   - After a stable release, main's tip moved past the last nightly (the version bump at least), so the next night builds `<next patch>-nightly.…` and Nightly copies catch up within a day.
3. **A nightly publishes itself** (`release.mjs draft`): it is still created as a draft (assets upload first, as today), then `gh release edit v<v> --draft=false --prerelease --latest=false`. Stable keeps waiting for review. This holds for a hand-started nightly too (`TERNO_VERSION=…-nightly.n pnpm release`), so "nightly" means one thing. If publishing fails, the draft stays and the run fails: nothing half-published.
4. **Old nightlies are pruned** after one is published: the newest 10 nightlies are kept, older ones are deleted with their tags (`gh release delete --cleanup-tag`). Only releases that are prereleases **and** whose tag matches `v\d+.\d+.\d+-nightly.\d+` are ever candidates (pure `nightliesToPrune`). A copy only ever needs the newest, and the Releases page stays readable. Failing to prune warns; it doesn't fail the run.
5. **`RELEASING.md`** gets a Nightly section: what runs when, how to switch a copy (Settings → About → Updates → Nightly), how to start one now (`gh workflow run nightly.yml` or the Actions tab), and that `pnpm release` is still how stable ships. The Settings hint already says what Nightly means; no UI change.

## Tests

`apps/desktop/src/release-ci.test.ts`, synthetic values only:
- `nightlyPlan`: skips when the tip is the last nightly's commit; builds otherwise; base is the package version when unreleased, the next patch when released; the stamp is UTC `YYYYMMDDHHmm`; the version passes `VERSION` and sorts after the last stable and before the next one (`compareVersions`), and after an earlier nightly.
- `nightliesToPrune`: keeps the newest 10 by version, never a stable release, never a non-prerelease with a nightly-looking tag, never a draft.
- `nightly.yml`: `schedule` and `workflow_dispatch` only; no `secrets.`, no `environment:`; permissions `contents: read` and `actions: write` only; checks out without persisting the token; dispatches through `release-ci.mjs nightly`.
- `release.yml` keeps `workflow_dispatch` as its only trigger (the existing test, unchanged).
- The draft's publish arguments for a nightly (`--draft=false --prerelease --latest=false`) and none for stable.

Proven for real only by a run on GitHub, which publishes a public prerelease: the maintainer starts the first one (`gh workflow run nightly.yml`) after pushing.

## Perf

None in the app. On GitHub: one macOS and one Linux run (~25 min) per night main changed, nothing on a quiet night.

## Out of scope

- A separate "Terno Nightly" app beside the stable one (its own bundle id and profile). One app with a channel switch is what plan 11 built and what T3 Code does.
- Nightly on Linux updating itself: Linux copies don't self-update yet (plan 189); the packages are attached anyway.
- Release notes written for nightlies: GitHub's generated notes (since the previous release) are what a nightly shows.

## Revisions after the Codex review

The critique raised 12 points (`/tmp/terno-scratch/p257/critique.out`). Changes made:

1. **A nightly build wrote `latest-mac.yml`** (confirmed in app-builder-lib 26.15.3: `getResolvedPublishConfig` takes the channel from the version only for the generic provider, and `GitHubPublisher` has no `checkAndResolveOptions`), so `release.mjs` would have failed every nightly: plan 11's nightly path never ran. `release-assets.mjs` now owns the publish config (`publishConfig(version)`), which sets `channel: "nightly"` for a nightly, and `package.mjs` requires exactly `${channelOf(version)}-mac.yml`. The engine sets `updater.channel` on every check, so the `channel` in a nightly's `app-update.yml` changes nothing at runtime.
2. The scheduler step gets `GH_TOKEN: ${{ github.token }}`.
3. **Only main releases:** the scheduler job runs only on `refs/heads/main`, and `release.yml`'s first check now also requires `GITHUB_REF` to be `refs/heads/main` (the environment's branch rule already stopped the build jobs; now every job says so first). The `release` environment has no required reviewer (checked), so a night needs nobody.
4. **A nightly never displaces a stable run waiting in the `release` group** (GitHub keeps one pending run per group): the scheduler skips a night while any `release.yml` run is queued, waiting or in progress. The next night catches up.
5. **Main moving after the plan:** the scheduler reads main's tip from the API right before dispatching, not `GITHUB_SHA`. A push between that and the run's start still fails the run ("main moved"); the next night builds the newer tip. Documented, not retried.
6. **Bump → nightly → stable published from the same commit:** the next night skips (same commit), and Nightly copies keep a nightly built from the very commit the stable release was built from. Nothing to catch up on; when main moves, the next nightly is `<next patch>-nightly.…`. Kept as designed, with a test for that sequence.
7. **Versions only go up:** the base is the larger of the package rule and the newest published nightly's base, and the draft job refuses a nightly that doesn't sort above every published nightly. "Is `v<version>` released" treats only a 404 as no; any other `gh` failure stops the scheduler rather than guessing. Two starts in one minute pick the same tag and the second fails at "already exists", as today.
8. electron-updater takes the **first** nightly in the Atom feed, not the highest. With (7), feed order and version order agree: each nightly is published after, and above, every earlier one.
9. **Publishing is read back:** if `gh release edit` fails, the release is read back; still a draft → deleted (`deleteFailedDraft`) and the run fails; published → success.
10. **Only the CI draft job publishes a nightly**, after both builds passed. `pnpm release --local` with a nightly version still makes a draft (macOS only, maybe not notarized).
11. **Pruning reads every release** (`gh api --paginate`), and deletes by tag only releases that are published prereleases with a nightly tag. A tag left behind by a failed cleanup is harmless (no release, so no copy ever sees it) and is only warned about.
12. **The cron runs at minute 17** (`17 8 * * *`), off the top of the hour GitHub delays first. RELEASING.md says schedules are best effort and how to start one by hand.

## What the Codex code review changed

The review (`/tmp/terno-scratch/p257/review.out`) raised six points. Each fix has a regression test that fails without it:

1. **A stable release in review is taken.** Stable `0.1.6` built from A waits as a draft while main moves to B: tonight's nightly used to be `0.1.6-nightly.…` of B, and switching that copy to Stable would install A's older code over B's newer mailbox (the SQLite downgrade guard then refuses it). `nightlyBase` now counts any release with the package version's tag, draft or published, so that nightly is `0.1.7-nightly.…`. The `isReleased` read is gone: one paginated release listing answers everything.
2. **Nightlies come only from the Nightly workflow.** `pnpm release` (and `--local`) refuses a nightly version, and the draft job's `assertNightlyVersion` requires exactly `nightlyBase(...)-nightly.N` above every published nightly. A hand-typed `1.4.0-nightly.1` can no longer raise every later nightly's base, and a local macOS-only, maybe un-notarized nightly draft can't be made at all.
3. **A run cancelled mid-upload** leaves a nightly draft nothing would publish; pruning now deletes nightly drafts below the newest published nightly (never one above it, never a stable draft).

Skipped as very rare: a second stable dispatch landing between the scheduler's busy check and its dispatch (GitHub would then replace the waiting stable run), and two drafts of one tag created at the same moment by a local and a CI run (local nightlies are now refused).
