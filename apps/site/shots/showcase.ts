/**
 * The mailbox the site's screenshots show (plan 97): a fictional person, fictional companies, English throughout.
 * The demo mailbox (`@terno/mock-data`) carries the maintainer's name and Spanish mail, which a public page
 * shouldn't. A curated top of the inbox (what the shots frame) sits on a few thousand older threads, so search
 * and the "everything similar" counts have real numbers behind them. Deterministic: same input, same pictures.
 */
import type { Address } from "@terno/core";
import type { MockAccount, MockCategory, MockDataset, MockMessage, ThreadTag } from "@terno/mock-data";

/** 9:24 on a Thursday morning in Los Angeles (the shots' timezone) */
export const SHOWCASE_NOW = Date.UTC(2026, 9, 29, 16, 24);
export const SHOWCASE_CODE = "482913";

const ME = "Sam Rivera";
export const ACCOUNTS: MockAccount[] = [
  { kind: "gmail", email: "sam.rivera@gmail.com", displayName: "Personal", color: "indigo", ownerName: ME, weight: 0.35 },
  { kind: "gmail", email: "sam@northwind.studio", displayName: "Northwind", color: "emerald", ownerName: ME, weight: 0.35 },
  { kind: "imap", email: "hello@samrivera.design", displayName: "Studio", color: "amber", ownerName: ME, weight: 0.2 },
  { kind: "imap", email: "sam.rivera@outlook.com", displayName: "Outlook", color: "cyan", ownerName: ME, weight: 0.1 },
];

export const CATEGORIES: MockCategory[] = [
  { name: "Receipts", color: "amber", tags: ["receipt", "bank", "shipping"] },
  { name: "Clients", color: "emerald", tags: ["client"] },
  { name: "Travel", color: "cyan", tags: ["travel"] },
  { name: "Reading", color: "violet", tags: ["newsletter"] },
  { name: "Dev", color: "indigo", tags: ["dev"] },
];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Msg {
  from: Address;
  /** time before SHOWCASE_NOW */
  ago: number;
  body: string;
  html?: string;
  /** this message's files; else the thread's go on its last message */
  attachments?: { filename: string; mime: string; size: number }[];
}
interface Thread {
  account: number;
  subject: string;
  tag: ThreadTag;
  messages: Msg[];
  read?: boolean;
  starred?: boolean;
  list?: string;
  bulk?: boolean;
  attachments?: { filename: string; mime: string; size: number }[];
  inInbox?: boolean;
  /** whom a thread you started is to (a message only you wrote has no one else to answer) */
  to?: Address;
}

const me = (account: number): Address => ({ name: ME, email: ACCOUNTS[account]!.email });

const priya = { name: "Priya Natarajan", email: "priya@oakandiron.com" };
const jonah = { name: "Jonah Weiss", email: "jonah@northwind.studio" };
const theo = { name: "Theo Park", email: "theo@northwind.studio" };
const marta = { name: "Marta Ruiz", email: "marta.ruiz@gmail.com" };
const elena = { name: "Elena Sato", email: "elena@brightwater.co" };
const nadia = { name: "Nadia Okafor", email: "nadia@northwind.studio" };

/** the newsletter that ends up filed in Reading; a promo the shots archive with everything like it */
const fieldnotes = { name: "Fieldnotes Weekly", email: "hello@fieldnotes.email" };
const outfitter = { name: "Outfitter Co.", email: "news@outfitter.co" };

const html = (paragraphs: string[]) =>
  `<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:15px;line-height:1.55">${paragraphs.map((p) => `<p>${p}</p>`).join("")}</div>`;

