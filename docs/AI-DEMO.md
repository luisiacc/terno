# The AI demo: `pnpm dev:demo-ai`

The demo mailbox with every AI feature already showing something, on real models, so you can test them in a minute. It runs the desktop dev build (Vite with HMR) on its own profile, with Dev mode's Pro AI on. Plan 167 records why it's built this way.

## Running it

```bash
pnpm dev:demo-ai           # prepares the profile on its first launch, then opens the window
pnpm dev:demo-ai --fresh   # the profile goes to the Trash and is prepared again
```

- **Keys.** It needs `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`; `JEV_API_KEY` is optional (smart categories are off in the demo). It reads only these three names: from your shell first, then this checkout's `.env`, then the main checkout's `.env` (so a worktree works without its own). The terminal names which file each came from, never a value. If one is missing, it stops before building and says where it looked.
- **The first launch** prepares the profile behind your windows before the window opens, in about 2 minutes. The reading of the last month's sent mail for follow-ups may still be going on then: it carries on in your window, and the Follow-ups list fills within a minute or two. Each step prints a `[demo-ai]` line. A profile prepared before a step existed runs only that step on its next launch (People's, say: no model, from ten seconds to a few minutes while What matters settles). Leave it alone while it runs (its window shows but never takes focus); Ctrl-C stops it, and so does closing that window or quitting it: nothing else opens, the step it was on isn't counted as a try, and the next launch picks up where it stopped.
- **Later launches** open at once on what was prepared. Nothing is prepared again unless a step didn't finish: the terminal says which, a screenshot of it (`demo-ai-<step>-failed.png`) is in the profile, and the next launch tries only what's missing (a conversation without its summary, a question that failed). After three launches it keeps what's there and stops trying; a step that fails outright on three launches is set aside the same way (the terminal names it on every launch, and `--fresh` starts over). Closing the preparation's window is never counted as a failure. A digest that came out empty is set aside at once: the app makes a day's digest once, and the demo's day doesn't change.
- **Profile:** `~/Library/Application Support/Terno-dev-demo-ai`. `TERNO_USER_DATA` moves it, but only to a new or empty folder (or one it prepared before): it refuses a real Terno profile and any folder that holds something else, before opening anything in it.

### What the first launch costs

Measured on four runs: **about 80 model requests, US$0.12 to 0.16**, counted by the app's own usage book (Settings → AI shows it). The end of the preparation prints its total. Roughly:

| Feature | Requests | Model (Pro's routing) |
| --- | --- | --- |
| Follow-ups: the last 30 days of sent mail (195 messages, the app says about $0.03) | 35 to 50 | GPT Luna |
| Summaries of 7 or 8 conversations, and the 4 with new mail since you read | 11 to 12 | GPT Luna |
| Reply ready on 4 or 5 conversations (the model decides whether a reply is needed, then writes one) | 9 to 11 | GPT Luna (whether a reply is needed) and Claude Sonnet |
| Ask: 4 questions and a follow-up (a plan and an answer each) | 10 | Claude Haiku and Sonnet |
| The newsletter digest | 1 | GPT Luna |
| A rule made with AI | 1 | Claude Opus |

Anything you try afterwards (⌘J, a new question, an action) is billed as usual.

## The clock: 22 October 2026, 16:00 UTC

The demo mailbox is dated around 22 October 2026 (its newest message is 15:30 UTC), so with today's date Today would be empty and the digest would have no newsletters. The demo always runs on that day: the backend's clock and the window's clock both start at **16:00 UTC** (the AI rating's instant) and run on from there. A later launch starts where the preparation ended, a few minutes after 16:00, so nothing it made is ahead of the clock. Times show in UTC.

So the list says "3:27 PM" for the newest message, Today is that Thursday, and "No reply in 13 days" counts from it. The digest was prepared at once because its time (08:00) had already passed.

## Where to look

Every surface below is filled when the window opens. Lumen is the style; any other style shows the same content.

The mailbox is the written one (plan 292, `scripts/demo-corpus/README.md`): Luis Cordero, a product designer at Acme Studio in London who freelances in Spanish for Mexican clients, about 7,000 messages over two years, written by agents from a cast of 98 people. It's in this checkout once `packages/mock-data/demo-corpus/demo.json` is; without it the command seeds plan 289's generated mailbox, and the names below don't apply.

