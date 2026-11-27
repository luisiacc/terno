# The written demo mailbox (plan 292)

`pnpm dev:desktop:demo` and `pnpm dev:demo-ai` seed a mailbox that people (well, agents) wrote: Luis Cordero, a product designer at Acme Studio in London who freelances in Spanish for Mexican clients, over two years up to Thursday 22 October 2026, 15:30 UTC. About 7,000 messages: ~3,300 written in 900 threads (a sixth in Spanish, on the Freelance account only), ~3,650 machine mail from 41 fictional brands, 30 spam. Every name, company and brand is invented, and every non-webmail domain and link is on `.example`, so the demo reaches no one's server.

Only the dev demo reads it (`dev.mjs` sets `TERNO_DEMO_CORPUS`; main honours it in unpackaged builds only). The packaged app, the smokes, e2e, the UI rating, `--seeded` and the web build keep the generated mailbox.

## Where things are

| Path | What |
| --- | --- |
| `packages/mock-data/demo-corpus/world.json` | the owner, his timeline, 98 people with style cards and facts, organisations, brands, storylines |
| `…/lists.json` | the mailing lists |
| `…/seeds/batch-NNN.json` | each thread's brief, sampled in code (`seeds.mjs`) |
| `…/threads/batch-NNN.json` | the written threads (`ThreadRecord`), each with its answer key (`truth`) |
| `…/facts/*.json` | lasting facts each batch invented, and the continuity pass's decisions |
| `…/bulk/*.json` | each brand's schedule, templates and newsletter issues; `spam.json` |
| `…/demo.json` | the starter rule, the learning example, and what `dev:demo-ai` prepares and checks |
| `packages/mock-data/src/demo-corpus/` | the types, the rules (`rules.ts`), the loader (`load.ts`), the Node reader (`node.ts`), tests |

## How it was made

1. **World** (`WORLD.md`): one agent wrote the cast; another, from the other provider, critiqued and fixed it.
2. **Seeds** (`seeds.mjs`, `taxonomy.json`): the diversity is sampled in code (account, people, shape, outcome, dates, length, attachments) and the planted scenarios the AI features need are fixed with their dates and read state.
3. **Writers** (`WRITER.md`): 31 batches, alternating Claude Opus and Codex, each run through `check.mjs` until clean and recording the facts it invented.
4. **Critics** (`CRITIC.md`): each batch reread and mended by the other provider.
5. **Machine mail** (`BULK.md`): templates and issues, filled by the loader on each brand's schedule.
6. **Continuity** (`CONTINUITY.md`): one pass over every facts ledger to make it one life.

Every model step ran on T3's Claude Code and Codex agents, not on API keys.

## Checking and looking

```bash
node scripts/demo-corpus/check.mjs all        # every rule over every batch (also: world, bulk, batch-NNN)
node scripts/demo-corpus/report.mjs           # openers, sign-offs, shared phrases, near-duplicates, stock phrases
pnpm --filter @terno/backend-dev exec tsx ../../scripts/demo-corpus/dataset.ts [--brand <id>] [--thread <seed id>]
pnpm exec vitest run --project unit packages/mock-data/src/demo-corpus packages/backend/src/demo-corpus.test.ts
```

## Changing it

- **A thread:** edit its batch file, run `check.mjs <batch>`; if a subject `demo.json` names changes, change it there too (the corpus test holds them together).
- **More mail:** add seeds to a new batch (`seeds.mjs` takes `--threads`, but rerunning it redraws every seed: write new ones by hand or with a new seed), hand the batch to a writer with `WRITER.md`, then to a critic with `CRITIC.md`.
- **A brand:** its `bulk/<id>.json`, then `check.mjs bulk`.
- An existing demo profile keeps the mailbox it was seeded with: `pnpm dev:desktop:demo --cleandb` or `pnpm dev:demo-ai --fresh` starts over.
