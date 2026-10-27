# Plan 36: visible HTML-only mail text (X04/B37)

## Request (verbatim)

Implement the actual X04/B37 normalization gap from provider reliability report, on main with atomic commits, no branches/worktrees/push. Preserve genuine plaintext precedence (including explicitly empty alternative), useful visible text, word/phrase whitespace/entity/case semantics, no network/inert parsing, portable imports, bounded backend work/low resource. Red tests must demonstrate hidden-only body rule does not archive/star and hidden search absent while visible body rules/search remain, across SQL/IDB and reopen. Parent owns distinct final Codex review and global release gates.

## Investigation

Read plans 16/29/33 and the baseline X04/B37. `mime.ts` converts HTML-only bodies using tag-stripping regexes; hidden descendants survive and become filter/search input. PostalMime 4.1.3 assembles MIME alternatives, attachments and addresses; retain it. PostalMime omits an explicitly empty plain alternative from its public result; retain its existing useful HTML fallback in that case. A supplied public `email.text` (including an empty string) wins by nullish precedence. No private fields, parser-instance changes or new source-presence semantics. Mixed-message public text may already include PostalMime conversions; this work only normalizes the absent-public-text HTML fallback.

`mail-body.tsx` sanitizes with DOMPurify and forbids style tags. Therefore embedded stylesheet/class/media rules do not hide content in Terno. No external stylesheet fetch or CSS cascade is needed here. Inline styles remain. Installed parse5 8.0.1 and css-tree 3.2.1 are portable inert parsers (currently transitive development dependencies). Add exact production pins and css-tree types. No browser DOM, activation, URLs or resource loader.

## Design and supported semantics

Use parse5 document parsing with scriptingEnabled:false and HTML tree construction/entity decoding and css-tree's declaration-list parser. Traverse iteratively; never recursively walk attacker-controlled depth. Omit hidden attributes, display:none subtrees, head/script/style/template and nonrendered embedded content. Respect inherited visibility:hidden/collapse, with explicit visible descendant override; display:none ancestors cannot be overridden; an explicit valid visible inline display overrides ordinary hidden on that same element. Hidden-until-found remains excluded. Recognize common inline email preheaders using opacity:0 and zero maximum height with hidden overflow. Do not prune font-size:0: descendants can reset it; font metrics/shorthand are outside this local model. Resolve duplicate declarations by importance/order, parse comments/escapes with CSS grammar. Do not build an HTML parser from regexes.

Text normalization collapses HTML whitespace/NBSP to one space, preserves inline word joins and adds word boundaries at blocks/br/table cells. Decode named/numeric entities once, retaining case and visible Unicode. No link target, image alt/attribute, comment or CSS text enters the body. Local extraction is not computed layout: no viewport, external/embedded cascade, geometric clipping, offscreen positioning, transparent color or arbitrary CSS expressions. These are explicitly out of scope, not claimed equivalent to all rendered pixels. The reader's sanitizer already drops embedded stylesheets.

Move the unused synchronous htmlToText export from mime.ts into its internal helper module (parent authorized; no workspace consumers). Production parseRaw dynamically imports the heavy helper only for HTML fallback. Browser ESM splits it; desktop single-CJS bundles contain the bytes with deferred initialization, not a separate chunk. Plain mail keeps its existing path. Preserve all MIME/address/Reply-To/attachment behavior and plaintext precedence. Empty alternatives retain PostalMime public-result semantics; only the exact fallback expression changes.

## Tests and performance

Agreed seams: parseRaw/htmlToText and actual raw HTML MIME -> public MailStore sync.ingest -> filters/actions/threads.searchText -> close/reopen. New independent suites for native SQL, SQLite-WASM and IDB both search modes; leave existing capture suites untouched. Hidden-only marker cannot archive/star or search; visible marker and entity/phrase/case controls still match. Cover malformed HTML, hidden nesting, entity-encoded styles, duplicate inline declarations, preheaders, no network and plaintext precedence/empty alternative. Existing MIME/address/Reply-To/attachment suites remain green.

Complete-path performance fixture starts before parseRaw and ends after durable ingestion/search/action, with unchanged 15ms slice budget and bounded representative mail. Large arbitrary HTML and worker isolation belong to plan33: no new global byte ceiling or truncation. Coordinate quiet timing with parent before running any timing gates. Parent runs full release gates, distinct code review and fixes assigned back here. No UI/locale/runtime/store/migration changes.

## Revisions after the Codex review

The required read-only CLI completed with 12 concrete points (exit0), retained at `/tmp/terno-visible-text-plan-review.txt`. Revisions are recorded before implementation:

1–2. Remove the unused mime helper export (parent authorized); keep only a dynamic import in the fallback. Verify ESM splitting and CJS deferred initialization separately. Desktop bytes remain in the existing CJS bundle; no packaging changes are authorized here.
3–4. Reject private-field/source-presence inference per parent instruction. Preserve PostalMime public text precedence exactly, including its mixed-message assembly. Empty omitted text uses cleaned visible HTML. No claim of per-part normalization for mixed text is made.
5. Full document parsing, scripting disabled; head metadata disappears while malformed visible nodes reparented into body remain. Test noscript, tables, formatting misnesting and foreign content; omit SVG/MathML subtrees conservatively because no layout is computed.
6. Parse declarations without recursive values; tokenize relevant scalar values, decode CSS escapes, validate the supported keyword/number vocabulary before importance/order resolution. Invalid trailing garbage does not override valid hiding.
7. Drop zero-font pruning from scope; support ancestor opacity zero and max-height zero plus overflow:hidden preheaders. Visible descendant font resets remain visible.
8. Explicit valid non-none inline display can override the same element's ordinary hidden attribute. Ancestor display:none still prunes descendants.
9. Use css-tree parseValue:false and nonrecursive tokenizer for scalar declarations, including arbitrary unsupported functions. Irrelevant deeply nested values are never parsed recursively.
10. No claim of arbitrary75MiB HTML within15ms. Complete-path gates qualify ordinary bounded messages and selected adversarial envelopes only. Rollout's whole-runtime large/deep HTML isolation remains dependent on plan33. Parser tree storage is input-proportional with no cache/timer/network; peak memory and worst-case HTML5 tree repair remain unqualified here. Parent owns that global gate.
11. Add raw parse -> partial setBody, exactly-once action and reopened search cases across SQL/WASM/IDB; include initial ingestion too.
12. Fix newly parsed mail only; existing cached fallback text is not migrated. Explicit normal body replacement reparses and removes stale terms; test that without new automatic cleanup or automation replay.

The scoped semantics deliberately exclude viewport/layout, stylesheet/class/media cascade, custom properties/functions and geometry/paint approximations. Embedded stylesheet exclusion matches the current reader. This is supported local extraction, not computed CSS equivalence.
