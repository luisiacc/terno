/**
 * Plan 282: the Put away rating set's mailbox (`pnpm ui:rate --screens putaway`). The desktop's demo mailbox as its first
 * launch seeds it (AI off), plus a week of mail that the user's rules and Terno's own filing took out of the Inbox, up to
 * the rating's instant (harness AI_NOW: the backend's clock starts there, TERNO_TEST_NOW, so the week is always this week).
 * One colleague you've written to was caught by your own rule (Needs a look and the Inbox's line).
 *   pnpm --filter @terno/backend-dev exec tsx src/put-away-seed.ts --out /tmp/terno-scratch/rating/pa-seed
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CategorizerModel, encodeFeatures, extractFeatures, type FilterRule } from "@terno/core";
import { openDatabase, SqlMailStore } from "@terno/db";
import { seedDemo } from "@terno/backend";

type IncomingMessage = Parameters<SqlMailStore["sync"]["ingest"]>[0][number];

const i = process.argv.indexOf("--out");
const out = i < 0 ? "" : (process.argv[i + 1] ?? "");
if (!out) throw new Error("usage: put-away-seed.ts --out <dir>");

/** the rating's instant (scripts/ui-rating/harness.mjs AI_NOW) */
const NOW = Date.UTC(2026, 9, 22, 16, 0);
const DAY = 86_400_000;
const HOUR = 3_600_000;

mkdirSync(out, { recursive: true });
const dbPath = join(out, "terno.db");
for (const suffix of ["", "-wal", "-shm", ".search"]) rmSync(dbPath + suffix, { force: true });
const db = openDatabase(dbPath);
const store = new SqlMailStore(db);

// as the desktop's demo launch: the mailbox, and AI off as on a real install (backend-entry.ts)
await seedDemo(store, { threads: 3000, accounts: 4 });
await store.settings.set("app", { ai: { provider: "none" } });

const accounts = await store.accounts.list();
const personal = accounts[0]!;
const work = accounts[1] ?? personal;
let n = 0;
const mail = (o: { from: { name: string; email: string }; subject: string; body: string; at: number; accountId?: number; listId?: string }): IncomingMessage => {
  const id = `put-away-${++n}`;
  const account = o.accountId ?? personal.id;
  return {
    accountId: account,
    providerMsgId: id,
    providerThreadId: null,
    rfcMessageId: `<${id}@rating.test>`,
    inReplyTo: null,
    references: [],
    from: o.from,
    to: [{ name: accounts.find((a) => a.id === account)!.displayName, email: accounts.find((a) => a.id === account)!.email }],
    cc: [],
    bcc: [],
    subject: o.subject,
    date: o.at,
    snippet: o.body.slice(0, 140),
    bodyText: o.body,
    bodyHtml: null,
    bodyState: "full",
    listId: o.listId ?? null,
    isRead: false,
    isStarred: false,
    inInbox: true,
    isSent: false,
    isDraft: false,
    isTrash: false,
    isSpam: false,
    hasAttachments: false,
    size: 2000,
  };
};
const rule = (conditions: FilterRule["conditions"], actions: FilterRule["actions"]): FilterRule => ({ match: "all", conditions, actions });

// two categories kept out of the Inbox: one a rule files newsletters into, one Terno files receipts into on its own
const reading = await store.categories.create("Boletines", "violet", { showInInbox: false });
const receipts = await store.categories.create("Recibos", "amber", { showInInbox: false });
await store.categories.update(receipts.id, { autoApply: true });

// the user's rules, and one Terno made when they deleted similar mail
await store.filters.save({ name: "Xataka", enabled: true, source: "manual", rule: rule([{ field: "from", op: "equals", value: "boletin@xataka.com" }], [{ type: "archive" }]) }, NOW - 40 * DAY);
await store.filters.save({ name: "Substack a Boletines", enabled: true, source: "manual", rule: rule([{ field: "fromDomain", op: "equals", value: "substack.com" }], [{ type: "addCategory", categoryId: reading.id }]) }, NOW - 30 * DAY);
await store.filters.save({ name: "Acme updates", enabled: true, source: "manual", rule: rule([{ field: "fromDomain", op: "equals", value: "acme.studio" }], [{ type: "archive" }]) }, NOW - 12 * DAY);
await store.filters.save({ name: "Delete: ofertas@liverpool.mx", enabled: true, source: "manual", auto: true, rule: rule([{ field: "from", op: "equals", value: "ofertas@liverpool.mx" }], [{ type: "trash" }]) }, NOW - 9 * DAY);

