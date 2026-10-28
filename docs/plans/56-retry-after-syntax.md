# Plan 56: pure Retry-After and HTTP-date syntax

Status: implementation and final bounded qualification recorded below after ROOT NATIVE END; scoped diff and the exact three-path parser commit conclude this window. Earlier source-only gates and casing selections below are historical; the active final contract is ASCII case-insensitive matching. The completed single plan critique and execution evidence are recorded below. Parser code needs its own future independent two-axis review; Plan55's two zero-finding reviews do not approve this prerequisite or complete W05.

## Request (verbatim, Plan26)

> I want you to go through every item to fix here in this report. For each item that needs fixing you already have, in that report, what needs to be done but for each item you need to:
> 1. Go for that item.
> 2. Spec it out a bit more.
> 3. Do maybe a better investigation on it to see what's truly needed for us.
> 4. Build a test case reproducing that scenario, that potential scenario, or multiple test cases.
> 5. Fix it.
> 6. That will do it.
> 7. Spawn a subagent with Codex doing a code review of that fix, of that code you have just fixed and/or added.
> 8. Fix any findings.
> create atomic commits as you are fixing things.
> That way there is a double check on what you're doing and this can be better. Of course we need to maintain our performance while doing this and follow the directives that we have. You're going to do this for each and every one of the items that you have done here.
> Let's not create a separate branch or anything like that. Let's just do the fixes right here in the main branch. You should not stop until everything in that report is done.

## Bounded request (verbatim)

> Next bounded Plan26 prerequisite: pure Retry-After/HTTP-date syntax parser, separate from policy. Root now ACKs the exact parser interface/candidate in your completed /tmp/terno-quota-header-metadata-design.md (parser section): parseRetryAfter(BoundedHttpHeader), parseHttpDate, exact canonical decimal string (never numeric overflow/clamp), explicit IMF/RFC850/asctime HttpDateParts including unresolved two-digit year and leap second; defensive256UTF16 bound, ASCII outerSP/HTAB, no hidden clocks/Date.parse/I/O/deadline/provider classifier/backoff/admission/schema changes. Full-year weekday/calendar validation; RFC850 century-dependent checks deferred explicitly. Source-format ambiguity must stay represented rather than retry sooner.

> Ownership ONLY new packages/mail/src/retry-after.ts + new retry-after.test.ts + docs/plans/56-retry-after-syntax.md if free; no existing production exports/calls/error API modifications. If any exact interface ambiguity/refinement needs change, report concrete proposal. You are not alone; preserve renderer drafts.ts/Plan43/untracked Forward WIP and any foreign edits. No source behavior imported into runtime until future resolver approval; this is an independently reviewable parser prerequisite, not W05 completion.

> First source/spec stage: reread full current Plan55 and candidate parser, relevant current types/helper; verify grammar against primary RFC9110 HTTP-date/Retry-After and Gregorian weekday requirements using web tools (explicit source research authorized), cite exact official links/sections and distinguish syntax policy choices from normative statements. Check Plan56 collision before create. Write concise Plan56 original user Plan26 request verbatim + this exact bounded request, what exists, exact type/result contract, meaningful RED/controls, perf/resource and exclusions. Then EXACTLY ONE read-only codex exec -s read-only -C checkout - critique <=6 points, prompt under12000B, no nested agents/tests/imports/build/discovery. Capture PID/argv/timing/actualexit/substantivefinal/naturalreap; read complete final, accept each relevant refinement, coordinate API scope change before implementation. New tests may be prepared after critique but NO functional command, production parser, type/lint/build/global until root SMALLCHECK release. Return READY with exact bounded test plan/commands and process IDLE. Existing two-axis Plan55R1 both0 complete finite, not parser approval by review; pure parser needs its own future independent2axis review. No schema allocation/branch/push, common commit helper later.

## Existing source and separate config correction

