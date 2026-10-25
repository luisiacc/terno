import { setLocale, translate } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { describe, expect, it } from "vitest";
import type { Reason } from "../types";
import { explain, parseReasons } from "./explain";
import { encodeFeatures, extractFeatures, type FeatureSource } from "./features";
import { CategorizerModel, SOURCE_WEIGHT, type TrainExample } from "./model";

const NOW = Date.UTC(2026, 9, 22);
const DAY = 86_400_000;
const FACTURAS = 1;
const LECTURAS = 2;
const ctx = { ownDomains: new Set(["acme.studio"]) };

function feat(over: Partial<FeatureSource> = {}) {
  return extractFeatures(
    {
      fromEmail: "uber.receipts@uber.com",
      fromName: "Uber Receipts",
      listId: null,
      subject: "Tu recibo de Uber · $123.40 MXN",
      bodyText: "Gracias por tu viaje. Total: $123.40 MXN. Factura 4821 disponible.",
      replied: false,
      attachmentNames: [],
      ...over,
    },
    ctx,
  );
}
const enc = (over: Partial<FeatureSource> = {}) => encodeFeatures(feat(over));
const ex = (categoryId: number, features: Uint32Array, over: Partial<TrainExample> = {}): TrainExample => ({
  categoryId,
  label: 1,
  weight: SOURCE_WEIGHT.user,
  at: NOW,
  content: true,
  features,
  ...over,
});

const RECEIPTS: Partial<FeatureSource>[] = [
  { fromEmail: "uber.receipts@uber.com", fromName: "Uber Receipts" },
  { fromEmail: "recibos@rappi.com", fromName: "Rappi", subject: "Tu recibo de Rappi · $88.00 MXN", bodyText: "Total: $88.00 MXN. Factura 912 disponible." },
  { fromEmail: "receipts@stripe.com", fromName: "Stripe", subject: "Your receipt #3311", bodyText: "Amount: $20.00. Invoice #3311." },
  { fromEmail: "billing@vercel.com", fromName: "Vercel", subject: "Your receipt from Vercel #771", bodyText: "Amount: $20.00. Invoice #771." },
  { fromEmail: "alertas@bbva.mx", fromName: "BBVA", subject: "Cargo por $512.00 en tu tarjeta", bodyText: "Se realizó un movimiento por $512.00 MXN." },
  { fromEmail: "notificaciones@bancoandino.co", fromName: "Banco Andino", subject: "Transferencia recibida", bodyText: "Se realizó un movimiento por $99.10 MXN." },
];
const NEWSLETTER: Partial<FeatureSource> = { fromEmail: "boletin@xataka.com", fromName: "Xataka", listId: "boletin.xataka.com", subject: "Lo mejor de la semana en tecnología", bodyText: "Esta semana hablamos de baterías. Darse de baja: https://x/u" };
const FRIEND: Partial<FeatureSource> = { fromEmail: "ana.garcia@gmail.com", fromName: "Ana García", subject: "¿Comida el sábado?", bodyText: "Hola, ¿vamos a comer? Un abrazo" };

/** A small mailbox: receipts in Facturas, a newsletter in Lecturas, friends uncategorized. */
function trained(): CategorizerModel {
  const m = new CategorizerModel({ decayRef: NOW });
  for (let i = 0; i < 8; i++) for (const r of RECEIPTS) m.train(ex(FACTURAS, enc(r)));
  for (let i = 0; i < 10; i++) m.train(ex(LECTURAS, enc(NEWSLETTER)));
  for (let i = 0; i < 400; i++) m.addBackground(1000 + i, enc({ ...FRIEND, fromEmail: `friend${i % 8}@gmail.com` }));
  return m;
}
const scoreOf = (m: CategorizerModel, f: Uint32Array, cat: number) => m.score(f).find((s) => s.categoryId === cat)!;

