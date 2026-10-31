# Provider reliability: seventh release milestone

Tested committed main `004cf99943afa4055219688b0121baf130cb5f60` once, serially in an isolated worktree. **Not release-green.** Live licensing/package WIP was excluded.

| Gate | Exit | Pass / Fail / Skip / NOTRUN |
|---|---:|---|
| 00-offline-install | 0 | None / None / None / None |
| 01-typecheck | 0 | None / None / None / None |
| 02-lint | 0 | None / None / None / None |
| 03-test | 0 | 13839 / 0 / 5 / 0 |
| 04-e2e | 1 | 1587 / 1 / 7 / 0 |
| 05-web | 0 | 53 / 0 / 0 / 0 |
| 06-ui-perf | 1 | 11 / 2 / 0 / 50 |
| 07-perf | 1 | 279 / 1 / 1 / 0 |
| 08-dist-mac | 0 | None / None / None / None |
| 09-smoke | 1 | 63 / 1 / 7 / 0 |

Five observed failures:

- Dropped images: expected a.png,c.jpg,d.gif; actual a.png,d.gif,c.jpg (composer-drop.spec.ts:160).
- 5 MB suggestions paired typing: start median1.183 against1.178; downstream checks unreached.
- Lumen comfortable sustained-j:150 ms maximum frame against50;50 UIperf successors NOTRUN.
- v23 folder migration backfill:20.139583 ms slice against16 (folders-migration.perf.test.ts).
- Packaged v13 People profile: schema expected30, actual32.

Backend perf completed naturally in1951.2seconds. No stage retries, source/oracle changes or outer signals. All required stages ran; source/index unchanged, outputs restored, zero owned survivors. Fresh0.1.0arm64 ad-hoc package hashes and deep signature verified; no notarization/Keychain clearance.

Unit11987/3skip plus normalWASM1852/2skip. E2E7skips:6optional autolinkcaptures and1classic-row/avatar case. Backend1opt-inindexcostskip. Smoke7skips:2testbuildfatal and5stable-signingupdate. Unit/WASM skip names not emitted. No required stage NOTRUN, but50UIperf cases unexecuted.

Evidence: [full report](/tmp/terno-release-milestone7-o5i3u5d5/report.md), [exact argv/results](/tmp/terno-release-milestone7-o5i3u5d5/results.json), [build identity](/tmp/terno-release-milestone7-o5i3u5d5/build-identity.json). Historical failures remain recorded; broader153-row goal remains open.

Next: separate worktrees for editor drop/suggestion costs, sustained list navigation, and database migration/backfill plus packaged schema witness. Targeted failing regressions, unchanged gates, one actual Codex review per fix series.
