// A local stand-in for a capable model, in Ollama's shape (plan 161): the rating's AI screens and the e2e specs answer
// from here, so every round reads the same words, costs nothing and stays on this machine. Plain JS: a round's frozen
// runtime has no TypeScript. Every answer is built from the request (its names, subjects, dates and labels) and is the
// same for the same request. An unknown task is a 500 naming it, so a new one can't pass silently.
//   import { startModelStub } from "./model-stub.mjs"; const stub = await startModelStub(); … stub.url … await stub.close();
import { createServer } from "node:http";

export const MODELS = [{ name: "qwen3:8b", size: 5_225_000_000 }, { name: "llama3.2:3b", size: 2_019_000_000 }];
export const MODEL = MODELS[0].name;

// ─── reading a request ───────────────────────────────────────────────────────

const text = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p.text ?? "").join("") : "");
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const DAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAYS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const DAY = 86_400_000;

/** Noon UTC of a YYYY-MM-DD (or an ISO time): a day, whatever the zone. */
const dayOf = (iso) => {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], 12) : null;
};
/** "Friday 23 October", "viernes 23 de octubre": a weekday never stands without its date. */
export const longDate = (ms, es = false) => {
  const d = new Date(ms);
  return es ? `${DAYS_ES[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTHS_ES[d.getUTCMonth()]}` : `${DAYS_EN[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_EN[d.getUTCMonth()]}`;
};
const shortDate = (ms, es = false) => {
  const d = new Date(ms);
  return es ? `${d.getUTCDate()} de ${MONTHS_ES[d.getUTCMonth()]}` : `${d.getUTCDate()} ${MONTHS_EN[d.getUTCMonth()]}`;
};
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
/** The first `weekday` after the day `from` (Friday seen on a Friday is the next one). */
const nextWeekday = (from, weekday) => from + (((weekday - new Date(from).getUTCDay() + 7) % 7) || 7) * DAY;

/** "Isabella Torres (Globex) <isabella@globex.mx>" → "Isabella Torres", and its first name. */
export function person(from) {
  const raw = (from ?? "").replace(/<[^>]*>/, "").replace(/\([^)]*\)/, "").replace(/"/g, "").trim();
  const name = raw || (from ?? "").replace(/[<>]/g, "").split("@")[0] || "Someone";
  return { name, first: name.split(/\s+/)[0] };
}

/** A tag's attributes, quoted values and all: a sender's "<address>" sits inside one. */
const TAG_ATTRS = String.raw`((?:[^>"]|"[^"]*")*)`;
const blocksOf = (prompt, tag) => [...prompt.matchAll(new RegExp(String.raw`<${tag} ${TAG_ATTRS}>\n([\s\S]*?)\n</${tag}>`, "g"))].map((m) => ({ head: m[1], body: m[2] }));
const attr = (head, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(head)?.[1];
const isSpanish = (s) => /[¿¡ñ]|\b(hola|que|los|las|para|por|gracias|tienes|podrías|quedo|una|del|el|la)\b/i.test(s);
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const sentencesOf = (body) =>
  body
    .split(/\n\s*>/)[0] // quoted history isn't this message's words
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(hi|hey|hello|hola|buen día|qué tal|¡hola)\b/i.test(l) && !/,$/.test(l) && !/^[\p{L}]+$/u.test(l))
    .flatMap((l) => l.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);

// ─── the demo's words, as a reader would put them ──────────────────────────────
// What a capable model writes about each sentence the demo mailbox is made of (packages/mock-data/src/banks.ts): `says`
// is what the sender did, in the third person; `ask` is what it asks of the reader; `reply` is how a reply answers it.
// `at(date)` resolves a relative day against the message's own date. A sentence not listed is quoted as written.

