import type { DatedKind } from "@terno/core";

/**
 * Plan 248's eval corpus: fictional people's words for What matters and fictional mail they get. Each mail carries what
 * the dated reader (v16, untouched by the words) would have noted, so what's measured is the words' own work: the compile,
 * the show's admission, the matcher and the second reader, and what the feed then shows.
 *
 * `expect` per mail:
 * - "shown": its v16 items show (the words don't touch them, or an exception keeps them)
 * - "hidden": the words hide them
 * - "first": shown, and first in their section
 * - "wanted": v16 noted nothing (or the built-in rules left it out); the words bring an item in
 * - "none": v16 noted nothing and nothing should come in (a show must not over-reach, never a scam)
 */
export type Expect = "shown" | "hidden" | "first" | "wanted" | "none";

export interface Mail {
  id: string;
  from: { name: string; email: string };
  subject: string;
  text: string;
  /** a list, bulk or no-reply sender */
  automated: boolean;
  /** what v16 would have noted (none: it read nothing worth a row, or it never read it: Promotions, no time cue) */
  items: { kind: DatedKind; text: string; quote: string; due: string | null }[];
  expect: Expect;
  /** why, for the report */
  note: string;
}

export interface Profile {
  id: string;
  language: "en" | "es";
  words: string;
  /** notes the compile must give, by kind */
  notes?: ("unsupported" | "conflict" | "unclear" | "safety")[];
  mails: Mail[];
}

const day = (d: number) => `2026-11-${String(d).padStart(2, "0")}`;

