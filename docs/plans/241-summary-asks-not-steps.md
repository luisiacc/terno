# Plan 241: a summary's to-dos are what's asked now, not every step

- **Status:** built. Prompt version 8: variant D's words (below) with the code review's three fixes. The later sections override the Design where they differ: `validate` still keeps six, the prompt asks for "usually at most four", the action rule doesn't define an action, and the compact prompt keeps version 7's words.
- **Builds on:** plans 132 (summaries), 148 (rows), 151 (the corpus), 153 (facts), 162 (the card), 202 (who has to act, prompt v7).

## The request

The owner opened a reminder from an app-assessment service (welcome, "your validation form is incomplete, please complete it", then "once completed, you will gain access to your scan by following these steps" with five numbered steps, project details, help, resources) and got:

> The sender says your account was created and the LOV form is still incomplete; the project covers one application (Project ID 24224). The message outlines the CASA assessment and final LOV process.
>
> To do · Complete the LOV form · Reply
> To do · Choose DAST for web apps or SAST for other apps, then submit the scan · Reply
> To do · Review and patch vulnerabilities found in the scan · Reply
> To do · Request a revalidation scan after remediation · Reply
> To do · Complete the SAQ accurately · Reply
> To do · After patching and completing the SAQ, contact support for the LOV submission · Reply

> i think tis an overwhelming ai summary with too manu todos, only one todo would have suffice here […] lets improve the ai summary here so its better generally, not just for this case.

## What exists

- The prompt (`packages/ai/src/summarize.ts`, version 7) asks for "at most six" items: an action is "something the reader has to do", one thing each, and plan 202's "Who has to act" settles *whose* it is. Nothing says *which* of the things a mail describes are asked now. A mail that lays out a process reads as six things the reader has to do, and every one of them is.
- `validate` keeps six (`SUMMARY_MAX_ITEMS`).
- The card (`thread-summary.tsx`) shows each action as "To do · … Reply".
- Actions matter outside the card: `summaryAsksNothing` (`packages/store/src/today.ts`) drops a conversation from Needs you when its current summary has no action and no question. Fewer actions is fine; **none where one was due** takes a conversation out of What matters.

On the 505 conversations of the corpus, v7 gives most cards no row (64%) or one; ten give three to five actions. Read by hand, most of those are real separate asks (a conveyancer's three deadlines, a tribunal's four directions, a party list), and some are the same failure in small: an optional favour ("Optionally alert the bank…"), a conditional ("If you disagree, do not sign"), a prohibition ("Do not write to the surveyor"), three things to bring split into three rows. So "one to-do" can't be the rule; the rule is what an item is.

## Design

Prompt version 8: four changes to the system prompt's words, nothing else.

1. **What an action is.** A new line under the items: an action is something the reader is asked to do *now*, not every step a mail describes. When a mail lays out a process, a checklist or instructions, the action is the step asked of the reader now; what comes once it's done, how to do it, tips, and what's optional or only for if something happens are never actions. Things done at once, for the same person and deadline, are one action ("Bring the tape, the boxes and the ladder"); separate requests stay separate.
2. **The summary carries what follows.** "What the reader has to do or answer *now* goes in the items…; steps that only come after it can be named in a few words ('then a scan, fixes and a questionnaire')." So the card still says the path ahead, once, in prose.
3. **At most four items** (was six), in the prompt and in `SUMMARY_MAX_ITEMS`. With grouping, no card in the corpus needs more than four.
4. **Credit by name.** "credit it to the person or organisation who said it, by name, never 'the sender'": the card above opened with "The sender says".
5. **The check** before answering also asks of each action: is it asked now, rather than a later step, a how-to or an option?

The compact prompt (a small window, no "Who has to act") shares the items' words, so it gets 1–3 and 5's check is in the full prompt only, as v7's check is.

Version 8 means a stored v7 summary isn't reused once its conversation is summarized again (a new message, or Clear AI data); a card already made stays until then, as with every version bump (`reusable` checks the version, `read` doesn't). `SUMMARY_WHO_ACTS_SINCE` stays 7: v8 keeps plan 202's words.

### Not changed

