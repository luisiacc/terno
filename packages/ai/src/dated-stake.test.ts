import { describe, expect, it } from "vitest";
import { cutAtClause, renewalBefore } from "./dated";
import { heldStake, orphanedConsequence } from "./dated-stake";

// fictionalized from round 13's panel mail (Margaret's tax installment and policy, Priya's receipts, Sam's lease and Tunewave)
const TAX = "Installment amount: $412.00\nDue: Friday, November 20, 2026\n\nYour installment is not paid automatically.\n\nMissed installments will remove the parcel from the prepayment plan.";
const POLICY = "Your homeowners policy will renew on December 1, 2026.\n\nTo keep your coverage without a lapse, please pay the renewal premium by November 25. If payment is not received, your policy will end at 12:01 a.m. on December 1, 2026.";
const RECEIPTS = "October books close on the 20th. Please add receipts by then so finance can close the month; anything missing after that gets flagged to your manager.";
const LEASE = "Please let us know whether you plan to renew by November 30. If we don't hear from you, we'll assume you're moving out and start showing the unit.";
const STREAM = "We weren't able to charge your Visa ending 8813 for Tunewave Premium ($10.99).\n\nPlease update your payment details by November 16. If we still can't charge you after that date, your account will switch to Tunewave Free and your downloaded playlists will be removed from your devices.";
const BLS = "Our records show your BLS certification expires on 12/10/2026. Please complete a renewal class before the expiration date.";
const DOMAIN = "Tu dominio vence el martes 8 de diciembre de 2026. Para no perder tu dominio ni el correo asociado, renueva antes de la fecha de vencimiento.";