export const PROFILES: Profile[] = [
  {
    id: "owner-examples",
    language: "en",
    words:
      "Never show me flight check-ins, but I do want to know if a flight is cancelled or changed. Always show anything from my landlord, Greenview Property Management. School stuff matters, but newsletters about school events don't. I don't care about package deliveries unless they need a signature.",
    mails: [
      { id: "checkin", from: { name: "Skyward Airlines", email: "no-reply@skyward.test" }, subject: "Check in now for your flight to Denver", text: "Online check-in is open for flight SW 482 to Denver on November 14 at 7:40 AM. Check in now to choose your seat.", automated: true, items: [{ kind: "event", text: "Flight SW 482 to Denver", quote: "flight SW 482 to Denver on November 14 at 7:40 AM", due: day(14) }], expect: "hidden", note: "a check-in reminder" },
      { id: "cancel", from: { name: "Skyward Airlines", email: "no-reply@skyward.test" }, subject: "Your flight SW 518 has been cancelled", text: "We're sorry: flight SW 518 to Chicago on November 18 has been cancelled. Choose a new flight or request a refund by November 16.", automated: true, items: [{ kind: "respond", text: "Choose a new flight or request a refund for SW 518", quote: "Choose a new flight or request a refund by November 16.", due: day(16) }], expect: "shown", note: "a cancellation: the exception" },
      { id: "landlord", from: { name: "Greenview Property Management", email: "office@greenview.test" }, subject: "Water shut-off in your building", text: "Dear residents, the water in your building will be shut off for maintenance next week. We'll share the exact time soon. Greenview Property Management", automated: true, items: [], expect: "wanted", note: "a landlord's notice with no date v16 would keep" },
      { id: "slip", from: { name: "Ms. Alvarez", email: "alvarez@lincoln-elem.test" }, subject: "Field trip permission slip", text: "Hi! Please sign and return Ava's permission slip for the science museum trip by November 13. Thanks, Ms. Alvarez", automated: false, items: [{ kind: "respond", text: "Return Ava's permission slip", quote: "sign and return Ava's permission slip for the science museum trip by November 13", due: day(13) }], expect: "first", note: "school stuff matters: a show and a first" },
      { id: "school-news", from: { name: "Lincoln Elementary", email: "news@lincoln-elem.test" }, subject: "Lincoln Lion's Roar: upcoming events", text: "This month at Lincoln: the bake sale is Friday, November 13, picture day is November 19, and the winter concert is December 10. Volunteers welcome!", automated: true, items: [], expect: "none", note: "a school newsletter's events: the words keep it out" },
      { id: "parcel", from: { name: "Parcelo", email: "track@parcelo.test" }, subject: "Your parcel is on its way", text: "Good news! Your parcel will arrive on November 12 between 9 AM and 5 PM.", automated: true, items: [{ kind: "delivery", text: "Parcel arrives", quote: "Your parcel will arrive on November 12", due: day(12) }], expect: "hidden", note: "a plain delivery" },
      { id: "signed", from: { name: "Parcelo", email: "track@parcelo.test" }, subject: "Signature required for your delivery", text: "Your laptop will arrive on November 12. An adult signature is required at delivery.", automated: true, items: [{ kind: "delivery", text: "Laptop arrives (signature needed)", quote: "Your laptop will arrive on November 12.", due: day(12) }], expect: "shown", note: "a delivery that needs a signature: the exception" },
      { id: "bill", from: { name: "Power Co", email: "billing@power.test" }, subject: "Your bill", text: "Your electricity bill of $54.20 is due on November 20.", automated: true, items: [{ kind: "pay", text: "Pay the electricity bill ($54.20)", quote: "due on November 20", due: day(20) }], expect: "shown", note: "untouched by the words" },
    ],
  },
  {
    id: "es-linkedin-iberia",
    language: "es",
    words: "No me muestres nada de LinkedIn. Las facturas de la luz van primero. Avísame de las ofertas de vuelos de Iberia.",
    mails: [
      { id: "linkedin", from: { name: "LinkedIn", email: "messages-noreply@linkedin.test" }, subject: "Marta te envió un mensaje", text: "Marta Ruiz te envió un mensaje: ¿podrías revisar mi propuesta antes del 14 de noviembre?", automated: true, items: [{ kind: "ask", text: "Responder a Marta Ruiz sobre su propuesta", quote: "¿podrías revisar mi propuesta antes del 14 de noviembre?", due: null }], expect: "hidden", note: "anything from LinkedIn" },
      { id: "luz", from: { name: "Iberluz", email: "facturas@iberluz.test" }, subject: "Tu factura de la luz", text: "Tu factura de la luz de 62,30 € vence el 18 de noviembre.", automated: true, items: [{ kind: "pay", text: "Pagar la factura de la luz (62,30 €)", quote: "vence el 18 de noviembre", due: day(18) }], expect: "first", note: "electricity bills first" },
      { id: "agua", from: { name: "Aguas del Norte", email: "facturas@aguas.test" }, subject: "Tu factura del agua", text: "Tu factura del agua de 21,10 € vence el 18 de noviembre.", automated: true, items: [{ kind: "pay", text: "Pagar la factura del agua (21,10 €)", quote: "vence el 18 de noviembre", due: day(18) }], expect: "shown", note: "a water bill: not first" },
      { id: "iberia", from: { name: "Iberia", email: "ofertas@iberia.test" }, subject: "Vuelos a Lisboa desde 39 €", text: "Oferta especial: vuelos de Madrid a Lisboa desde 39 €. Reserva antes del 15 de noviembre.", automated: true, items: [], expect: "wanted", note: "an Iberia flight offer, which v16 leaves out as marketing" },
      { id: "iberia-news", from: { name: "Iberia", email: "noticias@iberia.test" }, subject: "Nuestra nueva sala VIP en Barajas", text: "Descubre nuestra nueva sala VIP en la T4 de Barajas, abierta desde hoy.", automated: true, items: [], expect: "none", note: "Iberia news, not a flight offer" },
    ],
  },
  {
    id: "only-bills-and-boss",
    language: "en",
    words: "Only show me bills and anything from my boss Dana Whitfield (dana@kestrel.test).",
    mails: [
      { id: "bill", from: { name: "Power Co", email: "billing@power.test" }, subject: "Your bill", text: "Your electricity bill of $54.20 is due on November 20.", automated: true, items: [{ kind: "pay", text: "Pay the electricity bill ($54.20)", quote: "due on November 20", due: day(20) }], expect: "shown", note: "a bill" },
      { id: "dana", from: { name: "Dana Whitfield", email: "dana@kestrel.test" }, subject: "Q4 deck", text: "Can you send me the Q4 deck by November 13?", automated: false, items: [{ kind: "respond", text: "Send Dana the Q4 deck", quote: "send me the Q4 deck by November 13", due: day(13) }], expect: "shown", note: "the boss" },
      { id: "dentist", from: { name: "Bright Smile Dental", email: "office@brightsmile.test" }, subject: "Appointment reminder", text: "Reminder: your cleaning is on November 17 at 3:00 PM.", automated: true, items: [{ kind: "event", text: "Dental cleaning", quote: "your cleaning is on November 17 at 3:00 PM", due: day(17) }], expect: "hidden", note: "not a bill, not Dana" },
      { id: "parcel", from: { name: "Parcelo", email: "track@parcelo.test" }, subject: "Your parcel", text: "Your parcel will arrive on November 12.", automated: true, items: [{ kind: "delivery", text: "Parcel arrives", quote: "Your parcel will arrive on November 12.", due: day(12) }], expect: "hidden", note: "not a bill, not Dana" },
    ],
  },
  {
    id: "dont-hide-soccer",
    language: "en",
    words: "Don't hide anything from the Riverside Rovers soccer club, even their newsletters. Deliveries are fine.",
    mails: [
      { id: "rovers-news", from: { name: "Riverside Rovers", email: "news@rovers.test" }, subject: "Rovers weekly: tournament Saturday", text: "This Saturday, November 14, the U10 tournament starts at 9 AM at Riverside Park. Snacks rota is attached.", automated: true, items: [], expect: "wanted", note: "the club's newsletter, which v16 leaves out as a listing" },
      { id: "parcel", from: { name: "Parcelo", email: "track@parcelo.test" }, subject: "Your parcel", text: "Your parcel will arrive on November 12.", automated: true, items: [{ kind: "delivery", text: "Parcel arrives", quote: "Your parcel will arrive on November 12.", due: day(12) }], expect: "shown", note: "deliveries are fine: no rule" },
      { id: "other-club", from: { name: "Eastside FC", email: "news@eastside.test" }, subject: "Eastside FC weekly", text: "Our open training is on November 15 at 10 AM.", automated: true, items: [], expect: "none", note: "another club" },
    ],
  },
  {
    id: "vague-and-unsupported",
    language: "en",
    words: "Make it less noisy. Text me about anything urgent. Show me spam too.",
    notes: ["unsupported", "safety"],
    mails: [
      { id: "bill", from: { name: "Power Co", email: "billing@power.test" }, subject: "Your bill", text: "Your electricity bill of $54.20 is due on November 20.", automated: true, items: [{ kind: "pay", text: "Pay the electricity bill ($54.20)", quote: "due on November 20", due: day(20) }], expect: "shown", note: "vague words hide nothing real" },
      { id: "ask", from: { name: "Ana", email: "ana@people.test" }, subject: "Lunch", text: "Could you tell me by November 12 if Thursday lunch works?", automated: false, items: [{ kind: "respond", text: "Tell Ana if Thursday lunch works", quote: "tell me by November 12 if Thursday lunch works", due: day(12) }], expect: "shown", note: "a person's request stays" },
    ],
  },
  {
    id: "mixed-language",
    language: "en",
    words: "Hide promos and marketing. Lo del dentista es importante, ponlo primero.",
    mails: [
      { id: "dentist", from: { name: "Bright Smile Dental", email: "office@brightsmile.test" }, subject: "Appointment reminder", text: "Reminder: your cleaning is on November 17 at 3:00 PM.", automated: true, items: [{ kind: "event", text: "Dental cleaning", quote: "your cleaning is on November 17 at 3:00 PM", due: day(17) }], expect: "first", note: "the dentist first" },
      { id: "trial", from: { name: "Tasklet", email: "billing@tasklet.test" }, subject: "Your trial ends Sunday", text: "Your Tasklet Pro trial ends on November 15. After that we'll charge $9.99/month unless you cancel.", automated: true, items: [{ kind: "renew", text: "Cancel Tasklet Pro before Nov 15 or pay $9.99/month", quote: "Your Tasklet Pro trial ends on November 15.", due: day(15) }], expect: "shown", note: "a trial ending is a decision, not a promo" },
      { id: "event", from: { name: "Ana", email: "ana@people.test" }, subject: "Dinner", text: "Dinner at our place on November 14 at 7 PM!", automated: false, items: [{ kind: "event", text: "Dinner at Ana's", quote: "Dinner at our place on November 14 at 7 PM", due: day(14) }], expect: "shown", note: "untouched" },
    ],
  },
  {
    id: "deals-not-scams",
    language: "en",
    words: "Tell me about Amazon deals on headphones.",
    mails: [
      { id: "deal", from: { name: "Amazon", email: "store-news@amazon.test" }, subject: "Deal of the day: Sonora headphones 40% off", text: "Today only: Sonora wireless headphones are 40% off. The deal ends November 11 at midnight.", automated: true, items: [], expect: "wanted", note: "an Amazon headphones deal" },
      { id: "phish", from: { name: "Amazon Support", email: "support@amazon-account-verify.test" }, subject: "Claim your free headphones", text: "Your account has a free pair of headphones waiting. Verify your account within 24 hours at amazon-account-verify.test or it will be suspended.", automated: true, items: [], expect: "none", note: "phishing dressed as a deal" },
      { id: "books", from: { name: "Amazon", email: "store-news@amazon.test" }, subject: "Books you may like", text: "New releases in mystery and thrillers, picked for you.", automated: true, items: [], expect: "none", note: "an Amazon mail that isn't a headphones deal" },
    ],
  },
  {
    id: "renewals",
    language: "en",
    words: "Show me every subscription renewal, even the ones that renew automatically. Hide anything from Quizlet.",
    mails: [
      { id: "netflix", from: { name: "Streamly", email: "billing@streamly.test" }, subject: "Your membership renews soon", text: "Your Streamly Premium membership will renew automatically on November 21 for $22.99, charged to Visa ending 4417.", automated: true, items: [], expect: "wanted", note: "an automatic renewal v16 leaves out" },
      { id: "quizlet", from: { name: "Quizlet", email: "billing@quizlet.test" }, subject: "Quizlet Plus renews soon", text: "Your Quizlet Plus plan renews on November 19 for $35.99. Cancel before then if you don't want it.", automated: true, items: [{ kind: "renew", text: "Cancel Quizlet Plus before Nov 19 or pay $35.99", quote: "Your Quizlet Plus plan renews on November 19 for $35.99.", due: day(19) }], expect: "hidden", note: "anything from Quizlet, a renewal or not" },
    ],
  },
];