Baseline `381bf77af52668f5ec0f20789f75c4d6f6603240`. Full current Plan55 (168lines at initial inspection), current AGENTS, external candidate parser section and current types/helper were read. Plan56 was free and is created exclusively; neither new retry-after source/test exists yet. Existing `BoundedHttpHeader` in `packages/mail/src/types.ts:40–43` carries not-visible/value/too-long; the capture helper bounds Fetch-exposed strings at256UTF16units and preserves receipt/purpose. It performs no parsing. No existing provider or package entrypoint will import this parser. The old investigation's schema numbers remain obsolete; no schema is touched/allocated.

Source content pins: Plan55 initial blob81d281edcb1809a866f539902e1aa1833a6e5227; types87fa2fea125e808431c892d1dd4419ef48831326; helper9fa266859b9bc3fdc41541a67de14db712c13133. Plan55 receives a separate root-authorized config-RED note below its completed review. Preserve renderer drafts.ts/Plan43/untracked Forward WIP, icons, AGENTS and other source.

Concurrent root steering reports an actual global compile RED: the new Plan55 dual-store test was left in the backend Node-only project instead of its existing DOM lifecycle project. The exact two JSON list additions and Plan55 correction note are prepared under explicit root ownership extension, not part of the parser production ownership. One critique point checks that route and retained coverage. No config qualification/commit runs now; a later correction commit must contain only backend tsconfig.json, tsconfig.lifecycle.json and the Plan55 note, separate from Plan56/parser. Root's global window ended idle. That compile failure does not imply an HTTP behavior defect or an independently proven web error.

## Primary sources and interpretation

Normative grammar facts: Retry-After permits HTTP-date or decimal seconds; all three HTTP date forms are accepted by recipients. HTTP-date uses UTC, exact internal separators and case-sensitive named tokens. RFC850 year resolution depends on a current reference. Outer field whitespace is SP/HTAB. See [RFC9110 §10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3), [§5.6.7](https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7) and [§5.6.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.3).