const KNOWN = new Map(
  Object.entries({
    "Te comparto la información que platicamos ayer en la reunión.": { says: (d) => ({ en: `shared the notes from the meeting on ${longDate(d - DAY)}`, es: `compartió la información de la reunión del ${longDate(d - DAY, true)}` }), reply: { en: "Thanks for the notes from the meeting.", es: "Gracias por la información de la reunión." } },
    "¿Podrías revisar el documento antes del viernes?": { ask: (d) => ({ kind: "action", en: `Review the document before ${longDate(nextWeekday(d, 5))}`, es: `Revisar el documento antes del ${longDate(nextWeekday(d, 5), true)}` }), reply: { en: "[Whether you can review the document before Friday.]", es: "[Si puedes revisar el documento antes del viernes.]" }, words: ["document", "documento", "review", "revisar"] },
    "El cliente pidió algunos cambios en la sección de precios.": { says: () => ({ en: "says the client asked for changes to the pricing section", es: "dice que el cliente pidió cambios en la sección de precios" }), reply: { en: "Noted on the pricing changes.", es: "Tomo nota de los cambios en precios." }, words: ["pricing", "precios", "client", "cliente"] },
    "Adjunto la factura correspondiente al mes de marzo.": { says: () => ({ en: "sent the invoice for March", es: "envió la factura de marzo" }), reply: { en: "Thanks for the March invoice.", es: "Gracias por la factura de marzo." }, words: ["invoice", "factura", "march", "marzo"] },
    "Quedo atento a tus comentarios.": { ask: (d, name) => ({ kind: "action", en: `Send ${name} your comments`, es: `Enviarle tus comentarios a ${name}` }), reply: { en: "[Your comments.]", es: "[Tus comentarios.]" } },
    "Creo que podemos mover la entrega una semana sin problema.": { says: () => ({ en: "thinks the delivery can move a week without trouble", es: "cree que la entrega puede moverse una semana sin problema" }), reply: { en: "[Whether a week's delay works for you.]", es: "[Si te sirve mover la entrega una semana.]" }, words: ["delivery", "entrega", "deadline", "week"] },
    "La reunión será por videollamada a las 10 de la mañana.": { says: () => ({ en: "says the meeting will be a video call at 10 in the morning", es: "dice que la reunión será por videollamada a las 10 de la mañana" }), reply: { en: "Thanks for the details of the call.", es: "Gracias por los detalles de la videollamada." }, words: ["meeting", "reunión", "call", "videollamada"] },
    "Ya subí los archivos a la carpeta compartida.": { says: () => ({ en: "uploaded the files to the shared folder", es: "subió los archivos a la carpeta compartida" }), reply: { en: "Thanks for uploading the files.", es: "Gracias por subir los archivos." }, words: ["files", "archivos", "folder", "carpeta"] },
    "Me parece muy buena idea, avancemos con esa opción.": { says: () => ({ en: "agreed to go ahead with that option", es: "aceptó avanzar con esa opción" }), reply: { en: "Great, let's go ahead.", es: "Perfecto, avancemos." } },
    "Necesitamos confirmar el presupuesto con finanzas.": { says: () => ({ en: "says the budget still needs confirming with finance", es: "dice que falta confirmar el presupuesto con finanzas" }), reply: { en: "Noted on the budget.", es: "Tomo nota del presupuesto." }, words: ["budget", "presupuesto", "finance", "finanzas"] },
    "El diseño quedó increíble, felicita al equipo de mi parte.": { says: () => ({ en: "loved the design and asked you to congratulate the team", es: "le encantó el diseño y pide felicitar al equipo" }), reply: { en: "Thanks, the team will be glad to hear it.", es: "Gracias, al equipo le dará gusto saberlo." }, words: ["design", "diseño"] },
    "Hubo un problema con el pago, ¿lo puedes revisar?": { says: () => ({ en: "reports a problem with the payment", es: "reporta un problema con el pago" }), ask: () => ({ kind: "action", en: "Check what went wrong with the payment", es: "Revisar el problema con el pago" }), reply: { en: "[Whether you can look at the payment, and when.]", es: "[Si puedes revisar el pago y cuándo.]" }, words: ["payment", "pago", "pay"] },
    "Mañana te llamo para ver los detalles.": { says: (d) => ({ en: `plans to call you on ${longDate(d + DAY)} to go over the details`, es: `te llamará el ${longDate(d + DAY, true)} para ver los detalles` }), reply: { en: "Talk then.", es: "Hablamos entonces." }, words: ["call", "llamo", "llamada"] },
    "La canción que te mandé es la del concierto.": { says: () => ({ en: "says the song they sent is the one from the concert", es: "dice que la canción que mandó es la del concierto" }), reply: { en: "Thanks for the song.", es: "Gracias por la canción." }, words: ["song", "canción", "concert", "concierto"] },
    "Gracias por la paciencia, sé que fue una semana pesada.": { says: () => ({ en: "thanked you for your patience after a hard week", es: "agradeció tu paciencia tras una semana pesada" }), reply: { en: "", es: "" } },
    "Te recuerdo que el contrato vence el próximo mes.": { says: (d) => ({ en: `reminds you the contract ends in ${MONTHS_EN[(new Date(d).getUTCMonth() + 1) % 12]}`, es: `recuerda que el contrato vence en ${MONTHS_ES[(new Date(d).getUTCMonth() + 1) % 12]}` }), ask: (d) => ({ kind: "date", en: `The contract ends in ${MONTHS_EN[(new Date(d).getUTCMonth() + 1) % 12]}`, es: `El contrato vence en ${MONTHS_ES[(new Date(d).getUTCMonth() + 1) % 12]}` }), reply: { en: "Thanks for the reminder about the contract.", es: "Gracias por el recordatorio del contrato." }, words: ["contract", "contrato"] },
    "¿Tienes disponibilidad el jueves para una llamada rápida?": { ask: (d) => ({ kind: "question", en: `Are you free for a quick call on ${longDate(nextWeekday(d, 4))}?`, es: `¿Tienes disponibilidad el ${longDate(nextWeekday(d, 4), true)} para una llamada?` }), reply: { en: "[Whether you're free for the call, and when.]", es: "[Si puedes el jueves y a qué hora.]" }, words: ["call", "llamada", "thursday", "jueves"] },
    "Encontré un error en la búsqueda del sitio, ya abrí un ticket.": { says: () => ({ en: "found a bug in the site's search and opened a ticket", es: "encontró un error en la búsqueda del sitio y abrió un ticket" }), reply: { en: "Thanks for filing the ticket.", es: "Gracias por abrir el ticket." }, words: ["bug", "error", "search", "búsqueda", "ticket"] },
    "Las fotos del evento están en el enlace de abajo.": { says: () => ({ en: "shared a link to the photos from the event", es: "compartió el enlace a las fotos del evento" }), reply: { en: "Thanks for the photos.", es: "Gracias por las fotos." }, words: ["photos", "fotos", "event", "evento"] },
    "Ojo con las fechas del calendario, cambiaron otra vez.": { says: () => ({ en: "warns that the calendar dates changed again", es: "avisa que las fechas del calendario cambiaron otra vez" }), reply: { en: "Thanks for the heads-up on the dates.", es: "Gracias por el aviso de las fechas." }, words: ["calendar", "calendario", "dates", "fechas"] },
    "Following up on our conversation from yesterday.": { says: (d) => ({ en: `followed up on your conversation of ${longDate(d - DAY)}`, es: `retomó la conversación del ${longDate(d - DAY, true)}` }), reply: { en: "Thanks for following up.", es: "Gracias por el seguimiento." } },
    "Could you take a look at the draft before Friday?": { ask: (d) => ({ kind: "action", en: `Review the draft before ${longDate(nextWeekday(d, 5))}`, es: `Revisar el borrador antes del ${longDate(nextWeekday(d, 5), true)}` }), reply: { en: "[Whether you can look at the draft before Friday.]", es: "[Si puedes revisar el borrador antes del viernes.]" }, words: ["draft", "borrador", "review"] },
    "The client asked for a few changes to the pricing page.": { says: () => ({ en: "says the client wants a few changes to the pricing page", es: "dice que el cliente quiere cambios en la página de precios" }), reply: { en: "Noted on the pricing page.", es: "Tomo nota de la página de precios." }, words: ["pricing", "precios", "client", "cliente"] },
    "I've attached the invoice for this month.": { says: (d) => ({ en: `sent the invoice for ${MONTHS_EN[new Date(d).getUTCMonth()]}`, es: `envió la factura de ${MONTHS_ES[new Date(d).getUTCMonth()]}` }), reply: { en: "Thanks for the invoice.", es: "Gracias por la factura." }, words: ["invoice", "factura"] },
    "Let me know what you think.": { ask: (d, name) => ({ kind: "action", en: `Tell ${name} what you think`, es: `Decirle a ${name} qué opinas` }), reply: { en: "[What you think.]", es: "[Tu opinión.]" } },
    "We can push the deadline by a week if needed.": { says: () => ({ en: "offers to push the deadline by a week if needed", es: "ofrece mover la fecha límite una semana si hace falta" }), reply: { en: "[Whether you need the extra week.]", es: "[Si necesitas la semana extra.]" }, words: ["deadline", "entrega", "week"] },
    "The call is at 10am, link in the calendar invite.": { says: () => ({ en: "says the call is at 10am, with the link in the calendar invite", es: "dice que la llamada es a las 10am, con el enlace en la invitación" }), reply: { en: "Thanks for sending the invite.", es: "Gracias por la invitación." }, words: ["call", "llamada", "invite"] },
    "Uploaded the assets to the shared drive.": { says: () => ({ en: "uploaded the assets to the shared drive", es: "subió los archivos a la unidad compartida" }), reply: { en: "Thanks for the assets.", es: "Gracias por los archivos." }, words: ["assets", "files", "archivos", "drive"] },
    "Sounds great, let's go with that option.": { says: () => ({ en: "agreed to go with that option", es: "aceptó ir con esa opción" }), reply: { en: "Great, let's do it.", es: "Perfecto." } },
    "We still need sign-off from finance on the budget.": { says: () => ({ en: "says finance still has to sign off on the budget", es: "dice que finanzas aún debe aprobar el presupuesto" }), reply: { en: "Noted on the budget.", es: "Tomo nota del presupuesto." }, words: ["budget", "presupuesto", "finance", "finanzas"] },
    "Found a bug in search, filed a ticket already.": { says: () => ({ en: "found a bug in search and filed a ticket", es: "encontró un error en la búsqueda y abrió un ticket" }), reply: { en: "Thanks for filing it.", es: "Gracias por reportarlo." }, words: ["bug", "search", "ticket", "error"] },
    "Thanks for your patience this week.": { says: () => ({ en: "thanked you for your patience", es: "agradeció tu paciencia" }), reply: { en: "", es: "" } },
  }),
);

