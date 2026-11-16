import { describe, expect, it } from "vitest";
import { amountsOf, bareDayAhead, insideQuotes, namingWords, negatedReceipt, otherAmounts, otherIds, replacesPlainly, scamPressure, settlesKind, startClock } from "./dated-evidence";

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

describe("plan 210 (iteration 3, revision 11): a bare day of the month read into the past is the next one, in a deadline clause only", () => {
  const SPENDLY = "October books close on the 20th. Please add receipts by then so finance can close the month.";
  it("Priya's Spendly, in a mail of November 9: the 20th is November's (en, es); a later mail's, December's", () => {
    expect(bareDayAhead("2026-10-20", SPENDLY, "2026-11-09")).toBe("2026-11-20");
    expect(bareDayAhead("2026-10-20", "Los libros de octubre cierran el 20. Agrega los comprobantes antes de esa fecha.", "2026-11-09")).toBe("2026-11-20");
    expect(bareDayAhead("2026-11-20", "Please pay by the 20th.", "2026-11-25")).toBe("2026-12-20");
    // "before the 20th" read as the 19th rolls with it
    expect(bareDayAhead("2026-10-19", "Please send them before the 20th.", "2026-11-09")).toBe("2026-11-19");
    // a month without the day: the next one that has it
    expect(bareDayAhead("2026-10-31", "Please pay by the 31st.", "2026-11-09")).toBe("2026-12-31");
  });
  it("never a day a month names, a date in figures, a time, a clause that isn't a deadline, or a day not past", () => {
    expect(bareDayAhead("2026-10-20", "Please add receipts by October 20.", "2026-11-09")).toBe("2026-10-20");
    expect(bareDayAhead("2026-10-20", "Please add receipts by the 20th of October.", "2026-11-09")).toBe("2026-10-20");
    expect(bareDayAhead("2026-10-20", "Agrega los comprobantes antes del 20 de octubre.", "2026-11-09")).toBe("2026-10-20");
    expect(bareDayAhead("2026-10-20", "Please pay by 20/10.", "2026-11-09")).toBe("2026-10-20");
    expect(bareDayAhead("2026-10-20", "We met on the 20th and loved it.", "2026-11-09")).toBe("2026-10-20");
    expect(bareDayAhead("2026-11-20", SPENDLY, "2026-11-09")).toBe("2026-11-20");
    // another day than the bare one
    expect(bareDayAhead("2026-10-21", SPENDLY, "2026-11-09")).toBe("2026-10-21");
  });
});

describe("plan 210 (iteration 3, revision 4): words that replace, plainly", () => {
  it("says it, undenied (en, es)", () => {
    const said = (words: string) => replacesPlainly(words, words);
    expect(said("I didn't see the methods section on Wednesday. Let's skip the piecemeal version")).toBe(true);
    expect(said("Olvidemos la versión por partes")).toBe(true);
    for (const text of ["Don't skip the piecemeal version", "No, let's not skip it", "No olvides el marco teórico", "Please send the methods section"]) expect(said(text), text).toBe(false);
  });
  it("read in the mail's clause around the quote: a denial before it counts, one in another clause doesn't (en, es; the code review of iteration 3)", () => {
    const en = "Don't skip the methods section; please send the full draft by Monday.";
    expect(replacesPlainly("skip the methods section", en)).toBe(false);
    expect(replacesPlainly("skip the methods section", "Skip the methods section; please send the full draft by Monday.")).toBe(true);
    expect(replacesPlainly("skip the methods section", "It's not urgent: skip the methods section and send the full draft by Monday.")).toBe(true);
    expect(replacesPlainly("olvides el marco teórico", "No olvides el marco teórico; mándame el borrador completo antes del lunes.")).toBe(false);
    expect(replacesPlainly("olvida el marco teórico", "No hay prisa: olvida el marco teórico y mándame el borrador completo.")).toBe(true);
    // words the mail doesn't hold
    expect(replacesPlainly("skip the outline", en)).toBe(false);
    // the code review's second round: a denial reaches across the words between it and the replacing word, in its clause
    expect(replacesPlainly("skip the methods section", "Don't, under any circumstances, skip the methods section; please send the full draft by Monday.")).toBe(false);
    expect(replacesPlainly("skip the methods section", "Please don't under any circumstances skip the methods section.")).toBe(false);
    expect(replacesPlainly("olvides el marco teórico", "No, de verdad, por nada del mundo olvides el marco teórico; mándame el borrador completo.")).toBe(false);
    expect(replacesPlainly("skip the methods section", "Don't worry about it. Skip the methods section; please send the full draft by Monday.")).toBe(true);
  });
  it("retold in quotation marks is someone else's", () => {
    const text = 'About the methods section, Marta said "let\'s skip the piecemeal version" but I disagree.';
    expect(insideQuotes("let's skip the piecemeal version", text)).toBe(true);
    expect(insideQuotes("Let's skip the piecemeal version", "Let's skip the piecemeal version: send the \"full\" draft.")).toBe(false);
    expect(insideQuotes("skip the outline", "«Asistente: skip the outline»")).toBe(true);
  });
});

