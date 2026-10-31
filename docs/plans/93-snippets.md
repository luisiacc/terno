# 93: Snippets

## Request (verbatim)

> implement snippets, can be inserted in a draft with cmd_k menu navigating to the snippets section
> snippets like the ones used in superhuman that people love, lets make this really intuitive and easy to use.
>
> first make a plan then implement it like we do already.

Plan 88 §6 is the palette's half of the contract; this plan builds snippets themselves and fills it in.

## What Superhuman's snippets are (what people love)

- A snippet is a saved piece of an email: a **name**, a **rich body**, and optionally a **subject**, **To**, **Cc** and **Bcc** (and attachments).
- **⌘;** in a draft opens the snippet list; type a few letters of the name, Enter inserts it at the caret. Also reachable from ⌘K.
- **Variables**: `{first_name}`, `{last_name}`, `{email}`… are filled from the recipient when inserted.
- Creating one is quick: a snippet editor that looks like a composer; or "save this draft as a snippet".
- Snippets rank by use; the list shows a preview of each.

We take all of that except attachments (out of scope, below) and sharing with a team.

## What exists

- **The palette** (plan 88): records built in `components/command-palette.tsx`, scored and arranged by `lib/palette-commands.ts` (`PalettePage`, `PAGE_GROUPS`, `searchOnly`, `scale`, usage ranking through `lib/palette-usage.ts`). A draft group appears while a draft had focus (`paletteFrom.draftKey`, `lib/draft-commands.ts`); draft commands run once focus is back in the composer (`runInDraft`).
- **The composer controller** (`components/composer/controller.ts`, entry chunk, no ProseMirror): `openLink`, `focus`, `dropFiles`… registered per draft key by `RichBody` (`rich.tsx`, lazy chunk). The editor (`editor.ts`) parses mail HTML with `@terno/richtext`'s `parseHtml` (schema-bound: only what the schema knows survives) and serializes with `toEmailHtml`/`toPlainText`.
- **Draft fields**: `editDraft(key, patch)` and `editDraftRecipients(key, field, text, authored)` (`lib/drafts.ts`). A Cc/Bcc row shows when it has text; the subject row when `subjectEdited`.
- **Persistence**: `store.settings` (`get/set/update` by key) exists in both stores (SQLite in `packages/db`, IndexedDB in `packages/idb`). Filters and categories have their own RPC methods (`filters.list/save/delete`); settings are a JSON value under `"app"`.
- **Export/import** (`packages/backend/src/import.ts`): categories, filters, settings and drafts; snippets will join them.
- **Settings** (`settings-dialog.tsx`, `settings/tabs.ts`): the palette already lists every tab as "Settings → <tab>".
- **Keys**: `@terno/core` keybindings; `mod+k` → `palette.open` (allowed while typing).

## Design

### 1. The snippet

```ts
// @terno/core snippets.ts
interface Snippet {
  id: string;          // "s_" + random, stable (palette usage counts `snippet:<id>`)
  name: string;        // ≤ 80; "" shows as "Untitled snippet"
  bodyHtml: string;    // mail HTML from the editor (≤ 32 KB, no images); "" = empty
  bodyText: string;    // its plain text (≤ 16 KB): previews and search
  subject: string;     // ≤ 300
  to: string; cc: string; bcc: string; // address text as typed in a draft (≤ 2,000 each)
  createdAt: number; updatedAt: number;
}
```

At most 200 snippets and 1 MB in all (revision 10). Validated with zod in the contract (the limits above); the body is never rendered as HTML outside the editor, and the editor parses it through the schema, so a snippet can't carry script or styles the composer doesn't allow.

### 2. Storage and RPC

- Stored as one array under `store.settings` key `"snippets"`, written with `settings.update` (one read-modify-write unit, so two windows can't lose each other's save). No schema migration in either store; the budget (revision 10) keeps the value small.
- Methods (handlers in `packages/backend/src/handlers.ts`, logic in `packages/backend/src/snippets.ts`):
  - `snippets.list` → `Snippet[]` (by name).
  - `snippets.save` `{ id?, name, bodyHtml, bodyText, subject, to, cc, bcc }` → `Snippet`. No id: a new one. An id that isn't there is created with it (Undo of a delete puts back the same snippet, so its usage rank survives).
  - `snippets.delete` `{ id }` → `{ ok: true }`.