// the engine: the user filed a dozen of CFE's receipts in Recibos; it files the next ones on its own
const cfe = { name: "CFE Facturación", email: "facturacion@cfe.mx" };
const ownDomains = new Set(accounts.map((a) => a.email.split("@")[1]!.toLowerCase()));
const features = encodeFeatures(extractFeatures({ fromEmail: cfe.email, fromName: cfe.name, listId: null, subject: "Tu recibo de luz", bodyText: "Total a pagar", replied: false, attachmentNames: [] }, { ownDomains }));
const model = new CategorizerModel({ decayRef: NOW });
for (let k = 0; k < 12; k++) {
  const m = mail({ from: cfe, subject: `Tu recibo de luz ${k + 1}`, body: "Total a pagar $512.00 MXN. Fecha límite de pago 15.", at: NOW - (40 + k) * DAY });
  await store.sync.ingest([m], { applyFilters: false, now: m.date, classifier: null });
  const thread = (await store.debug.snapshot()).messages.find((x) => x.providerMsgId === m.providerMsgId)!.threadId;
  await store.categories.add({ categoryId: receipts.id, threadIds: [thread], addedBy: "user", now: m.date });
  model.train({ categoryId: receipts.id, label: 1, weight: 1, at: NOW, content: true, features });
}
for (let k = 0; k < 200; k++) model.addBackground(10_000 + k, encodeFeatures(extractFeatures({ fromEmail: `amigo${k % 20}@gmail.com`, fromName: "Amigo", listId: null, subject: "Comida", bodyText: "Hola amigo", replied: false, attachmentNames: [] }, { ownDomains })));
const classifier = { mode: "auto" as const, model };

// you've written to Javier
const javier = { name: "Javier Ortiz", email: "javier.ortiz@acme.studio" };
await store.sync.ingest([{ ...mail({ from: { name: work.displayName, email: work.email }, subject: "Presupuesto API de pagos", body: "Te paso el presupuesto.", at: NOW - 6 * DAY, accountId: work.id }), to: [javier], isSent: true, inInbox: false }], { applyFilters: false, now: NOW - 6 * DAY, classifier: null });

// the week's mail, as it arrived
const week: { m: IncomingMessage; terno?: boolean }[] = [
  { m: mail({ from: javier, subject: "Reunión de seguimiento — API de pagos", body: "¿Puedes confirmar hoy si movemos la reunión al jueves? El cliente espera respuesta.", at: NOW - 25 * 60_000, accountId: work.id }) },
  { m: mail({ from: { name: "Xataka", email: "boletin@xataka.com" }, subject: "291 gadgets que cambiarán tu escritorio", body: "Esta semana: teclados, monitores y lámparas.", at: NOW - 2 * HOUR, listId: "xataka.com" }) },
  { m: mail({ from: cfe, subject: "Tu recibo de luz de noviembre", body: "Total a pagar $498.00 MXN. Fecha límite de pago 15 de diciembre.", at: NOW - 3 * HOUR }), terno: true },
  { m: mail({ from: { name: "Ofertas Liverpool", email: "ofertas@liverpool.mx" }, subject: "Solo hoy: 40% en electrónica", body: "Aprovecha antes de medianoche.", at: NOW - 5 * HOUR }) },
  { m: mail({ from: { name: "Lenny's Newsletter", email: "lenny@substack.com" }, subject: "How the best PMs write specs", body: "This week: specs that ship.", at: NOW - DAY - 2 * HOUR, listId: "lenny.substack.com" }) },
  { m: mail({ from: { name: "Equipo Acme", email: "updates@acme.studio" }, subject: "Resumen semanal del equipo", body: "Lo que pasó esta semana en Acme.", at: NOW - DAY - 4 * HOUR, accountId: work.id }) },
  { m: mail({ from: { name: "Xataka", email: "boletin@xataka.com" }, subject: "Los mejores móviles de 2026", body: "Comparativa.", at: NOW - 3 * DAY, listId: "xataka.com" }) },
  { m: mail({ from: cfe, subject: "Aviso: tu recibo está disponible", body: "Total a pagar $512.00 MXN.", at: NOW - 5 * DAY }), terno: true },
];
for (const { m, terno } of week.sort((a, b) => a.m.date - b.m.date)) await store.sync.ingest([m], { applyFilters: true, now: m.date, classifier: terno ? classifier : null });

const placed = (await store.putAway.page({ now: NOW, limit: 50 })).items.length;
if (placed !== week.length) throw new Error(`expected ${week.length} conversations put away, found ${placed}`);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
await store.close();
console.log(`[put-away-seed] ${placed} conversations put away, in ${out}`);
