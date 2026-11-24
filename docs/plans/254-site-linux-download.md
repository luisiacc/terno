# 254: Download for Linux on terno.app; the waitlist is Windows only

## Request (verbatim)

> lets have a download for linux button since we do allow that already, have the windows only for the waitlist

## What exists

- **Linux ships** (plan 189): every release carries `Terno-<v>-linux-amd64.deb`, `-arm64.deb`, `-x86_64.rpm` and `-aarch64.rpm` beside the Mac DMG. v0.1.5 is published (not a draft, not a prerelease) with all four. Terno can't update itself on Linux; a new version is downloaded and installed again.
- **The site** (plan 97): every home design's hero has "Download for Mac" (→ the Worker's `/download/mac`, a 302 to the newest stable release's arm64 DMG, cached 10 minutes, `/download/` when there is none) and a "Windows & Linux · Join the waitlist" link; the closing section has the Mac button again; the waitlist section is "Windows and Linux are coming." with a platform select (Windows, Linux, Mac, Mac Intel). The hero note says "Free · macOS on Apple silicon". The JSON-LD says `operatingSystem: "macOS"`.
- Secondary pages (`privacy`, `download`, `waitlist`, 404) share one quiet column (`parts/pages.tsx`); routes come from `site.ts`, prerendered in both languages.
- The icon set (Hugeicons free) has no Linux mark.

## Design

### The Worker: one lookup, every package

`worker/download.ts` generalizes from the DMG to a table of targets, each a path and the asset it names:

| path | asset |
| --- | --- |
| `/download/mac` | `Terno-<v>-arm64.dmg` |
| `/download/linux/deb` | `Terno-<v>-linux-amd64.deb` |
| `/download/linux/deb-arm64` | `Terno-<v>-linux-arm64.deb` |
| `/download/linux/rpm` | `Terno-<v>-linux-x86_64.rpm` |
| `/download/linux/rpm-arm64` | `Terno-<v>-linux-aarch64.rpm` |

