# Plan 84: Support Terno (voluntary contributions)

- **Status:** proposed. Nothing is built. Ships **before** plan 85 (Free + Pro) and doesn't depend on it or on plan 50's Worker.
- **Builds on:** `9d3d661e` (main).

## The request

> we're going to do this for pricing lets make multiple plans, one for the subscriptions, another one for donations, donations will be done first
>
> for subscriptions lets leave the teams plan for later too, for now only free and pro, pro just has ai features.
>
> write the plans for now only, so we can implement them later.

The pasted pricing document, the parts this plan covers (§5, and the donation rows of §6 and §8):

> **Supporter: $5+.** One-time, yearly, or monthly. Optional contributions to support independent development.
>
> I would create a dedicated page called Support the Project. "Love the app? Support its development. The core email experience is free. Your support helps keep it fast, private, and independent." One-time / Yearly / Monthly; $15/year, $25/year, $50/year … I would default to $25 annually, but keep the other options available.
>
> Supporters could get an optional badge, a thank-you email, and recognition on the website if they choose. No paid features need to be unlocked. Crucially, people should never need to donate to continue using Free. A Pro customer also shouldn't feel expected to donate.
>
> | User donates once | One charge, optional thank-you |
> | User supports annually/monthly | Recurring charge, cancelable at any time |
>
> I would have two distinct billing records: `subscription` for the paid product, and `contribution` for voluntary support. Recurring contributions should also have clear renewal and cancellation controls.
>
> Launch the Support page at the same time. One-time, yearly and monthly contributions. No complicated rewards system.
>
> Support — Help keep great email software independent. A voluntary contribution from people who love the app.

## What exists

- **No accounts, no server, no payments.** Plan 50 (Cloudflare Worker, accounts, signed entitlements) is proposed, not built. Plan 82 (license keys and tiers) was dropped unmerged on 2026-10-31.
- **External links** open in the system browser: the renderer calls `window.ternoDesktop.openExternal(url)` (`apps/desktop/src/preload.ts:36`), main opens only `https:`/`mailto:` with `shell.openExternal` (`app.ts:624`, `:688`). The updater already uses it for release notes (`apps/web/src/lib/updates.ts:52`). The web build opens a new tab. A link the user clicks is outside local mode's scope (plan 05 §B: "an explicit user action outside the app"), so this works in local mode with no new network purpose.
- **Settings** sections are a closed list (`apps/web/src/components/settings/tabs.ts`, `SettingsTab` in `~/state/app`); the command palette offers each one.
- **App menu** (`apps/desktop/src/menu.ts`): About, Check for Updates…, Services, Hide, Quit.
- **Build-time constants for releases** live in `scripts/release-env.mjs` (the Sentry DSN pattern, plan 78): a release build bakes them in, dev/demo/test builds don't.
- **License:** BSL 1.1 with a 15-person Additional Use Grant (README → License). Contributions don't change it, and this plan doesn't touch it.

## Design

### Principle: zero infrastructure, zero data

The first version needs no server and sends nothing. The app shows the choice and opens the payment provider's **hosted checkout** in the browser. The provider charges, sends the receipt and the thank-you email, and runs the customer portal where recurring contributions are changed or cancelled. Terno learns nothing in the app: no install id, email or locale goes into the URL, no request is made, no state is stored besides "the user opened the page".

That keeps every principle: no network from the app (local mode untouched), no work until the page is opened, nothing to keep running, and nothing that can break mail.

### The payment provider

Pick **one** provider for both this plan and plan 85, so there is one tax setup, one dashboard and one customer portal. Requirements:

1. **Merchant of record** (it handles VAT and sales tax), because Pro will need one anyway.
2. Its acceptable-use policy allows **voluntary contributions/tips to a software developer** (not a registered charity). Some MoRs exclude donations; check this first, in writing.
3. Hosted checkout with a **customer-chosen amount** for one-time **and** recurring (monthly, yearly) payments, plus recurring products at fixed prices.
4. A **customer portal** for cancelling and changing recurring payments, reachable without a Terno account.
5. Webhooks (unused now; plan 85's Worker will record contributions, see "Later").

Candidates to verify against those: Lemon Squeezy, Paddle, Stripe (Managed Payments if it is offered in the developer's country; otherwise Stripe Checkout with Stripe Tax, where tax registration is ours). Open question 1.

### Wording: "support" and "contribution", not "donation"

Terno is not a charity, so a payment isn't a tax-deductible donation. The UI says **Support Terno** and **contribution**, and says plainly: "Contributions are voluntary and don't unlock anything. They aren't tax-deductible." The page never implies Free needs it, and Pro subscribers see the same calm page with no extra prompts.

### Products (configured at the provider)

| Kind | Amounts | Default |
|---|---|---|
| One-time | $10, $25, $50, or **Other amount** (from $5) | $25 |
| Yearly | $15, $25, $50, or **Other amount** (from $15) | **$25** (the page opens here) |
| Monthly | $3, $5, $10, or **Other amount** (from $3) | $5 |

Every cadence has an "Other amount" so someone can give more than the presets. The floor of a recurring custom amount is that cadence's lowest preset.

USD only at first. Each preset is its own checkout URL (a provider product or price), each cadence's "Other amount" is a pay-what-you-want product (one-time, monthly, yearly). The URLs live in one module, `packages/core/src/support.ts`:

```ts
export type SupportCadence = "once" | "yearly" | "monthly";
export interface SupportOption { cadence: SupportCadence; cents: number; url: string }
export const SUPPORT: { options: readonly SupportOption[]; customUrls: Record<SupportCadence, string>; manageUrl: string; defaults: Record<SupportCadence, number> } | null;
```

The table is generated at build time from `scripts/release-env.mjs` (`TERNO_SUPPORT`), like the DSN: release builds get our URLs, forks and dev builds get `null` and the entry points are hidden. A unit test checks every URL is `https:` on the provider's checkout host, so a typo can't send someone elsewhere.

Amounts are shown with `Intl.NumberFormat(locale, { style: "currency", currency: "USD" })`, so "$25" reads naturally in `en` and `es` ("25 US$"), never as hand-written strings in the catalog.

### Where it appears (no nagging)

- **Settings → Support Terno**, a new last section (heart icon, `settings.tab.support`), so the command palette offers it as "Settings → Support Terno".
- **App menu**: "Support Terno…" below "Check for Updates…" (desktop); it opens the settings section.
- **Nothing else.** No badges, banners, launch prompts, counters or "you've used Terno for N days" messages. If a gentle one-time mention is wanted later, it needs its own decision.

### The page

Hairline layout like the other settings sections:

1. Heading "Support Terno" and two sentences: "Terno's email client is free. Your support keeps it fast, private and independent."
2. A segmented control **Yearly · Monthly · One-time** (Yearly selected), roving arrow keys, `role="radiogroup"`.
3. The amounts for that cadence as a radio group; the default is selected. Each cadence ends with "Other amount" (the provider asks for the amount; the floor is shown, see the table).
4. A summary line: "$25 per year" / "$5 per month" / "$25 once".
5. Primary button **Continue in browser** (an external-link glyph, with "opens your browser" in its accessible description). It opens the option's URL. The page then shows a quiet line: "Finish in your browser. Thank you!" No polling for completion; there's nothing to poll.
6. Footer, small and secondary: "Voluntary, and it doesn't unlock anything. Not tax-deductible." and a link **Manage a recurring contribution** (the provider's portal).
7. Optional website recognition is asked **at checkout** (a provider custom field, "Show my name on the supporters page", default off), never in the app.

Keyboard: Tab reaches the cadence group, the amount group, the button and the link; arrows move inside groups; Enter/Space activate. Focus rings follow plan 54. Motion: none beyond the existing selection transitions (≤ `--motion`).

The last cadence and amount chosen are kept in renderer state for the session only (not persisted: nothing worth remembering).

### Web build

Same section and the same URLs, opened with `window.open(url, "_blank", "noopener,noreferrer")`. No CSP change: navigation isn't `connect-src`.

### Records: `contribution` stays separate from `subscription`

At the provider, contributions are their own products, never mixed with Pro's. When plan 85's Worker exists, its webhook handler stores them in their own `contributions` table (see "Later"), never in `subscriptions`, so a contribution can never grant or affect Pro.

## Copy (`en` and `es` together)

`settings.tab.support`, `menu.supportTerno`, `support.title`, `support.lead`, `support.cadence.{yearly,monthly,once}`, `support.amount.other`, `support.summary.{yearly,monthly,once}` (with an `{amount}` slot), `support.continue`, `support.continue.description`, `support.thanks`, `support.voluntary`, `support.manage`. Spanish uses "Apoya Terno" and "aportación".

## Tests

- **Unit (`packages/core`)**: `SUPPORT` shape; every URL is `https:` on the allowed checkout host; defaults exist for each cadence; `null` config hides everything.
- **Unit (build)**: `release-env.mjs` gives a release build the table and dev/test builds `null`; an override env replaces it.
- **Component/unit (`apps/web`)**: changing cadence selects that cadence's default; the summary formats via `Intl` in `en` and `es`; Continue calls the opener with exactly the selected option's URL and nothing appended.
- **E2E (`apps/web/e2e/support.spec.ts`)**, with a test table injected: open from the palette; arrow keys across cadence and amounts; Continue opens a new page at the expected URL (Playwright `context.waitForEvent("page")`); the thank-you line appears; axe clean in light and dark; a test that **no request** leaves the page while it is open or on Continue (route spy). Tagged `@design` so it holds in every design.
- **Desktop**: menu test (`menu.test.ts`) for the item and its action; the packaged smoke opens the section and checks `openExternal` receives the URL (stubbed `shell.openExternal`).
- **Screenshots**: the section in light and dark, looked at.

## Performance and resources

- The section is a lazy chunk like the other settings tabs; nothing in the entry chunk but the tab descriptor.
- No network, timers or storage. `pnpm test:ui-perf` unchanged.

## Out of scope

- Any server, account or webhook (comes with plan 85's Worker).
- An in-app supporter badge, supporter recognition page on terno.app, thank-you emails beyond the provider's receipt.
- Currencies other than USD, regional pricing.
- Any change to the license (README, LICENSE).
- Pro and Teams (plan 85; Teams later).

## Later (after plan 85's Worker exists)

- The webhook records contributions (`contributions`: account or anonymous provider customer id, cadence, amount, status, period end) separately from subscriptions.
- An optional "Supporter" badge in Settings → Account for signed-in users who choose to show it. Never shown to others, never gates anything.
- Opt-in recognition on terno.app driven by the checkout field.

## Decisions (2026-10-31)

1. **Provider:** one merchant of record for both plans, chosen only once it passes revision 6's sandbox gate (contributions allowed in its terms). Not picked yet.
2. **Amounts:** as proposed (one-time $10/$25/$50, yearly $15/$25/$50, monthly $3/$5/$10), **plus an "Other amount" on every cadence** so people can give more.
3. **Web:** the web build shows the page too, same URLs.

## Revisions after the Codex review

Codex (read-only, against `9d3d661e`) raised 11 points; all are accepted. The critique is kept at `/tmp/terno-plans-84-85/critique-84-support-terno.txt`. Each revision replaces what the earlier sections say.

1. **Opening the browser can fail, and the page says so.** Today `openExternal` is fire-and-forget (`preload.ts:36` uses `ipcRenderer.send`; `app.ts:687–688` drops `shell.openExternal`'s promise). Support adds an `invoke` variant (`terno:open-external-checked`) that resolves `{ ok: true } | { ok: false }` from `shell.openExternal`, used by Continue and Manage. Only on `ok` does the page show "Finish in your browser. Thank you!"; on failure it says "Terno couldn't open your browser. Copy the link and open it yourself." with a Copy link button. On the web, `window.open` with `noopener` can't report failure, so the web page shows the link as a real `<a target="_blank" rel="noopener noreferrer">` (the browser's own handling, nothing to detect) and the thank-you line is phrased "Your browser opened a new tab to finish". Tests: desktop rejection shows the recovery; Copy link copies exactly the URL.
2. **The menu item has a full command path.** "Support Terno…" is a new renderer command: added to the preload whitelist (`print-commands.ts:8`, `preload.ts:113–115`), typed in `desktop.d.ts:47`, dispatched in `apps/web/src/lib/keyboard.ts` (`:225–229`) to open Settings → Support. With every window closed on macOS (`app.ts:637–640` drops commands today), main first creates or restores the window, then sends the command once the renderer is ready. Tests: `menu.test.ts` for the item; the packaged smoke selects it with no window open and finds the section.
3. **Build precedence is explicit.** `TERNO_SUPPORT` follows this order: set (even empty) → that value (`""` = hidden); else a release build (`TERNO_RELEASE=1`) → ours; else hidden. Test and demo builds pass `TERNO_SUPPORT=""` explicitly in their scripts, as desktop does for its test config (`apps/desktop/scripts/build.mjs:45`), rather than relying on the absence of `TERNO_RELEASE`. Forks that run `scripts/release.mjs` (which sets `TERNO_RELEASE=1`, `:38`) are told in the README's build section to set `TERNO_SUPPORT=` like `TERNO_SENTRY_DSN=`. A build test checks that the main bundle and the renderer bundle carry the same value.
4. **Config crosses one boundary.** `packages/core/src/support.ts` holds only the schema (zod) and pure helpers (`parseSupportConfig`, `formatAmount`), no constant. The value is injected at the app boundary: Vite `define` for the renderer (`apps/web/vite.config.ts:117–125`); desktop main doesn't need it (the renderer passes the chosen URL, and main validates it, see 5). Unit tests construct configs directly.
5. **URLs are validated, and the promise is checked against the provider.** The schema requires `https:`, no credentials, no port, and the checkout host and the portal host each from their own allowlist; `release-env.mjs` validates the table at build time and fails the build on a mismatch. Main's checked opener accepts only URLs present in the baked table. Before launch, a manual **sandbox acceptance checklist** (kept in this plan once the provider is chosen) proves each option's amount, USD, cadence and each cadence's custom minimum match what the checkout shows.
6. **Provider feasibility is a gate, and merchant of record is mandatory.** Implementation starts only after the chosen provider is shown, in its sandbox, to do exactly this flow: static checkout links (no API call from us), pay-what-you-want with a minimum for one-time, monthly and yearly payments, monthly and yearly recurring prices, and cancelling a recurring contribution from a fresh browser through the portal without a Terno account; plus its terms allowing contributions. The Stripe Checkout + Stripe Tax fallback is **removed** (it would make tax registration ours, contradicting requirement 1). If no merchant of record passes, the plan stops for a decision.
7. **"Other amount" is its own state.** The selection is `{ cadence; kind: "custom" } | { cadence; kind: "preset"; cents }`, for every cadence (decision 2). With custom selected the summary reads "You choose the amount in your browser (from $5)" / "(from $15 a year)" / "(from $3 a month)". Switching cadence restores the last choice made in that cadence, custom included, or its default preset the first time. Tests cover each transition.
8. **The e2e checks the popup, not "no request".** Before clicking, the test routes the provider hosts at the context level and fulfills the popup's first navigation with a stub page; it asserts the popup URL equals the selected option's URL exactly (no query or fragment added) and that the Terno page itself made no request while the section was open. Production payment hosts stay blocked for the whole suite.
9. **Settings tabs aren't lazy one by one.** `settings-dialog.tsx:9–17` imports every tab eagerly; only the dialog is lazy (`app.tsx:35`). Support's panel is small (no dependencies beyond the existing UI parts), so it joins the dialog chunk like the others; the entry-chunk gate already covers that. No per-tab dynamic import.
10. **Session state lives outside the panel.** The selection is held in the renderer's app state (`~/state/app`, session-only, not persisted), so it survives switching tabs and closing the dialog (the panel unmounts in `TabsContent`). The page opens on Yearly · $25 only the first time in a session. A test leaves and reopens the section and finds the same selection, with focus where plan 47 restores it.
11. **No recognition field yet.** The checkout asks nothing beyond what the provider needs for payment. Recognition on terno.app waits for a design that covers publishing, withdrawal and removal. The "zero data" line is narrowed: Terno sends no identity from the app; the payment provider receives the billing details the user enters there, under its own privacy policy, which the page links.