describe("categorizer model", () => {
  it("a known sender is identity evidence; content alone moves an unknown sender", () => {
    const m = trained();
    const known = scoreOf(m, enc(), FACTURAS);
    expect(known.identity).toBe("sender");
    expect(known.I).toBeGreaterThan(2);
    expect(known.p).toBeGreaterThan(0.97);

    const netflix = scoreOf(m, enc({ fromEmail: "info@netflix.com", fromName: "Netflix", subject: "Tu recibo de Netflix · $199.00 MXN", bodyText: "Total: $199.00 MXN. Factura 77 disponible." }), FACTURAS);
    expect(netflix.identity).toBeNull();
    expect(netflix.I).toBe(0);
    expect(netflix.C + netflix.Nint).toBeGreaterThan(3);

    const friend = scoreOf(m, enc({ ...FRIEND, fromEmail: "friend1@gmail.com" }), FACTURAS);
    expect(friend.p).toBeLessThan(0.5);
    // additive categories: the newsletter is not evidence against Facturas, only background mail is
    expect(scoreOf(m, enc(NEWSLETTER), LECTURAS).p).toBeGreaterThan(0.97);
  });

  it("calibrates identity by the category's filing rate (positive-unlabeled)", () => {
    // the user files ~30% of everything: a newsletter filed 30% of the time is entirely theirs
    const m = new CategorizerModel({ decayRef: NOW });
    const senders = ["a@news.io", "b@news.io", "c@digest.dev", "d@weekly.mx"];
    let bg = 0;
    for (const email of senders) {
      for (let i = 0; i < 30; i++) m.train(ex(LECTURAS, enc({ ...NEWSLETTER, fromEmail: email })));
      for (let i = 0; i < 70; i++) m.addBackground(bg++, enc({ ...NEWSLETTER, fromEmail: email }));
    }
    for (let i = 0; i < 300; i++) m.addBackground(bg++, enc({ ...FRIEND, fromEmail: `f${i % 30}@gmail.com` }));
    expect(m.labelRate(LECTURAS)).toBeCloseTo(0.3, 5);
    const s = scoreOf(m, enc({ ...NEWSLETTER, fromEmail: "a@news.io" }), LECTURAS);
    expect(s.identityShare).toBeCloseTo(1, 5);
    expect(s.identityFit).toBe(1);
    // a sender the user files a tenth as often as the category's norm is counter-evidence
    for (let i = 0; i < 3; i++) m.train(ex(LECTURAS, enc({ ...NEWSLETTER, fromEmail: "rare@x.io" })));
    for (let i = 0; i < 97; i++) m.addBackground(bg++, enc({ ...NEWSLETTER, fromEmail: "rare@x.io" }));
    const rare = scoreOf(m, enc({ ...NEWSLETTER, fromEmail: "rare@x.io" }), LECTURAS);
    expect(rare.identityShare).toBeLessThan(0.15);
    expect(rare.identityFit).toBeLessThan(0.3);
  });

  it("filing rates are maintained incrementally: any history equals a model built from its end state", () => {
    const a = new CategorizerModel({ decayRef: NOW });
    const b = new CategorizerModel({ decayRef: NOW });
    const exs = Array.from({ length: 60 }, (_, i) => ex((i % 3) + 1, enc({ ...NEWSLETTER, fromEmail: `n${i % 9}@news${i % 4}.io` }), { label: i % 7 === 0 ? -1 : 1, weight: i % 7 === 0 ? 3 : 1 }));
    const bg = Array.from({ length: 40 }, (_, i) => enc({ ...NEWSLETTER, fromEmail: `n${i % 12}@news${i % 4}.io` }));
    // a: everything, with detours (untrained examples, background threads that left)
    exs.forEach((e) => a.train(e));
    bg.forEach((f, i) => a.addBackground(i, f));
    exs.slice(0, 15).forEach((e) => a.untrain(e));
    for (let i = 0; i < 10; i++) a.removeBackground(i);
    a.removeBackground(999);
    // b: only what is left
    exs.slice(15).forEach((e) => b.train(e));
    bg.slice(10).forEach((f, i) => b.addBackground(i + 10, f));
    for (const cat of [1, 2, 3]) expect(a.labelRate(cat)).toBeCloseTo(b.labelRate(cat), 12);
    const back = CategorizerModel.deserialize(a.serialize())!;
    for (const cat of [1, 2, 3]) expect(back.labelRate(cat)).toBeCloseTo(a.labelRate(cat), 12);
  });

  it("a domain vouches for a new sender only once several of its senders are filed", () => {
    const m = trained();
    // uber.com: one filed sender (receipts) — a new uber.com address gets no positive identity
    const promo = scoreOf(m, enc({ fromEmail: "promociones@uber.com", fromName: "Uber", subject: "Descuento", bodyText: "Promoción" }), FACTURAS);
    expect(promo.identity).toBeNull();
    // a client company: many people, all filed
    for (let i = 0; i < 6; i++) m.train(ex(LECTURAS + 1, enc({ fromEmail: `p${i}@cafealtura.mx`, fromName: `Persona ${i}`, subject: "Propuesta", bodyText: "Te comparto la propuesta" })));
    const client = scoreOf(m, enc({ fromEmail: "nueva@cafealtura.mx", fromName: "Nueva", subject: "Propuesta", bodyText: "Te comparto la propuesta" }), LECTURAS + 1);
    expect(client).toMatchObject({ identity: "domain", domainSenders: 6 });
    expect(client.I).toBeGreaterThan(0);
  });

  it("clips each evidence group (identity ±6, content ±4, intents ±3)", () => {
    const m = trained();
    for (let i = 0; i < 500; i++) m.train(ex(FACTURAS, enc()));
    for (let i = 0; i < 3000; i++) m.addBackground(20_000 + i, enc(FRIEND));
    const s = scoreOf(m, enc(), FACTURAS);
    expect(s.I).toBe(6);
    expect(Math.abs(s.C)).toBeLessThanOrEqual(4);
    expect(Math.abs(s.Nint)).toBeLessThanOrEqual(3);
  });

  it("untrain removes exactly what train added", () => {
    const m = trained();
    const before = m.score(enc(FRIEND));
    const extra = ex(FACTURAS, enc(FRIEND), { label: -1, weight: SOURCE_WEIGHT.removal, at: NOW - 400 * DAY });
    m.train(extra);
    expect(m.score(enc(FRIEND))).not.toEqual(before);
    m.untrain(extra);
    const after = m.score(enc(FRIEND));
    after.forEach((s, i) => expect(s.p).toBeCloseTo(before[i]!.p, 12));
  });

  it("background threads are weak negatives that can be removed again", () => {
    const m = trained();
    const f = enc({ fromEmail: "promos@uber.com", fromName: "Uber", subject: "20% de descuento en tu próximo viaje", bodyText: "Usa el código VERANO" });
    const before = scoreOf(m, f, FACTURAS);
    for (let i = 0; i < 20; i++) m.addBackground(9000 + i, f);
    m.addBackground(9000, f); // idempotent
    expect(m.backgroundSize).toBe(420);
    const after = scoreOf(m, f, FACTURAS);
    expect(after.identity).toBe("sender");
    expect(after.I).toBeLessThan(-1);
    expect(after.p).toBeLessThan(before.p);
    for (let i = 0; i < 20; i++) m.removeBackground(9000 + i);
    expect(scoreOf(m, f, FACTURAS).p).toBeCloseTo(before.p, 12);
  });

  it("decays old examples by half a year-ish, never below a quarter", () => {
    const m = new CategorizerModel({ decayRef: NOW });
    expect(m.effectiveWeight({ weight: 1, at: NOW })).toBe(1);
    expect(m.effectiveWeight({ weight: 1, at: NOW - 365 * DAY })).toBeCloseTo(0.5, 10);
    expect(m.effectiveWeight({ weight: 3, at: NOW - 5 * 365 * DAY })).toBeCloseTo(0.75, 10);
    // newer than the reference (trained after the last rebuild): full weight
    expect(m.effectiveWeight({ weight: 1, at: NOW + DAY })).toBe(1);
  });

  it("a bulk add past the content cap teaches identity only", () => {
    const a = new CategorizerModel({ decayRef: NOW });
    const b = new CategorizerModel({ decayRef: NOW });
    for (let i = 0; i < 6; i++) {
      a.train(ex(FACTURAS, enc(), { weight: SOURCE_WEIGHT.bulk, content: true }));
      b.train(ex(FACTURAS, enc(), { weight: SOURCE_WEIGHT.bulk, content: false }));
    }
    const other = enc({ fromEmail: "x@other.com", fromName: "Other" });
    expect(scoreOf(a, other, FACTURAS).C).not.toBe(0);
    expect(scoreOf(b, other, FACTURAS).C).toBe(0);
    expect(scoreOf(b, enc(), FACTURAS).identity).toBe("sender");
  });

  it("flags look-alikes: a trained display name from a different domain", () => {
    const m = trained();
    expect(m.lookAlike(enc({ fromEmail: "alertas@bbva.mx", fromName: "BBVA" }))).toBe(false);
    expect(m.lookAlike(enc({ fromEmail: "seguridad@bbva-mx-alertas.com", fromName: "BBVA" }))).toBe(true);
    expect(m.lookAlike(enc({ fromEmail: "x@banco-andino-seguro.top", fromName: "Banco Andino Seguridad" }))).toBe(true);
    expect(m.lookAlike(enc({ fromEmail: "ana@gmail.com", fromName: "Ana" }))).toBe(false);
  });

  it("counts senders across categories and background", () => {
    const m = trained();
    expect(m.senderSupport(enc())).toBe(8);
    expect(m.senderSupport(enc({ fromEmail: "friend1@gmail.com" }))).toBe(50);
    expect(m.senderSupport(enc({ fromEmail: "nobody@nowhere.dev" }))).toBe(0);
  });

  it("serializes to an exact image", () => {
    const m = trained();
    m.train(ex(FACTURAS, enc(FRIEND), { label: -1, weight: 3, at: NOW - 100 * DAY }));
    const bytes = m.serialize();
    const back = CategorizerModel.deserialize(bytes)!;
    for (const f of [enc(), enc(FRIEND), enc(NEWSLETTER), enc({ fromEmail: "new@x.io" })]) expect(back.score(f)).toEqual(m.score(f));
    expect(back.lookAlike(enc({ fromEmail: "s@bbva-x.com", fromName: "BBVA" }))).toBe(true);
    // background membership survives, so a later categorization can still remove it exactly
    expect(back.hasBackground(1000)).toBe(true);
    back.removeBackground(1000);
    m.removeBackground(1000);
    expect(back.score(enc(FRIEND))).toEqual(m.score(enc(FRIEND)));
    expect(CategorizerModel.deserialize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("explains a prediction with identity, words, intents and counter-evidence", () => {
    const m = trained();
    const reasons = explain(m, feat(), FACTURAS, "Facturas", "Uber Receipts");
    expect(reasons[0]).toEqual({ k: "reason.sameSender", p: { count: 8, category: "Facturas" } });
    expect(reasons.some((r) => typeof r === "object" && r.k === "reason.mentions")).toBe(true);
    expect(reasons).toContainEqual({ k: "reason.intent.amount" });

    const promo = { fromEmail: "promos@uber.com", fromName: "Uber", subject: "20% de descuento", bodyText: "Usa el código" };
    for (let i = 0; i < 10; i++) m.addBackground(9500 + i, enc(promo));
    expect(explain(m, feat(promo), FACTURAS, "Facturas", "Uber").at(-1)).toEqual({ k: "reason.alsoElsewhere", p: { sender: "Uber" } });

    const fresh = explain(m, feat({ fromEmail: "info@netflix.com", fromName: "Netflix", subject: "Tu recibo · $199.00 MXN", bodyText: "Factura disponible" }), FACTURAS, "Facturas", "Netflix");
    expect(fresh[0]).toEqual({ k: "reason.newSender" });
  });

  it("explains in the reader's language: descriptors render through the catalog", () => {
    const m = trained();
    const reasons = explain(m, feat(), FACTURAS, "Facturas", "Uber Receipts");
    const text = (r: Reason) => (typeof r === "string" ? r : translate({ key: r.k, params: r.p }));
    expect(text(reasons[0]!)).toBe("same sender as 8 conversations in Facturas");
    expect(text({ k: "reason.mentions", p: { count: 2, a: "uber", b: "viaje", c: "" } })).toBe("mentions “uber”, “viaje”");
    setLocale("es", es);
    try {
      expect(text(reasons[0]!)).toBe("mismo remitente que 8 conversaciones en Facturas");
      expect(text({ k: "reason.sameSender", p: { count: 1, category: "Facturas" } })).toBe("mismo remitente que 1 conversación en Facturas");
      expect(text({ k: "reason.mentions", p: { count: 1, a: "uber", b: "", c: "" } })).toBe("menciona «uber»");
      expect(text({ k: "reason.mentions", p: { count: 3, a: "a", b: "b", c: "c" } })).toBe("menciona «a», «b», «c»");
      expect(text(reasons.find((r) => typeof r === "object" && r.k === "reason.intent.amount")!)).toBe("incluye un importe");
    } finally {
      setLocale("en", en);
    }
  });

  it("reads stored reasons: descriptors, and strings persisted before them; nothing else", () => {
    expect(parseReasons(JSON.stringify(["mismo remitente que 8 conversaciones en Facturas", { k: "reason.newSender" }, { k: "reason.sameSender", p: { count: 2, category: "X" } }]))).toEqual([
      "mismo remitente que 8 conversaciones en Facturas",
      { k: "reason.newSender" },
      { k: "reason.sameSender", p: { count: 2, category: "X" } },
    ]);
    expect(parseReasons(JSON.stringify([1, null, { p: {} }, { k: "x", p: { a: {} } }, { k: "y", p: [1] }]))).toEqual([]);
    expect(parseReasons("not json")).toEqual([]);
    expect(parseReasons(JSON.stringify({ k: "reason.newSender" }))).toEqual([]);
    expect(parseReasons(null)).toEqual([]);
  });
});
