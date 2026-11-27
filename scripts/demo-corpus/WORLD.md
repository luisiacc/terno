# Brief: the world of the demo mailbox (plan 292, stage 0)

You are building the cast and the backstory of a fictional person's email, the demo mailbox of Terno, an email client. Later, other agents will write about 900 email threads from what you write here, so everything you write must be specific, consistent and varied. Nothing you write is a real person, company or product.

## What to write

Fill `packages/mock-data/demo-corpus/world.json` in place. The schema is `packages/mock-data/src/demo-corpus/types.ts` (`World`). Keep `anchor`, `accounts` and `categories` exactly as they are. Fill `owner` (bio, style), `timeline`, `people`, `orgs`, `brands`, `storylines`. Run `node scripts/demo-corpus/check.mjs world` until it prints `ok`. Don't run git, don't touch any other file.

## The owner

**Luis Cordero**, mid-thirties, a product designer at **Acme Studio** (a ~40-person design and product studio in London, `acme.studio`). Mexican, from Guadalajara, in London for about six years; bilingual. On the side he freelances for clients in Mexico, in Spanish, from `hola@luiscordero.dev`. The mail spans two years, 22 October 2024 to the anchor, **Thursday 22 October 2026, 15:30 UTC** (London is UTC+1 until Sunday 25 October 2026).

His four addresses (fixed):
- **Personal** `luis.cordero@gmail.com`, English: partner, friends, family that writes English, the flat, clubs, appointments, buying and selling things.
- **Acme Studio** `luis@acme.studio`, English: his team, the rest of the studio, Acme's clients, vendors, recruiters, events.
- **Freelance** `hola@luiscordero.dev`, **Spanish only**: Mexican clients, their teams, his accountant, a collaborator, new leads.
- **iCloud** `lccordero@icloud.com`, English: older and quieter; travel, an old friend group, insurance, a landlord from before.

**Hard rule:** everything on Personal, Acme Studio and iCloud is English, and nobody who writes to those accounts has Spanish accents in their name (Luis's Mexican family mostly uses messaging apps, not email; a sibling abroad who emails him writes in English). Spanish lives only on Freelance. A person who writes to Freelance writes Spanish there.

`owner.style.en` and `owner.style.es`: how Luis writes in each language. Make him one recognisable person: e.g. short and friendly at work, lowercase-ish and quick with friends, more formal with new Mexican clients (usted at first, tú once they're familiar). His signature differs per account (none on Personal, a work block on Acme, a freelance block on Freelance).

## The cast: about 100 people

Spread: Personal ~35, Acme Studio ~35, Freelance ~20, iCloud ~10 (a person may write to two accounts). Include a partner, a sibling, close friends, a friend group, a landlord or letting agent, neighbours, a running club or a five-a-side organiser, a book club, a dentist's receptionist, a wedding couple, an old university friend; at Acme his manager, his team (~10), people in other teams (engineering, ops, finance, HR), Acme's clients (5–6 companies), vendors, a recruiter or two; on Freelance 6–8 clients across 4–5 Mexican companies, their colleagues, his accountant (contadora), a developer he collaborates with, a couple of leads.

**Make them write differently.** This is the point: the writers will copy these cards. Across the cast:
- at least a fifth are terse (one or two lines, sometimes no greeting), at least a sixth write long;
- a quarter have quirks: lowercase, the odd typo, no punctuation, "Sent from my iPhone", "Sent from my phone, excuse brevity", bullet lists, one emoji, all-caps words, ALWAYS replying in the first line;
- quoting: most "bottom", some "top" (top-posting replies), a few "none";
- signatures: many none, some long corporate blocks with a phone number and a legal line, some a single name;
- registers from formal to very casual; varied ages, countries of origin, timezones (London mostly; also Mexico City, Monterrey, New York, Lisbon, Berlin, Toronto, Sydney…);
- names that fit them, varied (British, Irish, Indian, Nigerian, Polish, Chinese, Brazilian, Mexican on Freelance…), never two alike.
- `facts`: 2–5 concrete things that stay true (has two kids, is vegetarian, is leaving Acme in December, lives in Hackney, owes Luis £40 since the ski trip).

Addresses: people at an organisation use its domain; friends use webmail (gmail.com, icloud.com, outlook.com, hotmail.com, yahoo.com, proton.me) or a personal domain. Lowercase. All unique. **Every domain that isn't webmail ends in `.example`** (Acme is `acme.example`, a coffee roaster `cafealtura.example`, a personal site `ninaokafor.example`): the demo must never reach a real server, not even for an icon. Same for orgs' and brands' domains.

## Organisations: about 25

Acme Studio itself (`acme.studio`), Acme's clients (a fintech, a museum, a grocery chain, a bike-share, a charity…), vendors (a print shop, a font foundry, a catering company), Freelance's Mexican clients (a coffee roaster, a boutique hotel, a dental clinic chain, a craft brewery, a nonprofit…; Spanish), the accounting firm, the letting agency, the running club. Every name and domain invented; avoid anything that is, or sounds like, a real company.

## Brands: about 40, the machine mail

The senders of automated mail. Each with a kind, a language matching the accounts it writes to, the accounts, the category tag, a list id for newsletters, and a cadence in words. Cover: **about 16 newsletters** (design, tech, a local London newsletter, food, running, a finance one, a product-management one, a type foundry's; two Spanish ones for Freelance), a bank and a card issuer (UK), a Mexican bank and an e-invoicing platform (Spanish, Freelance), a ride-share, food delivery, two online shops, a parcel carrier, an airline, a train operator, a hotel booking site, a code host and a project tool (Acme), a design tool's notifications, a calendar/scheduling tool, a mobile carrier, an energy supplier, a gym, a streaming service, a security-alert sender, a couple of promos. All invented (the site's showcase uses names like `hopperrides.com`, `harborbank.com`, `parcelpoint.com`, `skylarkair.com`: same spirit, but make your own). The ride-share matters: the demo asks the AI to make a rule archiving its receipts.

## Storylines: about 60 arcs

Arcs that run across several threads and weeks: hiring a junior designer, the Acme team offsite (early November 2026), a client website relaunch with a slipping deadline, a flat move or a boiler that won't get fixed, his sister's wedding, a friend's 40th, a trip to Lisbon, a Freelance client's rebrand from quote to invoice to late payment, a contract negotiation, his accountant chasing documents, a conference talk he's asked to give, the running club's half marathon. Each: id, account, title, a dated summary of what happens start to end, the people, from–to dates. **About a third should be live at the anchor** (ending after 1 October 2026, things still open: promises not kept yet, replies awaited, decisions pending), the rest spread back over two years.

## Timeline: about 30 entries

Luis's two years in order: when he started leading a project, trips, moving flat, his partner's job change, a promotion, a sick week, holidays (when he's away, mail goes quiet). Writers use it to date things and keep them consistent.

## Quality bar

Specific beats generic: "the boiler in Flat 3, 14 Albion Road" beats "the apartment". Every person should be someone you could write a page about. Avoid clichés of generated fiction (no one named Elara, no "tapestry"). Then check: `node scripts/demo-corpus/check.mjs world` prints `ok`. Report the counts (people per account, orgs, brands by kind, storylines live at the anchor) in your final message.
