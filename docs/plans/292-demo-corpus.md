# Plan 292: a written demo mailbox, from a world of people

- **Status:** built (numbered 290, then 291, while it was written; both were taken by plans that landed or were drafted beside it (the Needs-you batched read, AI prompt caching)).
- **Builds on:** plan 289 (the demo mailbox in English, Freelance in Spanish; landed first), plan 167 (`pnpm dev:demo-ai`), plan 279 (the "since" conversations), plan 133 (invented writing personas), plan 151 (the graded corpus's `truth`).

## The request (verbatim)

> i want to create a better `demo` seeding of data and information, maybe also check our seeded command to see.
>
> i wan to create a synthetic corpus of emails for our demo and demoai accounts so its more realistic and the ai has better data to test on.
>
> but i want it to be realistic, i believe with the current capabilities of opus and codex we can make this and make a considerable corpus with at least 2k emails with a lot of variation between them simulating real accounts.

Then, after the research summary: yes to replacing the demo mailbox, fictional brands, keeping Luis Cordero and the four accounts, a pilot before the full run; and:

> instead of using the repo .env keys you will use the t3 claude code and codex subagents as the ais that will run this, not our api keys so we don't spend the money with the api keys., also lets do this in a worktree

> lets make the main text be english , with some spanish messages to test the ai drafting respects the language used

## What exists

- `seedDemo` seeds `generateDataset` (seed 42, ~3,000 threads, ~7,500 messages). Subjects come from templates and each body is three to seven sentences drawn at random from `SENTENCES_EN`/`SENTENCES_ES`. **Threads have no story:** a reply doesn't answer what came before, nobody promises anything that later comes due, the same people don't recur with a history. The AI demo shows something only through hand-written additions (`demo-since.ts`, the print fixtures).
- `seedDemo` is also the tests' fixture: `apps/backend-dev` (every e2e spec), ~20 packaged smokes (`TERNO_DEMO=1`), the MCP and export tests, the startup perf gate, the UI rating's harness. `--seeded` is the same generator at 12k threads, for scale.
- **Plan 289** (planned in parallel) adds a `"demo"` edition of the generator: Personal, Acme Studio and iCloud in English, Freelance (`hola@luiscordero.dev`) in Spanish, English categories (Receipts, Clients, Travel, Reading, Dev) and folders, `seedDemoSince`'s Spanish conversations moved to Freelance. The fixture stays byte for byte.
- `scripts/ai-real/corpus/synthetic/` (150 graded conversations) and `packages/mock-data/src/writing-personas/` (plan 133) already hold invented, model-written mail with an answer key.

## What the research says (summary)

PersonaBench (ACL 2025), PersonaTrace (EACL 2026) and SynthCorp (2026) build a world first (profiles, a social graph, a timeline of events) and write documents from it; the world is the ground truth and is never shown to the model under test. Persona Hub, AttrPrompt (NeurIPS 2023) and the 2026 persona-collapse papers find that "be diverse" collapses into one voice: diversity has to be sampled in code along chosen axes and handed to the writer as constraints; a length bound alone buys as much lexical diversity as rich persona detail. PersonaTrace runs a writer–critic loop. MaritimEmails (LREC 2026) mixes controlled generation with few-shot. Real inboxes are mostly machine mail (the real-mail panel: "Today was mostly bank notices").

## Design

### 1. Where it lives and who reads it

- **Sources, committed:** `packages/mock-data/demo-corpus/`: `world.json` (the people, organisations, brands, accounts, the owner's timeline), `seeds/` (the sampled briefs each batch was written from), `threads/batch-NNN.json` (the human mail, a JSON array of threads), `bulk/` (each brand's templates and written issues). Plain JSON: diffable, reviewable, fictional.
- **A pure loader,** `demoCorpusDataset(sources, { now })` in `@terno/mock-data` → `MockDataset`, the shape `store.dev.seed` already takes: threading headers (Message-ID, In-Reply-To, References), quoted history in each sender's habit, snippets, sizes, Gmail labels and IMAP locations, read/inbox/star state, bulk headers and unsubscribe, and the bulk mail expanded from templates on its brand's cadence with a seeded PRNG. Deterministic: the same sources give the same mailbox.
- **Only the demo commands read it.** `dev.mjs --demo` and `--demo-ai` set `TERNO_DEMO_CORPUS` to the sources' folder; the desktop backend, with the demo mailbox and that variable, reads it (fs, at seeding only) and passes the dataset to `seedDemo(store, { dataset })`. Without the variable nothing changes: the packaged app, the smokes, e2e, `--seeded`, the UI rating and the web build keep plan 289's generated mailbox. Nothing is bundled into the app: the corpus is data on disk, read once per profile, never an import.
- The "since" conversations are part of the corpus (planted, below), so `seedDemoSince` isn't run on a corpus profile.
- A demo profile seeded before keeps its mailbox; plan 289's `demo.edition` says which (`corpus` for this one), and a demo-ai launch on another says `--fresh` starts over.

### 2. The world (stage 0)

One owner, **Luis Cordero**, a product designer at Acme Studio in London (UTC/BST, so the demo's UTC clock reads as his day), Mexican, freelancing for Mexican clients in Spanish. The four accounts and their languages follow plan 289: Personal (Gmail), Acme Studio (Gmail), iCloud (IMAP), English; Freelance (IMAP), Spanish. English accounts carry no Spanish text.

`world.json` holds:
- **The owner:** a short bio, a timeline of his two years (moves, trips, projects, family events) every writer reads so threads agree, and a **style card per language** (how he greets, signs, how long he writes, his habits), so his sent mail sounds like one person across batches.
- **About 100 people,** each with an id, name, address, accounts they write to, language, timezone, relationship, organisation, a style card (register, length, greeting and sign-off, quirks such as typos, lowercase, "Sent from my iPhone", top- or bottom-posting) and facts.
- **About 25 organisations** and **about 40 brands** (newsletters, a bank, a card issuer, a ride-share, food delivery, shops, an airline, a hotel site, a code host, a project tool, a telecom, utilities), every one fictional, on `.example` domains (revision 12). No real company, product or person.

Written by one Opus delegate from a brief, critiqued by a Codex delegate, then read by me before any mail is written.

### 3. Seeds: the diversity is sampled in code (stage 1)

`scripts/demo-corpus/seeds.ts` draws ~900 thread briefs, deterministically, from `taxonomy.json` and the world:
- **Axes sampled per thread:** account; storyline kind (per account: family logistics, a flat repair, a friend's wedding, a running-club list, a client project, hiring, an offsite, a vendor quote, an invoice chase, a SAT question to the accountant…); participants (from the cast, by relationship); shape (a one-line FYI, a question and answer, a back-and-forth of 3–8, a reply-all group thread of 8–20, a forward, a list discussion); outcome (resolved, cancelled, rescheduled, dies unanswered, waiting on him, waiting on them); length bucket per message; formality; dates (35 % in the last 30 days, 25 % in the 90 before, 40 % up to two years back); attachments (present, forgotten then sent).
- **Planted scenarios** the AI features need, with their dates and read state: four "since" conversations (plan 279: read mail, then unread new mail that changes something; one where nothing changes); about 12 promises he made in the last month ("I'll send it Friday"); about 10 promises to him, some late (plan 280); about 10 sends with no reply in 5–20 days; about 10 requests with a deadline in the coming week; a recent mix that waits for his reply at the top of the Inbox, English and Spanish; facts an Ask question can find (amounts, addresses, dates); about 190 of his sent messages in the 30 days before the demo day (the follow-up scan reads them).
- Several briefs share a storyline (the offsite runs through a venue thread, a calendar invite and a dietary-needs thread), so mail across threads agrees.

### 4. Writing the human mail (stage 2), by T3's Claude Code and Codex agents

**No API keys and no app spend:** every model step is a T3 delegate (`delegate_task`) on the owner's Claude Code and Codex accounts. Batches of ~30 briefs alternate between Claude Opus 5.5 and Codex GPT-6.2 Sol, so the corpus has two voices. Each delegate gets the writer's brief (`scripts/demo-corpus/WRITER.md`), the world and its seed file, writes `threads/batch-NNN.json`, and runs `node scripts/demo-corpus/check.ts` on it until it passes. It never commits.

Each thread record: account, storyline id, tags (the categories' gold labels), subject, final state (inbox, archived, starred, trash, spam), messages (from and to by person id or `me`, date with offset, read, text, optional HTML, attachments' names, MIME types and sizes), new one-off people (a recruiter, a cold pitch) defined inline, and `truth`: what he owes, what others owe him, key dates and facts, as plan 151's corpus has it. The writer writes only what a person typed; the loader adds the quoted history.

### 5. Machine mail (stage 3): templates, not one model call a message

Each brand gets one HTML and text template, written once by a delegate, and pools for its slots (items, amounts, routes). The loader fills them on the brand's cadence (a daily newsletter on weekdays at its hour, a receipt per ride, a statement monthly, a code host's notifications in bursts on work days) for ~4,500 messages, so a sender always looks the same, as in life. Newsletters get written issues: unique ones for the last three weeks (the digest and Ask read them), a pool of older ones reused further back. Spam and phishing are a small written set. Verification codes stay `seedDemoCode`'s.

### 6. Checks and the critic (stage 4)

- **`check.ts`, per batch and over the whole corpus:** the schema; every person and account exists; dates in the window, in order within a thread, at plausible hours in the sender's timezone; English accounts have no Spanish text and Freelance is Spanish; no brand outside `world.json` and none on a list of real ones; planted briefs keep their constraints (dates, read state, who owes what); length buckets roughly kept.
- **Diversity report** (`scripts/demo-corpus/report.ts`): opener and sign-off frequencies, repeated 5-grams across threads, near-duplicates (shingle Jaccard), length distributions per sender, a list of model tells ("I hope this email finds you well", "I wanted to reach out", "delve", em dashes per message). Thresholds hold in a unit test.
- **The critic:** each batch is read by a delegate of the other provider, which rewrites what sounds generated or contradicts the world and runs `check.ts` again. I read samples of every batch.

### 7. Pilot, then the full run

The pilot is the world and two batches (one Claude, one Codex) of ~15 briefs, with the planted scenarios among them; then the loader on that much and `pnpm dev:demo` on it. The owner sees samples before the full run (~30 batches, ~6 delegates at a time).

### 8. Wiring the demo commands

- `demo-ai-prepare.mjs`'s named things (Ask questions, the since subjects, the fallback follow-up, the rule request: receipts from the corpus's ride-share) come from a manifest the corpus carries (`world.json`'s `demo` section), not constants.
- `docs/AI-DEMO.md`'s tour names the corpus's conversations, and says where the Spanish account is and what to try there.
- `docs/DEVELOPMENT.md` gains how the corpus is made and regenerated (`scripts/demo-corpus/README.md`).

## Tests

- `packages/mock-data/src/demo-corpus.test.ts`: the committed corpus passes `check.ts`'s rules; the loader is deterministic; counts (≥ 2,500 written messages, ~7,000 in all, ~190 sent in the last 30 days); threading headers chain; quoted history is the previous message; English accounts have no Spanish; brands are all in the world; the diversity thresholds.
- `seedDemo` with a dataset: its categories, rule and accounts come from the dataset.
- Desktop: `TERNO_DEMO_CORPUS` is read only with the demo mailbox; without it the generated mailbox is seeded. The demo-ai marker's source check (`demo-ai.test.ts`).
- Running it: `pnpm dev:demo` and `pnpm dev:demo-ai --fresh` on temp profiles, screenshots light and dark of the Inbox, a thread, What matters, People.

## Performance and resources

Seeding runs once per profile; the loader expands ~7,000 messages in well under a second, the same order as `generateDataset`. Nothing on a hot path changes, nothing ships in the app, no migration. The sources are a few MB of text in the repo.

## Revisions after the Codex review

1. **The corpus can't reach a packaged app.** `TERNO_DEMO=1` works in packaged builds, and the utility process inherits main's environment. Main resolves the corpus folder only when the demo mailbox is on *and* the build isn't packaged (`dev-mode.ts`'s check), strips `TERNO_DEMO_CORPUS` from the backend's environment, and hands the approved path over in the backend's init message. The loader is a static import; the corpus is read as data. A test launches with both set on a packaged-mode check and sees the generated mailbox.
2. **A seed is whole or recognisably partial.** The loader validates the whole dataset (the same `rules.ts`) before any write. `seedDemo` records the mailbox's source and revision (`demo.mailbox` = `{ source: "corpus", revision }`) only after the last write; a profile with accounts and no record is a partial seed, and the launch says `--fresh` (demo-ai) or `--cleandb` (demo) starts over. The demo-ai marker, the preparation's manifest and the since fixtures read that record, never the command line.
3. **The loader's per-message contract:** provider message ids unique per account, RFC Message-IDs unique across the corpus (`<slug@host.example>`), In-Reply-To and References only to earlier messages of the same thread; Gmail threads by `providerThreadId`, IMAP by headers; per-message flags explicit (`isSent`, `isRead`, `inInbox`, `bulk`, `listId`); Gmail labels from the account's declared folders plus `INBOX`, `SENT`, `UNREAD`, `STARRED`, `CATEGORY_*`; IMAP locations with UIDVALIDITY 1 and UIDs unique per account and mailbox. A test seeds SQLite and checks the threads, the Sent view and folder membership.
4. **Categories, the rule and the learning example by key.** The corpus's categories are fixed by name and tags in `world.json`; the starter rule is "Code host notifications → Dev", by the corpus's code-host sender and the Dev category resolved after seeding; `seedDataset` takes the learning example's sender as an option (default the fixture's Morning Brew) and the corpus names one of its newsletters. Tests check the rule's matches and the categories' members.
5. **Follow-ups read narrower windows than the plan said.** Unanswered sends count only up to 14 days and promises up to 7 days overdue; the scan skips bulk and list mail. The plants move: `awaiting` sends are 6–13 days before the demo day to someone outside his addresses; his promises are in the last 14 days, due from 7 days before to 10 after; his Gmail sends carry `SENT`. Plan 211's per-account checks run on their own after the first sync, so the preparation's old offer step is replaced by waiting for the named results.
6. **Each feature gets its own planted examples**, checked one by one: dated requests and promises to him within 14 days (What matters, Owed to you), `waiting-on-you` threads (People's "Waiting on you": a recent Inbox thread he wrote in earlier whose latest message from a person asks him something), and one person whose only item is such a row, for the preparation's Later step.
7. **The digest takes the newest 40 by insertion.** The loader inserts in date order, so the demo day's newsletters are the last written; they're unread, in the Inbox, unstarred, with a list id and bulk headers and no Updates label. A test checks the day's issues are the newest 40 candidates.
8. **The preparation names its targets.** The manifest lists ordinary summaries, Spanish Reply ready, the since threads and the Ask questions with the facts and threads their answers must cite. The preparation opens the since threads first (before anything marks them read), finds threads by subject from the manifest, and checks each expected view (a "Since" tab on three, the whole summary on the fourth); an Ask answer that doesn't cite its planted thread is a failure, not a pass.
9. **The rule is checked against planted mail:** the ride-share sends receipts and, from the same domain, a promo and a "rate your driver" note; the preview must include receipts and leave the others out.
10. **Clocks.** The corpus's dates are absolute (newest 15:30 UTC, 22 October 2026). `dev:demo` keeps the real clock and its sign-in code; `dev:demo-ai` keeps its fixed clock. `check.ts` holds every "Thursday 6 November" to the calendar of the year nearest the message.
11. **Who reads which mailbox:** `dev:demo` and `dev:demo-ai` the corpus; the packaged app with `TERNO_DEMO=1`, the smokes, the UI rating's harness, e2e (`apps/backend-dev`), `--seeded`, the web demo and Put away's seed plan 289's generated one. Plan 289's picture retake runs on whichever `dev:demo-ai` seeds when it is done; if this plan lands first, its Spanish-account check reads Freelance's senders and subjects from the corpus (`demoCorpusSpanishNames()`), which the corpus exports for it.
12. **Inert by construction.** Every non-webmail domain in the corpus (people, organisations, brands, Acme and the freelance address) ends in `.example`, and every link is on `.example`: the icon service skips names off the public suffix list, so the demo reaches no one's server. Unsubscribe stays mailto-only. Making the corpus uses only T3 delegates; preparing the AI demo afterwards still runs on the configured keys, as plan 167 does, and the corpus's automated checks use the model stub.

## What was built, and what changed on the way

- **The corpus:** 7,002 messages. 3,325 written in 900 threads (14 % one-liners, median 34 words, 15 % Spanish, all on Freelance), 3,647 machine mail from 41 brands (85 written newsletter issues), 30 spam; 375 of his sends in the 30 days before the demo day; every planted scenario present (since 4, top 6, his promises 12, promises to him 10, awaiting 10, deadlines 10, waiting on you 6, facts 6). 4.8 MB of JSON; built in under a second; the dev demo's first row 4 s after launch.
- **How it was made:** every model step on T3 delegates, alternating Claude Opus 5.5 and Codex GPT-6.2 Sol: the world (Opus, Codex critique), 31 writer batches, 31 critic passes by the other provider (most mended 13 to 29 of 30 threads: stories that didn't hold, voices off their cards, answer keys claiming more than the mail), four machine-mail agents, one continuity pass (26 contradictions across batches resolved, `facts/continuity.json`). No API key was used.
- **Added on the way:** a facts ledger per batch (writers invent lasting facts; later writers and critics read them); `check.mjs` grew weekday-against-calendar, `.example`-only links and a sender's zone offset; the loader grew fortnightly, nth-weekday and work-days schedules, and its hash a murmur3 finaliser (FNV alone drew the same value for slots named alike); `tend.mjs` archived 88 settled conversations, because the seeds had kept settled threads in the Inbox (What matters went from 134 to 93 waiting on the stub model; real summaries take out more).
- **Beside plan 289,** which landed first: one record of what seeded a demo profile, 289's `demo.edition`, now `"demo"` (the generated English edition) or `"corpus"`, written after the last write so a partial seed reads as an older mailbox; 289's `oldMailboxProblem` takes the edition this checkout wants, and replaces the marker field and the `demo.mailbox` record this plan first had. `seedDemo` takes either 289's `edition` or this plan's `mailbox`.
- **Verified:** the corpus, loader, seed and wiring tests (80 across the touched files); the dev build seeded from the corpus on a temp profile, AI through the UI rating's loopback stub: the Inbox opens on the planted conversations in English and Spanish, People and What matters fill, the learning example's offer shows, light and dark.

## Out of scope

- The tests' fixture and plan 289's generated demo edition (smokes, e2e, the UI rating's harness, `--seeded`, the web demo).
- The site's pictures: plan 289 retakes them from the demo-ai window; moving them onto the corpus is a follow-up once it lands.
- Real mail in the repo: the real-mail eval set stays in `~/.terno-evals`, and stays the final judge of the AI features.
