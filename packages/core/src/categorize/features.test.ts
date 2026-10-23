import { describe, expect, it } from "vitest";
import {
  contentTokens,
  decodeFeatures,
  encodeFeatures,
  extractFeatures,
  featureKey,
  featuresFromBlob,
  featuresToBlob,
  fnv1a,
  MAX_TOKENS,
  nameGrams,
  ownBodyText,
  type FeatureSource,
} from "./features";

const ctx = { ownDomains: new Set(["acme.studio"]) };
const src = (over: Partial<FeatureSource> = {}): FeatureSource => ({
  fromEmail: "uber.receipts@uber.com",
  fromName: "Uber Receipts",
  listId: null,
  subject: "Tu recibo de Uber · $123.40 MXN",
  bodyText: "Gracias por tu viaje. Total: $123.40 MXN. Factura 4821 disponible.",
  replied: false,
  attachmentNames: [],
  ...over,
});

describe("categorize features", () => {
  it("drops es/en stopwords and buckets numbers", () => {
    expect(contentTokens("Hola, el pedido 12 de la orden 48213 para MX1234 and the thing")).toEqual(["pedido", "#n", "orden", "#n4", "#a", "thing"]);
  });

  it("prefixes subject and body tokens, deduplicates and caps them", () => {
    const f = extractFeatures(src({ subject: "Factura factura", bodyText: "factura " + Array.from({ length: 300 }, (_, i) => `palabra${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`).join(" ") }), ctx);
    expect(f.tokens[0]).toBe("s:factura");
    expect(f.tokens.filter((t) => t === "s:factura")).toHaveLength(1);
    expect(f.tokens).toContain("b:factura");
    expect(f.tokens.length).toBe(MAX_TOKENS);
  });

  it("reads only what the message adds: quotes and replied-to history are stripped, 2 KB max", () => {
    const body = "Nuevo texto aquí\n> citado antiguo\n\nEl 3 oct 2026, Ana escribió:\nhistorial viejo";
    expect(ownBodyText(body)).not.toMatch(/citado|historial/);
    expect(ownBodyText(`Hi\n\nOn Mon, Ana wrote:\nold stuff`)).toBe("Hi\n\n");
    expect(ownBodyText("x".repeat(10_000)).length).toBe(2048);
    expect(ownBodyText(null)).toBe("");
  });

  it("detects es/en intents", () => {
    const intents = (over: Partial<FeatureSource>) => extractFeatures(src({ subject: "", bodyText: "", ...over }), ctx).intents;
    expect(intents({ subject: "Tu recibo · $123.40 MXN" })).toEqual(expect.arrayContaining(["amount", "invoice"]));
    expect(intents({ bodyText: "Adjunto el CFDI del mes" })).toContain("invoice");
    expect(intents({ subject: "Your receipt", bodyText: "Amount: 19.99 USD" })).toEqual(expect.arrayContaining(["amount", "invoice"]));
    expect(intents({ bodyText: "Tu paquete con número de guía MX123 está en camino" })).toContain("tracking");
    expect(intents({ bodyText: "Darse de baja: https://x/u" })).toContain("unsubscribe");
    expect(intents({ subject: "Invitación: Revisión semanal @ lun 10:00" })).toContain("calendar");
    expect(intents({ bodyText: "Tu código de verificación es 123456" })).toContain("otp");
    expect(intents({ subject: "Confirmación de tu vuelo a Lima" })).toContain("travel");
    expect(intents({ replied: true })).toContain("replied");
    expect(intents({ attachmentNames: ["factura-1.PDF"] })).toContain("pdf");
    expect(intents({ listId: "news.example.com" })).toContain("bulk");
    expect(intents({ fromEmail: "no-reply@figma.com" })).toContain("bulk");
    expect(intents({ fromEmail: "ana@gmail.com" })).toEqual(["consumer"]);
    expect(intents({ subject: "¿Comida el sábado?" })).toEqual([]);
  });

  it("skips the domain feature for consumer and own domains, but keeps the raw domain", () => {
    expect(extractFeatures(src({ fromEmail: "Ana.Perez@Gmail.com" }), ctx)).toMatchObject({ sender: "ana.perez@gmail.com", domain: null, rawDomain: "gmail.com" });
    expect(extractFeatures(src({ fromEmail: "lucia@acme.studio" }), ctx)).toMatchObject({ domain: null, rawDomain: "acme.studio" });
    expect(extractFeatures(src(), ctx)).toMatchObject({ domain: "uber.com", list: null, name: "uber receipts" });
  });

  it("is deterministic and versioned", () => {
    const a = extractFeatures(src(), ctx);
    expect(extractFeatures(src(), ctx)).toEqual(a);
    expect(a.v).toBeGreaterThan(0);
    expect([...encodeFeatures(a)]).toEqual([...encodeFeatures(extractFeatures(src(), ctx))]);
  });

  it("encodes to hashes that decode into the same groups, and survives a BLOB round trip", () => {
    const f = extractFeatures(src({ listId: "news.uber.com" }), ctx);
    const enc = encodeFeatures(f);
    const d = decodeFeatures(featuresFromBlob(featuresToBlob(enc)));
    expect(d.sender).toBe(fnv1a(featureKey.sender("uber.receipts@uber.com")));
    expect(d.list).toBe(fnv1a(featureKey.list("news.uber.com")));
    expect(d.domain).toBe(fnv1a(featureKey.domain("uber.com")));
    expect([...d.tokens]).toEqual(f.tokens.map(fnv1a));
    expect([...d.intents]).toEqual(f.intents.map((i) => fnv1a(featureKey.intent(i))));
    expect(d.names[0]).toBe(fnv1a(featureKey.name("uber receipts")));
    // a typical thread stays around half a kilobyte
    expect(featuresToBlob(enc).byteLength).toBeLessThan(600);
    // unaligned BLOB bytes from SQLite still decode
    const unaligned = new Uint8Array(featuresToBlob(enc).byteLength + 1).subarray(1);
    unaligned.set(featuresToBlob(enc));
    expect([...featuresFromBlob(unaligned)]).toEqual([...enc]);
  });

  it("name grams find a trained brand inside a longer display name, ignoring short words", () => {
    expect(nameGrams("bbva seguridad")).toEqual(["bbva seguridad", "bbva", "seguridad"]);
    expect(nameGrams("ana")).toEqual([]);
    expect(nameGrams("ana garcia cafe altura")).toContain("ana garcia");
    expect(nameGrams("ana garcia cafe altura")).not.toContain("ana");
  });

  it("never hashes to 0 (reserved for absent features)", () => {
    for (let i = 0; i < 10_000; i++) expect(fnv1a(`t${i}`)).not.toBe(0);
  });
});
