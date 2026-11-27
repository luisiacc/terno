import type { IncomingMessage, MailStore } from "@terno/store";

/**
 * Plan 279 in `pnpm dev:demo-ai` (plan 167): conversations whose summary has a "since". Each has mail already read from
 * someone else, then new mail that changes something, unread, so opening it and asking for a summary shows the new view
 * (the reader's snapshot, by hand: nothing here is live mail). One whose new mail changes nothing ("¡Gracias, recibida!")
 * shows the whole summary alone. Dated just below the Inbox's top six (14:58 and newer), so the conversations plan 167's
 * guide names keep their places.
 */
interface Line {
  from: { name: string; email: string } | "me";
  /** when, in minutes before 15:30 UTC on 22 October 2026 (the demo mailbox's newest mail) */
  ago: number;
  read: boolean;
  text: string;
}

interface Conversation {
  key: string;
  /**
   * The demo account it's on, by address (plan 289): Acme Studio's English, the Spanish ones on the Spanish account
   * (Freelance), where they test Spanish summaries and replies. By address, as the stores list accounts in the user's order.
   */
  account: string;
  subject: string;
  /** everyone else on it, for the To line of your own mail */
  with: { name: string; email: string }[];
  lines: Line[];
}

const DAY = 24 * 60;
const ACME = "luis@acme.studio";
const FREELANCE = "hola@luiscordero.dev";
const priya = { name: "Priya Shah", email: "priya.shah@acme.studio" };
const mariana = { name: "Mariana Cordero", email: "mariana.cordero@gmail.com" };
const diego = { name: "Diego Cordero", email: "diego.cordero@gmail.com" };
const andres = { name: "Andrés Villalobos", email: "andres@lumbrecafe.mx" };
const sofia = { name: "Sofía Treviño", email: "sofia.trevino@acme.studio" };
const laura = { name: "Laura Méndez", email: "laura.mendez@acme.studio" };

export const DEMO_SINCE: readonly Conversation[] = [
  {
    key: "offsite",
    account: ACME,
    subject: "Venue for the team offsite",
    with: [priya],
    lines: [
      { from: priya, ago: 2 * DAY + 200, read: true, text: "Hi Luis,\n\nWe have two options for the team offsite on Thursday 6 November: the loft in Roma Norte (up to 12 people, 18,000 MXN) or Casa Lamm (up to 20 people, 24,500 MXN). Both include lunch and a projector.\n\nWhich one do you prefer? I'd like to book by Friday 24 October.\n\nPriya" },
      { from: "me", ago: DAY + 300, read: true, text: "Hi Priya,\n\nLet's go with the Roma Norte loft, we're 11 with the new designer.\n\nThanks,\nLuis" },
      { from: priya, ago: 38, read: false, text: "Hi Luis,\n\nBad news: the Roma Norte loft cancelled on us this morning, they double-booked the 6th. Casa Lamm still has the date and agreed to 21,000 MXN for our group. I've put a hold on it until Monday 27 October.\n\nCan you confirm Casa Lamm by then, so I can pay the deposit?\n\nPriya" },
    ],
  },
  {
    key: "cena",
    account: FREELANCE,
    subject: "Cena de cumpleaños de papá",
    with: [mariana, diego],
    lines: [
      { from: mariana, ago: 3 * DAY, read: true, text: "¡Hola!\n\n¿Hacemos la cena de cumpleaños de papá el sábado 25 en mi casa a las 8? Yo pongo el pastel. Luis, ¿tú traes el vino?\n\nMariana" },
      { from: "me", ago: 3 * DAY - 90, read: true, text: "¡Va! Llevo dos botellas de tinto.\n\nLuis" },
      { from: mariana, ago: 41, read: false, text: "Cambio de planes: papá prefiere comer que cenar, así que lo movemos al domingo 26 a las 2 en El Cardenal de San Ángel. Ya reservé para 8. El vino lo ponen ahí, Luis, ya no hace falta que lleves.\n\nMariana" },
      { from: diego, ago: 35, read: false, text: "Perfecto, yo llego directo al restaurante. ¿Alguien puede pasar por la abuela? Yo no alcanzo.\n\nDiego" },
    ],
  },
  {
    key: "contrato",
    account: FREELANCE,
    subject: "Contrato con Lumbre Café",
    with: [andres, sofia],
    lines: [
      { from: andres, ago: 7 * DAY, read: true, text: "Hola Luis,\n\nTe comparto el borrador del contrato para el rediseño de la tienda en línea: 14 semanas, 380,000 MXN en cuatro pagos, con pago a 30 días de cada factura y una penalización de 10% por retraso en la entrega.\n\nQuedo atento a sus comentarios.\n\nAndrés" },
      { from: "me", ago: 7 * DAY - 120, read: true, text: "Gracias, Andrés. Sofía, de legal, lo revisa esta semana y te escribimos.\n\nLuis" },
      { from: sofia, ago: 6 * DAY, read: true, text: "Hola a ambos,\n\nYa lo estoy revisando. Tengo dudas sobre el plazo de pago y la penalización; les escribo en cuanto termine.\n\nSofía" },
      { from: sofia, ago: 47, read: false, text: "Hola Andrés,\n\nLegal aprobó el contrato con dos cambios: el pago pasa a 45 días de cada factura (no 30) y la penalización por retraso baja a 5%. Lo demás queda igual.\n\nSofía" },
      { from: andres, ago: 44, read: false, text: "Hola Sofía, Luis,\n\nAceptamos los dos cambios. ¿Firmamos el martes 28 de octubre a las 11 en sus oficinas? Llevo los dos ejemplares impresos.\n\nAndrés" },
    ],
  },
  {
    key: "factura",
    account: FREELANCE,
    subject: "Factura de septiembre",
    with: [laura],
    lines: [
      { from: laura, ago: 2 * DAY, read: true, text: "Hola Luis,\n\n¿Me mandas la factura de septiembre del proyecto de Lumbre? Cierro el mes este viernes.\n\nLaura" },
      { from: "me", ago: DAY + 60, read: true, text: "Hola Laura,\n\nTe la mando adjunta, son 95,000 MXN más IVA.\n\nLuis" },
      { from: laura, ago: 46, read: false, text: "¡Gracias, recibida!\n\nLaura" },
    ],
  },
];

