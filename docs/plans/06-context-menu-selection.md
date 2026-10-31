# Plan 06: context menu, multi-selection, triage shortcuts, exclusive moves

## 1. What other clients do

| | Apple Mail | Gmail | Superhuman | Outlook | Spark |
|---|---|---|---|---|---|
| Context menu (one) | Reply/All/Forward, read/unread, flag, move to, archive, delete, junk, "Mute", copy address | read/unread, archive, delete, move to, label as, snooze, "Find emails from X", mute | none (⌘K) | read, flag, categorize, move, rules "Always move from X", delete | read, pin, archive, delete, move, "Block sender" |
| Context menu (many) | same, acting on the selection | same; right-click on an unselected row acts on that row only | — | same | same |
| Select all | ⌘A | `* a`, header checkbox; banner "Select all N in Inbox" | ⌘A | ⌘A / Ctrl+A | ⌘A |
| Toggle / range | ⌘-click / ⇧-click | x / ⇧-click | x / ⇧J ⇧K | Ctrl-click / ⇧-click | ⌘-click / ⇧-click |
| Extend | ⇧↑ ⇧↓ | ⇧J ⇧K | ⇧J ⇧K, ⇧↑ ⇧↓ | ⇧↑ ⇧↓ | ⇧↑ ⇧↓ |
| Clear | click | `* n`, Esc | Esc | Esc | Esc |
| Trash | ⌫, ⌘⌫ | #, Delete | # , ⌘⌫ | Delete | ⌫ |
| Archive | ⌃⌘A | e | e | Backspace / e | e |
| Read / unread | ⌘⇧U toggles | ⇧I / ⇧U | u toggles | Ctrl+Q / Ctrl+U | ⇧U |
| Spam | ⌘⇧J | ! | ! | — | — |
| Star / flag | ⌘⇧L | s | s | Insert | s |
| Move to | ⌘⌃M | v | v | ⇧⌘V | m |
| Undo | ⌘Z | z | z, ⌘Z | ⌘Z | ⌘Z |