/** What one message says, read sentence by sentence (once each): the facts, what it asks of the reader (of `name`'s), and the rest as written. */
function read(body, date, name = "") {
  const out = { says: [], asks: [], replies: [], other: [] };
  for (const s of new Set(sentencesOf(body))) {
    const k = KNOWN.get(s);
    if (!k) {
      if (!/^(saludos|un abrazo|gracias|quedo pendiente|abrazo|best|thanks|cheers|talk soon)[,!.]?$/i.test(s)) out.other.push(s);
      continue;
    }
    if (k.says) out.says.push(k.says(date));
    if (k.ask) out.asks.push(k.ask(date, name));
    if (k.reply) out.replies.push(k.reply);
  }
  return out;
}

/**
 * Mail's own words, quoted on a card read on later days: a relative day becomes its date, from the message's own
 * ("esta semana" → "la semana del 19 de octubre"), as a careful model writes it.
 */
export function anchor(text, date) {
  const monday = date - ((new Date(date).getUTCDay() + 6) % 7) * DAY;
  const saturday = monday + 5 * DAY;
  const monthOf = (n) => (new Date(date).getUTCMonth() + n + 12) % 12;
  const en = { day: (d) => longDate(d), short: (d) => shortDate(d), month: (n) => MONTHS_EN[monthOf(n)] };
  const es = { day: (d) => longDate(d, true), short: (d) => shortDate(d, true), month: (n) => MONTHS_ES[monthOf(n)] };
  // longest first: "esta mañana" before "mañana", "next week" before a weekday
  const rules = [
    [/\bthis (morning|afternoon|evening)\b/gi, (_, part) => `on the ${part.toLowerCase()} of ${en.day(date)}`],
    [/\btonight\b/gi, () => `on the evening of ${en.day(date)}`],
    [/\bthis weekend\b/gi, () => `the weekend of ${en.short(saturday)}`],
    [/\b(next|last) weekend\b/gi, (_, w) => `the weekend of ${en.short(saturday + (w.toLowerCase() === "next" ? 7 : -7) * DAY)}`],
    [/\bthis week\b/gi, () => `the week of ${en.short(monday)}`],
    [/\b(next|last) week\b/gi, (_, w) => `the week of ${en.short(monday + (w.toLowerCase() === "next" ? 7 : -7) * DAY)}`],
    [/\bthis month\b/gi, () => `in ${en.month(0)}`],
    [/\b(next|last) month\b/gi, (_, w) => `in ${en.month(w.toLowerCase() === "next" ? 1 : -1)}`],
    [/\btomorrow\b/gi, () => `on ${en.day(date + DAY)}`],
    [/\byesterday\b/gi, () => `on ${en.day(date - DAY)}`],
    [/\btoday\b/gi, () => `on ${en.day(date)}`],
    [/\besta (mañana|tarde|noche)\b/gi, (_, part) => `la ${part.toLowerCase()} del ${es.day(date)}`],
    [/\beste fin de semana\b/gi, () => `el fin de semana del ${es.short(saturday)}`],
    [/\b(?:la semana (?:que viene|próxima)|la próxima semana)\b/gi, () => `la semana del ${es.short(monday + 7 * DAY)}`],
    [/\bla semana pasada\b/gi, () => `la semana del ${es.short(monday - 7 * DAY)}`],
    [/\besta semana\b/gi, () => `la semana del ${es.short(monday)}`],
    [/\beste mes\b/gi, () => `en ${es.month(0)}`],
    [/\b(?:el mes (?:que viene|próximo)|el próximo mes)\b/gi, () => `en ${es.month(1)}`],
    [/\bel mes pasado\b/gi, () => `en ${es.month(-1)}`],
    [/(?<!la )\bmañana\b/gi, () => `el ${es.day(date + DAY)}`],
    [/\bhoy\b/gi, () => `el ${es.day(date)}`],
    [/\bayer\b/gi, () => `el ${es.day(date - DAY)}`],
  ];
  let out = rules.reduce((t, [re, to]) => t.replace(re, to), text);
  // a weekday alone (or "next Friday") reads as the coming one: give it its date. One already dated isn't touched, and
  // an hour isn't a date ("Monday 9am"), as the summary's validator reads them
  const dated = String.raw`(?![,\s]+(?:the\s+|el\s+)?\d{1,2}(?!\s*(?:am|pm|a\.m|p\.m|h\b|:|\d)))`;
  const plain = (w) => w.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  out = out.replace(new RegExp(String.raw`\b(?:(?:this|next) )?(${DAYS_EN.join("|")})\b${dated}`, "gi"), (_, d) => longDate(nextWeekday(date, DAYS_EN.findIndex((x) => x.toLowerCase() === d.toLowerCase()))));
  out = out.replace(new RegExp(String.raw`(?<![\p{L}])(?:(?:este|próximo) )?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)(?![\p{L}])${dated}`, "giu"), (_, d) => longDate(nextWeekday(date, DAYS_ES.findIndex((x) => plain(x) === plain(d))), true));
  return out;
}

