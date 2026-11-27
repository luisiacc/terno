# Brief: the critic's pass over a batch (plan 292, stage 4)

Another model wrote a batch of a fictional person's email (read `scripts/demo-corpus/WRITER.md`: it is the writer's brief and your standard). You are the editor from a different model family: your job is to find what a human reader would notice as generated, wrong or samey, and fix it in place.

## Inputs

`packages/mock-data/demo-corpus/world.json` (the cast, their style cards and facts, the owner's timeline, the storylines), `facts/*.json` (lasting facts other batches invented: as true as the world; a thread that contradicts one is wrong, and if this batch has no `facts/<batch>.json` yet, write it as WRITER.md says), `seeds/<batch>.json` (the briefs), `threads/<batch>.json` (the mail), `scripts/demo-corpus/taxonomy.json` (the planted scenarios). Run `node scripts/demo-corpus/report.mjs <batch>` for the batch's openers, sign-offs, shared phrases and stock phrases.

## What to look for

1. **Voice.** Does each sender match their style card (length, greeting, sign-off, signature verbatim, quirks, quoting)? Do two different people sound the same? Does Luis sound like one person across the batch?
2. **Generated tells.** Openers or closers repeated across threads, tidy symmetric structure, every message ending with a question or a pleasantry, recaps of the thread at the top of replies, over-explaining, too-perfect grammar from people whose card says otherwise, em dashes, "just wanted to", "circle back", "no worries" from everyone.
3. **Truth.** Facts that contradict `world.json`, the timeline or another thread of the same storyline; dates outside the seed's window, implausible hours for the sender's timezone, weekday names that don't match the date; amounts or names that change between messages.
4. **The seed's contract.** Every `must` line, the planted scenario (is the promise, the deadline, the unanswered question unmistakable but natural?), `lastFrom`, `firstFrom`, `unreadFrom`, the message count.
5. **`truth`.** Does it say exactly what the mail says, no more?
6. **Language.** English accounts carry no Spanish at all; Freelance reads as natural Mexican Spanish, not translated English.

## What to do

Rewrite the messages that fail, in place, keeping each thread's `id`, its seed's constraints and its JSON shape; fix `truth` to match. Don't touch threads that are fine: most should be. Don't edit any other file, don't run git, don't start subagents. Run `node scripts/demo-corpus/check.mjs <batch>` until it prints `ok`.

Final message: how many threads you changed and the three most common problems you fixed, in a few lines.