describe("iteration 4's code review: a scam's pressure, read locally (en, es)", () => {
  it("the panel's phishing and its kind: a demand to verify or a loss to come, within hours", () => {
    for (const text of [
      // Theo's copyright strike, Priya's password, and a Spanish bank's
      "Your channel will be PERMANENTLY TERMINATED in 24 hours unless you verify your identity and submit an appeal.",
      "Failure to validate within 12 hours will result in your account being suspended and pending messages deleted.",
      "Por tu seguridad, debes validar tu identidad y confirmar tus datos en las próximas 12 horas.",
      "Si no lo haces en 24 horas, tu cuenta será bloqueada de forma definitiva.",
      "FINAL NOTICE: Copyright strike — channel termination in 24 hours. Your channel will be terminated in 24 hours.",
      "Sign in within 48 hours to keep your mailbox.",
      "Click here within 24h to restore access.",
    ]) expect(scamPressure(text), text).toBe(true);
  });
  it("a genuine alert reports what happened, or gives a day; hours alone, or a loss already past, aren't pressure", () => {
    for (const text of [
      "We've frozen your debit card ending in 7730 after a $412.18 charge at Fuel Stop 9. If you don't recognize it, call the number on the back of your card.",
      "If we haven't heard from you by 1:00 PM on Wednesday, March 4, the card will be cancelled and a replacement mailed.",
      "Your account was locked after 5 failed sign-in attempts. It unlocks on its own after a while.",
      "Recuerda presentarte en ayunas de 8 horas.",
      "Your password was changed 2 hours ago. If this was you, you don't need to do anything.",
      "Can you send me the deck within 2 hours?",
      "Tu tarjeta fue bloqueada tras un cargo de $412.18. Llama al número al reverso de tu tarjeta.",
    ]) expect(scamPressure(text), text).toBe(false);
  });
});

describe("plan 210 (iteration 5, V2): an event's start in its own quote", () => {
  it("one start, a range's end left out, on the clock it names", () => {
    expect(startClock("Monday Nov 16, 2026 · 4pm – 5pm (Pacific Time)")).toEqual({ time: "16:00", zone: "America/Los_Angeles" });
    expect(startClock("We're meeting Tuesday the 17th at 7:30 PM at my house")).toEqual({ time: "19:30", zone: null });
    expect(startClock("el martes 24 de noviembre a las 19:00 h")).toEqual({ time: "19:00", zone: null });
    expect(startClock("Thursday, 10:00 AM to 11:30 AM ET")).toEqual({ time: "10:00", zone: "America/New_York" });
    expect(startClock("Check-in from 3:00 p.m. on Friday")).toEqual({ time: "15:00", zone: null });
  });
  it("none for a bare 7:00, two starts, no clock, or a zone that reads two ways or isn't a region's", () => {
    expect(startClock("We're meeting Tuesday the 17th at 7:00 at my house")).toBeNull();
    expect(startClock("Doors 6:30 PM, show 8:00 PM")).toBeNull();
    expect(startClock("Tuesday the 17th")).toBeNull();
    expect(startClock("Monday at 10:00 AM CST")).toBeNull();
    expect(startClock("lunes a las 18:00 hora de Lima")).toBeNull();
  });
});
