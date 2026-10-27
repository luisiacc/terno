# Plan 48: keyboard entry to the conversation list

## Request (verbatim)

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

## Existing behavior and observed failure

Plan 24 deliberately excluded the virtualized conversation listbox from Tab navigation (§1, §2.5). Its rows are not independent Tab stops; global arrow commands move the selected row, exposed through aria-activedescendant. ThreadList's scroll container has tabindex=-1 and outline-none.

The new Plan 47 full-page accessibility oracle reached its original assertion and failed in all six theme/design cases. A separate two-case fixed-bundle diagnostic reached the same assertion on both the current 75b4040 bundle and the earlier 8e1f4fc bundle. Both identified exactly the scrollable Conversations listbox. Evidence: /tmp/terno-sign-in-browser-c9l7zhbw and /tmp/terno-scroll-axe-diag-6kzectlc. The comparison used the same current backend and different renderer pins; it proves presence at the earlier pin, not an isolated library-patch comparison. Existing Plan 24 accessibility checks suppress this rule, so their historical passes did not establish this behavior.

## Design and explicit policy revision

The conversation list is one Tab stop in both layouts. Rows remain virtualized, with the existing selected row announced through aria-activedescendant; no per-row Tab stops are added. This explicitly supersedes Plan 24's tabindex=-1/no-Tab policy. Back can still focus the same listbox programmatically. The covered List page remains inert and cannot receive focus.

Use tabindex=0 on the existing listbox and the existing ring token for an inset keyboard focus indicator. Keep the existing document-level navigation commands, selection semantics, handlers, DOM identity and virtualization. No backend, state, subscription, query, timer, public API, copy or locale changes are needed. Remove the scrollable-region-focusable suppression from Plan 24's full-page accessibility check; do not suppress it elsewhere to make the new gate pass.

## Qualification

Add an @design browser case for both layouts and both themes. Start from the checked Inbox navigation anchor, traverse with real Tab presses under a finite bound, and require focus on the exact named Conversations listbox. Require a visible keyboard focus indicator. In List layout, ArrowDown must advance the active descendant and selected row while keeping focus on the list and not opening Reader. Tab must leave the list rather than visit every virtual row. Capture unique light/dark screenshots and inspect them. Run full-page WCAG A/AA axe without rule exclusions. Preserve the original Plan 47 six-case checks and their historical failures.

The observed full-page axe failures are pre-fix RED evidence. New keyboard tests are unexecuted when written; record actual results separately. Run web/E2E typechecks and focused lint. Fresh independent Standards and Spec code reviews must follow the fix, with regressions for every finding. Actual packaged desktop and global/performance qualification remain required before report completion.

## Performance and resources

The source change is a static DOM attribute and CSS focus indicator. It adds no subscriptions, row state, allocations per navigation, backend work or idle activity. Keep the existing virtualized list and render gates; no budget changes. Global and UI performance failures remain open and must not be relabeled by this accessibility fix.

## Out of scope

This slice does not establish the cause of the rapid-conversion failures or the initial rich-editor HTML failure. It does not close incoming throughput, cold SQL/body costs, whole-operation terminal settlement, broader IDB shutdown or any remaining report item. Only Outlook is deferred by the original mandate.

## Revisions after the Codex review

One source-only Codex critique completed with actual exit 0, substantive DONE, and natural reap: /tmp/terno-list-keyboard-entry-critique/{critique.txt,result.json}. All three refinements accepted before production:

1. Backend settings mutation alone does not repaint the existing renderer. Reload after setting the theme and assert the resolved HTML theme before keyboard/axe checks.
2. Check that Tab leaves the entire list, not merely its root. After ArrowDown require the expected next row ID and accessible aria-selected, independently of data-cursor.
3. A selected row can be virtualized out after scrolling. Preserve both scroll and selection on Tab entry; omit aria-activedescendant while its option is absent and restore it when the selected option mounts. The existing selection subscription still updates without a ThreadList render. One constant-time DOM ID lookup on virtual-range commits keeps the attribute valid; no polling, extra subscription, per-row state, backend request or automatic jump on entry. Add a scrolled-entry regression.

The bounded retained-bundle keyboard baseline eventually reached its behavioral assertion and failed because Tab never reached Conversations: /tmp/terno-list-tab-baseline-8ck2e0ci/run.txt (actual exit 1). Before that, two external harness invocations failed before tests (unresolved external Axe import, then an anchored grep selecting no tests); discovery also initially used an incorrect generated config path and was corrected before the successful one-case discovery. Those setup failures are preserved, not counted as product REDs. The successful baseline retained all 137 assets and source/worker bytes, reaped captured processes and removed its own TMPDIR; no listener remained, but the renderer port still failed a direct bind and is not claimed free. Native browser input is real; this finite test does not establish every keyboard flow or performance.


The scrolled-entry source counterexample was independently reproduced before production against the retained pre-fix bundle: /tmp/terno-list-scrolled-red-20261027/run.txt. Its exact assertion reached a missing selected option with aria-activedescendant still present (thread-10); actual exit 1. All prior selected-ID/scroll/unmounted-option preconditions were reached. Later Tab and navigation assertions were not reached. Captured source/137 assets/worker stayed unchanged; processes reaped/TMP removed/no listener, direct renderer bind still occupied and not called free.

## Source implementation checkpoint

The list now has one Tab entry point, an inset token focus ring, and a valid active descendant only while the selected option is mounted. The existing selection subscription writes the attribute directly; a layout effect on the memoized virtual range handles unmount/remount without changing selection or scroll. The new suite covers both themes/layouts/designs plus scrolled List entry, with explicit resolved-theme, accessible selected-row and whole-list departure assertions. Plan24's rule suppression is removed. Web main/worker types, explicit E2E types, focused lint and diff check passed (/tmp/terno-list-keyboard-entry-critique/check-results.json). The 18 new browser cases, existing accessibility checks, screenshots, fresh code review and broader gates are still pending at this checkpoint.

## Actual browser qualification at ab6f586

All 18 new keyboard cases passed (both layouts/themes/designs, including six scrolled List cases); all six existing Plan24 list/thread/compose full-page accessibility and unchanged visual-baseline cases passed with the rule exclusion removed. The full combined invocation was 35 passed / 4 failed, actual exit 1: the three rapid-conversion cases and Lumen initial rich HTML case remain failed. All 12 new focused-list images plus six popup and ten successful checkpoint images were individually viewed; no apparent new layout defect. This is not performance, package or full renderer clearance.

Evidence: /tmp/terno-list-keyboard-qualification-fixed-20261027/{run.txt,case-results-summary.json,visual-audit.json,setup-correction-final.json,after.json}. The initial external wrapper missed its module marker and failed before tests; corrected preview reused the built bundle without a rebuild. A metadata preparation assertion wrongly expected 137 prior outputs rather than the actual 135, and the shell nevertheless launched; the intended prelaunch asset JSON was not written and is not claimed. The wrapper independently froze all 135 at serving, before real globalSetup ended, and verified source/assets/worker/installed dependency bytes unchanged afterward. Captured processes reaped/TMP removed/no listener; both direct binds occupied, not called free. Native Tab/ArrowDown are real browser input; PM state/perf/all-user scenarios remain unqualified. Fresh independent source review follows.