const list = (parts, es) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} ${es ? "y" : "and"} ${parts.at(-1)}`);

// ─── the tasks ────────────────────────────────────────────────────────────────

/** Plan 132: where the conversation stands, in one to three sentences, and what it leaves for the reader. */
export function summarize(system, prompt) {
  const es = /Write in Spanish/.test(system);
  const subject = /<subject>([\s\S]*?)<\/subject>/.exec(prompt)?.[1]?.trim() ?? "";
  const blocks = blocksOf(prompt, "message").map(({ head, body }) => ({ label: attr(head, "id"), from: person(attr(head, "from")), own: /author="the reader"/.test(head), date: dayOf(attr(head, "date")) ?? 0, text: body }));
  const theirs = blocks.filter((b) => !b.own);
  const last = theirs.at(-1) ?? blocks.at(-1);
  if (!last) return { summary: es ? "La conversación no tiene texto." : "The conversation has no text.", items: [] };
  const said = read(last.text, last.date, last.from.first);
  const who = last.own ? (es ? "Tú" : "You") : last.from.first;
  const facts = said.says.map((s) => (es ? s.es : s.en)).slice(0, 2);
  const sentences = [];
  // a clause that names its own day needs no other
  const dated = facts.some((f) => /\d/.test(f));
  if (facts.length) sentences.push(dated ? `${who} ${list(facts, es)}.` : `${who} ${list(facts, es)}${es ? ` el ${shortDate(last.date, true)}` : ` on ${shortDate(last.date)}`}.`);
  else if (said.other.length) sentences.push(es ? `${who} escribió el ${shortDate(last.date, true)}: “${anchor(said.other.find((o) => !o.endsWith("?")) ?? said.other[0], last.date)}”` : `${who} wrote on ${shortDate(last.date)}: “${anchor(said.other.find((o) => !o.endsWith("?")) ?? said.other[0], last.date)}”`);
  else sentences.push(es ? `${who} escribió sobre «${subject}» el ${shortDate(last.date, true)}.` : `${who} wrote about “${subject}” on ${shortDate(last.date)}.`);
  // what came before, in a sentence: who else spoke, and the reader's last word
  const earlier = theirs.slice(0, -1).reverse().find((b) => read(b.text, b.date).says.length);
  if (earlier && sentences.length < 3) {
    const before = read(earlier.text, earlier.date).says[0];
    const clause = es ? before.es : before.en;
    sentences.push(/\d/.test(clause) ? `${es ? "Antes" : "Before that"}, ${earlier.from.first} ${clause}.` : es ? `El ${shortDate(earlier.date, true)}, ${earlier.from.first} ${clause}.` : `On ${shortDate(earlier.date)}, ${earlier.from.first} ${clause}.`);
  }
  const mine = blocks.filter((b) => b.own).at(-1);
  if (mine && sentences.length < 3) sentences.push(es ? `Tu último mensaje es del ${shortDate(mine.date, true)}.` : `You last wrote on ${shortDate(mine.date)}.`);
  // a question the stand-in can't put in its own words is asked as written, its days anchored
  const asked = said.asks.length ? said.asks.map((a) => ({ kind: a.kind, text: es ? a.es : a.en })) : said.other.filter((o) => o.endsWith("?")).map((o) => ({ kind: "question", text: anchor(o, last.date) }));
  const items = last.own ? [] : asked.slice(0, 3).map((a) => ({ ...a, message: last.label }));
  return { summary: sentences.join(" "), items };
}

const STOP = new Set("a an the and or of in on at to for from is are was were my me i you your do does did when what where who why how which it its this that with about any anything there have has had did say said tell told el la los las un una de del en y o que qué cuando cuándo cual cuál donde dónde mi mis es son como cómo por para me dijo sobre algo hay".split(" "));
/** A word and its other forms and language: mail here is in English and Spanish. */
const SYNONYMS = [
  ["payment", "pago", "pay", "paid"], ["invoice", "factura", "invoices"], ["contract", "contrato"], ["call", "llamada", "videollamada", "llamo"],
  ["meeting", "reunión", "reunion"], ["budget", "presupuesto"], ["document", "documento", "draft", "borrador"], ["photos", "fotos"],
  ["files", "archivos", "assets"], ["deadline", "entrega", "delivery"], ["bug", "error", "ticket"], ["design", "diseño"], ["pricing", "precios", "price"],
  ["song", "canción"], ["concert", "concierto"], ["calendar", "calendario", "dates", "fechas"], ["books", "libros", "book", "libro"], ["trip", "viaje"],
];
const forms = (w) => SYNONYMS.find((g) => g.includes(w)) ?? [w];
const questionWords = (q) => q.toLowerCase().replace(/[¿?¡!.,;:"“”]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
/** A capitalized word inside the question that isn't its first: a person it names. */
const namedIn = (q) => q.replace(/^[¿¡\s]*\S+/, "").match(/\b[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\b/g)?.find((w) => !/^(I|Friday|Thursday|Monday|Tuesday|Wednesday|Saturday|Sunday|October|November)$/.test(w));
const EMPTY_QUERY = { terms: [], anyOf: [], from: null, to: null, subject: null, after: null, before: null, hasAttachment: null };
const COMMAND = /^\s*(?:(?:from now on|de ahora en adelante|a partir de ahora),?\s+)?(archive|delete|trash|mark|star|move|send|file|archiva|borra|elimina|marca|mueve|manda)\b/i;

/** Plan 141: a question into searches; a command is a command. */
export function askPlan(prompt) {
  const question = /<question>([\s\S]*?)<\/question>/.exec(prompt)?.[1] ?? "";
  if (/These searches found nothing/.test(prompt)) return { kind: "question", queries: [] };
  if (COMMAND.test(question)) return { kind: "command", queries: [] };
  const name = namedIn(question);
  const words = questionWords(question).filter((w) => w !== name?.toLowerCase());
  const queries = [];
  if (name) queries.push({ ...EMPTY_QUERY, from: name });
  if (words.length) queries.push({ ...EMPTY_QUERY, ...(name ? { from: name } : {}), anyOf: words.slice(0, 2).map(forms) });
  if (!queries.length) queries.push({ ...EMPTY_QUERY, terms: [question.trim().split(/\s+/)[0] ?? "mail"] });
  return { kind: "question", queries };
}

/** Plan 141: the answer, cited, from the messages given, in the question's language, with its status. */
export function answer(prompt) {
  const question = /<question>([\s\S]*?)<\/question>/.exec(prompt)?.[1] ?? "";
  const es = isSpanish(question);
  const name = namedIn(question)?.toLowerCase();
  const words = questionWords(question).filter((w) => w !== name).flatMap(forms);
  const blocks = blocksOf(prompt, "mail").map(({ head, body }) => ({ label: attr(head, "id"), from: person(attr(head, "from")), date: dayOf(attr(head, "date")) ?? 0, own: /author=/.test(head), subject: attr(head, "subject") ?? "", text: body }));
  const scored = blocks
    .map((b) => {
      const hay = `${b.subject} ${b.text}`.toLowerCase();
      const hits = words.filter((w) => hay.includes(w)).length;
      // a name only ranks: the message still has to be about what was asked, unless that's all the question names
      return { b, score: hits && (hits + (name && b.from.name.toLowerCase().includes(name) ? 2 : 0)) || (!words.length && name && b.from.name.toLowerCase().includes(name) ? 1 : 0) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.b.date - a.b.date);
  if (!scored.length) return `${es ? "No lo encontré en lo que busqué." : "I didn't find that in what I searched."}\n<status>not_found</status>`;
  const chosen = scored.slice(0, 2).map((x) => x.b);
  const sameFirst = chosen.length > 1 && chosen[0].from.first === chosen[1].from.first && chosen[0].from.name !== chosen[1].from.name;
  const lines = [];
  let said = null;
  for (const b of chosen) {
    const facts = sentencesOf(b.text)
      .map((s) => ({ s, k: KNOWN.get(s) }))
      .filter(({ s, k }) => (k?.words ?? []).some((w) => words.includes(w)) || words.some((w) => s.toLowerCase().includes(w)));
    const who = b.own ? (es ? "Tú" : "You") : sameFirst ? b.from.name : b.from.first;
    const when = es ? `el ${shortDate(b.date, true)}` : `on ${shortDate(b.date)}`;
    const k = facts[0]?.k;
    const says = k?.says ? (es ? k.says(b.date).es : k.says(b.date).en) : null;
    const ask = k?.ask ? (es ? k.ask(b.date, "").es : k.ask(b.date, "").en) : null;
    const clause = says && ask ? `${says} ${es ? "y te pide revisarlo" : "and asks you to look into it"}` : says ?? (ask ? `${es ? "te pide" : "asks you to"} ${ask.charAt(0).toLowerCase()}${ask.slice(1)}` : null);
    if (clause && clause === said) lines.push(es ? `${who} había dicho lo mismo ${when} [${b.label}].` : `${who} raised the same ${when} [${b.label}].`);
    else if (clause) lines.push(`${es ? `El ${shortDate(b.date, true)}` : `On ${shortDate(b.date)}`}, ${who} ${clause} [${b.label}].`);
    else lines.push(es ? `${who} escribió ${when}, en «${b.subject}»: “${facts[0]?.s ?? sentencesOf(b.text)[0] ?? b.subject}” [${b.label}].` : `${who} wrote ${when}, in “${b.subject}”: “${facts[0]?.s ?? sentencesOf(b.text)[0] ?? b.subject}” [${b.label}].`);
    said ??= clause;
  }
  return `${lines.join(" ")}\n<status>answered</status>`;
}

/** Kinds of mail a sentence can name, and what that mail says in its first lines, in both languages. */
const KINDS = [
  { test: /shipping|shipment|deliver|package|order|envío|envíos|pedido|paquete/i, field: "opening", value: "shipped|delivery|tracking|pedido|paquete|en camino|entregado|enviado" },
  { test: /receipt|recibo/i, field: "opening", value: "receipt|recibo|thanks for your payment|gracias por tu compra" },
  { test: /newsletter|boletín|boletin/i, field: "listId", value: "." },
  { test: /bank|banco|card charge|cargo/i, field: "opening", value: "cargo|estado de cuenta|transferencia|account alert|movimiento" },
  { test: /promotion|promo|oferta|sale/i, field: "listId", value: "." },
];
const VERBS = [
  [/^(archive|archiva)/i, "archive"], [/^(delete|trash|borra|elimina)/i, "trash"], [/^(mark .*spam|spam)/i, "spam"],
  [/^(mark .*read|marca .*leíd)/i, "markRead"], [/^(star|destaca)/i, "star"],
];

/** Plan 143: a sentence into a rule over fields, never thread ids. */
export function actionPlan(prompt, system) {
  const sentence = (/<sentence>([\s\S]*?)<\/sentence>/.exec(prompt)?.[1] ?? "").trim();
  const s = sentence.toLowerCase().replace(/^(from now on|de ahora en adelante|a partir de ahora),?\s+/, "");
  const categories = JSON.parse(/^Categories: (.*)$/m.exec(system)?.[1] ?? "[]");
  const conditions = [];
  const domain = /\bfrom ([\w-]+\.[a-z]{2,})\b|\bde ([\w-]+\.[a-z]{2,})\b/.exec(s);
  if (domain) conditions.push({ field: "fromDomain", op: "equals", value: domain[1] ?? domain[2], negate: false });
  const kind = domain ? null : KINDS.find((k) => k.test.test(s));
  if (kind) conditions.push({ field: kind.field, op: "matches", value: kind.value, negate: false });
  const age = /older than (a|one|\d+) (day|week|month|year)s?|más de (un|una|\d+) (día|semana|mes|año)/.exec(s);
  if (age) {
    const n = Number(age[1] ?? age[3]) || 1;
    const unit = { day: 1, día: 1, week: 7, semana: 7, month: 30, mes: 30, year: 365, año: 365 }[age[2] ?? age[4]];
    conditions.push({ field: "ageDays", op: "gt", value: String(n * unit), negate: false });
  }
  let actionType = VERBS.find(([re]) => re.test(s))?.[1] ?? "other";
  let categoryId = null;
  let categoryName = null;
  const into = /(?:move|send|file|mueve|manda) .+? to (?:the |my )?(.+?)(?: category)?$/.exec(s);
  if (into) {
    const named = categories.find((c) => c.name.toLowerCase() === into[1].trim());
    actionType = named ? "moveToCategory" : "createCategory";
    if (named) categoryId = named.id;
    else categoryName = capital(into[1].trim());
  }
  if (actionType !== "other" && !conditions.some((c) => c.field !== "ageDays")) {
    const noun = /^(?:\w+)\s+(?:all\s+|the\s+|my\s+)?([\p{L}]+)/u.exec(s)?.[1] ?? "x";
    conditions.unshift({ field: "subject", op: "contains", value: noun.replace(/s$/, ""), negate: false });
  }
  return { summary: capital(sentence.replace(/[.!]+$/, "")), actionType, categoryId, categoryName, accountId: null, folder: null, conditions, lookIn: actionType === "archive" ? "inbox" : "everywhere", future: !!into || /from now on|always|de ahora en adelante|siempre/.test(sentence.toLowerCase()), meaning: !domain };
}

/** Plan 143: what comes off the list: only groups that clearly don't fit the sentence's kind of mail. */
export function actionCheck(prompt) {
  const sentence = /<sentence>([\s\S]*?)<\/sentence>/.exec(prompt)?.[1] ?? "";
  const kind = KINDS.find((k) => k.test.test(sentence));
  if (!kind || kind.field !== "opening") return { drop: [] };
  const fits = new RegExp(kind.value, "i");
  const groups = [...prompt.matchAll(/<group id="(g\d+)"[^>]*>([^\n]*)<\/group>/g)];
  return { drop: groups.filter((g) => !fits.test(g[2])).map((g) => g[1]) };
}

const PROMISE = /\b(I'll|I will|I can send|let me|te (?:lo |la )?(?:mando|envío|paso)|voy a|te llamo|lo reviso)\b/i;
/** Plan 142: what a sent message promises and who owes an answer, quoting only the sender's own words. */
export function sentMail(prompt) {
  const own = /<own_text>\n([\s\S]*?)\n<\/own_text>/.exec(prompt)?.[1] ?? "";
  const recipients = [...(/<recipients>\n([\s\S]*?)\n<\/recipients>/.exec(prompt)?.[1] ?? "").matchAll(/^(r\d+): (.*)$/gm)].map((m) => ({ label: m[1], name: m[2] }));
  const sent = /(\d{1,2}) ([A-Za-z]+) (\d{4})/.exec(/It was sent ([^\n]*)/.exec(prompt)?.[1] ?? "");
  const sentDay = sent ? Date.UTC(+sent[3], MONTHS_EN.findIndex((m) => m.toLowerCase() === sent[2].toLowerCase()), +sent[1], 12) : null;
  const es = /always in Spanish|siempre en español/.test(prompt) || /enviar el contrato/.test(prompt);
  const sentences = own.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const people = recipients.filter((r) => !/noreply|no-reply|notifications@/i.test(r.name));
  const promises = sentences
    .filter((s) => PROMISE.test(s))
    .slice(0, 3)
    .map((s) => {
      const day = DAYS_EN.findIndex((d) => new RegExp(`\\b${d}\\b`, "i").test(s));
      return {
        text: s.replace(/^.*?\b(I'll|I will|let me|te (?:lo |la )?|voy a)\s+/i, "").replace(/\s+(by|on|before|el|antes del?) \w+[.!]?$/i, "").replace(/[.!?]+$/, "").toLowerCase(),
        quote: s,
        to: people[0]?.label ?? null,
        due: day >= 0 && sentDay ? iso(nextWeekday(sentDay, day)) : null,
      };
    });
  const asks = sentences.some((s) => s.endsWith("?")) || /let me know|quedo atent|quedo a la espera/i.test(own);
  void es;
  return { promises, expectsReply: asks, awaiting: asks ? people.map((p) => p.label) : [], kept: [] };
}

/** Plan 144: mail that asks something wants an answer; thanks, notices and receipts don't. */
export function needsReply(prompt) {
  const body = /<mail>[\s\S]*?\n\n([\s\S]*?)\n<\/mail>/.exec(prompt)?.[1] ?? "";
  const from = /^From: (.*)$/m.exec(prompt)?.[1] ?? "";
  if (/noreply|no-reply|notifications@|boletin@|crew@/i.test(from)) return { needsReply: false };
  return { needsReply: !/^\s*(thanks|thank you|gracias|fyi|para tu informaci)[^?]*$/i.test(body) };
}

/** What each newsletter topic in the demo argues, as its author would: a line a reader can decide on. */
const TOPIC_LINES = {
  "inteligencia artificial": { en: "AI assistants are moving from chat windows into the apps people already use.", es: "Los asistentes de IA salen del chat y entran en las apps de siempre." },
  "teléfonos plegables": { en: "Foldable phones are finally durable enough to recommend to most buyers.", es: "Los plegables por fin son lo bastante resistentes para recomendarlos." },
  "baterías de estado sólido": { en: "Solid-state batteries are close, but cars won't carry them for years.", es: "Las baterías de estado sólido están cerca, pero tardarán en llegar a los coches." },
  "realidad mixta": { en: "Mixed reality headsets are winning at work before they win at home.", es: "La realidad mixta gana primero en el trabajo y luego en casa." },
  "chips de 2 nanómetros": { en: "Two-nanometre chips promise longer battery life more than raw speed.", es: "Los chips de 2 nm prometen más batería que velocidad." },
  "interest rates": { en: "Markets expect interest rates to stay high longer than hoped.", es: "Los mercados esperan tipos altos durante más tiempo." },
  "the chip shortage": { en: "The chip shortage is easing, but carmakers are still waiting.", es: "La escasez de chips cede, pero los fabricantes de coches siguen esperando." },
  "streaming wars": { en: "Streaming services are raising prices and bundling to keep subscribers.", es: "Las plataformas suben precios y se agrupan para no perder suscriptores." },
  "electric vehicles": { en: "Electric car sales keep growing, led by cheaper models.", es: "Las ventas de eléctricos siguen creciendo gracias a modelos más baratos." },
  "remote work": { en: "Companies are settling on hybrid work as the lasting compromise.", es: "Las empresas se quedan con el trabajo híbrido como término medio." },
  "sqlite internals": { en: "A tour of how SQLite's pager and B-trees keep writes safe.", es: "Un recorrido por cómo el pager y los B-trees de SQLite protegen las escrituras." },
  "rust in the kernel": { en: "Rust drivers are landing in Linux, and maintainers are slowly warming up.", es: "Los drivers en Rust llegan a Linux y los mantenedores se van convenciendo." },
  "local-first software": { en: "Local-first apps keep data on the device and sync it later.", es: "Las apps local-first guardan los datos en el dispositivo y sincronizan después." },
  "crdts": { en: "CRDTs let people edit together offline without a central server.", es: "Los CRDT permiten editar juntos sin conexión y sin servidor central." },
  "webgpu": { en: "WebGPU brings near-native graphics and compute to the browser.", es: "WebGPU lleva gráficos y cómputo casi nativos al navegador." },
  "sistemas distribuidos": { en: "Distributed systems fail in parts, so design for partial failure first.", es: "Los sistemas distribuidos fallan por partes: hay que diseñar para eso primero." },
  "colas de mensajes": { en: "A message queue buys resilience at the cost of harder debugging.", es: "Una cola de mensajes da resiliencia a cambio de depurar con más dificultad." },
  "bases de datos embebidas": { en: "Embedded databases like SQLite are enough for most apps' data.", es: "Una base de datos embebida como SQLite basta para casi cualquier app." },
  "arquitectura hexagonal": { en: "Hexagonal architecture keeps business rules apart from frameworks and storage.", es: "La arquitectura hexagonal separa las reglas del negocio del framework y del almacenamiento." },
  "observabilidad": { en: "Good observability starts with a few traces people actually read.", es: "La buena observabilidad empieza con pocas trazas que alguien lee de verdad." },
  "variables": { en: "Figma variables now drive themes and prototype logic from one place.", es: "Las variables de Figma controlan temas y lógica de prototipos desde un solo lugar." },
  "dev mode": { en: "Dev Mode gives developers specs and code without editing the file.", es: "Dev Mode da a los desarrolladores medidas y código sin tocar el archivo." },
  "auto layout": { en: "Auto layout now wraps, so responsive designs need fewer frames.", es: "Auto layout ya ajusta en varias líneas: menos marcos para diseños adaptables." },
  "prototyping": { en: "Prototypes can now use conditions and variables without code.", es: "Los prototipos ya usan condiciones y variables sin código." },
  "design systems": { en: "Libraries with variables make design systems easier to keep in sync.", es: "Las bibliotecas con variables facilitan mantener sincronizado un sistema de diseño." },
};
/** A course sale or a launch is an ad, whoever sends it: "other". */
const PROMOTION = /descuento|nuevo curso|ruta de aprendizaje|% off|sale\b/i;

/** Plan 145: which of these are newsletters, with the point each issue makes. */
export function digest(system, prompt) {
  const es = /written in (Spanish|español)/i.test(system);
  const blocks = [...prompt.matchAll(/<mail id="([^"]*)">\nFrom: ([^\n]*)\nSubject: ([^\n]*)\n\n([\s\S]*?)\n<\/mail>/g)];
  return {
    items: blocks.map((b) => {
      const body = b[4];
      const newsletter = /unsubscribe|darse de baja/i.test(body) && /esta semana hablamos de|this week:|newsletter|boletín/i.test(`${b[3]} ${body}`) && !PROMOTION.test(b[3]);
      if (!newsletter) return { label: b[1], kind: "other", line: "" };
      const topic = /(?:Esta semana hablamos de|This week:) ([^.]+)\./.exec(body)?.[1]?.trim().toLowerCase();
      const known = topic && TOPIC_LINES[topic];
      const line = known ? (es ? known.es : known.en) : `${capital(b[3].replace(/^[^\p{L}]+/u, "").trim())}.`;
      return { label: b[1], kind: "newsletter", line };
    }),
  };
}

/** Plan 06: a sentence into a filter, named and explained in its own language. */
export function filter(prompt, system) {
  const p = prompt.toLowerCase();
  const es = isSpanish(prompt) || /^archiva|^borra|^mueve|^marca/.test(p);
  const categories = JSON.parse(/^Categories: (.*)$/m.exec(system)?.[1] ?? "[]");
  const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(prompt)?.[0];
  const domain = /\b([\w-]+\.(?:com|io|dev|app|mx|co|es|net|org))\b/.exec(p)?.[1];
  const conditions = [];
  if (email) conditions.push({ field: "from", op: "equals", value: email.toLowerCase(), negate: false });
  else if (domain) conditions.push({ field: "fromDomain", op: "equals", value: domain, negate: false });
  if (/newsletter|bolet/.test(p)) conditions.push({ field: "listId", op: "contains", value: ".", negate: false });
  const days = /(\d+)\s*(días|dias|days)/.exec(p);
  if (days) conditions.push({ field: "ageDays", op: "gt", value: days[1], negate: false });
  if (/adjunto|attachment/.test(p)) conditions.push({ field: "hasAttachment", op: "is", value: "true", negate: false });
  if (!conditions.length) conditions.push({ field: "subject", op: "contains", value: p.split(/\s+/).at(-1) ?? "x", negate: false });
  const actions = [];
  if (/spam/.test(p)) actions.push({ type: "spam", categoryId: null });
  else if (/borra|elimina|delete|trash|papelera/.test(p)) actions.push({ type: "trash", categoryId: null });
  else if (/archiv/.test(p)) actions.push({ type: "archive", categoryId: null });
  if (/leíd|leid|as read/.test(p)) actions.push({ type: "markRead", categoryId: null });
  const category = categories.find((c) => p.includes(c.name.toLowerCase()));
  if (category) actions.push({ type: "addCategory", categoryId: category.id });
  if (!actions.length) actions.push({ type: "archive", categoryId: null });
  // the sentence's own words for what it catches: "archiva los recibos de uber.com" → "Archiva los recibos de uber.com."
  const sentence = prompt.trim().replace(/[.!]+$/, "");
  const sender = (email ?? domain ?? "").split(/[.@]/)[email ? 1 : 0] ?? "";
  const noun = /(?:archive|archiva|delete|borra|mark|marca|star)\s+(?:all\s+|the\s+|los\s+|las\s+|todos los\s+)?([\p{L}]+)/u.exec(p)?.[1];
  const name = sender && noun ? (es ? `${capital(noun)} de ${capital(sender)}` : `${capital(sender)} ${noun}`) : capital(sender || category?.name || (es ? "Filtro" : "Filter"));
  return { name: name.slice(0, 60), explanation: `${capital(sentence)}.`, match: "all", conditions, actions };
}

/** Plan 133: the draft, in the author's voice, inside <email>. `prepared`: Reply ready's, which decides nothing for them. */
export function compose(system, prompt) {
  const sender = person(attr(new RegExp(`<sender ${TAG_ATTRS}/?>`).exec(system)?.[1] ?? "", "name"));
  const thread = blocksOf(prompt, "message").map(({ head, body }) => ({ from: person(attr(head, "from")), own: /author="the author"/.test(head), date: dayOf(attr(head, "date")) ?? 0, text: body }));
  const task = /<task>\n([\s\S]*?)\n<\/task>/.exec(prompt)?.[1] ?? "";
  const instruction = (/<instruction>\n([\s\S]*?)\n<\/instruction>/.exec(task)?.[1] ?? "").trim();
  const prepared = /^Answer what the thread needs, as far as the mail lets you/.test(instruction);
  const recipients = (/^recipients: (.*)$/m.exec(task)?.[1] ?? "").split(",").map((r) => person(r.trim())).filter((r) => r.name !== "Someone");
  const other = [...thread].reverse().find((m) => !m.own);
  const language = /^language: (\w+)/m.exec(task)?.[1];
  // a draft is in the thread's language; the stand-in can't translate notes, so an instruction in another one keeps its own
  const es = language ? language.startsWith("es") : instruction && !prepared ? isSpanish(instruction) : other ? isSpanish(other.text) : false;
  const to = other?.from.first ?? recipients[0]?.first ?? "";
  // their voice, the most specific level last (packages/core/src/writing/render.ts): their usual opening, with the
  // name in it; their closing as typed, " / " a new line; a signature block below it
  const habit = (name) => [...prompt.matchAll(new RegExp(`^${name}: "([^"]*)"`, "gm"))].at(-1)?.[1];
  const opens = habit("opens with");
  const closes = habit("closes with");
  const signs = habit("signs with");
  const hasSignature = /<signature>\n/.test(system);
  let body;
  if (prepared || !instruction) {
    const said = other ? read(other.text, other.date) : { replies: [] };
    const answers = said.replies.map((r) => (es ? r.es : r.en)).filter(Boolean);
    body = answers.length ? answers.slice(0, 3).join(" ") : es ? "Gracias por escribir. [Tu respuesta.]" : "Thanks for writing. [Your answer.]";
  } else body = notesToText(instruction, es);
  const hello = opens && !opens.includes("{name}") ? `${opens.replace(/[,!:]$/, "")} {name},` : opens ?? `${es ? "Hola" : "Hi"} {name},`;
  const greeting = hello.replace(/\s*\{name\}/, to ? ` ${to}` : "").trim();
  // a closing typed without the name still ends with it, as the rules ask
  const close = closes?.includes(" / ") ? closes.split(" / ").join("\n") : `${closes ?? (es ? "Saludos," : "Best,")}\n${sender.first}`;
  const closing = hasSignature ? "" : `\n\n${close}${signs ? `\n${signs.split(" / ").join("\n")}` : ""}`;
  const subject = /Write a subject too\./.test(task) ? `<subject>${subjectFor(instruction, es)}</subject>\n` : "";
  return `${subject}<email>${greeting}\n\n${body}${closing}</email>`;
}

