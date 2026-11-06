# The mail evals read

Two sets, for the evals in `scripts/ai-real/`. They're not used by `pnpm test`.

- **`synthetic/*.jsonl`, in this repo.** Conversations written by agents with different personalities. Every person, company and address is invented. The repo is public, so nothing real goes here.
- **Real mail, never in this repo.** Public archives, rebuilt by `fetch-real.py` into `~/.terno-evals/real-mail/`. They hold real people's words: they stay on this machine, and their text is never pasted into a plan, a commit or a test.

## One conversation, one line of JSON

```json
{
  "id": "marta-007",
  "author": "marta",
  "language": "es",
  "category": "supplier",
  "tags": ["informal", "own-last"],
  "subject": "Factura de marzo",
  "reader": { "name": "Lucía Romero", "email": "lucia@panaderia.example" },
  "today": "2026-03-05",
  "messages": [
    { "from": "Tom Baker <tom@vendor.example>", "date": "2026-03-01", "own": false, "to": ["Lucía Romero <lucia@panaderia.example>"], "cc": [], "text": "the body, as the mail would show it" },
    { "from": "Lucía Romero <lucia@panaderia.example>", "date": "2026-03-03", "own": true, "to": ["Tom Baker <tom@vendor.example>"], "cc": [], "text": "..." }
  ],
  "truth": {
    "readerOwes": ["what the reader has to do or answer, one thing each"],
    "othersOwe": ["what the reader is waiting on from someone else"],
    "settled": ["decisions already taken"],
    "keyDates": ["dates or deadlines that matter"],
    "mustNotClaim": ["a tempting wrong reading the summary must avoid"]
  }
}
```

- `reader` is whose mailbox this is, and `own: true` marks the messages they wrote. The oldest message comes first.
- `to` and `cc` are lists of `"Name <email>"`, with at least one in `to`: who the mail was addressed to and who was copied, as the conversation says. Someone only named in the text isn't on it, and someone who joins partway is on the mail from then on. When the reader is only copied (`cc-only`), the person asked is in `to`. Mail to a group or a mailing list (newsletters, announcements) has the list's `.example` address in `to` and `"list": true`, and doesn't name the reader.
- `truth` is written in English whatever the mail's language, by the person who wrote the mail. Empty lists are fine and common.
- `language` is the mail's main language. An eval asks for the summary in the reader's app language, which it chooses itself.
- `tags` say what's hard about it: `informal`, `formal`, `one-liner`, `long`, `quoted-history`, `signature`, `disclaimer`, `forwarded`, `own-last`, `cc-only`, `superseded`, `multi-ask`, `no-action`, `ambiguous`, `sensitive`, `automated`, `newsletter`, `receipt`, `phishing`, `injection`, `mixed-language`, `deadline`, `amounts`, plus any others that help.
- Invented only: addresses on `.example` domains, no real company or person, no working links (`https://x.example/...`), and nothing shaped like a real key or card number.

Check a file with `python3 -I scripts/ai-real/corpus/validate.py <file>`.

## Running it

```sh
python3 -I scripts/ai-real/corpus/fetch-real.py                  # once, builds ~/.terno-evals/real-mail
TERNO_AI_REAL=1 TERNO_AI_SUMMARY_CORPUS=<run> pnpm exec vitest run --config vitest.real.config.ts scripts/ai-real/summaries-corpus.real.ts
python3 -I scripts/ai-real/corpus/score.py <run> [<other run>]   # what can be counted
```

It costs about $0.17 for all 510 on GPT Luna, and goes through the harness's ledger. Counts can't judge meaning: plan 151 records how two judges graded runs blind, with their labels shuffled per conversation.