- Not exposed to the MCP server (agents have their own tool list; nothing changes there).
- **Export/import**: `MailboxExport.snippets` (optional, so older files import). Import adds the file's snippets whose id isn't here, skipping one whose name already exists here (the categories rule). The limits are checked one by one; a bad item is skipped.

### 3. Web state

`lib/snippets.ts`: a small zustand store `useSnippets` `{ list: Snippet[] | null }`, loaded on first need (the palette opening, the settings tab, ⌘;), kept after, and updated from each save and delete's answer. Nothing loads at startup; nothing polls. Another window's edits show on the next open (each open re-lists, a local call).

### 4. Inserting: the composer controller

`ComposerController.insertSnippet(snippet, values)`:

- Parses `bodyHtml` (or `bodyText`, one paragraph per line) into a document, fills the variables (§5) in its text nodes, and replaces the selection with it as one transaction and **one undo step** (history closed before and after). An empty body is replaced whole (no empty first line left above it). One-paragraph snippets merge into the line at the caret (an open slice), so "Thanks, {first_name}!" lands inline.
- Afterwards the caret is at the end of what was inserted, or, when a variable couldn't be filled, that variable's text is **selected**, so typing replaces it.
- Then the fields, each **only when empty** in the draft: To, Cc, Bcc (through `editDraftRecipients`, so they show, autosave and count as the user's), and the subject (only when it is empty and not edited: never over a reply's "Re: …"). Variables are filled in the subject too.
- Nothing happens while the draft is sending or held (`canMutate`), as for typing.

`lib/snippet-insert.ts` (entry chunk) computes the values and calls the controller: `insertSnippetInto(draftKey, snippet)`. If the editor isn't mounted yet (the chunk still loading) it waits for the controller to register, up to 2 s, then says "Couldn't insert the snippet. Try again." in a snack.

### 5. Variables