/** The author's notes, said as they would: "say yes, thursday at 4 works" → "Yes, Thursday at 4 works." */
function notesToText(instruction, es) {
  const parts = instruction
    .replace(/^(please\s+)?(write|reply|respond|answer|draft)\s+(back\s+)?(and\s+)?/i, "")
    .split(/\s*[,;]\s*|\s+and\s+(?=(?:say|tell|ask|thank|mention|let)\b)|\s+y\s+(?=(?:dile|pregúntale|agradece)\b)/i)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      let s = p
        .replace(/^(and|y)\s+/i, "")
        .replace(/^ask (?:him|her|them) to\s+/i, "could you ")
        .replace(/^say yes\b/i, es ? "sí" : "yes")
        .replace(/^say no\b/i, es ? "no puedo" : "I can't")
        .replace(/^(?:say|tell (?:him|her|them)|dile)\s+(?:that\s+|que\s+)?/i, "")
        .replace(/^ask (?:him|her|them)?\s*(?:if\s+)?/i, (m) => (/if/.test(m) ? "could you let me know if " : "could you "))
        .replace(/^pregúntale\s+(?:si\s+)?/i, "¿")
        .replace(/^thank (?:him|her|them)(?: for)?\s*/i, "thanks for ")
        .replace(/\bthursday\b/gi, "Thursday").replace(/\bfriday\b/gi, "Friday").replace(/\bmonday\b/gi, "Monday").replace(/\bi\b/g, "I");
      if (/^could you|^¿/.test(s)) s = `${s.replace(/[?.]+$/, "")}?`;
      return capital(s.replace(/^¿(.)/, (_, c) => `¿${c.toUpperCase()}`));
    });
  return parts.map((p) => (/[.!?]$/.test(p) ? p : `${p}.`)).join(" ");
}