/** The inbox the shots frame, newest first. */
const CURATED: Thread[] = [
  {
    account: 1,
    subject: "Your Tandem verification code",
    tag: "work",
    messages: [
      {
        from: { name: "Tandem", email: "no-reply@tandem.so" },
        ago: 3 * MIN,
        body: `Hi Sam,\n\nYour verification code is ${SHOWCASE_CODE}\n\nIt expires in 10 minutes. If you didn’t try to sign in, you can ignore this email.\n\nThe Tandem team`,
        html: `<div style="font-family:-apple-system,sans-serif;font-size:15px;line-height:1.5"><p>Hi Sam,</p><p>Your verification code is</p><p style="font-size:30px;font-weight:600;letter-spacing:6px">${SHOWCASE_CODE}</p><p>It expires in 10 minutes. If you didn’t try to sign in, you can ignore this email.</p><p>The Tandem team</p></div>`,
      },
    ],
  },
  {
    account: 2,
    subject: "Homepage concepts, round two",
    tag: "client",
    starred: true,
    messages: [
      {
        from: me(2),
        ago: 26 * HOUR,
        // on Sam's message, which the reader shows collapsed: a showcase file has no bytes, so its card would say so
        attachments: [{ filename: "homepage-concepts-v2.pdf", mime: "application/pdf", size: 4_812_000 }],
        body: "Hi Priya,\n\nAttached are three directions for the new homepage. A is the calm one, B leans on photography, C is the bold type-led version. Happy to walk you through them on a call.\n\nSam",
      },
      {
        from: priya,
        ago: 22 * HOUR,
        body: "These are lovely. The team is split between A and C. Could we try C with A’s colors?\n\nPriya",
      },
      {
        from: priya,
        ago: 18 * MIN,
        body: "Hi Sam,\n\nWe looked at the revised C this morning and everyone is in. The type finally feels like us, and the quieter palette makes the products the hero.\n\nTwo small things before we sign off:\n\n1. Could the headline wrap after “made”, so it reads as two lines on desktop?\n2. Let’s swap the third photo for the one from the workshop shoot.\n\nIf those are easy, we’re happy to approve on Friday and move on to the product pages. Thank you, this has been a joy.\n\nPriya",
        html: html([
          "Hi Sam,",
          "We looked at the revised C this morning and everyone is in. The type finally feels like us, and the quieter palette makes the products the hero.",
          "Two small things before we sign off:",
          "1. Could the headline wrap after “made”, so it reads as two lines on desktop?<br>2. Let’s swap the third photo for the one from the workshop shoot.",
          "If those are easy, we’re happy to approve on Friday and move on to the product pages. Thank you, this has been a joy.",
          "Priya",
        ]),
      },
    ],
  },
  {
    account: 0,
    subject: "Issue 212: The quiet interface",
    tag: "newsletter",
    list: "fieldnotes.email",
    bulk: true,
    messages: [{ from: fieldnotes, ago: 42 * MIN, body: "This week: why the best tools get out of the way, a field guide to keyboard-first design, and five apps that respect your attention." }],
  },
  {
    account: 1,
    subject: "Lisbon offsite: flights and the plan",
    tag: "travel",
    starred: true,
    messages: [
      { from: jonah, ago: 70 * MIN, body: "Flights are booked for everyone. We land Tuesday at 11:40, hotel is ten minutes from the studio. The full itinerary is in the shared folder, shout if anything looks off." },
    ],
  },
  {
    account: 1,
    subject: "[northwind/atlas] Add instant search to the command bar (#418)",
    tag: "dev",
    list: "atlas.northwind.forge.dev",
    bulk: true,
    messages: [{ from: { name: "Forge", email: "notifications@forge.dev" }, ago: 80 * MIN, body: "Nadia Okafor approved these changes. Looks great, the results show up before I finish typing. Ship it." }],
  },
  {
    account: 0,
    subject: "Your Wednesday evening ride with Hopper",
    tag: "receipt",
    read: true,
    messages: [{ from: { name: "Hopper Rides", email: "receipts@hopperrides.com" }, ago: 2 * HOUR, body: "Thanks for riding, Sam. Total $14.20. Pickup 8:02 PM, drop-off 8:21 PM." }],
  },
  {
    account: 0,
    subject: "Dinner Saturday?",
    tag: "personal",
    messages: [{ from: marta, ago: 3 * HOUR, body: "We’re doing the little Thai place on Alder at 7. Bring the good bread if you can!" }],
  },
  {
    account: 0,
    subject: "Last chance: 30% off all outerwear",
    tag: "promo",
    bulk: true,
    list: "news.outfitter.co",
    messages: [{ from: outfitter, ago: 4 * HOUR, body: "Our biggest sale of the season ends tonight. Coats, shells and the cozy fleece everyone asks about." }],
  },
  {
    account: 3,
    subject: "Your October statement is ready",
    tag: "bank",
    read: true,
    messages: [{ from: { name: "Harbor Bank", email: "statements@harborbank.com" }, ago: 5 * HOUR, body: "Your statement for the period ending October 28 is ready to view in online banking." }],
  },
  {
    account: 1,
    subject: "Check-in is open for your flight to Lisbon",
    tag: "travel",
    messages: [{ from: { name: "Skylark Air", email: "trips@skylarkair.com" }, ago: 6 * HOUR, body: "SFO → LIS, Tuesday Nov 3, seat 14A. Check in now to get your boarding pass." }],
  },
  {
    account: 1,
    subject: "Q4 roadmap draft, comments by Friday",
    tag: "work",
    read: true,
    attachments: [{ filename: "q4-roadmap.pdf", mime: "application/pdf", size: 1_204_000 }],
    messages: [{ from: theo, ago: 7 * HOUR, body: "First pass at the Q4 roadmap. The big bets are search and onboarding. Leave comments in the doc by Friday." }],
  },
  {
    account: 0,
    subject: "New: the autumn collection",
    tag: "promo",
    bulk: true,
    list: "hello.lumierecandles.com",
    messages: [{ from: { name: "Lumière Candles", email: "hello@lumierecandles.com" }, ago: 9 * HOUR, body: "Cedar, smoke and a little bit of orange peel. Meet the four new scents for the colder months." }],
  },
  {
    account: 0,
    subject: "Your package arrives today",
    tag: "shipping",
    read: true,
    messages: [{ from: { name: "Parcelpoint", email: "track@parcelpoint.com" }, ago: 10 * HOUR, body: "Your order from Pantry Market is out for delivery and should arrive by 6 PM." }],
  },
  {
    account: 2,
    subject: "Invoice 2026-041 received, thank you",
    tag: "client",
    read: true,
    messages: [{ from: elena, ago: 20 * HOUR, body: "Got it, payment goes out with Friday’s run. Looking forward to phase two!" }],
  },
  {
    account: 1,
    subject: "Invitation: Design review, Thu Oct 29 at 2 PM",
    tag: "calendar",
    read: true,
    messages: [{ from: nadia, ago: 23 * HOUR, body: "Design review for the onboarding flow. Bring your latest screens." }],
  },
  {
    account: 0,
    subject: "Typography that disappears",
    tag: "newsletter",
    read: true,
    bulk: true,
    list: "themargin.press",
    messages: [{ from: { name: "The Margin", email: "letters@themargin.press" }, ago: 26 * HOUR, body: "Good type is invisible. This week we look at three interfaces where the letters do the work and the chrome steps back." }],
  },
  {
    account: 0,
    subject: "Your Pantry Market order #20931",
    tag: "receipt",
    read: true,
    messages: [{ from: { name: "Pantry Market", email: "orders@pantrymarket.com" }, ago: 28 * HOUR, body: "Thanks for your order! 12 items, total $86.40. We’ll let you know when it ships." }],
  },
];