const NEWEST = Date.UTC(2026, 9, 22, 15, 30);
const SEEDED_KEY = "demo.sinceSeeded";

/** Once per profile: true when it added them. */
export async function seedDemoSince(store: MailStore): Promise<boolean> {
  if (await store.settings.get<boolean>(SEEDED_KEY, false)) return false;
  const accounts = await store.accounts.list();
  const of = (email: string) => accounts.find((a) => a.email === email);
  if (!DEMO_SINCE.every((c) => of(c.account))) return false;
  const messages: IncomingMessage[] = [];
  for (const c of DEMO_SINCE) {
    const account = of(c.account)!;
    // who writes: the account's sender name (the demo's owner), never its label ("Freelance")
    const me = { name: account.senderName || "Luis Cordero", email: account.email };
    const refs: string[] = [];
    c.lines.forEach((line, i) => {
      const mine = line.from === "me";
      const from = mine ? me : (line.from as { name: string; email: string });
      const rfc = `<demo-since-${c.key}-${i}@terno.test>`;
      const to = mine ? c.with : [me, ...c.with.filter((p) => p.email !== from.email)];
      messages.push({
        accountId: account.id,
        providerMsgId: `demo-since-${c.key}-${i}`,
        providerThreadId: `demo-since-${c.key}`,
        rfcMessageId: rfc,
        inReplyTo: refs.at(-1) ?? null,
        references: [...refs],
        from,
        replyTo: [],
        to,
        cc: [],
        bcc: [],
        subject: i ? `Re: ${c.subject}` : c.subject,
        date: NEWEST - line.ago * 60_000,
        snippet: line.text.replace(/\s+/g, " ").trim().slice(0, 140),
        bodyText: line.text,
        bodyHtml: null,
        bodyState: "full",
        listId: null,
        isRead: mine || line.read,
        isStarred: false,
        inInbox: !mine,
        isSent: mine,
        isDraft: false,
        isTrash: false,
        isSpam: false,
        hasAttachments: false,
        // Gmail's labels on a Gmail account only (Freelance is IMAP: inInbox and isRead say it)
        ...(account.kind === "gmail" ? { gmailLabels: mine ? ["SENT"] : line.read ? ["INBOX", "CATEGORY_PERSONAL"] : ["INBOX", "CATEGORY_PERSONAL", "UNREAD"] } : {}),
        size: line.text.length,
      });
      refs.push(rfc);
    });
  }
  await store.sync.ingest(messages, { applyFilters: false, now: NEWEST, classifier: null });
  await store.settings.set(SEEDED_KEY, true);
  return true;
}