function subjectFor(instruction, es) {
  const words = instruction.replace(/^(tell|ask|write to|email|escribe a|dile a)\s+\S+\s+(that|about|que|sobre)?\s*/i, "").split(/\s+/).slice(0, 6).join(" ");
  return capital(words.replace(/[.,;:!?]+$/, "")) || (es ? "Hola" : "Hello");
}

/** Plan 133 §5: who an instruction is addressed to; a name that's a verb or only mentioned isn't. */
export function parseIntent(prompt) {
  const instruction = (/^Instruction: (.*)$/m.exec(prompt)?.[1] ?? "").toLowerCase();
  const people = JSON.parse(/^People: (.*)$/m.exec(prompt)?.[1] ?? "[]");
  const match = people.find((p) => new RegExp(`\\b(tell|ask|email|write to|reply to|dile a|dile|escribe a|pregunta a|pregúntale a)\\s+${p.name.toLowerCase().split(/\s+/)[0]}\\b`).test(instruction));
  return { recipient: match?.id ?? null };
}

/** Plan 133 §7: a manner, never a topic; integers in range, no digits in notes. */
export function judgeVoice(prompt) {
  const messages = (prompt.match(/<message n=/g) ?? []).length || 1;
  const words = (prompt.match(/\S+/g) ?? []).length / messages;
  const es = /address: es/.test(prompt);
  const brief = words < 40;
  return {
    traits: { formality: brief ? 2 : 3, warmth: 4, directness: brief ? 5 : 3, detail: brief ? 2 : 4, humor: 1 },
    notes: es ? [brief ? "Va al grano y deja fuera lo que no hace falta" : "Da contexto antes de llegar al punto", "Saluda por el nombre y cierra con calidez"] : [brief ? "Gets to the point and leaves the rest out" : "Gives context before the point", "Greets by first name and closes warmly"],
  };
}

