# Release 2 native reload and print fixtures

## Request

> Act as the implementation sub-agent for this task.
> Work yourself in isolated T3 worktree, no children. Provider release2baseline priority.
> Five native-reload failures: missing/unknown stopped-engine modal override absent, missing/unknown menu/CmdR notice absent, savedACKpause absent. Print longURL selects Japanese subject instead of expectedSpanishlongURLs.
> Diagnose fixture readiness/semanticownership vs realretentionfault; NEVER weaken no-work-loss, unknownACKproof, pendingfiles, disclosedoverride, exactretainedbytes/focus, PDFheaders/content/Letter/A4/nooverflow assertions.

## Existing evidence and scope

Base 4bc4d2f6 includes renderer49e8b822. Own only apps/desktop/e2e/native-reload.smoke.ts, print.smoke.ts and directly necessary local fixture helpers/tests. Plans35 and09 define retention and PDF contracts. Main/worklist/plans64–68 and backend/store/shared compose remain read-only. The original bounded smoke evidence records six assertion failures; ordinary two-file baseline is running before edits.

Archived app source59b3661b differs from this checkout. Copy only into ignored local release path then synthetic temp app/profile. Executable SHA256 fd0b4ff9d1291588f641d8e30c4ff4b9deb3d6a91169907f4464595b1f767884; asar2d42124e8bde52e146d39817b50087d9ba0cd49845cbf0a842562ddb365f4246. Original archive/user outputs immutable. No build, keychain, real profiles, pushes or external traffic.

## Design and tests

Observe actual native flush requests/ACK/release/refusal/navigation phases and renderer save-request ownership before choosing a fix. Distinguish a gated autosave from a save held by native flush. Print selection must wait for the requested result identity, not a count that a previous search already satisfies. No fixed sleeps, retries or increased budgets. Preserve all exact bytes/focus/unknown response and disclosure/PDF assertions. Legacy identity holds cannot justify clearing work; shared renderer needs are handed off with evidence.

Use original affected smoke cases as RED, then minimal fixture changes and affected two-file GREEN plus desktop/web types and scoped strict lint. UI controls still get keyboard/axe and personally inspected app-only light/dark captures. Exactly one native gpt-6.1-sol/high read-only plan critique (<=12 points) then one completed Standards+Spec code review. Findings fail first; after cap only high correctness/data-loss fixes, lower issues backlog. No full suites, full smoke, perf or production builds. NODE_OPTIONS always appends /tmp/terno-network-guard.cjs; unset ELECTRON_RUN_AS_NODE, TERNO_DEV_URL and TERNO_SMOKE_SCREENSHOT. Owned PID/birth only; exhaustive close/join and temporary cleanup.

## Revisions after the Codex review

Native gpt-6.1-sol/high plan critique completed with nine points (artifact plan-review.md). Accept all: correlate native owner/document/flush phases; require native hold before exact ACK release; independently observe refusal routes plus burst coalescing; strengthen committed-copy identity proof without losing unknown status; wait requested results identity and exact fixture row; cover predecessor searches; await committed navigation before counting; always clean focus-window/gate/listeners. Archived-package results remain explicitly distinct from checkout validation. The failed CLI launch used an incorrectly inferred model_provider=release2baseline; root clarified this is the project baseline name. No global configuration was touched; the normal configured provider completed the critique.

Original two-file command, with inherited NODE_OPTIONS guard and launch variables unset: pnpm --filter @terno/desktop exec playwright test -c playwright.smoke.config.ts native-reload.smoke.ts print.smoke.ts. Exit1:6failed/9passed/2skipped/8notrun,4.6minutes. All five native assertions reproduce. Print stale predecessor occurs at wide-table→CJK rather than CJK→longURL this time. No retries or budget changes. Diagnostic phase runs are separate evidence, not retries claiming GREEN. Original logs and owned lifecycle manifest: /tmp/terno-release2-native-print/.

## Causal diagnosis and implementation

Phase diagnostics observed fresh flush-ready document tokens, then menu-before/menu-click with focused webContents=null and no flush-drafts/done/refusal at all. The helper called MenuItem.click() without Electron's callback window argument, so reloadFocused had neither focused contents nor a fallback owner. Passing the captured actual owned BrowserWindow through the real callback signature fixes dispatch; no product admission change or fake clearing is warranted. Saved-ACK now requires the native editing pause before the exact intercepted response can be released; the changed-focus and stored bytes assertions remain. Unknown-copy response validation plus SQL identity/revision witness strengthens committed-but-unacknowledged evidence. Successful native transitions await actual main-frame navigation rather than a previously visible row. Each stopped command is independently refused after dismissal, alongside original burst coverage.

Print waits data-results-for's requested query and the expected subject row, preserving count1 and exact Reader subject. All existing PDF content/header/Letter/A4/overflow/atomic/private-permission assertions remain. External renderer HTTP(S) is blocked, screenshot env is removed, and normal/failure cleanup uses the existing local packaged-fixture helper. That helper now captures PID+birth, validates identity before every signal, joins and reports survivors. Its added recycled/disappeared-PID regression fails before the identity fix (Owned Electron helpers remain alive), then all four helper tests pass. No renderer/store/backend production files or real profiles changed.

