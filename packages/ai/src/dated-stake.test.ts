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
    // iteration 5's code review (point 5): any condition in the mail is no support for this one's consequence
    expect(heldStake("pay", "Pay the tax installment (or policy ends Dec 1)", "Please pay the tax installment by November 25. If you have any questions, call us.")).toBe("Pay the tax installment");
    expect(heldStake("pay", "Pagar la cuota (o la póliza termina el 1 dic)", "Please pay the installment by November 25. If you have any questions, call us.")).toBe("Pagar la cuota");
    // a Spanish bracket on an English mail that says it on its condition, with its day, stays
    expect(heldStake("pay", "Pagar la prima (o la póliza termina el 1 dic)", POLICY)).toBe("Pagar la prima (o la póliza termina el 1 dic)");
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

// round 15's panel (the claims ledger's STAKE-CUT-BY-HELDSTAKE): Jordan's expenses, kickoff form and Tallis call, Margaret's
// homeowners policy, Sam's registration; each mail as the panel had it
const EXPENSES = "October expense reports must be submitted in Expensely by Thursday, November 12 at 11:59 PM CT. Reports submitted after the cutoff will roll into the December reimbursement run.";
const KICKOFF = "What you need to do:\n1. Complete the registration and travel form by Friday, November 20 (dietary needs, T-shirt size, arrival airport)\n2. Travel will book flights for you from the form\n\nNo form = no hotel room. We mean it this year.";
const TALLIS = "I think we need an exec-to-exec call (our CRO with their new CIO) before end of the month, otherwise procurement will treat this as a new evaluation. Can you set that up? I can prep the usage story.";
const REGISTRAR = "Your enrollment window closes Wednesday, December 9 at 11:59 PM. Doctoral students must register for at least 9 credits (or 1 credit of BIO 999 if advanced to candidacy) to keep full-time status and funding.\n\nRegister in HalvorsenOne > Student Center.";

describe("the claims ledger's second batch: a stake the mail supports in substance stays", () => {
  it("the panel's five rows: an \"or\" clause whose object the mail names where it says what happens if the reader doesn't act", () => {
    for (const [kind, text, mail] of [
      ["respond", "Submit October expense reports in Expensely (or rolls into December reimbursement run)", EXPENSES],
      ["respond", "Complete the Cobaltline FY27 Sales Kickoff registration and travel form (or no hotel room)", KICKOFF],
      ["respond", "Set up a Tallis exec-to-exec call (or procurement treats it as new evaluation)", TALLIS],
      ["pay", "Pay $1,486.00 for the Lakeshore Mutual homeowners policy (or coverage lapses Dec 1)", POLICY],
      ["respond", "Register in HalvorsenOne (or lose full-time status and funding)", REGISTRAR],
      // es
      ["respond", "Subir los gastos de octubre en Expensely (o pasan a la quincena de diciembre)", "Sube tus gastos de octubre en Expensely antes del jueves 12. Lo que llegue después del cierre pasa a la quincena de diciembre."],
      ["respond", "Llenar el formulario del congreso (o sin cuarto de hotel)", "Llena el formulario de registro antes del viernes 20.\n\nSin formulario no hay cuarto de hotel."],
      ["respond", "Inscribirte en el portal (o pierdes el estatus de tiempo completo y la beca)", "Tu periodo de inscripción cierra el miércoles 9. Inscríbete en al menos 9 créditos para conservar el estatus de tiempo completo y la beca."],
    ] as const) expect(heldStake(kind, text, mail), text).toBe(text);
  });

  it("never on what the mail doesn't name where it says what happens, nor on a condition about something else", () => {
    // the object named nowhere the mail speaks of not acting
    expect(heldStake("respond", "Submit October expense reports (or rolls into January payroll)", EXPENSES)).toBe("Submit October expense reports");
    expect(heldStake("respond", "Complete the kickoff form (or no flights booked)", "Complete the registration form by Friday, November 20. Flights are booked from the form.")).toBe("Complete the kickoff form");
    // any "if" is no failure to act: "If you have questions about your policy, call us"
    expect(heldStake("pay", "Pay the premium (or policy cancelled)", "Please pay the premium by November 25. If you have questions about your policy, call us.")).toBe("Pay the premium");
    // a fact the mail states, written as a fact, still goes when the mail says it only on a condition (iteration 5)
    expect(heldStake("respond", "Register in HalvorsenOne (funding lost)", REGISTRAR)).toBe("Register in HalvorsenOne");
    // es: the condition about something else
    expect(heldStake("respond", "Inscribirte en el portal (o pierdes la beca)", "Inscríbete antes del miércoles 9. Si tienes dudas sobre tu beca, escríbenos.")).toBe("Inscribirte en el portal");
  });

  it("its code review: the failure the mail speaks of is not doing this item", () => {
    // another failure ("if you have not booked a hotel room"), not the form's (en, es)
    expect(heldStake("respond", "Complete the form (or no hotel room)", "Complete the registration form by Friday. If you have not booked a hotel room, contact the travel desk.")).toBe("Complete the form");
    expect(heldStake("respond", "Llenar el formulario (o sin cuarto de hotel)", "Llena el formulario de registro antes del viernes. Si no has reservado cuarto de hotel, escribe a la agencia.")).toBe("Llenar el formulario");
  });

  it("its code review: \"to keep\" excuses only \"without a lapse\"; a stated denial still cuts it", () => {
    // "to keep" beside a denial: "will not lapse" (en), "no se suspenderá" (es)
    expect(heldStake("pay", "Pay the premium (or coverage lapses)", "To keep your coverage, pay by Friday, but your coverage will not lapse if you pay late.")).toBe("Pay the premium");
    expect(heldStake("pay", "Pagar la prima (o se suspende la cobertura)", "Para conservar tu cobertura, paga antes del viernes; tu cobertura no se suspenderá si pagas tarde.")).toBe("Pagar la prima");
    // "without a lapse" with "to keep" still says it (Margaret's)
    expect(heldStake("pay", "Pay the premium (or coverage lapses)", "To keep your coverage without a lapse, please pay the premium by November 25.")).toBe("Pay the premium (or coverage lapses)");
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