/** Smart categories: a label only where an item plainly names it. */
export function classify(prompt) {
  const line = (label) => JSON.parse(new RegExp(`^${label}: (.*)$`, "m").exec(prompt)?.[1] ?? "[]");
  const labels = line("Labels");
  const items = line("Items");
  return { results: items.map((it) => {
    const label = labels.find((l) => String(it.text ?? "").toLowerCase().includes(String(l).toLowerCase().replace(/s$/, ""))) ?? null;
    return { id: it.id, label, confidence: label ? 0.9 : 0.2 };
  }) };
}

// ─── which task a request is ──────────────────────────────────────────────────

/** First words of each system prompt, for a server that fell back from json_schema (the ladder adds the schema below). */
const SYSTEM_STARTS = [
  ["probe", "This is a connectivity test."],
  ["thread_summary", "You summarize one email conversation"],
  ["ask_plan", "You turn a question about someone's own email into searches"],
  ["action_plan", "You turn one sentence about someone's email into a rule"],
  ["action_check", "Someone asked for something to be done to their email"],
  ["sent_mail", "You read one email a person sent"],
  ["needs_reply", "Someone received this email and hasn't answered"],
  ["newsletter_digest", "Each <mail> block below is one automated email"],
  ["voice_judgment", "You study how one person writes email"],
  ["parse_intent", "Someone typed a short instruction for an email"],
  ["classification", "You assign each item exactly one of the given labels"],
  ["compose", "You write email for one person"],
  ["answer", "You answer one person's question about their own email"],
  ["filter", "You turn a user's description of an email filter"],
];