Scoped desktop and web package types pass. Explicit smoke/helper types expose the pre-existing imported apps/web/e2e/print-pdf.ts:31 pdfjs-dist DocumentInitParameters/isEvalSupported mismatch; owned-file diagnostics are resolved. This is a dependency-owner handoff, not a weakened PDF safety option. No new binary exists; all packaged results belong to immutable source59b3661b only.

## Single Standards+Spec review disposition

Exactly one completed native gpt-6.1-sol/high read-only code review (code-review.md, transcript code-review.log): Standards1/P2, Spec1/P1. P1: blanket route hides the positive print privacy witness. Candidate run fails that exact assertion; final fixture cancels external HTTP(S) at onBeforeSendHeaders in the owned default/print sessions, after the product fence. Existing witness handlers replace cancellation with their own recording+cancel, preserving no external transmission and every positive/negative assertion. P2 concerns required process-safety proof: the original added test only simulated absence. The revised test exposes a present ps result with a different birth and records any signal attempt. Removing only the birth comparison makes that regression fail; restoring it yields4/4. Logs review-helper-red.log/review-helper-green.log. No second review, model switch, production fix or lower-priority backlog introduced.

First candidate qualification:2failed/20passed/2skipped/1notrun. All eight PDF fixtures and four original native warning failures pass. Saved-ACK advances to the changed-native-focus predicate; the synthetic window now explicitly activates its own app before focus, retaining the actual focused-webContents assertion. The candidate also exposed the above privacy route conflict. These are retained failures, not green claims. Final qualification includes the completed fixture/readiness, stronger unknown-copy, birth-fence and cleanup edits.

## Final qualification and handoff (not green)

Final same two-file command with inherited NODE_OPTIONS guard and E2E_PORT57000/WEB_PORT57010, plus TERNO_SMOKE_PDF_OUT=/tmp/terno-release2-native-print/pdfs: **exit1,21passed/2failed/2skipped,5.6minutes;0notrun**. All13print cases pass, including32fixture PDFs, four demo PDFs, both privacy fences, native menu and no-printer path. Native stopped missing/unknown independently refuse menu/CmdR/CmdShiftR and preserve exact editor/recipient/files/bytes/Undo. Native unknown-work full sequence, exact saved-ACK admission through actual changed native focus and commit, and detached DevTools pass. Fatal-screen source-only cases remain the original two skips.

Two final native failures are retained, with no retry seeking green:

- Healthy Settings unknown-copy: committed response and matching SQL identity/revision witnessed; while waiting for the35s RPC unknown message the page/context closes after8.4s with copy state still Saving. Earlier candidate passed this exact case. No reason for closure established.
- Native missing-work: page/context closes during the initial compose-body.press(Meta+b), before any reload/recovery boundary;53.8s terminal duration. Earlier candidate passed the complete retained-work/disclosed-override flow. No reason for closure established.

These failures are not waived or attributed to external interference, current renderer, or retention without evidence. Root serial integration must qualify them and the fresh-source binary; no source Dev build was available and no production build was authorized. No shared compose/inline-draft source was edited and no fake legacy-identity hold clearing introduced. Full current-source packaged/release clearance is explicitly absent.

Commands/checks:
- Helper regression: pnpm --filter @terno/backend-dev exec tsx --test ../../apps/desktop/e2e/packaged-fixture.test.ts —4pass after both fail-first controls.
- pnpm --filter @terno/desktop typecheck —pass; pnpm --filter @terno/web typecheck —pass.
- pnpm exec tsc -p /tmp/terno-release2-native-print/types.json —fails only at existing imported apps/web/e2e/print-pdf.ts:31, unsupported isEvalSupported option. Dependency owner must resolve this without weakening PDF safety. Owned smoke/helper diagnostics are clear.
- pnpm exec oxlint --deny-warnings (four touched smoke/helper files) —pass; git diff --check —pass.
All test/check launches append inherited NODE_OPTIONS with --require=/tmp/terno-network-guard.cjs. No full/global gates, perf, production builds or retries.

Artifacts: /tmp/terno-release2-native-print/{red,diagnostic,phase,green,final}.log; plan-review.md; code-review.md; both review-helper RED/GREEN logs; identity.json; owned/cleanup manifests; final-error-contexts/;56app-only screenshots;36PDFs. Personally inspected app-only light/dark stopped/refusal/recovery captures, with passing keyboard/axe checkpoints; no desktop capture. Original archive executable and asar hashes rechecked unchanged; ignored local release copy removed. Temporary app/profile directories were already removed by fixture cleanup. All captured runner/owned processes joined; final cleanup manifest actions[]/remaining[]. No user ports, real profiles, keychain or secrets touched; no pushes/landing.

## Same-series continuation: identify the close boundary

