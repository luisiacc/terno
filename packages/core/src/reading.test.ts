import { describe, expect, it } from "vitest";
import { readingWords, wordsIn } from "./reading";

/** The summary worker's floor (packages/backend/src/summaries.ts). */
const MIN_WORDS = 60;

const LINKEDIN_FOOTER = `----------------------------------------

This email was intended for Rafa Ortiz (Founder at Ortiz Legal)
Learn why we included this: https://www.linkedin.com/help/linkedin/answer/4788
You are receiving LinkedIn notification emails.

Unsubscribe: https://www.linkedin.com/comm/psettings/email-unsubscribe?lipi=urn%3Ali%3Apage%3Aemail
Help: https://www.linkedin.com/help/linkedin/answer/67?lang=en

© 2026 LinkedIn Corporation, 1000 West Maude Avenue, Sunnyvale, CA 94085.
LinkedIn and the LinkedIn logo are registered trademarks of LinkedIn.`;

const LINKEDIN = `1 new message awaits your response

Mara Velez
Abogada

View message: https://www.linkedin.com/comm/messaging/thread/2-YTk2ZjQ1NzQtOGRhZC00?midToken=AQH

Install LinkedIn Widgets
Stay updated at a glance
Add widget: https://www.linkedin.com/comm/widgets

${LINKEDIN_FOOTER}`;

const EXCERPT = `Hi Rafa, I reviewed the draft lease you sent over and I think clause 7 needs a second look before Friday.
The landlord's lawyer wants the deposit held in escrow, which changes who pays the interest on it.
Could you call me tomorrow morning so we can agree on an answer before they send the final version?
I'll keep my calendar open until ten.`;

const GITHUB = (comment: string) => `${comment}

—
Reply to this email directly, view it on GitHub: https://github.com/acme/api/pull/412#discussion_r1
You are receiving this because you were mentioned.Message ID: <acme/api/pull/412/review/1@github.com>`;

const REVIEW = `@rafa the retry loop in fetchQuota never backs off: when the quota service returns 503 we hit it again
immediately, and with forty workers that's a thundering herd. Please add exponential backoff with jitter
before this merges, cap it at thirty seconds, and add a test that drives three 503s in a row through the fake
server so we know the cap holds. I'd also rename the flag to quotaRetries so it matches the other settings.`;

const RECEIPT = `Thanks for your purchase

Order #AX-20931
Total: $18.40
Paid with Visa •••• 4242

View your receipt: https://shop.example/receipts/AX-20931

You received this email because you made a purchase at Shop Example. © 2026 Shop Example, Inc. All rights reserved.`;

const BILL = `Your November statement is ready

Statement date: Nov 24, 2026
Previous balance: $1,204.10
Payments: -$1,204.10
New charges: $318.92
Minimum due: $35.00
Due date: Dec 18, 2026

Pay now: https://bank.example/pay

Unsubscribe from statement emails: https://bank.example/prefs`;

const NEWSLETTER = `If you'd rather not get these, you can unsubscribe at any time from the link at the bottom.

This week we looked at why small grocery chains are quietly winning back customers from the big delivery apps. The
short answer is reliability: when a store's own drivers know the neighbourhood, orders arrive on time and complete,
and people notice. We talked to three owners about what it cost them to bring delivery in-house, how long it took to
pay off, and what they would do differently. One of them, who runs four shops outside Valencia, said the biggest
surprise was how much the drivers' feedback changed what the shops stock.`;

const HARD_WRAPPED = `Ana, quick update on the move. The truck is booked for Saturday morning and the
building manager says we can use the service lift from eight until noon. I still need
someone to pick up the keys from the old office on Friday afternoon, and the cleaners
want to know whether we're leaving the shelves. Let me know what you think about both.`;

const INCIDENT = `Incident update: EU write latency

Rollback complete at the edge.
EU writes are healthy again.
Queue depth is back under a thousand.
We are replaying the delayed webhooks now.
Customers may see duplicate deliveries for an hour.
Support has a macro ready for those tickets.
The root cause was a bad index migration.
We will publish the review on Thursday.
No customer data was lost.

View the incident: https://status.example/incidents/481`;

const ES_NOTICE = `Laura Gómez te ha enviado un mensaje

Ver mensaje: https://red.example/mensajes/88

Recibes este correo porque tienes activadas las notificaciones de mensajes.
Para darte de baja, visita tus preferencias de notificaciones.
© 2026 Red Example. Todos los derechos reservados.`;

