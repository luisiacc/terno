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