Root requested a bounded diagnosis of the two remaining native failures, retaining a436f15d, all earlier errors/assets and the consumed review cap. No additional review, production change, new build or unchanged qualification run was performed.

Added opt-in TERNO_NATIVE_TRACE_DIR diagnostics in the directly owned native smoke/local fixture helper: timestamps, captured app PID/birth, bounded stderr, app exit code/signal, page/context close/crash, native window close/destroy, app quit callers/events, render/utility exit events, effective test timeout and cleanup entry/signals. A small external reporter records every test/hook/API boundary and effective120000ms test budget. Synthetic crash/diag/log/database evidence is retained before fixture removal. Normal runs without the trace variable acquire no listeners or output. Quit/window wrappers only forward original calls; no event is prevented or policy changed. A one-off own-PID native sample was used only in continuation-4; it is not part of the retained helper.

All diagnostic launches append the inherited Node guard and unset all three prohibited Electron/screenshot variables, using the unchanged120000ms test/35000ms unknown-status budgets and ports57000/57010. They select only the two failed native cases, then narrow the quit-caller/native-stack probes to healthy-settings unknown; no print/full smoke/full gates/retries to obtain a green summary.

Artifacts under /tmp/terno-release2-native-print/:
- continuation-1: diagnostic setup error, dynamic import is unsupported in Electron's evaluation VM. Both apps cleaned up/exited0; target paths never ran. Error retained; probe corrected to process.getBuiltinModule.
- continuation-2: actual path reproduction,1failed/1passed in28.8s. Healthy Settings unknown closes early; complete native missing-work retention/disclosed-override case passes. Main22566/worker22267/reporter JSONL identify the boundary below.
- continuation-3: added pass-through quit/window caller and modified-key tracing. Healthy Settings unknown completes its complete original assertions,1pass40.5s; only quit is the recorded expected cleanup app.quit call afterward.
- continuation-4: one additional own-PID native-stack probe,1pass41.2s; no unexpected quit captured. Its sample is explicitly the expected cleanup/inspector quit control, not evidence of the earlier quit's native caller. No repeat qualification follows these diagnostics.

### Causal boundary and concrete native-action handoff

The reproduced healthy unknown failure enters native app quit before the Playwright deadline and fixture teardown. Final exit is code0/signalnull, with no observed render crash:

1. Reporter shows the test waiting for unknown status; no keyboard/API close command is active. Test timeout is120000ms; failure occurs at15.7s.
2. Owned-PID22566 macOS unified log records AppKit performKeyEquivalent at16:04:05.043Z and sendAction at05.044Z. Main emits first before-quit at05.062Z, then hides its window. This sequence supports a native action-dispatch route; it does NOT identify an actual key or sender.
3. Product's existing forced explicit-quit shutdown runs. Second before-quit at09.099Z has the packaged main.cjs shutdown-finally stack; contents/window destroyed09.102Z; quit09.104Z; page-close09.106Z.
4. Only afterward does afterEach-cleanup-entry run09.110Z. closePackaged/app.close starts09.182Z. Captured app exits code0/signalnull09.223Z. No cleanup signal was sent. Thus this reproduced closure was initiated before helper cleanup and long before either test or assertion deadline.
5. Frozen synthetic DB independently verifies one committed copy, generation/revision1, exact healthy rich body/recipients/ref and AP+A attachment bytes after quit (post-quit-copy-witness.json). The original ACK remains withheld; no false acknowledgement/retry/discard was introduced.

Original missing-work PID70464's own unified log also has AppKit performKeyEquivalent09:56:26.783local/sendAction26.784, followed by proc_exit27.161. Original unknown PID64782 shows sendAction09:54:12.960/proc_exit13.095; there was no equivalent detailed lifecycle probe then, so its initial native action is not retrospectively asserted. Both original logs are retained alongside the reproduced proof. No process/user/controller is blamed, and the unknown request's sender remains unproven.

Concrete root integration boundary: correlate the native application Quit/action dispatcher while these owned app windows are foreground. The proven reproduced failure enters that native Quit interface before fixture cleanup; it is not evidence authorizing a renderer/store fix, different identity, disabled Quit, quiet-window requirement or changed retention/deadline. No in-scope readiness/cleanup defect causing this native dispatch was demonstrated, therefore no speculative behavioral fix was made. The complete original assertions succeed in instrumented controls, but the prior integrated21pass/2fail result is not overwritten or relabeled green. Branch remains unlanded pending integration's native-action attribution/current-source packaged qualification.

Validation after continuation: four cleanup helper tests pass; scoped strict lint/whitespace pass; scoped smoke/helper types have only the already disclosed imported print-pdf.ts:31 isEvalSupported mismatch. No second review. App-only light/dark unknown-modal captures personally inspected with passing keyboard/axe checks. Previous36PDFs/56screenshots/error logs untouched. All diagnostic app-process exits are joined with code0/no signal, temporary live app/profile copies removed, and archive executable/asar hashes rechecked unchanged. Frozen synthetic evidence is intentionally retained under continuation directories.