describe("plan 210 (iteration 5, revision 9): the stake is a condition, held to the mail before the cut", () => {
  it("a consequence the mail says only on a condition, written as a fact, goes; the action and the amount stay", () => {
    expect(heldStake("pay", "Pay $412.00 for the Marlow County tax installment (parcel removed from plan)", TAX)).toBe("Pay $412.00 for the Marlow County tax installment");
    expect(heldStake("pay", "Pay $1,486.00 for the Lakeshore Mutual homeowners policy (policy ends Dec 1 at 12:01 AM)", POLICY)).toBe("Pay $1,486.00 for the Lakeshore Mutual homeowners policy");
    expect(heldStake("respond", "Add 7 Lumora card receipts or memos (flagged to your manager)", RECEIPTS)).toBe("Add 7 Lumora card receipts or memos");
    // a clause apart: the amount kept, the conditional fact gone
    expect(heldStake("pay", "Update Tunewave Premium payment details ($10.99 failed; switches to Free, playlists removed)", STREAM)).toBe("Update Tunewave Premium payment details ($10.99 failed)");
    // es
    expect(heldStake("expire", "Renovar estudioramirez.mx (se libera el dominio)", "Si no renuevas, el dominio se libera el 8 de diciembre.")).toBe("Renovar estudioramirez.mx");
    const GASTOS = "Los libros de octubre cierran el día 20. Sube los comprobantes antes de esa fecha; lo que falte después se reportará a tu gerente.";
    expect(heldStake("respond", "Subir 6 comprobantes (se reporta a tu gerente)", GASTOS)).toBe("Subir 6 comprobantes");
    expect(heldStake("respond", "Subir 6 comprobantes (faltantes se reportan a tu gerente)", GASTOS)).toBe("Subir 6 comprobantes (faltantes se reportan a tu gerente)");
    // a condition left alone once what happens is gone says nothing: the bracket goes whole
    expect(heldStake("pay", "Pagar $1,512.00 de la póliza de Lakeview (si no, la póliza termina el 1 dic)", "Your policy renews on December 1. Please pay by November 25.")).toBe("Pagar $1,512.00 de la póliza de Lakeview");
  });

  it("said as a condition, as an amount or a percentage, or a fact the mail says plainly: kept", () => {
    for (const [kind, text, mail] of [
      ["pay", "Pay $412.00 for the Marlow County tax installment (or the parcel leaves the plan)", TAX],
      ["pay", "Pay $1,486.00 for the homeowners policy (policy ends Dec 1 if unpaid)", POLICY],
      ["respond", "Tell Maple Court whether you'll renew (if no reply, they show the unit)", LEASE],
      ["respond", "Add 7 Lumora card receipts (flagged after the 20th)", RECEIPTS],
      ["pay", "Pay $187.42 for Hill Country Power & Water (5% late fee)", "A late fee of 5% applies to balances not received by the due date."],
      ["respond", "Upload the W-9 for Pingwire ($18,000 held)", "We're holding your $18,000 payout until a W-9 is on file."],
      ["expire", "Book a BLS renewal class (certification expires Dec 10)", BLS],
      ["expire", "Renovar estudioramirez.mx (o se pierden el dominio y el correo)", DOMAIN],
      ["pay", "Pay the premium (if unpaid, policy ends Dec 1)", POLICY],
    ] as const) expect(heldStake(kind, text, mail), text).toBe(text);
  });

  it("an \"or\" that joins nouns is no condition; a negated consequence isn't the mail's; details and other kinds are left alone", () => {
    expect(heldStake("pay", "Pay the Brightline bill (card or bank account suspended)", "If payment isn't received by Friday, service will be suspended. Pay by card or bank account.")).toBe("Pay the Brightline bill");
    expect(heldStake("pay", "Pay the water bill (late fee charged)", "There is no late fee charged for this bill.")).toBe("Pay the water bill");
    expect(heldStake("respond", "Send Noor the keynote deck (16:9, embed fonts)", "Please send the deck in 16:9 with fonts embedded.")).toBe("Send Noor the keynote deck (16:9, embed fonts)");
    expect(heldStake("event", "Ship It Weekly recording (sound check at 11)", "Sound check at 11.")).toBe("Ship It Weekly recording (sound check at 11)");
    expect(heldStake("alert", "Card frozen (account closed)", "If you don't call, the account will be closed.")).toBe("Card frozen (account closed)");
  });

  it("a long cut never keeps what happens without its condition", () => {
    const text = "Pay $412.00 for the Marlow County real estate tax installment; the parcel leaves the prepayment plan if it's missed";
    const cut = cutAtClause(text, 100);
    expect(cut).toBe("Pay $412.00 for the Marlow County real estate tax installment…");
    expect(orphanedConsequence("Pay the bill; the parcel leaves the plan", " if it's missed")).toBeGreaterThanOrEqual(0);
    expect(orphanedConsequence("Pay the bill", ", or the parcel leaves the plan")).toBe(-1);
    // inside a bracket: whole or not at all
    expect(cutAtClause("Pay $1,486.00 for the Lakeshore Mutual homeowners policy renewal premium (policy ends Dec 1, if unpaid by Nov 25)", 100)).not.toMatch(/\(policy ends Dec 1\)/u);
  });
});

describe("plan 210 (iteration 5): a renewal's own \"before\" a day", () => {
  it("its words saying before its day sort it under the day before, keeping the day asked before; the mail's words never do", () => {
    expect(renewalBefore("2026-11-19", null, "Cambiar o cancelar Creatix Cloud antes del 19 nov")).toEqual({ due: "2026-11-18", before: "2026-11-19" });
    expect(renewalBefore("2026-11-14", null, "Cancel Tipotec Pro before Saturday or pay USD 29.00/month")).toEqual({ due: "2026-11-13", before: "2026-11-14" });
    // already the day before
    expect(renewalBefore("2026-11-18", null, "Cancel Creatix before Nov 19")).toEqual({ due: "2026-11-18", before: "2026-11-19" });
    // no "before" a day, a time, a lower bound: as it was
    expect(renewalBefore("2026-11-19", null, "Renew bakehouse.dev before it expires (auto-renew is off)")).toEqual({ due: "2026-11-19", before: null });
    expect(renewalBefore("2026-11-19", "17:00", "Cancel before the 19th")).toEqual({ due: "2026-11-19", before: null });
    expect(renewalBefore("2026-11-19", null, "Don't cancel before the 19th")).toEqual({ due: "2026-11-19", before: null });
  });
});
