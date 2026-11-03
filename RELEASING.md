# Releasing Terno

`pnpm release:mac` starts the release on GitHub and returns straight away. A Mac at GitHub builds, signs and notarizes Terno, then leaves a **draft** release on the Releases page. Nothing reaches users until you review the draft and publish it. (Plan 126; the workflow is `.github/workflows/release-mac.yml`.)

## One-time setup

The keys live in the repository's **`release` environment** (Settings → Environments → release). It is already created and only runs from `main`. Only that workflow reads them; pull requests and forks never see them, and GitHub hides them in logs.

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
for n in TERNO_GOOGLE_DESKTOP_ID TERNO_GOOGLE_DESKTOP_SECRET TERNO_GOOGLE_WEB_ID TERNO_GOOGLE_DESKTOP_DEV_ID TERNO_GOOGLE_DESKTOP_DEV_SECRET; do
  v="$(grep -E "^$n=" .env | head -1 | cut -d= -f2- | sed -E 's/^["'\'']|["'\'']$//g')"
  [ -n "$v" ] && printf '%s' "$v" | gh secret set "$n" --env release && echo "✓ $n"
done
```

The two `_DEV_` ones are optional. With them, accounts you connected in development keep working in the release.

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

You need these eight: `MAC_CERT_P12`, `MAC_CERT_PASSWORD`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `TERNO_GOOGLE_DESKTOP_ID`, `TERNO_GOOGLE_DESKTOP_SECRET` and `TERNO_GOOGLE_WEB_ID`. The release's first step checks them by name and stops if one is missing.

## Making a release

1. Bump `version` in `apps/desktop/package.json`, commit, and `git push`. GitHub builds the commit, so it must be on `main` there.
2. `pnpm release:mac`. It prints the run's link. `gh run watch` follows it, or close the terminal: it runs without you (about 15 to 25 minutes, mostly notarization). GitHub emails you if it fails.
3. Open the draft on the [Releases page](https://github.com/luisiacc/terno/releases), check the notes and the four files (zip, blockmap, `latest-mac.yml`, DMG), and **Publish**. Copies of Terno see it on their next update check.

**Nightly:** `TERNO_VERSION=1.4.0-nightly.1 pnpm release:mac` publishes to the nightly channel as a prerelease.

**On this Mac instead:** `pnpm release:mac --local` builds here as before. It uses your keychain and `.env`, and notarizes only when `APPLE_API_KEY` (the path to the `.p8`), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are set.

## When it fails

The run's log says which step failed and why:

- **"the secret … is missing or empty"**: set it (above).
- **"holds no Developer ID Application identity"**: the `.p12` has the wrong certificate, or the certificate without its private key. Export it again from My Certificates (the row with a disclosure triangle).
- **"isn't notarized"**: check the three `APPLE_API_*` secrets, and that the key wasn't revoked.
- **"v… already exists"**: a release with that version is already on the Releases page. If it's a draft you don't want, delete it there (or `gh release delete v1.4.0`); otherwise bump the version.

A failed run leaves no release behind: if uploading fails halfway, the script deletes its unfinished draft. So you can fix the problem and run `pnpm release:mac` again.

To replace a key, run its `gh secret set` again.
