# W12 S53: Web GIS recovery qualification

Request: qualify current Web account/provider errors through sidebar, settings and add-account UI in English and Spanish, light and dark, using the development Web app, real Chromium worker and SQLite/OPFS, synthetic GIS/provider responses and no external traffic. Preserve the ownership and testing restrictions in the task brief.

## Design and checks

A dedicated development-only Playwright configuration and spec use isolated port/output, real app initialization and per-test synthetic mailbox. Stub GIS before startup and intercept only exact synthetic provider endpoints; reject every other external request. Confirm OPFS storage. Exercise UI controls with popup closed/blocked, administrator denial and an unknown provider error containing a synthetic secret; check complete localized safe copy, actions, keyboard access, focus, pending behavior, duplicate submissions and absence of token RPC on rejected grants. Include successful same-account reconnect, and a long backend refusal if the Web endpoint can naturally produce it. Cover each surface across en/es and light/dark, with scoped axe and screenshots outside the worktree. Production Web discovery remains unchanged. Development React preamble needs CSP bypass; this does not qualify product CSP.

Existing protections need no invented red. A real owned renderer failure gets a fail-first regression and minimal correction with locale and visual checks. No backend, RPC, stores, mail providers, compose or receipt changes; no production build, full suite, perf, real profiles or real provider traffic. Plan critique precedes test implementation, and native read-only Standards+Spec code review follows the coherent slice.

## Revisions after the Codex review

The native sol/high read-only critique returned nine points. Use a real non-demo Gmail identity and reload for recovery, drive all controls, hold callbacks, include a worker-side wrong-account refusal and same-account success, enumerate provider routes, persist locale/theme, and check focus and accessible error copy. The Web identity path discards arbitrary non-OK provider bodies, so arbitrary long provider detail is not reachable; a long valid wrong mailbox can exercise a bounded worker refusal. GIS script-load qualification and late completion after dismissal are separate behaviors, not claims of this consent/error matrix; record any observed dependency rather than expanding into unrelated popup lifecycle work.

## Qualification

The unchanged renderer passed four development Web cases (en/es × light/dark). Each uses a real Chromium worker and confirms SQLite/OPFS, creates a synthetic Gmail identity, reloads to expose worker-driven reauthentication, drives sidebar notice and marker, Settings and Add Account, holds GIS callbacks to check disabled and duplicate-submission semantics, checks five fixed denial outcomes with exact catalog copy and no token RPC, and checks scoped axe. A worker-side long wrong-account response preserves the identity; the correct account then reconnects and receives focus. Precise synthetic provider routes are intercepted and all other traffic is blocked; onboarding local-model probes are explicitly aborted. Screenshots are outside the worktree in `/tmp/terno-w12-s53`, and representative light/dark English/Spanish long and admin errors were inspected. The dev React preamble requires `bypassCSP`; these tests do not qualify the product CSP, Google-hosted UI or native lifecycle.

The first run timed out on an incorrect sidebar accessible-name fixture; the first expanded run's three failures were the fixture's own accounting of blocked local-model probes. Neither is product RED. No production source changed. Web package typecheck and strict touched-file lint passed; full builds and suites were not run.

## Code review and final checks

Native read-only sol/high Standards+Spec R1 reviewed `0902d386` and found one P2: the test's broad catalog key failed a dedicated test typecheck. That check independently reproduced the real compile failure (alongside fixture Window declarations); `a89f0bdd` narrows the key and declares the fixture state. The dedicated test/config typecheck and strict touched-file lint then passed. R1 had no Spec findings but did not have the complete brief. Native sol/high R2 reviewed the whole series with the brief and R1 response: Standards and Spec both zero findings, R1 resolved. Review logs are `/tmp/terno-w12-s53-code-review.txt` and `/tmp/terno-w12-s53-code-r2.txt`.

The post-correction browser matrix passed 4/4 in 28 seconds. Production Web `--list` reports 51 tests in 9 files and excludes this dev-only spec. No production build, full suite, perf gate, native lifecycle or real provider was exercised. These are bounded Web recovery/error qualifications, not S53-wide release clearance.