const isabella = { name: "Isabella Grant", email: "isabella@larchandpine.com" };
const daniel = { name: "Daniel Brooks", email: "daniel@brookspress.co" };
const leo = { name: "Leo Martins", email: "leo@leomartins.photo" };

const letter = (from: Address, list: string, subject: string, ago: number, paragraphs: string[]): Thread => ({
  account: 0,
  subject,
  tag: "newsletter",
  list,
  bulk: true,
  messages: [{ from, ago, body: paragraphs.join("\n\n"), html: html(paragraphs) }],
});

/** What the AI pictures read (`showcaseDataset({ ai: true })`): every word the models write about them is their own. */
const AI_EXTRAS: Thread[] = [
  // Reply ready: a client moves next Thursday's walkthrough and asks for the address, which Sam's own message holds
  {
    account: 2,
    subject: "Thursday’s walkthrough",
    tag: "client",
    messages: [
      {
        from: me(2),
        ago: 3 * DAY,
        body: "Hi Isabella,\n\nHere are the details for next Thursday’s walkthrough of the product pages.\n\nWhen: Thursday, November 5, 2 PM\nWhere: our studio, 418 Alder Street, Suite 3\nParking: the lot behind the building\n\nSam",
      },
      {
        from: isabella,
        ago: 25 * MIN,
        body: "Hi Sam,\n\nI’m so sorry, I just found out I’ll be at a furniture fair in Milan that week. Could we move Thursday’s walkthrough to the week after? Any afternoon works for me, so just tell me which day suits you.\n\nAnd could you send me the studio’s address again? I’d like to forward it to Marco, who’s joining us.\n\nThanks,\nIsabella",
      },
    ],
  },
  // Ask: what Isabella said about the payment, across two conversations already out of the Inbox
  {
    account: 2,
    subject: "Invoice 2026-044",
    tag: "client",
    read: true,
    inInbox: false,
    attachments: [{ filename: "invoice-2026-044.pdf", mime: "application/pdf", size: 96_000 }],
    messages: [
      { from: me(2), ago: 12 * DAY, body: "Hi Isabella,\n\nAttached is the invoice for the homepage and the product pages: $8,400, net 30 as agreed.\n\nThanks again,\nSam" },
      {
        from: isabella,
        ago: 11 * DAY + 3 * HOUR,
        body: "Thanks, Sam! We’ll pay it in two halves: $4,200 this month and the rest once the product pages are live. I hope that works for you.\n\nIsabella",
      },
    ],
  },
  {
    account: 2,
    subject: "First payment is on its way",
    tag: "client",
    read: true,
    inInbox: false,
    messages: [
      {
        from: isabella,
        ago: 2 * DAY + 2 * HOUR,
        body: "Hi Sam,\n\nThe first $4,200 went out this morning by bank transfer, so you should see it by Friday. The second half follows when the product pages go live.\n\nIsabella",
      },
    ],
  },
  // a summary: a scope decision, a deadline and a question for Sam
  {
    account: 2,
    subject: "Phase two: scope and timeline",
    tag: "client",
    messages: [
      {
        from: me(2),
        ago: 2 * DAY + 5 * HOUR,
        body: "Hi Elena,\n\nFor phase two I’d suggest the journal first, since your stories are ready, then the store locator. The careers page could wait. Does that order work for you?\n\nSam",
      },
      {
        from: elena,
        ago: 50 * MIN,
        body: "Hi Sam,\n\nWe talked it over this morning and we agree: the journal first, and the careers page can wait until spring.\n\nOne firm date: the store locator has to be live by December 10, for our holiday launch. Could you send the estimate by Monday?\n\nThanks,\nElena",
        html: html([
          "Hi Sam,",
          "We talked it over this morning and we agree: the journal first, and the careers page can wait until spring.",
          "One firm date: the store locator has to be live by December 10, for our holiday launch. Could you send the estimate by Monday?",
          "Thanks,<br>Elena",
        ]),
      },
    ],
  },
  // a promise in sent mail (Today: "You said: call to go over the details")
  {
    account: 2,
    subject: "Quote: letterpress cards",
    tag: "work",
    read: true,
    inInbox: false,
    messages: [
      { from: daniel, ago: 3 * DAY + 2 * HOUR, body: "Hi Sam,\n\nHere’s the quote for 500 two-color letterpress cards on cotton stock: $640, ready ten working days after you approve the proof.\n\nDaniel\nBrooks Press" },
      { from: me(2), ago: 2 * DAY + 3 * HOUR, body: "Thanks, Daniel, this looks good. I have a couple of questions about the paper and the second color. I’ll call you tomorrow to go over the details.\n\nSam" },
    ],
  },
  // a question no one has answered (Today and Follow-ups: "No reply from Leo Martins")
  {
    account: 2,
    subject: "Raw files from the workshop shoot",
    tag: "work",
    read: true,
    inInbox: false,
    to: leo,
    messages: [
      { from: me(2), ago: 6 * DAY + 2 * HOUR, body: "Hi Leo,\n\nCould you send over the raw files from the workshop shoot? Priya would like one of them for the new homepage, ideally by the end of next week.\n\nThanks!\nSam" },
    ],
  },
  // an action in plain English ("Archive shipping notices older than a month"): old notices nobody archived
  ...[
    { ago: 34 * DAY, subject: "Your package is on its way", body: "Your order from Pantry Market has shipped. Tracking number PP4471 8820 9135. Estimated delivery: Friday." },
    { ago: 41 * DAY, subject: "Delivered: your package from Ember & Oak", body: "Your package was delivered at 2:14 PM and left at the front door." },
    { ago: 52 * DAY, subject: "Out for delivery today", body: "Your package from Pantry Market is out for delivery and should arrive by 6 PM." },
    { ago: 67 * DAY, subject: "Your package is on its way", body: "Your order from Northside Books has shipped. Tracking number PP4471 6203 1178. Estimated delivery: Tuesday." },
    { ago: 88 * DAY, subject: "Delivered: your package from Pantry Market", body: "Your package was delivered at 11:02 AM and handed to a resident." },
  ].map((n): Thread => ({ account: 0, subject: n.subject, tag: "shipping", read: true, messages: [{ from: { name: "Parcelpoint", email: "track@parcelpoint.com" }, ago: n.ago, body: n.body }] })),
  // the week's newsletters, for the digest (Fieldnotes and The Margin are in the curated inbox)
  letter({ name: "The Weekly Loop", email: "hello@weeklyloop.news" }, "weeklyloop.news", "Issue 88: Batteries, browsers and a very small phone", 110 * MIN, [
    "Good morning! Three things worth your coffee this week.",
    "A pilot line for solid-state batteries started shipping cells to two carmakers, the first outside a lab. Range claims are modest, but charging to 80% in twelve minutes is not.",
    "Two of the big browsers agreed on a shared format for saved tab groups, so a group made on one opens on the other.",
    "And a four-inch phone made it past its crowdfunding goal in a day. Small phones are back, at least for 40,000 people.",
  ]),
  letter({ name: "Kiln Notes", email: "studio@kilnnotes.com" }, "kilnnotes.com", "Winter glazes, and open studio nights are back", 5 * HOUR, [
    "The kilns are warm again. This month we’re testing three winter glazes: a smoky celadon, an iron red and a matte white that breaks brown on the edges.",
    "Open studio nights return on Wednesdays from November 4, 6 to 9 PM. Bring a piece to finish or just come and throw.",
    "Members get first pick of the new glaze tiles.",
  ]),
  letter({ name: "Small Batch", email: "letters@smallbatch.kitchen" }, "smallbatch.kitchen", "Five soups for the first cold week", 11 * HOUR, [
    "The first proper cold week calls for soup. Here are five we make on repeat, all under an hour.",
    "A roasted squash and miso soup, a white bean and rosemary one, a quick ribollita, a Thai-style carrot soup and a creamy potato and leek with crispy shallots.",
    "Each recipe makes four bowls and freezes well.",
  ]),
  letter({ name: "Type Tuesday", email: "news@typetuesday.xyz" }, "typetuesday.xyz", "Three new grotesques worth a look", 19 * HOUR, [
    "This week: three new grotesques from independent foundries, each with a different idea of warmth.",
    "One has ink traps that only show at small sizes, one comes with a true italic instead of a slanted roman, and one ships in twelve weights with a variable axis for optical size.",
    "We also look at how to pair them with a serif for long reading.",
  ]),
  letter({ name: "The Bridge Letter", email: "editor@bridgeletter.org" }, "bridgeletter.org", "New bike lanes on Alder, and the riverfront plan", 30 * HOUR, [
    "The protected bike lanes on Alder Street open next Monday, between 3rd and 12th.",
    "The city also published its draft plan for the riverfront: a wider path, two new piers and a night market on summer weekends. Comments are open until November 20.",
    "Plus: the library’s late hours are back for the winter.",
  ]),
  letter({ name: "Runway Weekly", email: "hi@runwayweekly.co" }, "runwayweekly.co", "How to price your first product", 40 * HOUR, [
    "Most first products are priced too low. This week we walk through three ways to set a price: from cost, from competitors and from the value to the customer.",
    "Our advice: start from value, test two prices on real buyers, and raise it before you think you should.",
    "Also inside: a pricing page checklist and five mistakes we see every week.",
  ]),
];

