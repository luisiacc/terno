Here's the full list. I took these steps from the current code and labels on main, but I didn't run through them myself. The Pro plan isn't built yet, so there's no checkout and no hosted AI. The Pro AI switch in Dev mode runs Pro's model choices on your own keys, so that's how you test it for now.

## Set up once
1. Put `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `JEV_API_KEY` in `.env`.
2. Run `pnpm dev:desktop`.
3. Go to Settings → Dev mode and turn on **Pro AI**.

## Pro plan features (from plan 85)
| Feature | How to test |
|---|---|
| **Summaries, one mail** | Open a mail. Click the sparkle at the top. A summary shows. |
| **Summaries, new mail** | Settings → AI → turn on **Summarize new mail**. Get a new mail. Open it. A summary is there. |
| **Drafting** | Open a mail. Press ⌘J. Type "say yes". Press Enter. A draft shows up. Nothing sends. |
| **Writing style** | Settings → AI → Drafting → turn on **Learn from my sent mail**. Open **Writing style**. See what it learned. |
| **Ask your mail** | Press ⇧⌘K. Ask "who wrote to me last?" You get an answer with its sources. |
| **Smart categories** | Settings → Categories → turn on **Ask AI for help**. Get a new mail that fits no category. Look for **Review** in the sidebar. |
| **Pro's AI allowance** | Can't test yet. It isn't built. |

## Other AI features we have now
| Feature | How to test |
|---|---|
| **Actions in plain English** | Press ⇧⌘K. Type "archive shipping notices older than a month". Check the list. Click Apply. Undo it. |
| **Follow-ups** | Settings → AI → turn on **Keep track of what I promise**. Send "I'll send the contract Friday". Open that thread. A line shows the promise. |
| **Nudge** | Find a follow-up where someone owes you a reply. Click **Nudge**. A draft opens. Nothing sends. |
| **Reply ready** | Settings → AI → turn on **Prepare a reply**. Open a mail waiting on your reply. Click **Use**. The words go in a draft. |
| **Today** | Click **Today** in the sidebar. You see what needs you. |
| **Newsletter digest** | Settings → AI → turn on **Prepare a digest each day**. Have an unread newsletter. Open Today. Look under Newsletters. |
| **Create a filter with AI** (free, but needs an AI provider) | Open Filters. Type "archive receipts from uber.com". Click **Create with AI**. Check it. Save. |

## Check that it hides
- **Local build:** turn **Pro AI** off. All AI buttons, the Today row and the Follow-ups row go away. ⌘J and ⇧⌘K do nothing. Stored summaries hide, and no new AI jobs run. **Create with AI** in Filters stays if you have a saved key.
- **Normal free user:** the buttons and rows above don't show until they add a key or a local model.

## Good to know
- **Summaries need OpenAI:** with only an Anthropic key, Terno asks before it sends mail to Anthropic.
- **Categories need JEV for Pro's setup:** without `JEV_API_KEY`, they run on your main provider instead.

