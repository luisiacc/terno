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
  { kind: "imap", email: "sam.rivera@icloud.com", displayName: "iCloud", color: "cyan", ownerName: ME, weight: 0.1 },
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
    attachments: [{ filename: "homepage-concepts-v2.pdf", mime: "application/pdf", size: 4_812_000 }],
    messages: [
      {
        from: me(2),
        ago: 26 * HOUR,
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
    attachments: [{ filename: "lisbon-itinerary.pdf", mime: "application/pdf", size: 312_000 }],
    messages: [
      { from: jonah, ago: 70 * MIN, body: "Flights are booked for everyone. We land Tuesday at 11:40, hotel is ten minutes from the studio. Itinerary attached, shout if anything looks off." },
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

/** Senders whose older mail fills the archive (and the counts of "everything from …"). */
const BULK: { from: Address; tag: ThreadTag; list?: string; subjects: string[]; account: number; share: number }[] = [
  { from: fieldnotes, tag: "newsletter", list: "fieldnotes.email", account: 0, share: 3, subjects: ["Issue {n}: Small software", "Issue {n}: The case for less", "Issue {n}: Tools that last", "Issue {n}: Notes on focus"] },
  { from: outfitter, tag: "promo", list: "news.outfitter.co", account: 0, share: 4, subjects: ["Weekend only: free shipping", "New arrivals for the trail", "You left something in your cart", "{n}% off ends tonight"] },
  { from: { name: "Lumière Candles", email: "hello@lumierecandles.com" }, tag: "promo", list: "hello.lumierecandles.com", account: 0, share: 2, subjects: ["Back in stock: Fig & Cedar", "A gift guide for slow evenings", "{n}% off sitewide"] },
  { from: { name: "Hopper Rides", email: "receipts@hopperrides.com" }, tag: "receipt", account: 0, share: 4, subjects: ["Your Monday morning ride with Hopper", "Your Friday evening ride with Hopper", "Your Sunday afternoon ride with Hopper"] },
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
      to: [sent ? other : me(t.account)],
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
      hasAttachments: Boolean(t.attachments?.length) && i === t.messages.length - 1,
      size: m.body.length + (m.html?.length ?? 0),
      attachments: i === t.messages.length - 1 ? (t.attachments ?? []) : [],
      tag: t.tag,
      tags: [t.tag],
    };
  });
}

export function showcaseDataset(o: { now?: number; older?: number } = {}): MockDataset {
  const now = o.now ?? SHOWCASE_NOW;
  const random = prng(96);
  const messages: MockMessage[] = CURATED.flatMap((t, i) => messagesOf(t, `cur${i}`, now));
  const total = BULK.reduce((s, b) => s + b.share, 0);
  const older = o.older ?? 4000;
  for (let i = 0; i < older; i++) {
    let pick = random() * total;
    const b = BULK.find((x) => (pick -= x.share) < 0) ?? BULK[0]!;
    const subject = b.subjects[Math.floor(random() * b.subjects.length)]!.replace("{n}", String(Math.floor(random() * 380) + 20));
    // two days to two years back; most of it read and out of the inbox, as a tended mailbox is
    const ago = 2 * DAY + Math.floor(random() * random() * 730 * DAY);
    const people = !b.list && !["receipt", "shipping", "bank", "travel"].includes(b.tag);
    messages.push(
      ...messagesOf(
        { account: b.account, subject, tag: b.tag, list: b.list, bulk: Boolean(b.list), read: true, inInbox: random() < 0.04, messages: [{ from: b.from, ago, body: people ? FILLER[i % FILLER.length]! : `${subject}. ${FILLER[i % FILLER.length]}` }] },
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