/** Senders whose older mail fills the archive (and the counts of "everything from …"). */
const BULK: { from: Address; tag: ThreadTag; list?: string; subjects: string[]; account: number; share: number }[] = [
  { from: fieldnotes, tag: "newsletter", list: "fieldnotes.email", account: 0, share: 3, subjects: ["Issue {n}: Small software", "Issue {n}: The case for less", "Issue {n}: Tools that last", "Issue {n}: Notes on focus"] },
  { from: outfitter, tag: "promo", list: "news.outfitter.co", account: 0, share: 4, subjects: ["Weekend only: free shipping", "New arrivals for the trail", "You left something in your cart", "{n}% off ends tonight"] },
  { from: { name: "Lumière Candles", email: "hello@lumierecandles.com" }, tag: "promo", list: "hello.lumierecandles.com", account: 0, share: 2, subjects: ["Back in stock: Fig & Cedar", "A gift guide for slow evenings", "{n}% off sitewide"] },
  { from: { name: "Hopper Rides", email: "receipts@hopperrides.com" }, tag: "receipt", account: 0, share: 4, subjects: ["Your {weekday} morning ride with Hopper", "Your {weekday} evening ride with Hopper", "Your {weekday} afternoon ride with Hopper"] },
  { from: { name: "Pantry Market", email: "orders@pantrymarket.com" }, tag: "receipt", account: 0, share: 3, subjects: ["Your Pantry Market order #{n}"] },
  { from: { name: "Parcelpoint", email: "track@parcelpoint.com" }, tag: "shipping", account: 0, share: 2, subjects: ["Your package is on its way", "Delivered: your package from Pantry Market"] },
  { from: { name: "Harbor Bank", email: "statements@harborbank.com" }, tag: "bank", account: 3, share: 1, subjects: ["Your statement is ready", "Payment received, thank you"] },
  { from: { name: "Forge", email: "notifications@forge.dev" }, tag: "dev", list: "atlas.northwind.forge.dev", account: 1, share: 6, subjects: ["[northwind/atlas] Fix flaky checkout test (#{n})", "[northwind/atlas] Speed up the sync engine (#{n})", "[northwind/atlas] Improve keyboard navigation (#{n})", "[northwind/atlas] Bump dependencies (#{n})"] },
  { from: { name: "Skylark Air", email: "trips@skylarkair.com" }, tag: "travel", account: 1, share: 1, subjects: ["Your trip to Tokyo is confirmed", "Your trip to Mexico City is confirmed", "Earn double miles this month"] },
  { from: { name: "Stayhaus", email: "bookings@stayhaus.com" }, tag: "travel", account: 3, share: 1, subjects: ["Booking confirmed: 3 nights in Kyoto", "How was your stay?"] },
  { from: { name: "The Margin", email: "letters@themargin.press" }, tag: "newsletter", list: "themargin.press", account: 0, share: 2, subjects: ["The grid, revisited", "On whitespace", "Letters from the studio"] },
  { from: priya, tag: "client", account: 2, share: 2, subjects: ["Product page feedback", "Workshop photos", "Next phase timeline"] },
  { from: elena, tag: "client", account: 2, share: 2, subjects: ["Kickoff notes", "Brand guidelines, final", "Quick question about the logo files"] },
  { from: jonah, tag: "work", account: 1, share: 3, subjects: ["Sprint notes", "Hiring: second designer", "Can you look at this before standup?"] },
  { from: theo, tag: "work", account: 1, share: 3, subjects: ["Roadmap sync", "Metrics for the board deck", "Offsite agenda"] },
  { from: marta, tag: "personal", account: 0, share: 2, subjects: ["Photos from the hike", "Book club: next pick", "Happy birthday!"] },
];