HTTP's referenced date semantics require weekday/date agreement, a real month/day, valid time fields and years1900or later. [RFC5322 §3.3](https://www.rfc-editor.org/rfc/rfc5322.html#section-3.3). Gregorian leap-year and weekday arithmetic is illustrated by [RFC3339 AppendixC](https://www.rfc-editor.org/rfc/rfc3339.html#appendix-C) and [AppendixB](https://www.rfc-editor.org/rfc/rfc3339.html#appendix-B). AppendixB's sample is documented only from0000-03-01 onward; do not copy it blindly for January/February0000. [AppendixD](https://www.rfc-editor.org/rfc/rfc3339.html#appendix-D) describes leap-second occurrence; this syntax parser does not contain or fetch an occurrence table.

Active contract after root’s explicit in-window source clarification: match named HTTP-date tokens ASCII case-insensitively as the approved syntax-preservation candidate, with exported types unchanged. That clarification supersedes the intervening case-sensitive selection recorded historically below. RFC9110 remains case-sensitive; the broader project behavior is deliberate compatibility leniency, not a normative claim or a cache-specific exception.

Project choices, explicitly not normative guarantees: tolerate ASCII case variants; preserve full-year0000–1899 as proleptic Gregorian syntax; retain second60 without asserting a historical/future leap event; canonicalize decimal text; and cap exposed input before trimming. Pre1900 returns syntax parts, not a semantically valid RFC HTTP timestamp or scheduling permission. No result promises a usable epoch. The unchanged type carries ambiguity through form, year.kind/value and second60; raw evidence remains separately available.

## Exact module contract

Only new `packages/mail/src/retry-after.ts` exports these types/functions. Import existing BoundedHttpHeader as a type; the existing256limit may be referenced from the helper's constant without modifying that file. No existing barrel/export/caller/error type changes.

```ts
export type HttpDateParts = Readonly<{
  form: "imf-fixdate" | "rfc850" | "asctime";
  year: Readonly<{ kind: "full" | "two-digit"; value: number }>;
  month: number; day: number; weekday: number;
  hour: number; minute: number; second: number;
}>;
export type RetryAfterDirective =
  | { readonly kind: "not-visible" }
  | { readonly kind: "too-long" }
  | { readonly kind: "invalid" }
  | { readonly kind: "delay-seconds"; readonly decimal: string }
  | { readonly kind: "http-date"; readonly parts: HttpDateParts };
export function parseRetryAfter(header: BoundedHttpHeader): RetryAfterDirective;
export function parseHttpDate(header: BoundedHttpHeader):
  | { readonly kind: "not-visible" | "too-long" | "invalid" }
  | { readonly kind: "http-date"; readonly parts: HttpDateParts };
```

Result invariants: month1–12, weekday0Sunday through6Saturday, day valid as below; hour0–23, minute0–59, second0–60. IMF/asctime yield full0–9999; RFC850 yields two-digit0–99, never an invented century. The type permits combinations more broadly than the actual function outputs; do not extend it silently. Numbers here are only bounded calendar fields, never decimal directive seconds or milliseconds. Readonly nested results and input preservation hold; callers retain the original raw snapshot separately. Unknown/malformed evidence does not authorize a retry or overwrite any bound.

Input handling: pass not-visible and too-long states through. For value, check original UTF16length>256 before scanning/copying/trimming; return too-long even if stripping whitespace/zeros would reduce it. Then remove only outer ASCII space/tab, never JS trim's Unicode set. Empty is invalid. Whole-input matching must reject all trailing junk/CR/LF/NUL/nonASCII and internal tabs; beware JS dollar-anchor acceptance of a final newline. No list splitting or first-date wins.

Delay grammar: only ASCII digits. Strip leading zeros, returning exactly0 for all-zero input, otherwise the exact remaining decimal string. Reject sign/fraction/exponent/Infinity/NaN/units/Unicode digits/comma lists. A256digit number stays exact, valid syntax regardless of numeric representability. No Number/parseInt/parseFloat/BigInt conversion of the directive, clamp, policy ceiling or timer conversion.

Date forms: exact field widths/separators in the three documented forms, with deliberate ASCII case-insensitive matching for English short/long weekdays, months and GMT. Reject nonASCII before case folding; do not use Unicode folding or change raw evidence. IMF needs short weekday, two-digit day, month, four-digit year, complete time and GMT; RFC850 needs long weekday, day-month-two-digit-year and GMT; asctime needs short weekday/month then a two-digit day or a space-padded single digit, complete time and four-digit year, no GMT suffix. Reject ISO strings, offsets/local zones, missing seconds, extra internal whitespace, comments and combined dates. Parse response Date with parseHttpDate, never numeric grammar. No timezone/environment dependency.

Full-year validation: arithmetic Gregorian month lengths, divisibility-by4/100/400 leap rule, and exact numeric weekday. Use a bounded formula with well-defined integer division and positive modulo, not JS Date constructors/UTC/parse or a year/day scan. Mapping a year by an integral400year cycle for arithmetic is permitted solely to avoid year0/negative-division pitfalls; keep the returned year unchanged. Pre1900 validation is an explicit proleptic extension, not the RFC5322 minimum-year semantics. Preserve60 rather than normalize to the next minute/day or verify a leap-second calendar.

RFC850 validation: retain the two digits and named weekday. Reject date impossibilities independent of century, including day0/April31/February30 and February29 when yy is not divisible by4. Preserve February29 for yy00 (century-dependent), and defer century/century-dependent leap/weekday agreement. No hidden current year, fixed1969/1970pivot, RFC5322 mail-year pivot, or implementation of RFC9110's current-time-dependent fifty-year rule. A later explicitly clocked resolver owns it; this parser alone is not a complete HTTP timestamp interpreter.

## Future REDs and controls — none executed

Approved seam: the two newly exported pure functions. Tests will be new `retry-after.test.ts`, with literal independent expected results and input immutability. No provider mocks/network/server are needed for this grammar prerequisite. After release, first establish a compilable interface-only scaffold returning invalid, then observe a valid nonzero decimal/date case failing by wrong result, not module-not-found/type/import failure; this is an unimplemented-feature RED, not a claim against existing provider behavior. Implement in small RED/GREEN steps. No scaffold, module or test execution now.

- Decimal:0/0000/000120; exact long integers around2^53 and256digits;257units returns too-long before trim; distinct empty/not-visible/too-long; invalid negative/plus/fraction/exponent/nonASCII/embedded tab/newline/combined values.
- Exact full results for independent dated fixtures in all3forms, numeric month/weekday mappings, asctime06 versus space6 and optional ASCII outer whitespace. Canonical, lowercase, uppercase and mixed ASCII-case weekdays/months/GMT all decode to the same numeric parts; nonASCII lookalikes remain invalid. The same HTTP-date yields equivalent parts from both functions; numeric value is invalid only for parseHttpDate.
- Full Gregorian controls:2000February29 accepted with Tuesday;1900February29 and2100February29 rejected;2000January1Saturday versus wrong named day; April31; month/day/time bounds; proleptic0000January1Saturday and0000February29Tuesday to cover the AppendixB domain pitfall; four-digit0099 is retained instead of Date's1900offset. Expected dates are literal test fixtures, not computed with the implementation helper or Date.parse.
- RFC850: exact two-digit94 retained irrespective of machine clock; February29-00 retained; February29-01 rejected independent of century; named weekday disagreement remains unresolved rather than guessed/normalized. No epoch or resolved century output.
- Leap syntax: valid calendar date with second60 returns unchanged60 in each form; second61 rejected; no occurrence lookup, rounding or normalization. Date semantic/epoch applicability remains unresolved. Malformed GMT/offsets/ISO/list/CRLF/NUL/strict whole-input boundaries rejected while raw input stays intact.
- Purity/resource controls: temporarily make Date.now/Date.parse throw only around direct parser calls, restoring in finally before the test runner needs clocks; immutable inputs/results do not retain headers/Response/body; large-but-bounded synthetic overlong input returns too-long. Unit tests verify bounded contracts; no timing benchmark or physical heap guarantee is claimed. No test logs real data; all strings synthetic calendar/header values.

## Proposed bounded commands after root release

Serial only, each with actual argv/PID/start/exit/natural wait/reap and source/worker/emitter hashes; root coordinates globalSetup's incoming-worker build. No command below is authorized/run in this phase:

1. RED/GREEN: `pnpm exec vitest run --project unit packages/mail/src/retry-after.test.ts --maxWorkers=1 --no-file-parallelism` under180seconds, only after a module/scaffold exists. Compile/import failure is a harness failure, not a product RED.
2. Evidence controls after green: `pnpm exec vitest run --project unit packages/mail/src/http-response-evidence.test.ts packages/mail/src/gmail-http-evidence.test.ts --maxWorkers=1 --no-file-parallelism` under180seconds.
3. `pnpm --filter @terno/mail typecheck` under120seconds; `pnpm exec oxlint --deny-warnings packages/mail/src/retry-after.ts packages/mail/src/retry-after.test.ts` under120seconds; exact owned whitespace diff check under15seconds. Stop/reconcile failures before widening.
4. Separate config correction: `pnpm --filter @terno/backend typecheck` under120seconds checks both Node and DOM lifecycle projects; exact two-config/Plan55 diff and coverage-list check under15seconds. No tests lost from both projects; no DOM added to Node production. Separate atomic commit later through the common helper/lock, never stage parser/Plan56 with it.

Aggregate runtime ceiling and review/check ownership are set by root at release; propose≤600seconds per bounded window, no overlapping commands. No broad/global/browser/native/perf run now. Finite O(256)scan/workspace; at most256digit string output and fixed-depth date objects, no unbounded loops, clock/I/O, timers, dependencies, cache/history, raw logging, mailbox work or entry-bundle import. No schema allocation, branch, push, classification, resolver/deadline/backoff/admission/quota/UI change. No API/scope refinement without root coordination.

## Revisions after the Codex review

Exactly one bounded read-only critique completed with a4,251byte prompt and at most6points. The complete2,013byte substantive final was read. Its sole medium finding confirms the known backend type-project routing defect and the already-prepared exact two-list correction; accepted within root's explicit ownership extension. It confirms preserved five prior paths, lifecycle ES2023+DOM libs, empty exclude override, and the package's sequential two-project typecheck. Qualification is still pending; the web task's recursive cancellation is not an independently established web defect. No additional substantiated parser-plan findings were returned. No result/type/interface/scope change is proposed or implemented. No second critique was started.

Actual Codex PID48466, supervisorPID48464; argv `codex exec -s read-only -C /Users/Luis/projects/emailclient --output-last-message /tmp/terno-plan56-critique-4gtpmb18/final.md -` with prompt on stdin. UTC start2026-10-28T01:34:24.831349+00:00, finish01:35:06.085693+00:00;41.215seconds under300second ceiling; actual exit0, direct natural wait/reap=true. The transcript wrapper appends CODEX_EXIT0 and DONE; the substantive final does not contain or need a literal DONE.

The supervisor itself returned1 because its immediate exit-group snapshot still contained captured PID49681, a CLI-bootstrap computer-use helper already reparented to PID1. At cleanup inspection the helper had exited, and a fresh exact-group snapshot was empty; no signal was sent. This was a transient wrapper cleanup gate, not a second critique or a failed Codex result. No direct wait/reap claim is made for that reparented helper. No browser/native operation was requested or performed by the critic; automatic CLI MCP startup is recorded as a process-side-effect limit. Complete lifecycle/cleanup evidence: `/tmp/terno-plan56-critique-4gtpmb18/lifecycle.json` and `cleanup.json`; full prompt/final/transcript are adjacent. The recorded critic commands read only named sources and exact config diffs; no tests, imports, build, discovery, nested agents/CLI or source edits were executed.

Readiness: source plan READY, parser test plan READY, process IDLE. Neither retry-after source nor test exists; no functional command or compile recovery ran in this source/spec phase. The separate prepared working-tree config/Plan55 correction remains uncommitted and unqualified. Await root SMALLCHECK release, with config correction isolated in its own later commit. Future parser code requires fresh independent two-axis review and all applicable qualification; this plan critique grants no production/release/W05 clearance.

## Root contract correction after the critique

Between the source critique and implementation, root explicitly selected: “Use case-sensitive tokens; retain the candidate’s explicit pre-1900 syntax preservation”. The plan temporarily changed accepted token casing while leaving every exported type/result shape unchanged. The planned rejection controls reflected that intervening selection; the later explicit in-window clarification below supersedes it. Pre1900 proleptic syntax, unresolved RFC850 century and second60 remain as specified; no invalid/unresolved result grants retry permission or discards the separately retained raw evidence.

The single completed source critique reviewed the earlier case-insensitive candidate; its result is preserved historically and is not claimed as a review of this later selection. No second critique, parser/test source, functional check or commit was started for this documentation correction. Implementation remains gated on root SMALLCHECK and future independent two-axis code review.

## In-window root clarification of the casing contract

The SMALLCHECK release’s lenientcase wording conflicted with the earlier explicit case-sensitive selection. During independent config work the worker requested clarification and implemented only shared canonical behavior; the interim133case canonical GREEN and189case run with rejection expectations were not final approved-contract qualification. Root then inspected the source WIP and explicitly reaffirmed ASCII case-insensitive matching, directing a meaningful case-variant RED→GREEN. This is the active contract and supersedes the case-sensitive selection above without changing exported types, pre1900 preservation, unresolved RFC850/leap semantics or runtime scope. The worker changes the17case-variant fixtures from rejection to acceptance before changing production matching; a fresh guarded RED must show wrong results, then the final parser/control/types/lint/diff checks run serially on the corrected source. No earlier partial GREEN is relabeled as final.

## Released window: results before the native-baseline hold

The config correction was qualified first: backend package typecheck0 checks both Node and DOM lifecycle projects; exact route/coverage/diff0 preserves all six routes. Separate atomic commit `336e708b3427147023e0a140bc7c3f2fdcabeffb` contains only the two backend configs and Plan55, via the common helper/lock with empty index and required footer. Independent compose/menu/Plan57 commits subsequently advanced shared main through `7be6c6d7`; they were preserved. The recorded hash scope is the explicit input list in each guard JSON, not a whole-repository freeze or a claim that HEAD never moved.

The interface-only compilable scaffold produced an actual wrong-result RED:53failed/80passed of133, with no import/compile failure. Canonical parsing then passed133; a later189case run included case-sensitive rejection expectations and is not final qualification. After root's explicit in-window clarification, the17variant fixtures became acceptance controls;34assertions failed/155passed of189 before the matcher changed. ASCII is checked before folding, then the corrected parser passed all189cases (PID77414, actual0, natural0.525seconds). Existing evidence controls reran afterward:57passed (PID77859, actual0, natural1.062seconds). Both command groups were empty after natural wait/reap. The earlier mail typecheck0 preceded the final casing change and must not be claimed as final-source qualification.

Full argv/PID/UTCstart/actualexit/reap/child-group/input-hash records and logs are under `/tmp/terno-plan56-checks-9b9evekx/`. The parser has no caller/barrel/schema/provider change or policy/deadline authority. No additional critique, browser/native/perf/global check was launched by this worker.

Root requested a trusted native scheduler baseline during this window. The then-current evidence-controls-final command finished naturally with actual0 before the hold; it was not terminated/restarted. CHECKS_IDLE was sent, and no new functional/type/lint/build command is permitted until ROOT NATIVE END. Remaining final-source work: mail typecheck≤120seconds, exact two-file owned lint≤30seconds, scoped diff≤15seconds, then the separate parser/test/Plan56 atomic commit only if all checks pass. This temporary hold is not parser END or production/release/W05 clearance. Source-only Plan56 bookkeeping is allowed during it.


## Final qualification and root-owned review handoff

ROOT NATIVE END explicitly released only remaining final mail types/owned lint/scoped diff/commit; no test repeat was started afterward. Root reaffirmed ASCII case-insensitive matching and that the older strict-case summary did not override the current contract. No parser source/test changed after the final189case acceptance GREEN and57evidence-control GREEN. Mail final typecheck passed actual0 (PID83175, natural1.046seconds); exact two-file owned lint passed actual0 (PID83225, natural0.528seconds). All direct guarded commands were naturally waited/reaped with empty remaining command groups. No timeout, signal, test setup correction, import/module error or new unrelated failure occurred in this window. The two nonzero test commands are the expected scaffold and case-variant wrong-result REDs, explicitly preserved below.

The parser implements only the approved bounded pure exported seam. Numeric directive seconds remain canonical strings, including256digit values; calendar numbers are only fixed-width fields. Full-year validation uses bounded Gregorian arithmetic with an extra400year cycle for year0 safety; RFC850 leaves century/weekday agreement unresolved and conservatively retains00February29. Second60 and pre1900 values remain syntax, with no epoch/deadline claim. All189cases include ASCII case variants after nonASCII rejection, the three forms, all12months/seven weekdays, leap-century controls, year0000/0099/9999, header states/bounds, malformed whole-input controls and clock/Date parse/UTC guards. No existing provider/caller/barrel/error/schema/UI/logging source was changed. The parser is not wired into runtime consumers; importing the existing header-limit constant does not call the HTTP capture helper.

The final scoped diff command checks only retry-after.ts, retry-after.test.ts and this Plan56, including new-file whitespace checks. Git no-index content-difference exit1 without diagnostics is normal; whitespace diagnostics/other errors fail. Only those three paths may enter the later parser atomic commit, under the shared helper/lock with an empty index and required footer. Config commit336e708b remains separate and includes no parser path. The actual new parser SHA and exact parent are in parser-commit.log/json and the external handoff, avoiding post-commit edits of this plan.

### Guarded command ledger through final lint

All artifacts: `/tmp/terno-plan56-checks-9b9evekx/`. Each named log/JSON records full argv, actual PID/OS start, UTC times, bounds, result, direct natural reap, sampled descendants/remaining group and before/after SHA256 for the explicit22input paths. Sampling is not a claim to have directly waited every short-lived grandchild or frozen the entire repo. Independent commits/source changes outside this named scope are preserved; HEAD movement is not silently equated with input mutation. The only build invoked here was the acknowledged unit-globalSetup incoming-worker build; no extra build/browser/native/perf/global command was run by this worker.

| Record | PID | Actual exit | Seconds | Meaning |
|---|---:|---:|---:|---|
| config-types | 66405 | 0 | 2.167 | Both backend type projects passed |
| config-coverage | 67913 | 0 | 0.541 | Exact two-list routing/coverage/diff passed |
| config-commit | 67968 | 0 | 0.527 | Separate three-path config commit |
| parser-red | 69977 | 1 | 1.06 | Expected scaffold RED:53failed/80passed; imports worked |
| parser-green-canonical | 73085 | 0 | 0.531 | 133shared canonical cases passed; interim only |
| parser-green | 73625 | 0 | 0.531 | 189with old strict rejection cases; not final contract |
| evidence-controls | 74128 | 0 | 1.054 | 57passed before casing correction; interim |
| mail-types | 75479 | 0 | 1.053 | Passed before casing correction; interim |
| parser-case-red | 76327 | 1 | 1.051 | Expected case RED:34failed/155passed of189 |
| parser-case-green | 77414 | 0 | 0.525 | Final approved parser:189passed |
| evidence-controls-final | 77859 | 0 | 1.062 | 57passed after corrected matcher |
| mail-types-final | 83175 | 0 | 1.046 | Final mail types passed |
| parser-lint | 83225 | 0 | 0.528 | Exact two-file lint passed |

Test commands were≤180seconds, package types≤120seconds, lint≤30seconds and coverage/diff≤15seconds. ledger.json contains the exact aggregate; source-editing and the root-owned native baseline are not falsely counted as test runtime. The two commit-helper calls have separate captured runtimes. Source/worker/emitter hashes are scoped to the named manifest; final summary.json reports observed stability and any per-command deltas, not an unmeasured whole-build reproducibility guarantee.

Fresh independent two-axis code review is root-owned and pending for this parser and the separate config correction as appropriate. Root owns Plan26/worklist and global type/lint retry. PARSER END/CHECKS_IDLE closes only this worker's bounded implementation window; it grants no W05/T04/A10/durable-throttling/restart/performance/release clearance. No schema number, branch or push was created. Any later findings need meaningful regressions and another coherent correction; this worker ran no extra critique.

The final hash audit found exactly one within-command input delta: the first unit invocation (parser-red) rebuilt `packages/backend/dist/incoming.worker.cjs` from SHA256 `338a19186945cbc0a404ce74f477e117f24526442cec352920b2a476cd28f875` to `db77deedbf313c08960a086092791bb274a9dcfb3bf1379d031644d72034aa2e`. All later captured output hashes remained at the latter value. The named worker source, emitter/setup scripts, Vitest config, AGENTS, provider files and entrypoints stayed unchanged across these captures. This is the acknowledged globalSetup build-output effect, not an assertion of stable generated output over the whole window. The22path manifest does not cover every transitive build dependency or freeze independent shared commits, so it cannot identify the full upstream cause of a different generated image. No extra build or test repeat was launched for this expected delta. The three-path whitespace check is rerun only because this evidence paragraph changed the plan.

## Parent independent R1 review

The finite review pins `c68bf54ff5727f79215309b11dea88175f59f1fd` and reviews only its parser change plus the immediate-parent config correction `336e708b`; intervening foreign menu work is not attributed to this slice. Standards and Spec each reported zero confirmed findings and the known medium routing issue resolved. The parent read both complete verdicts, CLI finals, contract dispositions and reconciliation: `/tmp/terno-provider-hardening.x0emTS/retry-after-syntax-r1-standards-zr7_f_o3/verdict.md` and `/tmp/terno-provider-hardening.x0emTS/retry-after-syntax-r1-spec-z7zbuu34/verdict.md`.

Each fresh CLI finished naturally with actual exit 0 and was reaped. Archive bytes and executable modes stayed unchanged. Standards' initial oversized output was recovered; Spec's grouped aggregate exceeded the display budget while individual chunks remained complete. These recorded procedural deviations do not conceal an unread mandatory contract. Full typecheck and lint later passed at clean `2ea6027a`; the separate full unit/WASM failures remain in Plan26. This parser still has no runtime retry-policy caller and supplies no deadline, durable cooldown, admission, restart or W05 clearance.
