# Plan 126: releases build on GitHub

## Request

> so how do i manage releases with the proper keys for prod, when i do a release command, i want it to be done on github so i don't have to wait on my machine, how do i set up github to put that token in the build

> yes set those up and add a small md file at the root with the instructions like the ones above for me to know how to set the env keys up

## What exists

- `pnpm release:mac` (`apps/desktop/scripts/release.mjs`, plan 11 §8.2) builds on the maintainer's Mac: `pnpm build`, then `package.mjs` (sign, notarize, zip, channel file, DMG), then a **draft** GitHub release with `gh`.
- `package.mjs` signs with the best identity in the keychain (`TERNO_SIGN_IDENTITY` overrides) and notarizes when `APPLE_API_KEY` (a path to the .p8) + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` (or the Apple ID trio) are set.
- `scripts/release-env.mjs` (plans 78, 99, 123): a release bakes Terno's DSN (public, in code) and the Google clients from the environment or the git-ignored `.env`: `TERNO_GOOGLE_DESKTOP_ID/SECRET` (required in a release unless set to `""`, which means a fork without one), the optional dev pair, and `TERNO_GOOGLE_WEB_ID`.
- Source maps go to Sentry when the `sentry` CLI is signed in; otherwise they stay in `apps/desktop/.maps/`.
- The repo is public. `.github/workflows/deploy-site.yml` is the pattern (pnpm, node 24, a GitHub environment).

## Design

1. **`.github/workflows/release-mac.yml`**, `workflow_dispatch` only (never `pull_request`, so no fork ever reaches a secret), on `macos-15` (Apple Silicon; free for a public repo). Inputs: `sha` (the commit to build) and an optional `version` (a nightly's `x.y.z-nightly.n`). Inputs reach shell steps only through `env`, never `${{ }}` inside `run`. One release at a time (`concurrency`, no cancelling).
   - Job in the `release` GitHub environment: its secrets exist only there, and the environment allows deployments from `main` only (the maintainer can add a required reviewer).
   - Checks out main's tip (the dispatched ref) and fails unless it is still the `sha` the caller saw (review 2).
   - **Preflight** (`release-ci.mjs check`): every required secret is non-empty, the `sha` is 40 hex characters and `version` is empty or a release version. A missing secret arrives as `""`, which `buildGoogleClients` would read as "a fork, no client", so the preflight is what keeps a release from shipping without Google sign-in.
   - Imports the Developer ID certificate into a throwaway keychain (random password, partition list for codesign so nothing prompts), plus Apple's Developer ID G2 intermediate, puts it first in the search list, and fails unless a "Developer ID Application" identity is there. Writes the .p8 to `$RUNNER_TEMP` and points `APPLE_API_KEY` at it.
   - Optional Sentry: with `SENTRY_AUTH_TOKEN` set, installs the `sentry` CLI and signs it in so `upload-maps.mjs` uploads. The source-map archive is uploaded as a workflow artifact either way (90 days), since the runner's copy disappears.
   - Runs `release.mjs` with `GH_TOKEN` = the job's token (`contents: write`). Removes the keychain and key files in an `always()` step.
2. **`release.mjs`**:
   - Without `--local` and outside GitHub Actions it **dispatches** instead of building: the same early checks as today (gh signed in, version valid, `v<version>` doesn't exist, clean tree), plus HEAD must be GitHub's `main` tip and no `v<version>` tag may exist (it never pushes for you). Then `gh workflow run release-mac.yml --ref main -f sha=<HEAD> [-f version=…]`, and prints the run's URL and `gh run watch`.
   - `--local` keeps today's build on this Mac.
   - In CI (`GITHUB_ACTIONS=true`): the build must be Developer ID signed and notarized (`spctl` says `Notarized Developer ID`); locally both stay warnings.
   - `gh release create` gets `--target <sha>` so the tag points at the commit that was built.
3. **`RELEASING.md`** at the root: the one-time setup (the `release` environment, exporting the certificate, the App Store Connect key, each `gh secret set`), how to release, and what to do when it fails.
4. The `release` environment itself is created now (`gh api`), limited to `main`. The secrets are the maintainer's to add.

## Tests

`apps/desktop/src/release-ci.test.ts`:
- the preflight lists every missing or empty required secret by name, accepts a full set, and rejects a bad `sha` or `version`;
- `dispatchArgs` builds the `gh workflow run` call, with the version only when set;
- the workflow file: `workflow_dispatch` is its only trigger, the job is in the `release` environment, no `run:` interpolates `${{ inputs.* }}` or `${{ secrets.* }}`, every secret the preflight requires is passed to it, and the keychain cleanup runs `if: always()`.

The workflow itself can only be proven by a run, which needs the secrets: the first release after setup is that run.

## Perf

None: build tooling only.

## Out of scope

- Intel or universal builds (arm64 only, as today).
- Publishing the draft automatically: the maintainer still reviews and publishes.
- A tag-push trigger: the version lives in `apps/desktop/package.json`, and the release creates the tag.

## Revisions after the Codex review

The plan critique raised 10 points. Changes made:

1. **electron-builder refused the Developer ID name** (`Please remove prefix "Developer ID Application:"`), so any Developer ID build failed, on a Mac too. `sign-identity.mjs`'s `builderIdentity` drops the prefix for the builder only; `package.mjs` keeps the full name for the hardened-runtime decision and its codesign probe. The test checks the result against app-builder-lib's own prefix list.
2. **An older commit brings older tooling**, and the environment's `main` rule checks the workflow's ref, not a SHA input. The workflow now builds **main's tip** (the dispatched ref, `GITHUB_SHA`) and only compares it with the `sha` input, failing if main moved. `pnpm release:mac` requires HEAD to be main's tip (`isMainTip`). Nothing checks out a caller-named commit.
3. **A leftover tag** would be reused by `gh release create`: `release.mjs` now stops when `v<version>` exists as a tag (`tagExists`).
4. **The keychain:** unlocked with a 6-hour lock timeout and added to the existing search list; it now also signs a scratch file right after the import, so a key codesign can't use fails before the build.
5. **Notarization credentials:** RELEASING.md asks for a *team* key (it has the issuer ID). On GitHub, `package.mjs` throws before building when the notarization trio or the Developer ID is missing, rather than building an un-notarized app; `release.mjs` still checks `spctl` at the end.
6. **Electron's binary:** the install keeps lifecycle scripts (the root postinstall installs it) and doesn't copy the site's `ELECTRON_SKIP_BINARY_DOWNLOAD`.
7. **`hdiutil` flakes on hosted runners:** `create` and `convert` retry up to three times, with a 10-minute timeout each.
8. **Supply chain:** every action is pinned to a commit; the checkout doesn't persist its token; `pnpm install` and the Sentry CLI install run before the certificate or the .p8 is on the runner.
9. **Source maps:** the artifact sets `include-hidden-files`, names only the two `.maps` directories, and uploads even when the build fails. They hold the app's source, which is public here anyway.
10. **Concurrency:** GitHub keeps only the newest *waiting* run in a group, so a third start replaces a waiting second. That's documented in the workflow rather than worked around; releases are started by hand, one at a time.

## What the code review changed

Codex reviewed the implementation (commit 25f2be13) and found three problems, each fixed with a test that fails without the fix:

1. **A failed upload left a draft** (`gh release create` creates the draft before uploading), and that draft blocked the retry with "already exists". `release.mjs` now deletes its own unfinished draft (`deleteFailedDraft`, drafts only) and RELEASING.md says how to clear a stale one.
2. **The signing probe passed when codesign failed:** inside an `&&` chain `bash -e` doesn't stop. The probe is now its own `if !` line; the test runs the workflow's import step with stand-in `security` and `codesign` and expects a failing codesign to fail the step.
3. **The dispatch could print an earlier run's link**, because it took any run created within 5 s before the dispatch. It now uses the URL `gh workflow run` prints, else the first run that wasn't listed before dispatching.
