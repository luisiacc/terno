# The AI demo: `pnpm dev:demo-ai`

The demo mailbox with every AI feature already showing something, on real models, so you can test them in a minute. It runs the desktop dev build (Vite with HMR) on its own profile, with Dev mode's Pro AI on. Plan 167 records why it's built this way.

## Running it

```bash
pnpm dev:demo-ai           # prepares the profile on its first launch, then opens the window
pnpm dev:demo-ai --fresh   # the profile goes to the Trash and is prepared again
```

- **Keys.** It needs `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`; `JEV_API_KEY` is optional (smart categories are off in the demo). It reads only these three names: from your shell first, then this checkout's `.env`, then the main checkout's `.env` (so a worktree works without its own). The terminal names which file each came from, never a value. If one is missing, it stops before building and says where it looked.
- **The first launch** prepares the profile behind your windows before the window opens, about 2 to 4 minutes. Each step prints a `[demo-ai]` line. Leave it alone while it runs; Ctrl-C stops it, and the next launch picks up where it stopped.
- **Later launches** open at once on what was prepared. Nothing is prepared again unless a step didn't finish: the terminal says which, a screenshot of it (`demo-ai-<step>-failed.png`) is in the profile, and the next launch tries only what's missing (a conversation without its summary, a question that failed). After three launches it keeps what's there and stops trying.
- **Profile:** `~/Library/Application Support/Terno-dev-demo-ai`. `TERNO_USER_DATA` moves it, but only to a new or empty folder (or one it prepared before): it refuses a real Terno profile and any folder that holds something else, before opening anything in it.

### What the first launch costs

Measured on four runs: **about 80 model requests, US$0.12 to 0.16**, counted by the app's own usage book (Settings → AI shows it). The end of the preparation prints its total. Roughly:

| Feature | Requests | Model (Pro's routing) |
| --- | --- | --- |
| Follow-ups: the last 30 days of sent mail (195 messages, the app says about $0.03) | 35 to 50 | Claude Haiku |
| Summaries of 7 or 8 conversations | 7 to 8 | GPT Luna |
| Reply ready on 4 or 5 conversations (the model decides whether a reply is needed, then writes one) | 9 to 11 | Claude Sonnet and Haiku |
| Ask: 4 questions and a follow-up (a plan and an answer each) | 10 | Claude Haiku and Sonnet |
| The newsletter digest | 1 | Claude Haiku |
| A rule made with AI | 1 | Claude Opus |

Anything you try afterwards (⌘J, a new question, an action) is billed as usual.

## The clock: 22 October 2026, 16:00 UTC

The demo mailbox is dated around 22 October 2026 (its newest message is 15:30 UTC), so with today's date Today would be empty and the digest would have no newsletters. The demo always runs on that day: the backend's clock and the window's clock both start at **16:00 UTC** (the AI rating's instant) and run on from there. A later launch starts where the preparation ended, a few minutes after 16:00, so nothing it made is ahead of the clock. Times show in UTC.

So the list says "3:27 PM" for the newest message, Today is that Thursday, and "No reply in 13 days" counts from it. The digest was prepared at once because its time (08:00) had already passed.

## Where to look

Every surface below is filled when the window opens. Lumen is the style; any other style shows the same content.