const FILLER = [
  "Quick note to follow up on this. Let me know what you think when you have a moment.",
  "Here is the summary from today. Most of it is good news, a couple of small things to look at.",
  "Thanks again for the help with this, it made a real difference.",
  "Sharing this in case it is useful. No rush on a reply.",
];

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const files = (t: Thread, i: number) => t.messages[i]!.attachments ?? (i === t.messages.length - 1 ? (t.attachments ?? []) : []);

function messagesOf(t: Thread, key: string, now: number): MockMessage[] {
  const rfc = (i: number) => `<${key}-${i}@showcase.terno.test>`;
  return t.messages.map((m, i): MockMessage => {
    const sent = m.from.email === ACCOUNTS[t.account]!.email;
    const other = t.messages.find((x) => x.from.email !== ACCOUNTS[t.account]!.email)?.from ?? m.from;
    return {
      accountIndex: t.account,
      providerMsgId: `${key}-${i}`,
      providerThreadId: key,
      rfcMessageId: rfc(i),
      inReplyTo: i ? rfc(i - 1) : null,
      references: Array.from({ length: i }, (_, j) => rfc(j)),
      from: m.from,
      to: [sent ? (t.to ?? other) : me(t.account)],
      cc: [],
      bcc: [],
      subject: i ? `Re: ${t.subject}` : t.subject,
      date: now - m.ago,
      snippet: m.body.replace(/\s+/g, " ").slice(0, 160),
      bodyText: m.body,
      bodyHtml: m.html ?? null,
      bodyState: "full",
      listId: t.list ?? null,
      bulk: t.bulk ?? false,
      isRead: sent || (t.read ?? false),
      isStarred: t.starred ?? false,
      inInbox: t.inInbox ?? true,
      isSent: sent,
      isDraft: false,
      isTrash: false,
      isSpam: false,
      hasAttachments: files(t, i).length > 0,
      size: m.body.length + (m.html?.length ?? 0),
      attachments: files(t, i),
      tag: t.tag,
      tags: [t.tag],
    };
  });
}

