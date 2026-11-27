# Brief: the continuity pass over the whole mailbox (plan 292, stage 4b)

Thirty-one batches of a fictional person's email were written in parallel by different agents, each reading the same world (`packages/mock-data/demo-corpus/world.json`) but not each other's mail. Each batch recorded the lasting facts it invented in `facts/<batch>.json`. Some of those facts contradict each other (in one batch Harriet has a cat called Pippin, in another a dog called Pickle), and some threads contradict the world, the timeline or each other. Your job is to make the mailbox one consistent life.

## How

1. Read `world.json` (owner, timeline, people, storylines) and every `facts/*.json`. List the contradictions: the same person, place, date, amount, relationship or event described two incompatible ways; an event placed when the owner's timeline says he was elsewhere; a person in a place or role the world rules out.
2. For each, decide the canonical version: the world wins; then the version more batches already rely on; then the one that touches fewer messages. Write your decisions to `facts/continuity.json` as `{ "person": "<id or 'world'>", "fact": "…", "replaces": "…", "batches": ["batch-…"] }`.
3. Fix every thread that states the losing version (search the thread files for the person's id, name and the detail), in place, keeping each thread's `id`, its seed's constraints (`seeds/<batch>.json`: dates window, message count, who sends first and last, unread state) and its JSON shape, and update its `truth`. Change as little as makes it true. Update the batches' facts files to match.
4. Run `node scripts/demo-corpus/check.mjs all` until it prints `ok`.

Where many batches already contradict one of a person's `facts` in `world.json` the same way (the world says Luis replied to the recruiter Duncan only once; several batches have him reply more), you may change that one fact in `world.json` instead of rewriting the threads, and say so. Nothing else in `world.json`; don't edit the seeds, the bulk folder or any code. Don't run git, don't start subagents.

Final message: how many contradictions you found and resolved, the ten most significant (one line each), and anything you left because resolving it would rewrite a storyline.
