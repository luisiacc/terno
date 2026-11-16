import { describe, expect, it } from "vitest";
import { amountsOf, namingWords, negatedReceipt, otherAmounts, otherIds, settlesKind } from "./dated-evidence";

describe("plan 210 (iteration 3, revision 5): amounts are read whole", () => {
  it("a currency amount is one token, whatever its separators or sign; a number alone isn't one", () => {
    expect([...amountsOf("Pago para no generar intereses: $8,432.17")]).toEqual(["¤8432.17"]);
    expect([...amountsOf("Pago mínimo: $1,105.00")]).toEqual(["¤1105"]);
    expect([...amountsOf("Total: 8.432,17 €")]).toEqual(["¤8432.17"]);
    expect([...amountsOf("US$29 a month, or MX$450")]).toEqual(["¤29", "¤450"]);
    expect([...amountsOf("29 USD")]).toEqual(["¤29"]);
    expect([...amountsOf("€5.862,00 a year")]).toEqual(["¤5862"]);
    expect([...amountsOf("($2,941.18 total)")]).toEqual(["¤2941.18"]);
    // grouped with cents and no sign is still an amount; an invoice's or a card's number isn't
    expect([...amountsOf("Recibimos 8,432.17 hoy")]).toEqual(["¤8432.17"]);
    expect([...amountsOf("invoice 1001, card ending 6631, order BD-55018, 12/11/2026")]).toEqual([]);
  });
  it("an amount is never split into identifiers; real invoice and order numbers stay identifiers", () => {
    const words = namingWords("Recibimos tu pago por $8,432.17 a tu Tarjeta terminación 6631");
    expect(words.has("¤8432.17")).toBe(true);
    expect(words.has("432")).toBe(false);
    expect(words.has("6631")).toBe(true);
    // Diego's minimum against the receipt's amount: no identifier differs
    expect(otherIds({ text: "Pagar $1,105.00 de la Tarjeta de Crédito Nopal Oro", quote: "Pago mínimo: $1,105.00" }, "Recibimos tu pago por $8,432.17 a tu Tarjeta de Crédito Nopal Oro terminación 6631")).toBe(false);
    expect(otherIds({ text: "Pay invoice 1002", quote: "Invoice 1002 is due" }, "Payment received for invoice 1001")).toBe(true);
  });
  it("another amount, and none of the item's, is another payment's", () => {
    const bill = { text: "Pay $54.20 for the Brightline bill", quote: "Amount due: $54.20" };
    expect(otherAmounts(bill, "We received your payment of $61.00.")).toBe(true);
    expect(otherAmounts(bill, "We received your payment of $54.20.")).toBe(false);
    expect(otherAmounts(bill, "Payment received, thank you.")).toBe(false);
    expect(otherAmounts({ text: "Pay the Brightline bill", quote: "your bill is ready" }, "We received your payment of $61.00.")).toBe(false);
  });
  it("a receipt said not to have happened is no receipt (en, es)", () => {
    for (const text of ["We have not received your payment.", "We haven't received your payment yet.", "No payment received for your bill.", "No hemos recibido tu pago.", "Aún no recibimos tu pago."]) {
      expect(negatedReceipt(text), text).toBe(true);
      expect(settlesKind("pay", text), text).toBe(false);
    }
    for (const text of ["Payment received, thank you.", "No action needed: we received your payment.", "Recibimos tu pago por $8,432.17."]) {
      expect(negatedReceipt(text), text).toBe(false);
      expect(settlesKind("pay", text), text).toBe(true);
    }
  });
});