describe("readingWords (plan 269)", () => {
  it("a notice is its template: nothing to read, in English and Spanish", () => {
    expect(wordsIn(LINKEDIN)).toBeGreaterThanOrEqual(MIN_WORDS);
    expect(readingWords(LINKEDIN)).toBe(0);
    expect(readingWords(ES_NOTICE)).toBe(0);
  });

  it("the same notice with what she wrote in it reads as what she wrote", () => {
    const withExcerpt = LINKEDIN.replace("Abogada\n", `Abogada\n\n${EXCERPT}\n`);
    expect(readingWords(withExcerpt)).toBe(wordsIn(EXCERPT));
    expect(wordsIn(EXCERPT)).toBeGreaterThanOrEqual(MIN_WORDS);
  });

  it("text with no lines (HTML-only mail as stored) counts as before: template and prose can't be told apart", () => {
    const flat = LINKEDIN.replace(/\s+/g, " ");
    expect(readingWords(flat)).toBe(wordsIn(flat));
  });

  it("short lines that are sentences are read: an incident update in one-line steps", () => {
    expect(readingWords(INCIDENT)).toBeGreaterThanOrEqual(MIN_WORDS);
  });

  it("a review notice with no comment has nothing to read; one with a real review does", () => {
    expect(readingWords(GITHUB("@rafa approved these changes."))).toBeLessThan(MIN_WORDS);
    expect(readingWords(GITHUB(REVIEW))).toBeGreaterThanOrEqual(MIN_WORDS);
  });

  it("a receipt with one total isn't reading; a statement with several amounts and dates counts whole", () => {
    expect(readingWords(RECEIPT)).toBeLessThan(MIN_WORDS);
    expect(readingWords(BILL)).toBe(wordsIn(BILL));
  });

  it("a footer phrase drops its line, never what follows it", () => {
    expect(readingWords(NEWSLETTER)).toBeGreaterThanOrEqual(MIN_WORDS);
  });

  it("plain text wrapped at 72 columns reads as its paragraph", () => {
    expect(readingWords(HARD_WRAPPED)).toBe(wordsIn(HARD_WRAPPED));
  });
});

describe("readingWords after the Codex review (plan 269)", () => {
  const padding = "Your account\nSettings\nHelp center\nSecurity\nPrivacy\nBilling\nTeam\nIntegrations\nAPI keys\nAudit log\nSupport\nStatus\nDocs\nBlog\nCareers\nPress\nPartners\nAffiliates\nCommunity\nEvents\nWebinars\nGuides\nTemplates\nChangelog\nRoadmap\nPricing\nEnterprise\nContact sales";

  it("two facts are two: a date then a time on the next line, or one timestamp with its zone", () => {
    expect(readingWords(`Delivered 24 Nov\n12:30 at the front door\n${padding}`)).toBe(0);
    expect(readingWords(`New sign-in to your account\n2026-11-24 14:30:20 +00:00\n${padding}`)).toBe(0);
  });

  it("an amount with a spaced currency sign is an amount", () => {
    const bill = `Your statement is ready\nPrevious balance: $ 18.40\nNew charges: $ 318.92\nMinimum due: $ 35.00\n${padding}`;
    expect(readingWords(bill)).toBe(wordsIn(bill));
  });

  it("a link's words never make its sentence a footer, and a link doesn't take the sentence's full stop", () => {
    const prose = "We moved your mailbox to the new region last night and every folder came across intact, including the shared ones. If anything looks out of place, the guide at https://help.example/unsubscribe-guide walks through the checks we ran. Replies to this message reach the migration team directly.";
    expect(readingWords(`Migration finished\n\n${prose}\n\nThanks`)).toBe(wordsIn(prose) - 1);
    expect(readingWords("Account update\nOpen the requested account details at https://help.example/account.\nThanks")).toBe(6);
  });

  it("a sentence followed by a button keeps counting: the button isn't its wrapped end", () => {
    const entry = "We restored writes across the impacted EU regions.";
    expect(readingWords(`${entry}\nView incident\n`.repeat(8))).toBe(8 * 8);
  });

  it("knows the common footer wordings: 'is intended for', a typographic apostrophe", () => {
    const fine = "This email is intended for the named recipient only and may contain confidential information; if you received it in error please delete it and notify the sender immediately without reading, copying or forwarding any part of it to anyone else.";
    expect(readingWords(`Your statement is ready\nView statement\n\n${fine}`)).toBe(0);
    expect(readingWords("Your statement is ready\nView statement\n\nYou’re receiving this because you have an account with Example Bank and chose to get statements by email every month.")).toBe(0);
  });

});
