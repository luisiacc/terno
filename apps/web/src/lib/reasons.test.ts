import type { Reason } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { reasonText } from "./reasons";

afterEach(() => setLocale("en", en));

const sameSender = (count: number): Reason => ({ k: "reason.sameSender", p: { count, category: "Facturas" } });

describe("reasonText", () => {
  it("renders descriptors in the active language, with plurals", () => {
    expect(reasonText(sameSender(12))).toBe("same sender as 12 conversations in Facturas");
    expect(reasonText(sameSender(1))).toBe("same sender as 1 conversation in Facturas");
    expect(reasonText({ k: "reason.newSender" })).toBe("new sender");
    expect(reasonText({ k: "reason.mentions", p: { count: 2, a: "uber", b: "viaje", c: "" } })).toBe("mentions “uber”, “viaje”");
    setLocale("es", es);
    expect(reasonText(sameSender(12))).toBe("mismo remitente que 12 conversaciones en Facturas");
    expect(reasonText(sameSender(1))).toBe("mismo remitente que 1 conversación en Facturas");
    expect(reasonText({ k: "reason.mentions", p: { count: 1, a: "brief", b: "", c: "" } })).toBe("menciona «brief»");
    expect(reasonText({ k: "reason.aiLocal", p: { category: "Facturas" } })).toBe("la IA (en este Mac) cree que es de Facturas");
  });

  it("formats counts for the locale", () => {
    expect(reasonText(sameSender(1200))).toBe("same sender as 1,200 conversations in Facturas");
  });

  it("shows reasons stored before descriptors, and keys this build doesn't know, as they are", () => {
    expect(reasonText("mismo remitente que 8 conversaciones en Facturas")).toBe("mismo remitente que 8 conversaciones en Facturas");
    expect(reasonText({ k: "reason.fromTheFuture" as never })).toBe("reason.fromTheFuture");
  });
});