| Feature | Where | What you'll see |
| --- | --- | --- |
| **Summary** | Inbox → the top conversation, **¿Vamos al concierto?** (Isabella Álvarez). Also the next five in the Inbox and the first ones in Today. | A Summary card above the message: what it says, a To do with Reply, *Written with AI ▾* (which model). The ✦ button in the toolbar updates or asks for one on any other conversation. |
| **Reply ready** | The same top conversation, and **Blockers for sistema de diseño**, **Boletos para el partido ⚽**, **旅行の写真**. | *Reply drafted* under the message, with *1 gap to fill* where only you can decide, **Use as draft** (R) and Dismiss. A conversation that doesn't wait for your reply has none (the model decided so: **Design review — portal de clientes** is one). |
| **Today** | Sidebar → **Today** (the top item). | *The newest 12 of 44 that need you*: promises you made ("You said: call to go over the details"), people who haven't replied ("No reply from Jack Chen in 13 days"), and mail waiting for your reply. |
| **Newsletter digest** | Today → the first row, **16 newsletters · today's digest**. | Today's digest: one line per newsletter, each ticked to archive, **Archive 16**, Untick all; open one and Back returns to the digest. |
| **Follow-ups** | Sidebar → **Follow-ups**, or open one from Today. | Seven conversations: "Jack Chen hasn't replied in 13 days", "You told Emma García you'd call…". Open one: the card has *Write a follow-up* (or Done), Reschedule, Dismiss, *Your message, Oct 9 →*, *Found with AI ▾*. |
| **Ask your mail** | ⇧⌘K → **Previous AI questions** (the clock row under the field): four conversations. | "What did Isabella say about the payment?" (with a follow-up, "When did she write about it?"), "What's blocking the sistema de diseño work?", "Who asked me for a call this week, and when?", "Which newsletters came in this week…". Open one to see its answer, sources and follow-up field. |
| **Rule made with AI** | Sidebar → **Rules** (bottom left), **Archive Uber receipts**, marked *AI*. | The rule the model built from "archive receipts from uber.com": domain is uber.com, subject matches receipt\|recibo, Archive; *Created with AI*; it matches 66 conversations. It was saved for new mail only, so the Inbox is untouched. Type a new request in *Describe the rule and AI builds it* to try another. |
| **Writing style** | Settings (⌘,) → AI → Writing style. | "Learned from 181 sent messages on this Mac": learned on the machine, no model. The *Study with AI* there is optional and reads many sent messages at the provider. |
| **Settings → AI** | ⌘, → AI. | The four background switches on (Summarize new mail, Follow-ups, Prepare a reply, the digest), each feature's provider and model, and the usage so far. |
| **Dev mode** | ⌘, → Dev mode. | *Pro AI* on, and the three keys as Set or Missing. Turning it off is AI off. |

### Try these yourself (made by what you type)

- **⌘J, write in the draft:** open **Recomendaciones de libros**, press ⌘J, type "thank him, say I'll start with the first one this weekend" and press ⌘J again (or Return). The draft is written in place with Undo, Regenerate, Shorter and Warmer above it.
- **Actions in plain English:** ⇧⌘K, type "Archive shipping notices older than a month" and press Return. A preview of what it would archive appears, with *How Terno read it*, matches it left out, and **Archive 3**; Cancel leaves everything as it was.
- **Summarize anything else:** open a conversation and press the ✦ button in the toolbar.
- **A fresh Reply ready:** open a conversation in Today marked *Waiting for your reply*. *Preparing a reply…* shows while the model writes it.

## Resetting

- `pnpm dev:demo-ai --fresh` puts the profile in the Trash and prepares it again (it costs the same as the first launch). It refuses while a Terno window has the profile open.
- Don't delete `demo-ai.json` by hand: it is how the command knows the folder is the AI demo's, and without it the command refuses the folder. Use `--fresh`.
- The rest of your setup is untouched: your real profile and `pnpm dev:desktop:demo`'s profile are separate folders, and none of their settings or keys change.

## What it never does

- It never touches your real profile (`~/Library/Application Support/Terno`) or another dev profile.
- It writes nothing into the database by hand: every summary, reply, answer, follow-up, digest line and rule comes from the app's own jobs, run by clicking through the app as you would, so what you see is what a user gets.
- Keys go only into the Electron process's environment, as `pnpm dev:desktop` already does (plan 146). They are never saved in the profile or printed.
- Mail goes only to the providers Pro uses (Anthropic and OpenAI) and only for the features above. Sender icons and automatic update checks keep their usual settings.
