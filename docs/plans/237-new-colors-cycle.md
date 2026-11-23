# Plan 237: a new category or account takes the next color

- **Status:** shipped.
- **Builds on:** plan 194 (the palette, `CATEGORY_COLORS`), plan 158 (accounts started neutral; this reverses that), plan 169 (accounts in the sidebar's order).
- **Request (verbatim):** "when creating categories and accounts, lets cycle the colors that we use, so they don't always get the same color, lets also have into account if the user changed the color of the last account/category so we don't create a category with the same color as the current last-category."

## 1. What exists

- **Categories.** Three windows pick the color themselves, each as `CATEGORY_COLORS[categories.length % 8]`: the sidebar's "+" (`apps/web/src/lib/new-category.ts`), the category picker's "Create" (`components/category-picker.tsx`) and Settings → Categories (`components/settings/categories-tab.tsx`). Delete one and the next new one repeats a color still in use; recolor the last one and the new one can match it. The command palette's Move to / Add to "Create" uses the picker's helper. The MCP server's "add to a category by name" hard-codes `brown`. A "Do this to similar" sweep that makes a category (`packages/backend/src/actions.ts`) takes the first unused color, else `length % 8`. Import gives a category it creates the file's color (one that merges by name keeps its own). Demo seeding (`seedDemo`, both stores) writes its dataset's colors directly and stays as it is.
- **Accounts.** Every new account is `slate` (`NEW_ACCOUNT_COLOR` in `packages/backend/src/handlers.ts`, three sites: IMAP, Gmail in desktop, Gmail by token on the web). Plan 158 made them neutral; the owner now wants them colored like categories.

## 2. Design

One rule in `@terno/core`, beside `categoryColor` (`packages/core/src/types.ts`):

`nextColor(taken: readonly string[]): CategoryColor`, where `taken` is the colors of the categories (or the accounts) there now, **in sidebar order**:

1. Start at the palette slot after the **last** one's color (normalized with `categoryColor`, so a retired or unknown color counts as its successor or slate). With none, start at the first slot (rose).
2. From there, walk the palette once and take the first color nobody uses.
3. When all eight are used, take the slot after the last one's color.

So new ones cycle through the palette; a new one never matches the one just above it, including after its owner recolored that one; and while the palette has a free color, no color repeats.

Categories and accounts cycle separately: they're different lists in the sidebar (dots and diamonds, plan 194).

**Where it runs: the backend.** `categories.create`'s `color` becomes optional; without one the handler reads the list and picks `nextColor`. The three windows and the MCP server stop sending one, so the rule lives in one place and every creator of a category (window, agent, sweep) follows it. A caller that names a color (an import, tests, an agent that wants one) still gets it. The sweep in `actions.ts` uses `nextColor` too. The three account sites use `nextColor` over `store.accounts.list()` (already read there for the label), and `NEW_ACCOUNT_COLOR` goes.

Existing accounts and categories keep their colors: nothing is migrated.

## 3. Tests

- `packages/core/src/themes.test.ts` ("category colors"): empty → rose; cycles in palette order; skips used colors; after the last one's color even when that one was recolored (`[rose, amber]` → lime; with amber recolored to cyan → brown); all eight used → the slot after the last's; a retired/unknown last color is read as its successor/slate.
- `packages/backend/src/settings-edits.test.ts`: `categories.create` without a color takes the next one, and after the last category is recolored the next skips past it; a named color is kept. Two IMAP accounts get rose then amber; after recoloring the second, the third follows that one.

## 4. Perf and resources

One `categories.list()` per create (a few dozen rows), no new I/O for accounts. Nothing on a hot path.

## 5. Out of scope

- Recoloring existing slate accounts.
- A color choice in the create flows (Settings and the account menu already recolor).

## 6. Revisions after the Codex review

The critique made eight points; what changed:

1. **Read-then-create isn't atomic** (two creates at the same instant could pick the same color). Not fixed: it needs two creates within one store round trip, the result is only a repeated color the user can change, and the windows' old `length % 8` had the same race. Making it atomic would put the palette rule into both stores' contracts for a cosmetic default.
2. `backend.test.ts` asserted a new IMAP account is slate: it now expects violet, the color after the fixture's brown account.
3. The command palette's Create goes through `category-picker.tsx`'s helper, so it is covered by the same change (named above).
4. Seeding and import are named as exceptions above.
5. The category test reorders so that the last in sidebar order and the newest give different answers (amber vs violet).
6. `google-connection.test.ts` asserts the cycle for desktop Gmail (four accounts) and Gmail on the web (two).
7. The sweep (`actions.test.ts`: after rose, cyan → brown; the old first-free rule gave amber) and the MCP server (`mcp.test.ts`) assert the color they create; both fail with the old rules.
8. No screenshots or UI rating: nothing is drawn differently, only which of the existing palette colors a new item starts with.