- The card's "Reply" on every action. An action done elsewhere (a form, a portal) gets Reply all the same; that's a question for the card (whether an item says how it's done), not for this prompt. Noted below as a follow-up.
- "Who has to act", the effort (Luna at default medium), the schema and the validation's other checks.

## Tests

- **Corpus.** Nine invented conversations in `scripts/ai-real/corpus/synthetic/steps.jsonl` (author `steps`): six that lay out a process or instructions around one ask (the owner's reminder, re-told with invented names; a new job's first day; a visa appointment, in Spanish; an account to verify; a course deposit; a password change), two genuine multi-asks a fix could over-merge (three requests from a colleague; a Spanish move with things to bring and a question), and an end of tenancy with a checkout guide.
- **Eval**, Luna at its default (what ships): the whole corpus at v7 and with the change as a `TERNO_AI_SUMMARY_VARIANT`, then `score.py`, the action counts per card, and by hand: every card whose actions change, and **every card that goes from one or more actions or questions to none** (What matters drops those).
- **Blind audit** (plan 153's): Claude and Codex judge the two cards of each changed conversation, labels shuffled, for a lost ask and for a wrong fact.
- **Unit** (`summarize.test.ts`): the version is 8; at most four items survive `validate`; the prompt says what an action is and lets later steps into the summary.

## Perf and resources

None: the same one call per summary, a prompt about 600 characters longer (well inside `summaryBudget`; the compact threshold moves by about 150 tokens).

## Out of scope

- Reply on an action that isn't done by replying.
- The digest, follow-ups and the dated reader have their own prompts.

## Revisions after the Codex review

Codex's twelve points, and what changed:

1. **The compact prompt was over its window.** At 2,000 tokens the compact prompt sits at `summaryBudget`'s floor (the mail gets its 200-token minimum), so any words it gains push the whole request past the window. The new rules (what an action is, the summary naming later steps, the credit rule, the check) are in the full prompt only, as "Who has to act" is; the compact prompt changes only "six" to "four". A unit test says the compact prompt has none of them; the backend's 2,000-token test holds.
2. **Four as a hard cap could drop a real ask** (the cap takes the first four of any kind, and an action lost there can take a conversation out of Needs you). `validate` keeps six; only the prompt asks for four. That is also exactly what the variant measured (point 9).
3. **"Asked now" against promises and dated steps.** The rule now says "a request put to the reader, or their own promise", "the reader's next step" rather than "now", and "separate requests stay separate, each with its own date". Case `steps-013`: a lettings agent's two dated steps and the reader's own promise to do both.
4. **A condition that has happened, and choice questions.** "only for if something happens *that hasn't*"; the check's "a later step, a how-to or an option" is about actions only. Cases `steps-010` (a refund declined, so the conditional receipt photo is now asked) and `steps-011` ("a refund or a replacement?").
5. **Later steps' amounts and deadlines.** The summary names later steps "with any deadline or amount they carry"; `steps-005`'s truth now has the remaining 360 before the first class.
6. **The check contradicted the summary rule.** The check now says "nothing the reader has to do or answer *now*".
7. **Grouping across messages.** "Things asked *in one message*, done at once, for the same person and the same deadline". Case `steps-012`: two people's requests with the same deadline stay two.
8. **Regeneration.** Corrected above: a version bump stops reuse, not a stored card's display.
9. **The variant didn't measure the cap.** Moot with 2: the cap is unchanged at six.
10. **The corpus never runs compact.** True, and unchanged: the compact prompt's only change is one word.
11. **The audit's selection.** Every changed card is judged against the corpus truth for completeness (asks, deadlines, amounts), not only for lost asks.
12. **Attribution without a name, and the reader.** "by name (their address when there's no name), "you" for the reader, never "the sender"".

## What was measured

All 515 conversations (the 502, the nine new `steps` cases and four more from Codex's critique, `steps-010`…`013`), GPT Luna at its default effort, as shipped, on 2026-11-22. v7 ran with a variant that turns v8's words back into v7's (checked equal to `HEAD`'s prompt). Spend: about $1.32 across five runs, in fresh ledgers.

| | Rows per card | Most rows | Cards with 3+ actions | Actions citing the reader's own message | Rows repeating the summary | Cut off |
|---|---:|---:|---:|---:|---:|---:|
| v7 (today) | 0.51 | 6 | 14 | 9 | 18 | 2 |
| A: first wording (plan's Design) | 0.45 | 4 | — | 9 | 17 | 1 |
| B: after Codex's critique ("a request put to the reader, or their own promise") | 0.47 | 4 | 9 | **41** | 12 | 0 |
| C: B without "or their own promise" | 0.38 | 4 | 9 | **0** | 15 | 1 |
| **D: B, but "Not every step a mail describes is an action"** | 0.40 | 4 | 5 | 13 | 8 | 3, then 1 |

**The process mails.** On the owner's reminder re-told (`steps-001`), v7 gave six to-dos; B, C and D give one ("Complete and submit the Validation Letter form"), and the summary names what follows. The course deposit (v7: four), the end of tenancy (v7: five), the password expiry (v7: two) and the visa appointment (v7: two and two dates) all come to one. The multi-asks keep every ask: Rob's three, the move's two (the three things to bring as one row), Bea's and Hal's two with one deadline, the lettings agent's two dated steps.

**B's promise clause.** Defining an action as "a request put to the reader, or their own promise" turned the reader's own words into to-dos: "Don't send flowers", "Write more later", "Keep Con Ed at its existing setting". Both judges named it as B's main loss. Without the clause (C), "a request" alone dropped every real open promise too, against "Who has to act". D doesn't define an action: it only says which steps aren't one, and own-message actions came back to v7's level with the real promises (marta-009, marta-010) kept.

**The blind audit** (plan 153's, Claude and Codex, cards labelled X and Y at random per conversation, each finding with its evidence and a severity, judged against the mail and, for fictional mail, its answer key):

| Round | Set | Better: new / v7 / same, Claude | Codex | Noise rows, new / v7 (Claude; Codex) | High-severity missing, new / v7 (Claude; Codex) | High-severity wrong, new / v7 (Claude; Codex) |
|---|---|---|---|---|---|---|
| B vs v7 | 107: every fictional card whose rows changed or had 2+, and 40 real | 55 / 19 / 33 | 40 / 23 / 44 | 19 / 42; 19 / 36 | 0 / 5; 26 / 37 | 1 / 1; 6 / 7 |
| D vs v7 | 63: where D's rows differ from B's, and every card outside round one whose asks changed in number | 20 / 19 / 24 | 22 / 16 / 25 | 12 / 21; 8 / 17 | 4 / 5; 18 / 17 | 2 / 0; 0 / 1 |

Round two is the contested set by construction, so a tie there is the expected floor; D keeps half the noise without losing accuracy: where both judges agree, D is better on 9 and v7 on 10, and cards both flag with a high-severity error are 2 for D and 3 for v7. What's left on D is what v7 also does: an open promise of the reader's missed now and then, a detail a fewer-row card left out (a "don't write to the surveyor", the substance of the resolutions being signed).

**The reader named.** The judges noticed summaries calling the reader by name. Counted over the corpus: v7 25 of 513, B 24, C 24, D 32, the first wording (no "you for the reader") 52. D is within B and C's spread; the "you" clause is what holds it. "The sender" was rare already (v7: 2); it's the case the owner hit, a display name of just "ESOF -", which the address fallback covers.

**Cut-offs.** A long thread (`enron-01ba7278fc`) is at the 3,000-token answer budget's edge: D was cut off on it in 2 of 4 tries, at 22 s when it finished. v7 had two other cut-offs in its run. Not new to v8.

## Revisions after the Codex code review

1. **"At most four" would make a model leave out a fifth real ask.** The full prompt asks for "usually at most four things … (up to six when there are more separate requests)". Case `steps-014`: five separate dated requests from one person.
2. **The check could drop an independent dated request** ("a later step rather than the reader's next": sign Monday, *pay Tuesday*). It now drops "any action that can only come once another is done, or is a how-to or an option", the main rule's own words.
3. **`steps-008`'s answer key** asked whether Raúl is coming; the mail asks whether *she* is coming with him.

The longer count would have put the compact prompt over its window again, so the compact prompt now keeps version 7's words exactly ("at most six"), and a test says it has none of plan 241's.

**The final code over the corpus** (516, with `steps-014`):

| | Rows per card | Most rows | Cards with 3+ actions | Own-message actions | Rows repeating the summary | Cut off (all fine on a retry) |
|---|---:|---:|---:|---:|---:|---:|
| v7 | 0.51 | 6 | 14 | 9 | 18 | 2 |
| D | 0.40 | 4 | 6 | 13 | 8 | 1 |
| **Shipped** | 0.41 | 5 | 7 | 8 | 11 | 3 |

Every `steps` case as intended: one to-do for each process mail, the summary naming what follows; all three of Rob's asks, all five of Lena's, both of Bea's and Hal's, both of the lettings agent's dated steps.

## Follow-ups

- Reply on a to-do that isn't done by replying ("Complete the form" on a portal).
- A stored v7 card stays until its conversation changes. The owner's reminder will show the old six rows until then.
