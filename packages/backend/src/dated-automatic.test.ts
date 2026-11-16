import { describe, expect, it } from "vitest";
import { handledItself } from "./dated-automatic";
import { paragraphsOf } from "./dated-evidence";

/** As `checkDates` reads it: the whole mail as the item's tied words (one item), the subject apart. */
const handled = (kind: string, text: string, quote: string, mail: string, subject = "Your account") => handledItself({ kind, text, quote }, { subject, paragraphs: paragraphsOf(mail), tied: mail });

describe("plan 210 (iteration 5, revision 1): a plan that renews by itself and a bill paid, in the item's own words, need nothing", () => {
  it("an affirmative, unconditional automatic renewal of this plan, subscription or membership (Theo's Loomcast, Priya's Pagewise and Framewell, Diego's Creatix)", () => {
    const LOOMCAST = "Hi Theo,\n\nThis is a heads-up that your Loomcast Business plan for Pingwire will renew automatically on December 1, 2026.\n\nPlan: Business (annual)\nAmount: $1,440.00 + applicable tax\nCard: Visa ending in 4242\n\nWant to change seats or switch to monthly? You can make changes in Settings any time before December 1.";
    expect(handled("renew", "Loomcast Business renews ($1,440.00)", "will renew automatically on December 1, 2026", LOOMCAST)).toBe(true);
    const PAGEWISE = "Hi Priya,\n\nThis is a reminder that the Lumora workspace on Pagewise renews soon.\n\nPlan: Team, annual\nRenewal date: November 18, 2026\nAmount: $6,144.00 (billed to Visa ending 4417)\n\nNeed to change seats before you're billed?";
    expect(handled("renew", "Pagewise Team plan renews ($6,144.00)", "Renewal date: November 18, 2026", PAGEWISE)).toBe(true);
    const CREATIX = "Hola, Diego:\n\nTu suscripción anual a Creatix Cloud se renovará automáticamente el 19 de noviembre de 2026.\n\nSi quieres cambiar de plan o cancelar sin penalización, hazlo antes de la fecha de renovación. Después de esa fecha, cancelar implica una tarifa del 50% del compromiso restante.";
    expect(handled("renew", "Cambiar o cancelar Creatix Cloud antes del 19 nov", "se renovará automáticamente el 19 de noviembre de 2026", CREATIX)).toBe(true);
    // a bill charged by itself (iteration 4's AutoPay), its sentence in a paragraph of its own pointing to the due date
    const AUTOPAY = "Hi Maria,\n\nAmount due: $142.67\nDue date: November 8, 2026\n\nAutoPay is on. We'll charge your Visa ending 2291 on the due date.";
    expect(handled("pay", "Pay $142.67 for the Brightline bill", "Due date: November 8, 2026", AUTOPAY)).toBe(true);
  });

  it("an invoice the mail says is paid; mixed invoices keep the one still due, and a partial payment keeps the balance", () => {
    expect(handled("pay", "Pay $500.00 for the Northwind invoice", "Invoice 2231 for $500.00 was due November 20", "Invoice 2231 for $500.00 was due November 20. It has been paid in full. Thank you!")).toBe(true);
    expect(handled("pay", "Pagar $500.00 de la factura de Northwind", "La factura 2231 por $500.00 vencía el 20 de noviembre", "La factura 2231 por $500.00 vencía el 20 de noviembre. Ya está pagada en su totalidad.")).toBe(true);
    // two invoices: the paid one's sentence names another number and amount
    const MIXED = "Hello,\n\nInvoice 2231 ($500.00) has been paid. Invoice 2240 ($300.00) is due November 30. Please pay it by then.";
    expect(handled("pay", "Pay $300.00 for the Northwind invoice", "Invoice 2240 ($300.00) is due November 30", MIXED)).toBe(false);
    expect(handled("pay", "Pay $500.00 for the Northwind invoice", "Invoice 2231 ($500.00) has been paid", MIXED)).toBe(true);
    // a part paid: the rest is still due
    const PARTIAL = "We received your payment of $200.00. A balance of $300.00 remains, due November 30.";
    expect(handled("pay", "Pay $300.00 for the Northwind invoice", "A balance of $300.00 remains, due November 30", PARTIAL)).toBe(false);
    expect(handled("pay", "Pagar $300.00 de Northwind", "Queda un saldo pendiente de $300.00 con vencimiento el 30 de noviembre", "Recibimos tu pago de $200.00. Queda un saldo pendiente de $300.00 con vencimiento el 30 de noviembre.")).toBe(false);
  });

  it("iteration 5's code review (point 1): another invoice paid, said in generic words, never pays this one", () => {
    // the shared noun and "your" pick out nothing; the month says it's another period's
    const TWO = "Your October invoice has been paid in full. Your November invoice for $300 is due November 30.";
    expect(handled("pay", "Pay $300 for the November invoice", "Your November invoice for $300 is due November 30", TWO)).toBe(false);
    expect(handled("pay", "Pay $300 for the November invoice", "Your November invoice for $300 is due November 30", "Your November invoice for $300 is due November 30. Your previous invoice has been paid in full.")).toBe(false);
    expect(handled("pay", "Pay the Northwind invoice", "Your invoice is due November 30", "Hello,\n\nYour invoice is due November 30.\n\nThank you for your payment last month.")).toBe(false);
    expect(handled("pay", "Pagar la factura de noviembre ($300)", "Tu factura de noviembre por $300 vence el 30 de noviembre", "Tu factura de octubre ya está pagada. Tu factura de noviembre por $300 vence el 30 de noviembre.")).toBe(false);
    // its own words still say it: its number, its amount, or the sentence right after its own
    expect(handled("pay", "Pay $300 for the November invoice", "Your November invoice for $300 is due November 30", "Your November invoice for $300 is due November 30. The $300 has been paid in full.")).toBe(true);
  });

  it("a fee, a condition or a negation is no affirmation: \"we will charge a late fee unless paid\" is a bill to pay", () => {
    expect(handled("pay", "Pay the Northwind invoice", "Your invoice is due November 20", "Your invoice is due November 20. We will charge a $25 late fee unless it's paid by then.")).toBe(false);
    expect(handled("pay", "Pay the Northwind invoice", "Your invoice is due November 20", "Your invoice is due November 20. If you've set up AutoPay, we'll charge your card on file that day.")).toBe(false);
    expect(handled("pay", "Pay the Marlow County installment", "Due: Friday, November 20, 2026", "Due: Friday, November 20, 2026\n\nYour installment is not paid automatically. You can pay online.")).toBe(false);
    expect(handled("renew", "Renew the Appvault membership ($99)", "expires on Dec 10, 2026", "Your Appvault membership expires on Dec 10, 2026. Renew it before it expires. If you have automatic renewal turned on, no action is needed.")).toBe(false);
    // an offer to set it up isn't it being on
    expect(handled("pay", "Pay $54.20 for the electricity bill", "due on November 20", "Your electricity bill of $54.20 is due on November 20. Set up AutoPay so your bill is paid automatically.")).toBe(false);
  });

  it("what still needs the reader vetoes it: auto-renew off, a lapse, a failed charge, an expired card, a trial to decide on", () => {
    expect(handled("renew", "Renew pingwire.dev", "expires on December 7, 2026", "Your domain pingwire.dev expires on December 7, 2026. Auto-renew is off for this domain.")).toBe(false);
    expect(handled("renew", "Renovar estudioramirez.mx", "vence el martes 8 de diciembre de 2026", "Tu dominio vence el martes 8 de diciembre de 2026. Tienes la renovación automática desactivada.")).toBe(false);
    expect(handled("pay", "Pay $84.20 for the Brightline bill", "on November 20", "AutoPay is on, but we tried to charge your Visa for your bill of $84.20 on November 20 and the payment was declined.")).toBe(false);
    expect(handled("renew", "Update the card for Loomcast", "will renew automatically on December 1", "Your plan will renew automatically on December 1. The card on file has expired: update your payment method before then.")).toBe(false);
    expect(handled("renew", "Cancel Notably Pro before Sunday or pay $14.99/month", "Your free trial ends Sunday", "Your free trial ends Sunday. After that it renews automatically at $14.99/month unless you cancel.")).toBe(false);
  });

  it("only its own words: an AutoPay line about another account, or a footer about other customers, isn't this item's", () => {
    const TWO = "Your water bill of $61.00 is due on November 20.\n\nYour electricity account ending 7730: AutoPay is on, $54.20 will be charged automatically.";
    expect(handled("pay", "Pay $61.00 for the water bill", "Your water bill of $61.00 is due on November 20", TWO)).toBe(false);
    expect(handled("pay", "Pay the water bill", "Your water bill is due on November 20", "Your water bill is due on November 20.\n\nCustomers enrolled in AutoPay are charged automatically each month.")).toBe(false);
    // an event, a request: never
    expect(handled("event", "Gala", "will renew automatically", "Your membership will renew automatically on December 1.")).toBe(false);
  });
});