export function taskOf(body) {
  const named = body.response_format?.json_schema?.name;
  if (named) return named;
  const system = text(body.messages?.find((m) => m.role === "system")?.content);
  const known = SYSTEM_STARTS.find(([, start]) => system.startsWith(start));
  return known ? known[0] : null;
}

/** The whole answer to one chat request: what the model "writes", for a task. Null: a task this stub doesn't know. */
export function answerFor(body) {
  const task = taskOf(body);
  const system = text(body.messages?.find((m) => m.role === "system")?.content);
  const prompt = text(body.messages?.find((m) => m.role === "user")?.content);
  const json = (v) => ({ task, content: JSON.stringify(v) });
  switch (task) {
    case "probe": return json({ ok: true });
    case "thread_summary": return json(summarize(system, prompt));
    case "ask_plan": return json(askPlan(prompt));
    case "action_plan": return json(actionPlan(prompt, system));
    case "action_check": return json(actionCheck(prompt));
    case "sent_mail": return json(sentMail(`${system}\n${prompt}`));
    case "needs_reply": return json(needsReply(prompt));
    case "newsletter_digest": return json(digest(system, prompt));
    case "filter": return json(filter(prompt, system));
    case "voice_judgment": return json(judgeVoice(prompt));
    case "parse_intent": return json(parseIntent(prompt));
    case "classification": return json(classify(prompt));
    case "compose": return { task, content: compose(system, prompt) };
    case "answer": return { task, content: answer(prompt) };
    default: return null;
  }
}

// ─── the server ───────────────────────────────────────────────────────────────

/** Pieces a stream is sent in: a dozen characters, as a model's tokens arrive in a few words at a time. */
export const chunksOf = (content) => content.match(/[\s\S]{1,12}/g) ?? [];

/**
 * Starts the stand-in on 127.0.0.1. `paceMs` spaces a stream's pieces (a rater sees it write); the e2e hooks hold or
 * fail a chat request: `chatHeld` waits on a promise, `chatDelayMs` waits, `summaryFails()` returns an HTTP status for a
 * summary. `requests` lists every request's method and path, `tasks` every chat request's task, `summaries` what each
 * summary request carried.
 */
export async function startModelStub(options = {}) {
  const { port = 0, paceMs = 0, chatDelayMs = 0, chatHeld, summaryFails } = options;
  const requests = [];
  const tasks = [];
  const summaries = [];
  const unknown = [];
  /** the last request of each task, for a test (or a person) to read what the app sent */
  const last = {};
  /** chat requests not yet answered: a capture waits for none before a shot */
  let active = 0;
  const server = createServer((req, res) => {
    let data = "";
    let gone = false;
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      const json = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.url === "/api/tags") return json(200, { models: MODELS });
      if (req.url === "/api/ps") return json(200, { models: [{ name: MODEL }] });
      if (req.url === "/api/show") return json(200, { model_info: { "qwen3.context_length": 40960 } });
      if (req.url !== "/v1/chat/completions") return void res.writeHead(404).end();
      // counted and watched from arrival: a request cancelled while it's held or delayed is gone when its answer comes
      active++;
      res.on("close", () => {
        gone = true;
        active--;
      });
      if (chatHeld) return void chatHeld.then(chat);
      if (chatDelayMs) return void setTimeout(chat, chatDelayMs);
      chat();
    });
    function chat() {
      let body;
      try { body = JSON.parse(data); } catch { return void res.writeHead(400).end(); }
      const task = taskOf(body);
      tasks.push(task ?? "unknown");
      last[task ?? "unknown"] = body;
      if (task === "thread_summary") summaries.push(JSON.stringify(body.messages));
      // what was asked is recorded either way; nobody is left to answer, nor to fail
      if (gone) return;
      if (task === "thread_summary") {
        const failure = summaryFails?.();
        if (failure) return void res.writeHead(failure, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "The stub says no.", type: "error", code: null } }));
      }
      const out = answerFor(body);
      if (!out) {
        unknown.push(text(body.messages?.[0]?.content).slice(0, 80));
        return void res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `model-stub: no answer for this task (${task ?? "unrecognised"})`, type: "error", code: null } }));
      }
      if (!body.stream) {
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "stub", object: "chat.completion", created: 0, model: body.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: out.content, refusal: null } }], usage: { prompt_tokens: Math.ceil(data.length / 4), completion_tokens: Math.ceil(out.content.length / 4), total_tokens: 0 } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const pieces = chunksOf(out.content);
      const frame = (delta, finish = null) => `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      let i = 0;
      const next = () => {
        if (gone) return;
        if (i < pieces.length) {
          res.write(frame(i === 0 ? { role: "assistant", content: pieces[i] } : { content: pieces[i] }));
          i++;
          return void (paceMs ? setTimeout(next, paceMs) : setImmediate(next));
        }
        res.write(frame({}, "stop"));
        res.end("data: [DONE]\n\n");
      };
      next();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const actual = server.address().port;
  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    requests,
    tasks,
    summaries,
    unknown,
    last,
    get active() {
      return active;
    },
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

// `node model-stub.mjs [port]`: a stand-in to point a hand-run app at
if (import.meta.url === `file://${process.argv[1]}`) {
  const stub = await startModelStub({ port: Number(process.argv[2] ?? 0), paceMs: 25 });
  console.log(`model stub on ${stub.url}/v1 (${MODEL})`);
}
