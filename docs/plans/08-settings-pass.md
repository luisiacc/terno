# Plan 08: settings pass (reachable, accessible, editable)

- **Status:** shipped (§5).
- **Builds on:** plan 07 as shipped (`52d1027..f3ba8d6`): General is inset-grouped; every other tab kept its own layout.
- **Request:** "Go through settings and make sure all pages are accessible and everything inside them is editable."

## 1. How the audit was done

- The e2e fixture (backend-dev with the seeded mailbox, production renderer build, 1440×900 @2x) driven by a scratch Playwright script: gear → every tab, axe-core on the dialog in light and dark, the accessible name of every control, an ARIA snapshot, a screenshot per tab, then the tab list with the keyboard, Esc, and the palette.
- The code behind each control, followed to the RPC and both stores: `settings-dialog.tsx`, `settings/*`, `filters-dialog.tsx`, `web/storage-section.tsx`, `packages/backend/src/{settings,handlers,core,agent-socket}.ts`, `AppSettings`/contract in `packages/core/src/rpc/contract.ts`, `packages/db/src/repos.ts`, `packages/idb/src/mail.ts`.

axe (before): General 3 violations (critical `button-name`, critical `label`, serious `aria-toggle-field-name`), IA 1 critical (`button-name`), Agentes 1 serious; the same in dark. No contrast violations in Terno light/dark (the other 11 themes weren't covered by any settings check).

## 2. Findings

### Reachability

| Page | Control | Problem | Fix |
|---|---|---|---|
| All | Tab list | `orientation="vertical"` never reaches Base UI: `packages/ui` `Tabs` destructures it for the data attribute and drops it, so tabs are `data-orientation="horizontal"` and ↑/↓ do nothing (only ←/→, which a vertical list doesn't suggest) | pass `orientation` through; ↑/↓, Home/End move between tabs |
| All | ⌘K palette | One "Ajustes" command (always General); no way to reach a tab from the palette | "Ajustes → General / Apariencia / Cuentas / Categorías / Filtros / IA / Agentes / Datos" |
| All | Keyboard | No shortcut opens settings (⌘, is the platform's) | `mod+,` → `settings.open` (works while typing; listed in the shortcuts dialog) |
| All | Esc / focus return | Works (focus returns to the gear) | kept; covered by the new spec, for the palette too |
| Filters | — | Filters live only in a separate dialog (sidebar "Filtros"); Ajustes has no page for them | a Filtros tab listing them (enable, edit, delete); edit opens the builder on that filter and returns to Ajustes → Filtros |
| Data (web) | Storage section | Hidden at the bottom of General | its own tab, "Datos" (desktop: export/import; web: persistence, engine, export/import) |
| Shortcuts | — | Not shown in Ajustes (the `?` dialog is a reference) | General gets a row that opens it; not editable (see §4) |

### Accessibility

| Page | Control | Problem | Fix |
|---|---|---|---|
| General | Densidad select | No accessible name (axe critical `button-name`) | `aria-labelledby` the row label, `aria-describedby` the hint |
| General | Imágenes remotas switch | No name, hint not linked (axe serious) | labelled/described by its row |
| General | Ventana de sincronización | Unlabelled number input (axe critical `label`) | `<label for>`, hint linked |
| Agentes | Permitir que los agentes envíen | Switch without a name (axe serious) | labelled/described by its row |
| IA | Proveedor / Servicio selects | `Field`'s `<Label>` has no `htmlFor` target: unnamed triggers (axe critical) | the trigger is labelled by the field label |
| IA | Endpoint error, test result | Not announced; error not linked to the input | `role="alert"` + `aria-describedby`; result in a polite live region |
| Categorías | "Añadir sola" switches | Every switch is named "Añadir sola": indistinguishable by name | "Añadir sola a «Facturas»" |
| Filters dialog | Enable switch per filter | No name | "Activar «name»" |
| Cuentas | Client secret input | Placeholder only, no label | labelled |
| Apariencia | Mode, motion, HTML mail toggle groups | Groups have no name (a screen reader hears "Sistema, Claro…" without "Modo") | `aria-labelledby` their row label |
| All | Contrast | The contrast suite checks text on `tint` but not what settings draw on it: `destructive`, `success`, `primary` text, the focus `ring` and `primary` switch track on `tint`, `sidebar-foreground` on the settings sidebar | pairs added to `CONTRAST_PAIRS` (all 13 themes); axe `color-contrast` over every tab in every theme in the spec |
| Cuentas | Quitar cuenta | `window.confirm` (no focus management, blocks the renderer) | an AlertDialog that says what goes away; focus returns |

### Editable

| Page | Control | Problem | Fix |
|---|---|---|---|
| General | Ventana de sincronización | `onBlur` clamps < 7 to 7 silently; > 3650 is rejected by the contract and the promise is dropped (the field shows a value that was never saved, no error); `defaultValue` never follows a change made elsewhere | validated input (7–3650), error announced, saves on blur/Enter, follows the stored value |
| Cuentas | Each account | Read-only rows: no rename or color although `accounts.update` exists; no signature, sender name or per-account sync window anywhere; no reconnect on the Mac (a revoked Gmail or a changed IMAP password leaves the account in error for good: `connectGmail` refuses an existing address and nothing updates a password) | per-account editor: name, sender name, color, signature (appended at send, shown under the draft), sync window (or the default), reconnect (Gmail sign-in again for the same address; IMAP password re-verified), remove. Backend: `Account` gains `senderName`, `signature`, `syncWindowDays`; `accounts.update` takes them (both stores, in `provider_config`); new `accounts.reconnect`; sync uses the account's window |
| Cuentas | Client secret | Write-only: no way to see whether one is saved or to remove it | `gmailClientSecretSet` in settings; "Guardado · Quitar" |
| Categorías | Each category | Only "Añadir sola": no rename, color, reorder or delete anywhere in the app (only create, from the sidebar and the picker) | rename, color, move up/down, delete (confirm), create; new `categories.reorder` (one transaction, both stores) |
| Filtros | — | (dialog) edit/enable/delete work; delete has no confirmation | Filtros tab + confirm |
| Apariencia | Custom themes | Import and delete only: no edit | "Editar" opens the theme's JSON, validated like an import (same id allowed) |
| Agentes | MCP token | Regenerated at each launch only; no way to cut off an agent that has it | "Cambiar token": new token file, connected agents disconnected (`agents.rotateToken`, desktop/backend-dev; not available to MCP) |
| Datos (web) | Storage engine | Read-only text | choice of SQLite (OPFS) / IndexedDB: settings, categories and filters are carried to the other engine through the export, which then imports them; the other mailbox stays where it was |
| Datos | Export | Export without import | `app.import` (settings without secrets, categories merged by name, filters with categories remapped) |
| IA | Provider/model/endpoint/key | Round-trip correctly (existing tests) | restyle + names only |
| Owner | Cambiar… | Works | restyle |

### Design

Every tab but General keeps a pre-plan-07 layout (boxed rows, `border-border` dividers, ad-hoc cards): Apariencia sections, Cuentas cards and a bordered form, Categorías dividers, IA fields, Agentes copy blocks and a stray row. All move to the inset-grouped style: `tint` groups with radius 10, rows split by `hairline`, 13/18 labels and 12/16 muted hints, section titles 12/600 muted, controls on the right, `--motion` only.

## 3. Commits

1. `docs: plan 08 settings audit`
2. `fix(ui): vertical tabs get their orientation (↑/↓ move between settings tabs)`
3. `feat(web): settings from the palette (Ajustes → tab) and ⌘,`
4. `feat(web): inset-grouped settings parts; General labelled and validated`
5. `feat(ui): contrast pairs for what settings draws on tint and its sidebar`
6. `feat(core,db,idb,backend,web): accounts editable (name, sender, color, signature, sync window, reconnect, remove)`
7. `feat(core,db,idb,backend,web): categories editable in Ajustes (rename, color, reorder, delete)`
8. `feat(web): Ajustes → Filtros`
9. `feat(web): Apariencia inset-grouped; custom themes editable`
10. `feat(web): IA inset-grouped and labelled`
11. `feat(backend,desktop,web): agents token rotation; Agentes inset-grouped`
12. `feat(core,backend,web): Ajustes → Datos: import, and the web storage engine`
13. `test(web): settings-pass e2e with axe in every tab and theme`
14. `test(web): settings baselines`
15. `docs: plan 08 outcome`

## 4. Not made editable (and why)

- **Keyboard shortcuts:** shown as a reference (`?`, and now from General); custom bindings would need a binding store, conflict detection and every surface reading user bindings — a feature of its own.

## 5. Outcome

Shipped in the order of §3, with these departures:

- **Contrast on tint.** The first attempt (commit 5) made `tint` fainter until errors, "saved", links and the ring all read on it; that left Apple's groups white and Terno's barely visible. `tint` is plan 07's again; two derived tokens, `destructive-ink` and `success-ink` (stepped to 4.5:1 on background, tint and menus), carry error, destructive and "saved" text in settings, the ring's alpha also reaches 3:1 on tint and the sidebar, and add buttons on tint are ink rather than primary text. 74 pairs per theme now.
- **Settings tabs activate on focus** (System Settings' sidebar): ↑/↓ moves and shows.
- **⌘, works from anywhere**, a draft included (a chord types nothing).
- **The signature is not written into the draft**: like the quote, it is kept apart (shown under the draft, "-- " plus the account's signature) and joined only when sending, so a restored draft never carries it twice and changing the From account changes it.
- **Reconnect on the Mac** goes through the same sign-in as adding (Google for the same address, or the IMAP password checked by a live login); the secret is written only if the mailbox is still the same one.
- **Import never makes an install less private**: local mode can only come on and agent sending only go off. Filters naming a mailbox that isn't connected are left out (by name) instead of changing meaning.
- **The storage engine switch** carries what can't be re-synced through an export kept in sessionStorage for the reload; the mailbox in the previous engine stays, so switching back finds it.
- **Colour picks** show at once and go back if the save fails.

Tests: `pnpm test` 1,327 + 386 (db-wasm), new: account and category conformance on every adapter, `settings-edits.test.ts` (accounts.update/reconnect, per-account sync window, categories, app.import), token rotation on the socket, signature in `sendBody`, sync-window parsing, ⌘, binding. `pnpm test:e2e` 178 (20 in `settings-pass.spec.ts`: every tab from gear/palette/keyboard, every control edited and checked after a reload and where it shows, axe with nothing serious in light and dark, axe contrast on every tab in all 13 themes, 980×600, motion). `pnpm test:web` 20 (engine switch and back, import, Ajustes → Datos). `test:ui-perf` 15/15, packaged smoke 6/6.

## 6. Still not editable

- **Keyboard shortcuts** (§4).
- **The desktop storage engine**: one adapter (SQLite in the app's folder); Datos shows export/import only.
- **The owner on a demo build**: demo installs have no Terno account by design.