`{first_name}`, `{last_name}`, `{full_name}`, `{email}` (the draft's first To recipient after the snippet's own To is applied) and `{my_first_name}`, `{my_name}` (the sending account's sender name). Case-insensitive, spaces inside the braces allowed (`{ First_Name }`). Names come from the address's display name ("Ana García <ana@x.com>": Ana, García); with no display name, `{first_name}` is left unfilled (no guessing from the local part: a wrong name is worse than a visible blank). Any other `{word}` is plain text.

The editor in Settings has an **Insert variable** menu, so nobody has to remember the syntax, and the help line under the body names them.

### 6. The palette (plan 88 §6, filled in)

- `PalettePage` gets `"snippets"`; `PAGE_GROUPS.snippets = ["snippets", "snippetsManage"]`.
- **In a focused draft** the draft group gets **Insert snippet…** (`⌘;`, opens the page) and **Save as snippet…** (creates a snippet from the draft's body, subject unless it's a reply's, and its recipients only for a new message, then opens Settings → Snippets on it with the name selected).
- **The snippets page** lists every snippet: its name, the first line of its text as a muted hint on the right (truncated), most used first, then by name. Enter inserts into the draft (through `runInDraft`, like the other draft commands). Below them **New snippet…** (opens the editor in Settings). With no snippets the page shows "No snippets yet" and New snippet….
- **Outside a draft** the same page is **New message from snippet…** (actions group): Enter opens a new message (`openCompose("new")`) and inserts into it once its editor is there.
- **Search-only records** at the root, `snippet:<id>`: in a draft "Insert snippet: Intro call" (scale 1: in a draft a snippet's name is what you meant), outside one "New message from: Intro call" (scale 0.5, like other values). Usage counts `snippet:<id>` either way.
- **⌘;** (`mod+;`, allowed while typing and in the palette): opens the palette straight on the snippets page, recording the focused draft like ⌘K. ⌘; with the palette already on that page closes it.
- The Settings group gets "Snippets" for free (the tab) and **New snippet…**.

### 7. Settings → Snippets

A new tab (`snippets`, icon `NotepadText`), between Filters and AI.

- **The list**: one row per snippet: name (or "Untitled snippet"), a muted one-line preview, and small tags for what it fills ("Subject", "To"). Click or Enter on a row edits it; a trash button deletes it at once with a snack offering **Undo** (no confirmation dialog: undo is exact). **New snippet** at the bottom; a short empty state explaining ⌘; when there are none.
- **The editor** replaces the list inside the tab (a back arrow "Snippets" returns):
  - **Name** (focused on a new snippet).
  - **Body**: the composer's own editor and format bar (lazy, the composer chunk), with an **Insert variable** menu beside the format toggle.
  - **Also fills in** (disclosure, open when any is set): Subject, To, Cc, Bcc as plain text fields with hints ("Filled in only when the draft's is empty").
  - **Autosaves** 500 ms after the last change and when leaving (back, another tab, closing settings), like drafts: never a Save button to forget. A new snippet is created on its first non-empty save. A quiet "Saved" status. Delete is there too.

### 8. Look

Hairline rows like Filters; the editor reuses the composer's field style (borderless, hairline below each field). No new colors, durations or motion. Icons: `NotepadText` for snippets.

## Tests

- **Unit**
  - `packages/core/src/snippets.test.ts`: the zod limits; `fillText` variables (case, spaces, unknown words, missing names); `nameParts`.
  - `packages/backend/src/snippets.test.ts`: list/save/delete round trip in the test store; save with an unknown id recreates it; the 500 cap; export carries snippets and import adds them, skipping an existing name and a bad item.
  - `apps/web/src/components/composer/snippets.test.ts` (ProseMirror): fill in text nodes keeps marks; unfilled ranges; insertion into an empty doc replaces it, into a line merges, is one undo step.
  - `apps/web/src/lib/palette-commands.test.ts`: the snippets page groups; snippet records are search-only and scaled outside a draft.
  - `packages/core/src/keybindings/resolve.test.ts`: `mod+;` resolves while typing.
- **E2E** `apps/web/e2e/snippets.spec.ts`
  - Settings → Snippets: New snippet, name, body with bold text and `{first_name}` via Insert variable, autosaves (reopen settings: it's there).
  - Reply to a conversation, ⌘; → the page, type part of the name, Enter: the body has the text with the first name filled and bold kept; ⌘Z removes it in one step.
  - A snippet with a subject and To into a new message: both filled; into a reply: the subject stays "Re: …".
  - Unfilled variable (recipient without a name) is selected: typing replaces it.
  - ⌘K "intro" ↵ in a draft inserts; outside a draft "New message from snippet…" opens a new message with it.
  - Save as snippet… from a draft opens the editor with its body.
  - Delete, then Undo: back, same id (palette usage kept).
  - Spanish: the page and tab are named in Spanish.
- **designs.spec** axe on the Snippets tab in light and dark; screenshots of the tab, the editor and the palette page in light and dark.

## Performance and resources

- Nothing at startup: snippets load on first use and stay (≤ 200 records, ≤ 1 MB).
- The palette builds snippet records only while open; search-only records render only when they match (plan 88's value rule).
- The editor in Settings is the composer chunk, already lazy; the Snippets tab mounts it only while editing.
- Insertion parses one snippet (≤ 32 KB) once.

## Out of scope

- Attachments in snippets (they need the attachment store's ownership model; later).
- Text-expansion triggers typed in the body (";intro").
- Shared/team snippets, folders.
- A send-time warning for unfilled variables (the selection after insert makes them visible; revisit if people send them).

## Revisions after the Codex review

1. **The Settings editor is its own host**, not `RichBody` (which needs a real draft, attaches to draft autosave, ghost suggestions and file ingestion). `composer/snippet-editor.tsx` (lazy, the composer chunk) builds a ProseMirror view with `createEditor`/`newState`, no ghost hooks, no file hooks, and registers a `ComposerController` under `snippet:<id>` so the composer's `FormatBar` and link popover work on it. Nothing in it is a mail draft.
2. **Save as snippet… reads the live editor**, not `LocalDraft.bodyHtml` (which lags the editor until materialized): a new controller method `snapshot()` serializes the editor's document. With no editor mounted it says so in a snack and creates nothing. E2E: type, then at once Save as snippet.
3. **Images never enter a snippet.** Inline images belong to their draft's attachments. Saving strips image nodes (and the backend rejects `<img` in a snippet body), and insertion strips them again (imported files). Unit test: a draft with an inline image saves without it.
4. **Undo covers the fields too.** ⌘Z undoes the body insertion (one step). When the snippet also filled fields, a snack "Inserted “Intro call”" offers **Undo**: each field it filled goes back to empty if it still holds what the snippet put there, and the body insertion is undone if it is still the editor's latest change (otherwise the body stays and ⌘Z remains). E2E for a snippet with To and subject.
5. **A pending insertion is re-checked when it applies.** Insertion runs through `runInDraft`'s checks, and then directly (the controller is there once focus is back in the editor); the values are computed from the draft at that moment. If the editor isn't mounted then, nothing is inserted and a snack says "Couldn't insert the snippet. Try again." (no long wait that could land in another draft).
6. **New message from snippet creates the draft with the snippet in it.** `openCompose("new", null, 0, prefill)` passes the snippet's subject, recipients and filled body (`newFields` + prefill) to `createDraft`, the same synchronous step a new message already takes, so there's no window where a later compose could receive it. No accounts: the existing "add an account" path, nothing inserted.
7. **⌘; carries its page and keeps the draft.** `paletteFrom.page` is the page an opening starts on (reset to root after it's read). ⌘; with the palette open on another page switches to snippets without re-reading the focused element (which is inside the palette by then); on the snippets page it closes. Tests from the editor, the root and another page.
8. **Autosave has an owner and never duplicates or resurrects.** The id is made in the renderer when "New snippet" opens the editor, so every save is the same snippet. `lib/snippets.ts` keeps one save in flight per snippet and coalesces the rest (the latest content wins); closing Settings or leaving the editor flushes the pending save from the module (not the unmounting component). A failed save keeps the content and shows "Couldn't save. Retry". Delete waits for that snippet's save in flight and stops its editor's saving.
9. **Edits from another window aren't silently overwritten.** `snippets.save` takes `base`: the `updatedAt` the edit started from (null to create, or to restore a deleted one). An update whose base isn't the stored `updatedAt`, or whose snippet is gone, fails with `CONFLICT`; the editor then says "This snippet changed in another window" with **Keep mine** (saves over it) and **Load theirs**.
10. **A real size budget.** 32 KB of HTML and 16 KB of text per snippet, at most 200 snippets and 1 MB of snippets in all (checked on save and import), so the settings value stays small to parse and write in both stores and any backup imports back. Perf test: saving the 200th snippet into a full 1 MB list stays under 20 ms in each store.
11. **Import is specified end to end**: the `app.import` envelope accepts `snippets`, `importMailbox` validates each item on its own (limits, no images, the budget), adds those whose id and name aren't here, and `ImportResult` gains `snippets` (count); the web's import summary says it in English and Spanish, and the snippets cache reloads. Tested through `app.import`.
12. **Variables match across formatting.** Filling scans each textblock's whole text in the inserted range (a `{first_name}` split by a bold "first" is still one variable), maps matches back to positions, and replaces from last to first with the marks at the variable's start. Unit tests: split tokens, two unfilled variables, values longer and shorter than the token.

## Implementation notes

- **The palette's page lives in a small store** (`usePalettePage`, `lib/palette-open.ts`) instead of the component's state: whoever opens the palette sets it (⌘K the root, ⌘; the snippets), so ⌘; can switch an open palette to the snippets page and keep the draft it was opened from.
- **The draft group's order**: Send, Insert snippet…, Attach files, Add Cc, Add Bcc, Insert link, Save as snippet…, Discard draft.
- **Deleting in Settings shows its Undo in the list**, where the snippet was: a snack sits under the Settings dialog, which makes everything outside it inert. Deleting from the editor goes back to the list with the same Undo.
- **Settings' content column got `min-w-0`** (and the tabs root): the snippet editor's format bar would otherwise widen the column past the dialog. The bar now folds into More as it does in a narrow composer.
- **Spanish calls them "Plantillas"** (what Gmail calls templates); "snippet" still matches as an English word.
- New ids are made in the renderer (`newSnippetId`, `lib/snippets.ts`): core has no `crypto` in its Node typings.

## What the Codex code review changed

1. **A new message from a snippet was discarded as untouched.** The prefill went into `createDraft`, which makes a clean draft: Escape dropped it and autosave skipped it. It is now an edit (`editDraft`) right after creation, saved like typing. E2E: New message from snippet, Escape, the draft is stored (fails without the fix).
2. **An editor opened again lost what it couldn't save.** After a failed save or a conflict the session kept the content, but the editor started from the stored snippet, and the next change saved the stale text over it. The editor now starts from the session's unsaved content (`unsavedContent`), and a new snippet whose first save failed stays in the list as "Couldn't save." until it saves. Unit test.
3. **Quitting or reloading skipped a waiting save.** The 500 ms timer was flushed only when the editor unmounted. `snippetsSaved()` now joins the desktop's shutdown flush (with `draftsSaved`) and the web's `pagehide`: it saves what's waiting at once and reports false if anything isn't stored. Unit test.
4. **Load theirs could save the editor's text over theirs.** Typing while it loaded queued a save that ran on their version once it arrived. The session now drops changes while it replaces the content. Unit test.
5. **Delete then Undo after a failed save restored the older text.** Delete now takes what a failed in-flight save put back (newer than the stored one, older than anything queued). Unit test.
6. **A new snippet opened again (another tab and back) conflicted with itself.** The editor began a fresh session with no base. A session already open keeps its version, and the base comes from the stored snippet whenever there is one. Unit test.
7. **One imported snippet too large for the remaining budget stopped the rest.** It is skipped and later ones that fit still come in; only the count cap stops the import. Unit test (IndexedDB).

## Verification

- Unit: core (`snippets.test.ts`, keybindings), backend (`snippets.test.ts` over RPC on SQLite, `snippets-idb.test.ts`), web (`lib/snippets.test.ts`, `components/composer/snippets.test.ts`, `palette-commands.test.ts`, tabs, backup).
- E2E: `snippets.spec.ts` (11, including axe in light and dark), `palette.spec.ts`, `settings*.spec.ts`, `designs.spec.ts`, `i18n.spec.ts`, `composer.spec.ts`, `shortcuts.spec.ts`.
- Screenshots of the Snippets tab, the editor and the palette page, light and dark, looked at.

## After: ⌘K is the palette in a draft, ⌘L the link

Requested afterwards: "when i'm doing a draft, pressing cmd+k is bring up the 'insert link', change that to cmd+l instead, and remove cmd+l from toggling on the 'unread' in the thread list, so that i can press cmd+k for inserting a snippet."

- **The editor's link is ⌘L** (`Mod-l` in `composer/editor.ts`, the snippet editor's too). ⌘K in the text now reaches the app's `palette.open` like everywhere else, with the draft's commands (Insert snippet… second). ⌘K inside the link popover still goes on to the palette. The Link button's tooltip, the palette's Insert link row and the shortcuts dialog's formatting list show ⌘L.
- **The unread filter has no key** (plan 12's ⌘L is gone): no `mod+l` binding, no desktop View-menu accelerator (it would take ⌘L before the editor), no forwarding from a mail's frame, and no ⌘L on its tooltip, its palette row or the shortcuts dialog. The header button, Lumen's chips, ⇧U/⇧A, the palette and View → Filter by Unread still set it. On the web, ⌘L outside a draft is the browser's again (the address bar).
- Tests: `resolve.test.ts` (⌘L resolves to nothing anywhere, ⌘K to the palette in a draft), `menu.test.ts` (nothing in the menu claims ⌘L), `composer.spec.ts` (⌘L opens the link popover, ⌘K the palette with Insert snippet…), `unread-filter.spec.ts` (⌘L leaves the filter alone; no key on its palette row), `palette.spec.ts`, `snippets.spec.ts`, and the specs that toggled the filter with ⌘L now use the palette or the button. The desktop `unread.smoke.ts` checks that the View item toggles once per click and that ⌘L toggles nothing.
- Codex code review of this change: no functional findings; two stale descriptions fixed: the README's "unread (⌘L)" (now ⇧U, ⇧A for all) and `tabs.test.ts`/`tabs.ts`, which still called the Unread tab "⌘L" (with the palette's, `page.ts`'s and `unread-filter.ts`'s comments).

## After rebasing onto main's Hugeicons (plan 92)

- **Renumbered from 89 to 93:** main took 89 for word and pattern filters, and 92 is Hugeicons.
- **Icons come from `@terno/ui/icons`,** as plan 92 requires: and the editor uses Pencil, Plus, Trash2 and the chevrons.
- **Three icons added to the catalog,** picked by eye at 16 px:
  - `NotepadText` → `Note01Icon`, for snippets in Settings and the palette. TextQuote is now Hugeicons' “66”, the same as the composer's blockquote button, so snippets get an icon of their own.
  - `BookmarkPlus` → `BookmarkAdd01Icon` (Hugeicons' own alias), for Save as snippet….
  - `Braces` → `ThirdBracketIcon`, for Insert variable. It draws `{ }`, the variables' own syntax. Hugeicons' `Braces` alias draws parentheses.
