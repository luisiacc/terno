# Releasing Terno

`pnpm release` starts the release on GitHub and returns straight away (`pnpm release:mac` is the same command). Two builds run side by side: a Mac at GitHub builds, signs and notarizes Terno for macOS, and a Linux machine builds the `.deb` and `.rpm` packages for x64 and arm64, installs the x64 one and smoke-tests it. When both pass, a third job leaves one **draft** release with every file on the Releases page. Nothing reaches users until you review the draft and publish it. (Plans 126 and 189; the workflow is `.github/workflows/release.yml`.)

## One-time setup

The keys live in the repository's **`release` environment** (Settings → Environments → release). It is already created and only runs from `main`. Only the two build jobs read them (the Linux job only the Google clients); pull requests and forks never see them, and GitHub hides them in logs. The job that creates the draft holds no secret and is the only one allowed to write to the repository.

Run these from the repo root with the `gh` CLI. Each `gh secret set` without `<` asks you to paste the value, so it stays out of your shell history.

### 1. Signing certificate (Developer ID Application)

In Keychain Access → My Certificates, right-click **Developer ID Application: Luisiacc LLC (…)** → Export… → save as `cert.p12` with a password. Then:

```sh
base64 -i cert.p12 | gh secret set MAC_CERT_P12 --env release
gh secret set MAC_CERT_PASSWORD --env release   # the export password
rm cert.p12
```

### 2. Notarization key (App Store Connect API)

