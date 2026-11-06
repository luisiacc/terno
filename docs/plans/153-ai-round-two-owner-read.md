# Plan 153: what the owner decided after reading round two

## The request

> Okay the needs-you rule. Can you explain what the needs-you rule actually is? I don't understand it.
>
> Keep the future-only rules. I don't think so. I think the ones that select the future ones also do things for the things in the past. Now for the things that are still weak, I think that's for the first one.
>
> Rules based on the subject word still miss some emails. Maybe we can use the first chunk of the email content. The sums and counts: we need to give the model a way to calculate those using the machine, not counting them themselves.
>
> Why can follow-ups drop items past the promise cap? I think that should be fixed. Now the first email from someone doesn't reach the issue. We have to be careful there because some people just hit you with, "Hey do you want the service?" and they're just spam that we don't care about at all.
>
> We need to be careful. For example we need to respect Gmail's spam. If emails move them to spam, we don't even consider them at all. Let's remember this, okay? If it's something that Gmail classifies as spam, we just don't even trigger anything on it at all.
>
> Also when there are a lot of waiting threads, let's make sure to not overwhelm the user with this. I think probably just showing the current list that we show is fine.

## Decisions

1. **"From now on" also acts on what's here.** `futureOnly` (added to plan 143 after the panel) goes: the sentence previews and applies like any other, with "+ new mail too" ticked.
2. **Spam triggers nothing.** A message in Spam doesn't reach a filter, what Terno learns about who you write to, the waiting state, follow-ups, the unread count of a conversation that's otherwise in the Inbox, the unsubscribe offer, automatic remote images, the action preview or the categorizer's examples. Opening or searching Spam by hand stays as it is.
3. **A rule can read a message's first lines.** A new field, `opening`: the subject plus the stored snippet (200 characters), by pattern only. A filter may use it too, so Settings shows it.
4. **The machine counts and adds.** The answer writes `<count>m1 m3</count>` and `<sum>120.50 + 80</sum>` and code puts the number there. `<shown>` also tells it how many conversations the search found.
5. **A list of promises survives.** The cap goes from 3 to 10 per message, which is what the prompt can already be shown as open.
6. **Unchanged:** first contact stays out of Needs you, since a cold pitch looks the same; a mailbox with many waiting threads keeps today's list.

## Design

- **Spam.** `findRuleMatches` (`db/rules.ts`, `idb/mail.ts`) adds `is_spam = 0`: that's filters on arrival, catch-up, apply-to-existing and the action scan. `noteSentMail` and `own` learning skip spam at ingest and in both facts backfills. `answered` and the follow-up `later` skip spam. A thread's `unread_count` ignores spam messages when it has any others; a whole-spam thread keeps its count, so the Spam folder still reads unread. `unsubscribeSource` skips spam. `remoteAllowed` with "always" doesn't apply to a Spam message; a click still does. The categorizer skips a spam root.
- **Opening.** `TEXT_FIELDS` + `opening`, `PATTERN_FIELDS` + `opening`; op must be `matches`. SQL: `terno_opening(?, m.subject_norm, m.snippet)`; core: `normalizeText(subject + " " + snippet)` the same way. No body read, no `ruleReadsBody`. ACTION v5 tells the planner to use it for a kind of mail. The check still sees no body (plan 143's decision), so what it can't tell stays listed for a non-destructive action and is dropped for a destructive one.
- **Count and sum.** `answerFilter` holds `<sum` and `<count` as it holds `<status>`, then replaces them. Decimal arithmetic in scaled `BigInt`. `<count>` counts distinct labels that exist. Results are formatted for the app's locale. `askSpecifics` is run over results as authorized and over a sum's operands as said, so an operand no mail holds is flagged. ASK v6. A `<sum>` that doesn't parse shows its words with no total.
- **Promises.** `FOLLOWUP_PROMISES_MAX` 10, `FOLLOWUP_MAX_TOKENS` 2500 (hidden reasoning counts), FOLLOWUP v5.

## Tests

Conformance in both stores for each spam gate and `opening`; core tests for the rule, the calculator and the filter's streaming; backend Ask test that a computed total isn't flagged and a made-up operand is; ai tests for the cap; e2e for "from now on" acting on what's there and the filter dialog's new field.

## Perf

`opening` is a pattern over at most 200 + a subject's characters, per message, on the rule's slices: covered by the existing filter and action gates. Spam gates are one more column on rows already read. The unread rule is one more branch in the per-thread walk.

## Out of scope

Junk folders IMAP can't identify; undoing what a filter or `written` already did before this; a sum over more mail than an answer reads (it still says "at least"); first contact in Needs you.