| Feature | Where | What you'll see |
| --- | --- | --- |
| **Summary** | Inbox → the top conversation, **offsite demo: Tandem or Pennywort?** (Gabriel Santos, 3:30 PM). Also the next ones in the Inbox (**Link for the November open evening**, **Orden de compra fajilla diciembre**, **Etiqueta trasera para el lote de Chiapas** …) and the first ones in Today. | A Summary card above the message: what it says, a To do with Reply, *Written with AI ▾* (which model). The ✦ button in the toolbar updates or asks for one on any other conversation. |
| **What's new since you read** (plan 279) | Inbox, among the newest: **Left shin / Marshgate** (Harriet Lowe), **collection page filter bar** (Hollie Tran) and, on Freelance in Spanish, **Alta de proveedor en nuevo sistema** (Emilio Cárdenas). Each has mail you'd read, then new mail in the last two hours that changes something. | The Summary card opens on **Since today** · **Whole conversation**: one sentence on what changed (Harriet moves your session to Wednesday 28 October and stops Saturday's long run; Hollie moves the freeze to the 28th; Emilio moves the payment to the 30th), the whole summary a click away, the new mail's to-dos first. **Holloway import + DNS** (Rhys Morgan) ends on a thanks: nothing changed, so its card is usually the whole summary alone. |
| **Reply ready** | The Inbox's newest where a reply is owed (**offsite demo: Tandem or Pennywort?**, **Link for the November open evening**), and the Spanish ones on Freelance (**Orden de compra fajilla diciembre**, **Etiqueta trasera para el lote de Chiapas**), where the draft should be in Spanish. | *Reply drafted* under the message, with *1 gap to fill* where only you can decide, **Use as draft** (R) and Dismiss. A conversation that doesn't wait for your reply has none (the model decides so: a newsletter, or a conversation you answered last). |
| **What matters** | Sidebar → **What matters** (the top item). | What needs you: promises you made ("I'll send the staging link and a note on corrections by Wednesday"), deadlines asked of you (Yasmin wants the talk's title, bio and headshot by Friday 23 October), people who haven't replied, and mail waiting for your reply. The mailbox is busy, as a lead designer's is: dozens wait. |
| **Newsletter digest** | What matters → the digest row. | Today's digest: one line per newsletter that came in unread (a Thursday: Compile Weekly and Window Seat, and the week's unread ones), each ticked to archive, **Archive N**, Untick all; open one and Back returns to the digest. |
| **Follow-ups** | Sidebar → **Follow-ups**, or open one from What matters. | Conversations from the last month's sent mail: who hasn't replied (ten sends from 6 to 13 days ago still wait for an answer), promises made to you (Lena at Kestrel promised the icon masters by Friday 16 October, then "first thing Thursday"). Open one: the card has *Write a follow-up* (or Done), Reschedule, Dismiss, *Your message, Oct 9 →*, *Found with AI ▾*. |
| **People** (plan 281) | Sidebar → **People**, under Inbox (`g p`). | **Open**, longest waiting first: everyone with something between you, each row saying what and for how long ("Waiting on you · …", "Asked you · …", "Owes you a reply · …", "You promised · …", and *+3* when there's more). The last row in Open is one person whose only item the preparation put off with Later: it says *Back Oct 26* (next Monday) and isn't counted. The terminal names who; never a conversation the steps above showed off. Below, **Everyone**, those you write to most first, each with *Last email*. Open someone: their page has *Open between you* with **Done** and **Later** at each item's side on hover (Later's presets and *Pick a date…*), then their conversations, marked where they didn't write. |
| **Person card** (plan 281) | Any conversation with several people, e.g. **Beta on 1 December: what we need from you** (Acme Studio): click a name chip under the subject. | The person's card: up to two things open between you, each with Done and Later on hover, *N more in People* when there are more, *Last between you* when you've written each other elsewhere, *New message to …*, and, for someone who wrote in this conversation, the filing actions under *More*. |
| **Ask your mail** | ⇧⌘K → **Previous AI questions** (the clock row under the field): four conversations. | "What was the booking reference for my emergency dentist appointment, and how much did I pay?" (WCD-48213, £68; with a follow-up, "Did Jo pay me back?"), "How much did Margins pay up front for the programme print job?" (£410.40), "What's the booking reference for Daniela's physio call with Harriet?" (DSC-1043), "Which newsletters came in this week…". The preparation counts an answer only if it states those facts. Open one to see its answer, sources and follow-up field. |
| **Rule made with AI** | Sidebar → **Rules** (bottom left), the rule marked *AI*. | The rule the model built from "archive ride receipts from sidestreetrides.example": Side Street Rides' receipts, not its offers or "rate your driver" notes from the same address; *Created with AI*. It was saved for new mail only, so the Inbox is untouched. Type a new request in *Describe the rule and AI builds it* to try another. The starter rule beside it, **Branch Ferries → Dev**, files the code host's notifications. |
| **Writing style** | Settings (⌘,) → AI → Writing style. | "Learned from 181 sent messages on this Mac": learned on the machine, no model. The *Study with AI* there is optional and reads many sent messages at the provider. |
| **Settings → AI** | ⌘, → AI. | The four background switches on (Summarize new mail, Follow-ups, Prepare a reply, the digest), each feature's provider and model, and the usage so far. |
| **Dev mode** | ⌘, → Dev mode. | *Pro AI* on, and the three keys as Set or Missing. Turning it off is AI off. |

### Try these yourself (made by what you type)

- **⌘J, write in the draft:** open **Have you still got the little phone stand?** (Harriet Lowe), press ⌘J, type "yes, I'll drop it at the clinic on Monday on my way in" and press ⌘J again (or Return). The draft is written in place with Undo, Regenerate, Shorter and Warmer above it.
- **Actions in plain English:** ⇧⌘K, type "Archive shipping notices older than a month" and press Return. A preview of what it would archive appears, with *How Terno read it*, matches it left out, and **Archive 3**; Cancel leaves everything as it was.
- **Summarize anything else:** open a conversation and press the ✦ button in the toolbar.
- **A fresh Reply ready:** open a conversation in Today marked *Waiting for your reply*. *Preparing a reply…* shows while the model writes it.

## The Spanish account (plan 289)

Every account is in English but **Freelance** (hola@luiscordero.example in the written mailbox), whose mail is all in Spanish: Mexican clients (a coffee roaster, a boutique hotel, a dental chain, a brewery, a nonprofit), his contadora, a designers' list, two Spanish newsletters, a Mexican bank and an e-invoicing service. It's there to check that what's written for you follows the conversation's language, not the app's:

- Open a Freelance conversation that waits for you, e.g. **Orden de compra fajilla diciembre** (Emilio Cárdenas) or **Etiqueta trasera para el lote de Chiapas** (Mariana Gómez): Reply ready's draft should be in Spanish.
- In **¿Sí salieron las de Ofrenda?** (Fernanda Ríos), press ⌘J and type an instruction in English ("say yes, I'll send the invoice on Monday"): the draft should be in Spanish.
- Summaries and What matters' lines are in the app's language (English), whatever the mail's.

The site's pictures (`apps/site/shots/demo-shots.ts`) leave Freelance out: it turns off Freelance's Show in What matters and Follow-ups in its copy of the profile and refuses any frame with Spanish in it.

## Resetting

- `pnpm dev:demo-ai --fresh` puts the profile in the Trash and prepares it again (it costs the same as the first launch). It refuses while a Terno window has the profile open.
- A profile prepared before plan 289 holds the earlier mailbox (Spanish throughout): the command refuses it and says to run `--fresh`. `pnpm dev:desktop:demo --cleandb` starts the plain demo over the same way.
- Don't delete `demo-ai.json` by hand: it is how the command knows the folder is the AI demo's, and without it the command refuses the folder. Use `--fresh`.
- The rest of your setup is untouched: your real profile and `pnpm dev:desktop:demo`'s profile are separate folders, and none of their settings or keys change.

## What it never does

- It never touches your real profile (`~/Library/Application Support/Terno`) or another dev profile.
- It writes nothing into the database by hand: every summary, reply, answer, follow-up, digest line and rule comes from the app's own jobs, run by clicking through the app as you would, so what you see is what a user gets.
- Keys go only into the Electron process's environment, as `pnpm dev:desktop` already does (plan 146). They are never saved in the profile or printed.
- Mail goes only to the providers Pro uses (Anthropic and OpenAI) and only for the features above. Sender icons and automatic update checks keep their usual settings.