Each picks the newest stable release that has its asset (as the DMG does today, from GitHub's own download host only). One GitHub request fills all five (cached together, 10 minutes, a failure for 1 minute), so the Linux paths add no requests. With no stable package, the Mac still lands on `/download/` (the waitlist stand-in); a Linux package lands on `/download/linux/`, which links to GitHub's releases page as well, so a click never dead-ends or loops (the page's own buttons are the Worker paths, but the page also says where the releases are).

### `/download/linux/` (and `/es/download/linux/`)

A new page kind, `linux`, in the plain column, indexed (people search for a Linux mail client) and in the sitemap:

- "Terno for Linux" and one line: packages for Debian and Ubuntu (.deb) and for Fedora and RHEL (.rpm), for Intel/AMD (x86-64) and ARM (arm64) processors.
- Two groups, each with two buttons (x86-64 first, the common one) and the install command for it in a code line: `sudo apt install ./Terno-*-linux-amd64.deb`, `sudo dnf install ./Terno-*-linux-x86_64.rpm`.
- "Not sure? `uname -m` prints x86_64 or aarch64."
- "Terno can't update itself on Linux yet: when a new version is out, download it here and install it the same way." and a link to every release on GitHub.

### Home designs

- **Hero:** "Download for Mac / Apple silicon" (primary, as today) and "Download for Linux / .deb · .rpm" (each design's secondary button) side by side; the note under them: "Free · macOS on Apple silicon and Linux" and the waitlist link, now "Windows · Join the waitlist".
- **Closing:** both buttons.
- **Waitlist section:** "Windows is coming."; the select loses Linux (Windows first and preselected; the two Mac options stay for the `/download/` stand-in). The Worker still accepts `linux` from a page cached before the change, so an old form never fails; `waitlist:csv --platform=linux` still lists who joined for Linux, so they can be told it's out.
- The Linux button's icon is the terminal (`Terminal`), the closest in the free set; the Mac's stays Apple.
- **JSON-LD:** `operatingSystem: "macOS, Linux"`.

Copy in `en` and `es` together.

### Out of scope

- Detecting the visitor's distribution or processor (a browser on Linux often reports x86_64 under ARM emulation, and a guess that's wrong installs nothing); the page shows all four.
- An apt or dnf repository, GPG signing, Flatpak/Snap/AppImage (plan 189).
- The privacy policy's "the Terno app for Mac" and "macOS Keychain" wording, and "Just your Mac." headlines: the policy is legal text, raised with the owner rather than rewritten here.

## Tests

- `worker.test.ts`: each target picks its own asset from the newest stable release that has it (a prerelease or draft with it is skipped); one GitHub request serves all targets within the cache; the Mac falls back to `/download/`, a Linux target to `/download/linux/`; only GitHub's download host is followed; an unknown `/download/linux/…` is a 404.
- `render.test.ts`: every home design (en and es) has both download links with the right paths and the waitlist link; the waitlist's select has no Linux; `/download/linux/` and `/es/download/linux/` are indexed, in the sitemap, link the four Worker paths and show both commands.
- Site e2e: the new page is axe-clean and fits at 1440 and 390 px, light and dark.

## Perf

Static HTML; the Worker's lookup is shared and cached. No change to the app.

## Revisions after the Codex review

The plan critique raised ten points, all taken:

1. **The waitlist is Windows only everywhere**: no platform select (a hidden `platform=windows`). `/download/` (where a Mac download lands when GitHub is unreachable) no longer asks for a Mac waitlist, since the Mac is published: it says the newest version couldn't be reached and links to GitHub's releases. The e2e test that chose Linux checks there's no select.
2. **Language survives a fallback**: the Mac link and the Linux page's package links carry `?lang=es` on the Spanish pages, and the Worker lands on `/es/download/` or `/es/download/linux/`. `pathIn` maps `linux` to `/download/linux/`.
3. **Routing is tested against the real Worker** (wrangler, e2e): both Linux pages answer 200, `/download/linux` is canonicalized to the slash, each package path is a 302 with `no-store`, an unknown package is a 404, and the sitemap lists both Linux pages.
4. **Each package has its own command** (`amd64.deb`, `arm64.deb`, `x86_64.rpm`, `aarch64.rpm`), with "open the file with your software center" first, and a note to type the full name when an older download sits in the same folder.
5. **"Latest" is GitHub's documented one**: `GET /repos/{repo}/releases/latest` (the newest release that is neither a draft nor a prerelease), not the first match in a list's order. A release without a target's file sends that target to its page.
6. **One lookup at a time**: the in-flight lookup is shared in the isolate, so a rush of clicks on a cold cache asks GitHub once (tested with every target at once).
7. **`no-store` on every package redirect** (`isTarget` in `headers.ts`); the Linux page keeps the pages' revalidation.
8. **The Linux page has its own title and description** in both languages (tested by value); the home page's title and description say "Mac and Linux".
9. **The header's Download goes to the hero's buttons** (`#download`), in all three designs, instead of straight to the DMG.
10. **Coverage**: every design's keyboard test Tabs to the Mac and then the Linux download; the Linux page is axe-clean and fits at 1440 and 390 px in both languages (the plain pages are dark only, so one scheme); the Spanish home already runs at 390 and 320 px.

## Built

- Commands on the Linux page wrap only between words (each word kept whole), so a phone never breaks a file name or scrolls a code box (axe flagged the scroll areas as unreachable by keyboard).
- The package buttons read "Download .deb · x86-64" with the download icon; the home's Linux button uses the terminal icon (the free set has no Linux mark).
- Found on the way, not from this plan: four waitlist tests in `worker.test.ts` fail on Node 24 before this change too: the test's D1 stand-in (`node:sqlite`) rejects the numbered parameters (`?1`…`?4`) that D1 accepts ("column index out of range").

## Revisions after the Codex code review

Six findings, all fixed, each with a test that fails without the fix:

1. **A cancelled first click could strand the rest.** The shared lookup's I/O belonged to the request that began it; cancelled mid-lookup (reproduced in `workerd`), every click waiting on it stayed pending. The lookup is handed to the Worker's `ctx.waitUntil`, and GitHub gets 8 seconds (`AbortSignal.timeout`). Test: one lookup, handed over once, both waiting clicks answered.
2. **A failed Linux package reloaded the page silently.** It lands on `/download/linux/#unavailable`, where a notice (shown only by `:target`, like the waitlist's outcomes) says it couldn't be reached and links every version on GitHub. Tested in the Worker and in e2e (hidden, then shown, axe-clean).
3. **The Mac fallback linked the release that had just failed.** It links every release, not `/releases/latest`.
4. **The e2e test couldn't tell commands apart.** Each package's button and its own command are checked within the same item.
5. **The test cache never expired.** It now honours `max-age` on a clock: a failure is asked again after a minute, a release after ten.
6. **The prerelease test never reached the guard** (its nightly names failed the patterns first): it uses names that would pass.
