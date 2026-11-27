# Brief: writing a batch of the demo mailbox (plan 292, stage 2)

You are writing real-looking email for a fictional person, **Luis Cordero**: one batch of about 30 threads of his mailbox. The mailbox is the demo of Terno, an email client; its AI features (summaries, reply drafts, follow-ups, "what matters", questions about your mail) will be tested on what you write, so it must read like mail people actually typed, not like a model's idea of email.

## Inputs (read all of them first)

- `packages/mock-data/demo-corpus/world.json`: the owner (his bio, his style card per language, his timeline), every person (their style card and facts), organisations, storylines, the accounts.
- `packages/mock-data/demo-corpus/seeds/<batch>.json`: your briefs, one per thread. Each fixes the account, the people, the shape, the outcome, the number of messages, the date window, length and attachments, the state at the end, sometimes who sends first or last, which messages are unread (`unreadFrom`), a planted scenario (`plant`) and `must` lines. Follow every field.
- `packages/mock-data/src/demo-corpus/types.ts`: the format (`ThreadRecord`, `MessageRecord`, `Truth`, `Person`).
- `scripts/demo-corpus/taxonomy.json`: what each shape means and the planted scenarios in full.
- `packages/mock-data/demo-corpus/lists.json`: the mailing lists (their address and list id).

- `packages/mock-data/demo-corpus/facts/*.json`: lasting facts other writers invented about world people (Harriet is a physio with a dog called Pickle). They're as true as `world.json`: don't contradict them.

A seed's `kind` that starts with `free:` is a nudge, not a contract: if it doesn't fit the people (a "statement of work" with a recruiter), write what these people would plausibly email each other about instead.

## Output

`packages/mock-data/demo-corpus/threads/<batch>.json`: a JSON array of `ThreadRecord`, one per seed, each with the seed's `id`, in the seeds' order. Then run `node scripts/demo-corpus/check.mjs <batch>` and fix everything until it prints `ok`. Read its warnings too and fix the ones that are real. Don't edit `world.json`, the seeds or any other file, don't run git, don't start subagents.

## How people write (the whole point)

- **Each sender writes as their style card says.** Greeting, sign-off and quirks as written; the signature block verbatim at the end of every message they send (not in replies that their card says they send from a phone without one, if the quirks say so). A terse person writes one line. A long writer rambles a bit. Lowercase people stay lowercase. Typos only for people whose quirks say so, and only a few.
- **Luis** writes by `owner.style.en` on English accounts and `owner.style.es` on Freelance, and his signature follows the account. He is one person across the whole mailbox: same habits, same voice, same people he likes.
- **Real mail is uneven.** About a fifth of all messages are a single line or two ("thanks, got it", "7 works", "on it"), more between people who know each other well. People answer half the question, bring up something else, forget what was said, correct themselves in a second message, reply hours or days later and apologise for it (or don't). Not every message has a greeting or a sign-off. Not every message ends with a question or a pleasantry. Lists and bold are rare. Some subjects are lowercase, vague ("quick q", "Saturday?", "re the thing"), a few have a typo; in long threads someone changes the subject (set `subject` on that message).
- **Specific, invented details:** amounts with their currency (£, MXN, €), times, street addresses, flat numbers, booking references, order numbers, names of places and dishes. They must agree with `world.json` and with the other threads of the same storyline in your batch.
- **Never** write what the checker calls model tells ("I hope this email finds you well", "I wanted to reach out", "please don't hesitate", "delve", "rest assured"…), nor their cousins: "I'd be happy to", "Great question", "Absolutely!", "Looking forward to hearing from you" on every message, neat triplets, a recap of the thread at the top of a reply. At most one em dash in a message; most messages have none.
- **No quoted history.** Write only what the sender typed. The loader adds "On … wrote:" and the quoted text in each sender's quoting style. A forward has only the line typed on top ("see below, can you deal with this?") in `text`, and `forward: true` when it forwards the message before it in the thread, or `forward: { from: "Name <address>", date, subject, to, text }` when it forwards mail from outside the thread (that mail's text in full; its sender's domain on webmail or `.example`).
- **Language:** Personal, Acme Studio and iCloud are English only: no Spanish words, no Spanish letters (á é í ó ú ñ ¿ ¡), not even in names. Freelance is Spanish only, Mexican Spanish, usted or tú as the relationship has it.

## Dates and state

- Every `date` is ISO 8601 with the sender's own UTC offset (London is +01:00 until 25 October 2026 and +00:00 in winter; Mexico City is −06:00 all year; check the person's timezone). Inside the seed's window, after the message before it, never after the anchor (2026-10-22T15:30:00Z).
- People write at their hours: work mail on work days mostly, friends in the evening, a late night now and then, replies minutes to days apart. Luis's timeline says when he was away: be quiet then, or have him say he's away.
- A weekday you name must be that day: "Thursday 6 November" in 2026 is wrong (it's a Friday); the checker catches it.
- `read`: as the seed says (`unreadFrom`; without it, everything is read). Luis's own messages: `read: true`.
- `state.inbox`, `trash` as the seed says. `folder`: optionally one of the account's folder keys that fits.
- Attachments: `some` means one or more messages carry plausible files (filename, MIME type, size in bytes); `forgotten` means someone says "attached" and attaches nothing, then sends it in the next message.

## People

Use the seed's people. Add one-off people when the seed says so (a recruiter, a stranger) or the story needs someone new (a colleague cc'd once): define them in the thread's `people` with a full `Person` (id unique and specific, e.g. `tom-recruiter-brightwell`; address on webmail or a `.example` domain; a style card). Mailing-list threads: set `listId` to the list's `listId` from `lists.json`, address messages to `"list"`, and Luis may or may not take part.

## Truth

For every thread, `truth` as things stand at the anchor: a one-sentence summary, what Luis still owes, what others still owe, the promises made by and to him (with due dates and whether they were kept), key dates, and the facts a question could find. It's the answer key: make it exact, and only what the mail says.

## Planted scenarios

A seed with `plant` exists so an AI feature has something to find; its `must` lines are the contract. Make the thing unmistakable to a careful reader but natural: a promise is said the way people say it ("I'll get the revised quote to you by Friday"), not announced. Read the plant's description in the taxonomy.

## Facts you invent

Write `packages/mock-data/demo-corpus/facts/<batch>.json`: a JSON array of `{ "person": "<world person id>", "fact": "…" }` for every lasting fact you invented about someone in `world.json` that another writer could contradict (a job, a pet, an address, a partner, a holiday, a debt, a habit, a date that matters). Not one-off details of a single thread. Skip one-off people.

## Before you finish

Read your batch top to bottom once as a sceptic. If two messages open the same way, or two people sound alike, or something reads like a template, rewrite it. Run the checker again. Your final message: how many threads and messages, how many in each account, anything in a seed you had to bend and why.