/**
 * `ai`: also the conversations the AI pictures need (shots/ai-shots.ts). Kept out of the other pictures, which show the
 * app without Pro: a client's change of plans and her payment, a scope decision, a promise and an unanswered question in
 * sent mail, and the week's newsletters.
 */
export function showcaseDataset(o: { now?: number; older?: number; ai?: boolean } = {}): MockDataset {
  const now = o.now ?? SHOWCASE_NOW;
  const random = prng(96);
  const messages: MockMessage[] = CURATED.flatMap((t, i) => messagesOf(t, `cur${i}`, now));
  if (o.ai) messages.push(...AI_EXTRAS.flatMap((t, i) => messagesOf(t, `ai${i}`, now)));
  const total = BULK.reduce((s, b) => s + b.share, 0);
  const older = o.older ?? 4000;
  const sameDay = new Set<string>();
  for (let i = 0; i < older; i++) {
    let pick = random() * total;
    const b = BULK.find((x) => (pick -= x.share) < 0) ?? BULK[0]!;
    const template = b.subjects[Math.floor(random() * b.subjects.length)]!.replace("{n}", String(Math.floor(random() * 380) + 20));
    // two days to two years back; most of it read and out of the inbox, as a tended mailbox is
    const ago = 2 * DAY + Math.floor(random() * random() * 730 * DAY);
    // a ride's receipt names the day it was taken (the day it's dated, in the shots' timezone)
    const day = new Date(now - ago).toLocaleDateString("en-US", { weekday: "long", timeZone: "America/Los_Angeles" });
    const subject = template.replace("{weekday}", day);
    const people = !b.list && !["receipt", "shipping", "bank", "travel"].includes(b.tag);
    const inInbox = random() < 0.04;
    // one of each a day: three "Sunday evening rides" on one Sunday reads as made up (the draws above still happen, so
    // what follows is as it was)
    const once = `${b.from.email} ${subject} ${new Date(now - ago).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })}`;
    if (sameDay.has(once)) continue;
    sameDay.add(once);
    messages.push(
      ...messagesOf(
        { account: b.account, subject, tag: b.tag, list: b.list, bulk: Boolean(b.list), read: true, inInbox, messages: [{ from: b.from, ago, body: people ? FILLER[i % FILLER.length]! : `${subject}. ${FILLER[i % FILLER.length]}` }] },
        `old${i}`,
        now,
      ),
    );
  }
  return { accounts: ACCOUNTS, categories: CATEGORIES, messages };
}

