# Plan 289: the demo mailbox in English, one account in Spanish

- **Status:** plan.
- **Builds on:** plan 167 (`pnpm dev:demo-ai`), plans 224 and 288 (the site's pictures from the AI demo), plan 279 (the demo's "since" conversations), plan 211 (an account's "Show in What matters").

## The request (verbatim)

> for the screenshots on the marketing site, we need to redo them so the pictures don't have things in spanish in them like the category name,s account names, and email content. we'll redo the `demo` command and demoai command so only one account is in spanish, all other accounts should be purely english, the spanish account will be mainly for testing using demoai command to test that languages are grabbed correctly for drafting replies, in the screenshots all emails and things shown should be in english, not spanish.

## What exists

- **One generator, two jobs.** `@terno/mock-data`'s `generateDataset` makes the mailbox for both the demo (what people look at: `pnpm dev:desktop:demo`, `pnpm dev:demo-ai`, the packaged app's `TERNO_DEMO=1`, `pnpm dev:web`'s demo, the UI rating's harness) and the tests' fixture (`apps/backend-dev`'s server behind every e2e spec, the seeded profiles, the perf gates, the stores' conformance). Three conversations in four are Spanish, on every account; the categories (Facturas, Clientes, Viajes, Lecturas, Desarrollo), the folders (Familia, Recibos, Proyectos…), most notifications (Amazon México, BBVA, Aeroméxico, a Spanish calendar invite), the project words ("sistema de diseño", used in English subjects too: "Blockers for sistema de diseño") and most contact names are Spanish.
- **The fixture is pinned.** `generate.test.ts` fingerprints its output ("seeded fixtures, perf DBs and screenshots depend on it"). 47 e2e spec files and 192 visual baselines name its Spanish content.
- `seedDemo` (`packages/backend/src/demo.ts`) seeds it and a rule, "Notificaciones de GitHub → Desarrollo". `seedDemoSince` (plan 279) adds four hand-written conversations: one English (offsite, Acme Studio) and three Spanish (a birthday dinner on Personal, a contract and an invoice on Acme Studio).
- **The site's pictures.** Most come from `shots/showcase.ts`, an English mailbox of its own. Three come from the AI demo's window (`shots/demo-shots.ts`, plans 224 and 288): `ai-what-matters`, `ai-followups`, `ai-people`. All three show Spanish today: the categories in the sidebar, "Recomendaciones de libros", "¿Vamos al concierto?", "Planeación del sprint 8", Xataka and Platzi, Spanish snippets.
- `demo-ai-prepare.mjs` drives the demo by position (the Inbox's top six, Today's first four), except for a few named things: the Ask questions ("What did Isabella say about the payment?", "What's blocking the sistema de diseño work?"), the fallback follow-up's recipient (Arjun Ramírez), the rule request (uber.com receipts) and the since subjects. The UI rating's capture (`scripts/ui-rating/capture.mjs`) and the AI rating smoke open conversations by subject ("Recomendaciones de libros", "departamento en la Roma") and ask about Isabella.

## Design

### Two editions of the mock mailbox

`GenerateOptions.edition?: "fixture" | "demo"`. **`"fixture"` (the default) is unchanged byte for byte:** the fingerprint test still holds, and nothing the tests, baselines or perf gates read moves. Rewriting the fixture would cost 47 specs and 192 baselines for no gain in what the tests check.

**`"demo"`** is the mailbox people look at:

- **Each account has one language.** `MockAccount.lang?: "en" | "es"` (absent in the fixture: mixed, as now). Personal, Acme Studio and iCloud are English. **Freelance (hola@luiscordero.dev) is Spanish**: its clients, its folders ("Clientes antiguos", "Facturación") and plan 279's contract and invoice are already Mexican. Beyond four accounts (not used by the demo), the rest are English, their labels too ("Hotmail (old)", "University", "Shopping").
- **Everything a message carries follows its account's language:** the person pools (English names for English accounts, Spanish names for the Spanish one, disjoint, so nobody English has a Spanish-account conversation on their People page), coworkers, client companies, project words, subjects (personal, work, client), openers, sentences, closers, attachment names, the reply prefix, newsletters, notifications (receipts, shipping, bank, travel, calendar: the English ones get proper English templates, not the fixture's terse "Order N shipped"), GitHub and Linear (English accounts only) and spam.
- **Categories in English:** Receipts, Clients, Travel, Reading, Dev (the showcase's names). Folders on English accounts in English (Family, Receipts, Receipts/Taxes 2026; Projects, Projects/Website redesign, Team; Saved trips).
- The English banks are new lists in `banks.ts` (`EN_*`, and the Spanish-only views `ES_*` of the shared ones), so the fixture's lists, and so its draws, stay as they are.
- The same seed (42), sizes and dates as now: ~3,000 conversations, the newest at 15:30 UTC on 22 October 2026, so plan 167's clock and everything dated by it hold.
- Adversarial families stay fixture-only (the categorization eval); the demo never asks for them.

The two editions share one generator: a thread's language is `account.lang ?? (chance(0.75) ? "es" : "en")`, and each pick goes through `bank(lang)`, which in the fixture returns the old lists. Where the fixture made a draw the demo doesn't need (the language coin), the demo skips it: its stream is its own.

### Seeding

- `seedDemo(store, { edition })`: `"demo"` gives English category names and the rule "GitHub notifications → Dev"; the default stays the fixture's.
- **The demo's launches pass `edition: "demo"`:** the desktop backend when `demo` is set (`dev:desktop:demo`, `dev:demo-ai`, `TERNO_DEMO=1`, the UI rating's harness). `apps/backend-dev` (e2e and `pnpm dev`), `--seeded`, Put away's rating seed and the web worker's demo (see the revisions) stay on the fixture.
- `seedDemoSince`: the English offsite conversation stays on Acme Studio; the three Spanish ones move to the Spanish account (Freelance), where they test Spanish summaries and replies. Accounts by address (see the revisions).
- An existing demo profile keeps the mailbox it was seeded with (seeding is once per profile). A profile seeded with the demo edition holds the setting `demo.edition`. The demo-ai marker's version goes to 2, and a launch on a profile prepared with version 1 is refused with `--fresh` as the way on; `dev:desktop:demo --cleandb` starts the plain demo over.

### What the demo commands name

- `demo-ai-prepare.mjs`: the Ask questions and the fallback follow-up's recipient are re-picked from the new mailbox (an English contact who wrote about a payment, a project in English). The rule request (uber.com receipts) stays: English accounts get Uber's English receipts. The since subjects follow `DEMO_SINCE`.
- `capture.mjs` (UI rating) and `ai-rating.smoke.ts` open conversations that exist in the new mailbox, and their typed reply matches.
- `docs/AI-DEMO.md`'s "Where to look" names the new conversations, and says where the Spanish account is and what to try there (open a Spanish conversation; Reply ready and ⌘J write in Spanish). `docs/DEVELOPMENT.md`'s demo line follows.

### The site's pictures

`demo-shots.ts` takes the three pictures from the English accounts only:

- Before taking anything, on the copy of the profile it already requires, it turns off the Spanish account's **Show in What matters** and **Follow-ups** (plan 211's and plan 142's own switches, through the app's own call, as it sets the appearance). What matters leaves that account out, and People's Open with it.
- **The window must be in English** (`<html lang>`): the UI follows the Mac's languages.
- **A check on every frame:** no Spanish letter (á é í ó ú ñ ¿ ¡), and no whole word only the Spanish account says (its people's names, every Spanish first name, its subjects, its folders, its "since" conversations) painted in the frame. A Follow-up or a person whose frame fails is passed over; a frame about to be taken that fails is refused.
- Then the three pictures are retaken: `pnpm dev:demo-ai` on a new temp profile (never the owner's), on real models, then `shots:demo`.

## Tests

- `generate.test.ts`: the fixture's fingerprints hold (unchanged test). New: the demo edition is deterministic; every message on an English account has none of the Spanish banks' strings and no Spanish letters (á é í ó ú ñ ¿ ¡) in its subject, body, attachment names or participants' names; every conversation on the Spanish account opens with a Spanish opener; the categories and English accounts' folders are the English names; the English and Spanish person pools share nobody.
- `demo-since.test.ts`: the Spanish conversations land on the Spanish account, the offsite on Acme Studio.
- A seedDemo test: `edition: "demo"` names the categories and the rule in English; the default is the fixture.
- The demo-ai marker's edition check (`demo-ai.test.ts`).
- Run: the mock-data and backend unit files touched, typecheck, lint; the AI rating smoke with the stub (it launches the desktop demo); the site's render test after the retake.

## Performance

Generation runs once per profile, ~3,000 conversations, as now; per-language lists are built once per call. Nothing on a hot path changes. No migration.

## Out of scope

- The fixture behind the tests stays Spanish and mixed.
- The account owner's name (Luis Cordero) stays; the pictures already never show the demo account's own name or address.
- The showcase mailbox (`shots/showcase.ts`) and the AI pictures taken from it are English already.
- Put away's rating seed (plan 282) stays on the fixture.

## Revisions after the Codex review of the plan

Twelve points; what changed:

1. and 2. **The switches don't reach everything.** What matters honors "Show in What matters", but the Follow-ups list doesn't filter by either switch, and People's Everyone and search don't either. The pictures don't rely on the switches alone: the per-frame check above passes over a Follow-up or a person of the Spanish account and refuses any frame that shows its mail.
3. People's Everyone sits below the fold in the picture; the check covers the whole window anyway.
4. **English UI pinned and checked:** the window's language is checked; the check looks for Spanish letters too, so translated UI, Spanish folders and AI text written in Spanish are caught, not just a list of subjects.
5. **A whole-output fingerprint.** The old test fingerprints a projection that strips folders, labels, unsubscribe, bulk, tags and families. A second test fingerprints the whole output of four fixture configurations (including the adversarial set and seedDemo's exact 3,000 threads), computed from the generator before this change: they are equal.
6. **Every kind of mail is covered:** newsletter HTML and text (the demo's newsletters get their own lines, which also stops What matters reading "a problem with the payment" in a newsletter), calendar, attachment names (`invoice-N.pdf`), spam, Uber's receipts in English. The test checks every message kind on the English accounts, HTML included.
7. **`DEMO_SINCE` by address**, not by position (the stores list accounts in the user's order). Gmail's labels go only on a Gmail account: Freelance is IMAP, and its conversations' Inbox and read state come from `inInbox` and `isRead`. The test checks each lands on its account and in that account's Inbox.
8. and 9. **The web demo stays on the fixture.** The web worker's demo also seeds the web e2e and perf runs (`VITE_WEB_DEMO`, `?demo=…&accounts=8`), and its "new mail" import maps by position. The request is the desktop's demo commands, and the web build is low priority: out of scope.
10. **More consumers:** `ai-draft-body.smoke.ts` (the real-model draft smoke) and the rating capture's follow-up recipient are updated with the others.
11. **The top rows.** The demo's Inbox is new: its top six are English (five Acme Studio and Personal conversations and a newsletter), with Freelance's first Spanish conversation eighth. The preparation's named inputs are re-picked from it: Ask asks about James Harris's payment ("Concert on Friday?", the counterpart of Isabella's), "What's blocking the instant search work?" (the third conversation), and the fallback follow-up goes to Henry Haddad.
12. **A stale profile** is recognised by the marker's version (2 since this plan): seeding never runs over an existing mailbox, so a version-1 profile is refused before anything starts, with `--fresh` as the way on. A profile seeded with the demo edition also holds `demo.edition`.

## Revisions after the Codex code review

Nine findings; each fixed with a test where one can catch it:

1. The pictures were still the old ones: retaken (below).
2. **A stale profile is recognised by its database, not the marker.** A truncated or rewritten marker could let a profile seeded with the old mailbox through. `dev.mjs` reads the profile's database (read only) before anything opens it: a mailbox without `demo.edition = "demo"` is refused with `--fresh`. The marker's version stays 1. `oldMailboxProblem` is tested on each case.
3. **The frame check refused good English.** The Spanish account's words included what the English accounts say too ("Google Calendar", "Uber Receipts", "Airbnb") and folder parts with no letter ("2026"). `demoSpanishWords` now leaves out every word the English accounts also use, and any without a letter; the test checks both.
4. **The frame check let unaccented Spanish through:** "Facturas", an older demo window (the same addresses), AI text written in Spanish. The window must hold the demo edition's categories, and a short list of words only Spanish writes ("el", "para", "pago", "gracias", "facturas"…) is refused too, case-insensitively.
5. **A Follow-up on Freelance could be picked** (the list ignores the account's switches, and a subject may carry no accent): a candidate whose reader names the Spanish account is passed over.
6. **The language:** the demo window doesn't take `TERNO_TEST_LANGUAGES` (only the preparation does), so the script sets the copy's own language to English, as Settings → General does, and waits for it.
7. **The demo edition with the adversarial families** would mix Spanish into English accounts: it throws.
8. **The since test** compared each conversation's account with the same value the seeder used: it now names the address and kind (Acme Studio, Gmail; Freelance, IMAP) and checks Gmail's labels on the Gmail one only. Your own mail there was signed with the account's label ("Freelance"): it's signed with the owner's name now, tested.
9. `docs/AI-DEMO.md` named conversations that no longer exist: rewritten, with a section on the Spanish account.

## As built

- The fixture: identical to before on every field, for every configuration the tests use (checked against the generator at the plan's base, and pinned in `generate.test.ts`).
- The AI demo prepared on a fresh profile in 389 s: 161 model requests, about US$0.52. The Inbox's top six are English; the "since" step summarized all four (the Spanish ones' summaries in English, the app's language). The Claude steps (Reply ready, Ask, the AI rule) didn't finish: Anthropic refused every request with "You have reached your specified API usage limits. You will regain access on 2026-12-01", nothing to do with this change. The Spanish drafts (the reason for the Spanish account) are checked once that limit is raised.
- The AI rating smoke (stub) passes on the new demo.