Common ground: the menu acts on the selection if the clicked row is in it, else on that row; ⌘A selects what is loaded (Gmail's banner reaches the whole view); ⇧ extends; Esc clears.

## 2. Shortcuts for Terno

Existing bindings stay (j/k ↑/↓, Enter/o, x, Esc, e, #, ⌫, !, s, u, l, c, r, a, f, /, ⌘K, g-sequences, ⌘↵, y/n, snackbar 1–5/z/Esc). New:

| Keys | Command |
|---|---|
| ⌘A (Ctrl+A off Mac), `* a` | Select all loaded rows |
| `* n` · `* r` · `* u` · `* s` | Select none · read · unread · starred (loaded rows) |
| ⇧J / ⇧↓ · ⇧K / ⇧↑ | Extend the selection down / up |
| Delete (⌦), ⌘⌫ | Trash (beside # and ⌫) |
| ⌃⌘A | Archive (Apple Mail) |
| ⇧I | Mark read |
| ~~⇧U~~ | ~~Mark unread (beside u)~~: since plan 12's addendum, ⇧U is the Unread filter and u is unbound; Mark unread is in the menus |
| ⌘⇧U | Toggle read/unread (Apple Mail) |
| ⌘⇧J | Spam (Apple Mail) |
| ⌘⇧L | Star toggle (Apple Mail) |
| v | Move to… (exclusive, §5) |
| z, ⌘Z | Undo the last action (the snackbar's `z` wins while it is up) |
| ⇧F10, ContextMenu key | Open the context menu for the selection |

Nothing fires while typing in a field (⌘A, ⌘Z, ⌫ keep their text meaning) or while a dialog or the menu is open.

## 3. Selection model

A pure module (`lib/selection.ts`, unit tested) over list order:

- **Click** selects and opens (unchanged); it clears the multi-selection and sets the anchor.
- **⌘-click** (Ctrl-click off Mac) toggles a row; **⇧-click** selects the range anchor→row in list order (rows virtualized out of the DOM count, they're in the loaded list); an anchor that left the list falls back to the row alone.
- **⇧J/⇧K** extend: `(checked − range(anchor, cursor)) ∪ range(anchor, cursor')`, so moving back toward the anchor shrinks.
- **Esc** clears; a selection is pruned when its rows leave the view (actions, reloads, other windows).
- Per-row selectors: toggling renders one row; ⌘A renders only mounted rows whose state changed.

**Select all.** ⌘A checks every loaded row. When more rows exist, a banner above the list offers "Seleccionar las N conversaciones de «Entrada»" (N from `threads.scopeCount`). Accepting switches to a **scope selection** `{view, account, category}` or `{search, …}`: actions then run on the backend over the whole scope. Toggling a row leaves scope mode.

## 4. Context menu

One Base UI `ContextMenu` around the listbox, not per row, so opening it renders no row; the clicked row gets a ring from a keyed CSS rule. Target: the selection if the row is in it, else that row alone. ⇧F10 / ContextMenu key open it at the selected row. Items show their shortcut.

1. Responder · Responder a todos · Reenviar (one thread only)
2. Marcar como leído / no leído (whichever applies; both when mixed) · Destacar / Quitar destacado
3. Archivar · Eliminar · Spam — contextual: in Archivo "Mover a Entrada" replaces Archivar; in Papelera "Restaurar a Entrada" with Eliminar disabled; in Spam "No es spam" with Spam disabled
4. Categorías ▸ checkbox per category (✓ all in it, toggles add/remove, additive) + "Nueva categoría…" · Mover a… ▸ (exclusive, like drag)
5. When all targets share a sender: Todo de ‹remitente› ▸ categories (the existing `categorize.apply` sender scope, progress + undo) · Crear filtro desde este remitente… (filter builder prefilled `from`) · Buscar correos de ‹remitente› · Copiar dirección
6. Seleccionar todo

Actions that would change nothing are disabled; "Mover a…" is disabled in scope mode. Category adds open the categorization snackbar.

**Bulk bar.** With ≥ 2 selected the reader area shows the count, the main actions, "Seleccionar todo" and "Deseleccionar (esc)". The palette gains the actions; the shortcuts dialog lists every binding.

## 5. Exclusive moves (drag and "Mover a…")

Dragging threads onto a category **moves** them: afterwards each is in the target only, leaving every other category (not only the one being viewed). ⌥ no longer matters. "Mover a…" (menu, bar, `v`) is the same move. Multi-filing stays possible through the toggles (context menu Categorías, its keyboard twin `l`, accepted suggestions, the snackbar's bulk adds).

- `categories.moveThreads({to, threadIds, source})`: one set-based transaction removes every other membership and adds `to`. The journal records each removed row **with its category** (SQL migration v8 rebuilds `cat_move_rows` keyed by `(batch, thread, category)`; IndexedDB v2 does the same) and the decisions of every affected category. Training follows in slices: a positive in `to`, a removal example per category left. Undo restores every source row exactly (origin, time, previous batch) and removes what the move added, in one transaction; examples follow in slices; crash recovery is unchanged.
- No-op only when every thread is already in the target alone; a thread in A+B dropped on A still loses B.
- Renderer: rows show only the target in the same frame; in a category view the rows that left it leave the list (reflow, selection moves on); sidebar unread counts move from the sources to the target; the snackbar says "Movido a X" and its undo restores everything at once.

## 6. Backend for scope actions

- `threads.scopeCount({scope})` → `{count, capped}`.
- `threads.actScope({scope, action, jobId})` → `{undoId, affected}`: ids resolved once by keyset pages of `threads.list` / `threads.search` (≤ 500 per store call, yielding between), then `store.threads.act` in `runSliced` slices (~8 ms each): every slice is one transaction with one op per account. Progress is a `bulkProgress {jobId, done, total}` event (≤ 10/s). The affected thread ids stay in a bounded in-memory journal (last 16 jobs); `threads.undoScope({undoId})` applies the inverse to exactly them, sliced.
- `categories.addScope({categoryId, scope})` → `{added, batchId}`, sliced like the picker's filing; undo is `categorize.undo`.
- `threads.act` above 200 ids also runs sliced.
- Learning: renderer `threads.act` keeps recording signals (explicit picks); scope actions record none (an inbox sweep says nothing about senders); MCP never does. MCP may not call the scope methods (agents name threads).

## 7. Performance gates

Right-click → menu painted ≤ 50 ms p95; toggling one row renders 1 row; ⌘A over 500 loaded rows commits ≤ 16 ms p95 rendering only changed rows; archiving ≥ 5,000 threads by scope on the 50k mailbox keeps concurrent `threads.list` p95 ≤ 20 ms and the longest event-loop stall ≤ 50 ms; the move gate (5,000 threads) and the existing UI gates still pass.

## 8. Risks

The undo journal for scope actions is in memory (a restart loses the undo, not the action). Electron's Edit menu owns ⌘A/⌘Z: the renderer handles them first and prevents the default, verified in the app. Scope ops add one op per account per slice (hundreds for a large sweep); the worker drains them like any other.

## 9. Outcome

Shipped as planned, with these decisions made on the way:

- A plain click opens a row and clears the multi-selection (desktop list convention); ⌘/⇧-click don't move the open thread, so a toggle renders exactly one row. A press on a row of the selection keeps it (it may start a drag of the group) and collapses it on release.
- Thread actions slice at half the usual budget (4 ms): their commit writes every message, thread and op touched, and under external load that write was what stretched slices past 50 ms.
- Migration v8 keeps instant search snapshots valid (their identity follows the last search-relevant migration, v7).
- In scope mode, "Mover a…" is disabled (moves stay per thread, ≤ 5,000); Categorías adds the whole scope as one undoable batch.

Measured (load average 5–6 from other work): menu painted p95 ~13 ms with no row renders; ⌘A over 500 loaded rows ~1.6 ms p95; scope archive of 18,792 threads longest stall ~24 ms with `threads.list` p95 ~0.5 ms; 5,000-thread exclusive move ~33 ms stall, its undo ~35 ms.

## 10. After review (Codex, 9 findings)

- Undo is exact: every action returns its changed messages as they were (read, star, place); `threads.undo` restores exactly those, for loaded selections and scopes, with the provider ops in order (out of Papelera/Spam through the inbox). It replaces the inverse-action undo, which sent archived mail to Entrada.
- Exclusive moves run in slices (record, then apply per slice, train; undo likewise), so a 5,000-thread move out of 20 categories each stalls ~35 ms instead of ~150 ms (undo ~30 ms instead of ~320 ms). Visible atomicity gives way to per-slice atomicity; progress is per thread and resumes forward.
- View scopes are counted and enumerated from the indexes (`scopeIds` / `scopeCount`); a 47,000-thread category counts in ~7 ms.
- v7-era move journals restore cleanly after the upgrade; a failing resume at startup is logged, never an unhandled rejection.
- Selection: the dwell's mark-read never clears it; ⇧F10 opens on the selection; no dragging in scope mode; the Categoría button always toggles; z undoes an action still in flight; aria-selected follows the real selection and the open thread is the listbox's `aria-activedescendant`.