[App Store Connect](https://appstoreconnect.apple.com/access/integrations/api) → Users and Access → Integrations → Team Keys → **+**, access **Developer**. Download the `.p8` (Apple lets you download it only once). Then:

```sh
gh secret set APPLE_API_KEY_P8 --env release < AuthKey_XXXXXXXXXX.p8
gh secret set APPLE_API_KEY_ID --env release    # the Key ID column
gh secret set APPLE_API_ISSUER --env release    # the Issuer ID above the table
```

Keep the `.p8` in your password manager, then delete it.

### 3. Google sign-in clients

These are the same values as in your `.env`. This copies them without printing anything:

```sh
for n in TERNO_GOOGLE_DESKTOP_ID TERNO_GOOGLE_DESKTOP_SECRET; do
  v="$(grep -E "^$n=" .env | head -1 | cut -d= -f2- | sed -E 's/^["'\'']|["'\'']$//g')"
  [ -n "$v" ] && printf '%s' "$v" | gh secret set "$n" --env release && echo "✓ $n"
done
```

There is one client, Terno Desktop (since 2026-11-20, for Google's verification): development builds use it too, so there are no `_DEV_` secrets. The web client (`TERNO_GOOGLE_WEB_ID`) belongs to the web build only and isn't needed here.

Outlook's sign-in (plan 259) needs the Microsoft Entra app registrations' client IDs: "Terno" for releases and "Terno Dev" for development builds. They are public IDs, with no secret, kept with the others:

```sh
for n in TERNO_MICROSOFT_CLIENT_ID TERNO_MICROSOFT_DEV_CLIENT_ID; do
  v="$(grep -E "^$n=" .env | head -1 | cut -d= -f2- | sed -E 's/^["'\'']|["'\'']$//g')"
  [ -n "$v" ] && printf '%s' "$v" | gh secret set "$n" --env release && echo "✓ $n"
done
```

### 4. Sentry source maps (optional)

With this set, each release's source maps go to Sentry, so error reports show readable stack traces. Without it, they're kept for 90 days as the workflow run's `source-maps-…` artifact.

Create an organization auth token at sentry.io → Settings → Auth Tokens, then:

```sh
gh secret set SENTRY_AUTH_TOKEN --env release
```

### Check

```sh
gh secret list --env release
```

You need these eight: `MAC_CERT_P12`, `MAC_CERT_PASSWORD`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `TERNO_GOOGLE_DESKTOP_ID`, `TERNO_GOOGLE_DESKTOP_SECRET` and `TERNO_MICROSOFT_CLIENT_ID` (`TERNO_MICROSOFT_DEV_CLIENT_ID` is optional). Each build's first step checks the ones it uses by name and stops if one is missing. Linux needs nothing more: its packages aren't signed.

## Making a release

1. Bump `version` in `apps/desktop/package.json`, commit, and `git push`. GitHub builds the commit, so it must be on `main` there.
2. `pnpm release`. It prints the run's link. `gh run watch` follows it, or close the terminal: it runs without you (about 15 to 25 minutes, mostly notarization). GitHub emails you if it fails.
3. Open the draft on the [Releases page](https://github.com/luisiacc/terno/releases), check the notes and the eight files, and **Publish**. Copies of Terno on macOS see it on their next update check.
   - macOS: `Terno-<v>-arm64-mac.zip`, its `.blockmap`, `latest-mac.yml` and `Terno-<v>-arm64.dmg`.
   - Linux: `Terno-<v>-linux-amd64.deb`, `Terno-<v>-linux-x86_64.rpm`, `Terno-<v>-linux-arm64.deb` and `Terno-<v>-linux-aarch64.rpm`.

**Linux users** install with `sudo apt install ./Terno-<v>-linux-amd64.deb` (Debian, Ubuntu) or `sudo dnf install ./Terno-<v>-linux-x86_64.rpm` (Fedora), and update by installing the next one: Terno can't update itself on Linux yet, and Settings says so. There's no AppImage on purpose: it can't keep Chromium's sandbox on, which Terno needs for mail (plan 189).


**On this Mac instead:** `pnpm release --local` builds macOS here and drafts it, without Linux. It uses your keychain and `.env`, and notarizes only when `APPLE_API_KEY` (the path to the `.p8`), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are set.

## Nightly

The releases above are the **stable** channel. The **nightly** channel builds itself (plan 257):

- **Every night** (08:17 UTC), `.github/workflows/nightly.yml` starts the same release run for `main`'s tip, unless `main` hasn't changed since the last nightly or a release run is already queued or running. Nothing to push or bump.
- It's versioned `<next>-nightly.<YYYYMMDDHHmm>`, for example `0.1.6-nightly.202611250817`: above the last stable release (or the one in review) and below the next one. Linux packages record it as `0.1.6~nightly.202611250817`.
- It **publishes itself** as a prerelease, never marked "Latest". Stable copies and the site's download links only ever see stable releases. The newest 10 nightlies are kept; older ones, and nightly drafts a cancelled run left, are deleted with their tags.
- **To use it:** in Terno, Settings → About → Updates → Channel → **Nightly**. That copy then takes each new nightly. Switching back to Stable doesn't downgrade: Terno waits for the next stable release that's newer than the nightly it runs.
- **A nightly now:** `pnpm release:nightly`. Like `pnpm release`, it needs a clean tree that is GitHub's `main` tip (push first). It picks the number, starts the build and prints the run's link, or says why there's nothing to build: `main` is already the newest nightly, or a release run is going. It publishes itself when both builds pass. Without this Mac: "Run workflow" on the Nightly workflow in the Actions tab.
- GitHub's schedules are best effort: a night can be late or skipped. A failed nightly emails you like any failed run, and the next night tries again. If `main` moved while a nightly was starting, that run stops with "main moved", and the next night builds the newer tip.

Nightlies come only from the workflow or `pnpm release:nightly`, which decide the same way: `pnpm release` refuses a nightly version, and the release run refuses a nightly whose number isn't the one they would pick. A stable release that's built but still waiting for your review counts as taken, so nightlies after it are numbered for the next version and switching back to Stable never installs older code.

## When it fails

The run's log says which step failed and why:

- **"the secret … is missing or empty"**: set it (above).
- **"holds no Developer ID Application identity"**: the `.p12` has the wrong certificate, or the certificate without its private key. Export it again from My Certificates (the row with a disclosure triangle).
- **"isn't notarized"**: check the three `APPLE_API_*` secrets, and that the key wasn't revoked.
- **The Linux smoke test failed**: the run's log has Playwright's report. `docs/DEVELOPMENT.md` → Linux runs the same test in Docker.
- **"isn't fused as a shipped build" or "Nothing debugs the app" failed** (plan 283): what was built could be started with a debugger, so it isn't kept. The message names each Electron fuse that's wrong; `apps/desktop/scripts/fuses.mjs` holds the table.
- **"a nightly of this commit is …"** or **"doesn't sort above the published …"**: a stable release went into review, or a newer nightly came out, while this nightly was building. Nothing was published; the next night numbers it right.
- **"couldn't publish v…-nightly…"**: the nightly's draft was removed, and the next night builds again.
- **"v… already exists"**: a release with that version is already on the Releases page. If it's a draft you don't want, delete it there (or `gh release delete v1.4.0`); otherwise bump the version.

A failed run leaves no release behind: the draft is made only when both builds pass, and if uploading fails halfway, the script deletes its unfinished draft. So you can fix the problem and run `pnpm release` again.

To replace a key, run its `gh secret set` again.