/** Snippets the shots show in ⌘; and Settings. */
export const SNIPPETS = [
  { id: "s_introcall1", name: "Intro call", subject: "", to: "", cc: "", bcc: "", bodyHtml: "<p>Thanks, {first_name}! I’d love to hear more. Does a 20-minute call this week work? Here are a few times:</p>", bodyText: "Thanks, {first_name}! I’d love to hear more. Does a 20-minute call this week work? Here are a few times:" },
  { id: "s_received1", name: "Received, thanks", subject: "", to: "", cc: "", bcc: "", bodyHtml: "<p>Got it, thank you {first_name}. I’ll take a look and get back to you by Friday.</p>", bodyText: "Got it, thank you {first_name}. I’ll take a look and get back to you by Friday." },
  { id: "s_invoice01", name: "Invoice follow-up", subject: "Invoice {invoice}", to: "", cc: "", bcc: "", bodyHtml: "<p>Hi {first_name}, a gentle nudge on the invoice from last month. Let me know if you need anything from me.</p>", bodyText: "Hi {first_name}, a gentle nudge on the invoice from last month. Let me know if you need anything from me." },
  { id: "s_ooo000001", name: "Out of office", subject: "", to: "", cc: "", bcc: "", bodyHtml: "<p>I’m away until Monday with limited access to email. For anything urgent, write to Jonah.</p>", bodyText: "I’m away until Monday with limited access to email. For anything urgent, write to Jonah." },
];
