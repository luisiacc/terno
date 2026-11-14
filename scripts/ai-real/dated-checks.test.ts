import { describe, expect, it } from "vitest";
import { alertAttributed, alertInstructs, madeUpDetails } from "./dated-checks";

describe("the dated eval's alert checks (plan 204, the Codex code review of the fourth round)", () => {
  it("an instruction, in English or in Spanish, imperative or infinitive", () => {
    for (const text of [
      "Call the bank about the $412.18 charge",
      "Verify your identity to restore access",
      "Wire $48,210.55 by 1:00 PM",
      "Check with Tri-River about the frozen card",
      "Pagar $1,249.99 para desbloquear la tarjeta 7730",
      "Paga el saldo pendiente",
      "Pague antes del viernes",
      "Llamar al banco por el cargo",
      "Llama al número del reverso",
      "Verificar la cuenta en 24 horas",
      "Verifique su identidad",
      "Transferir $48,210.55 para la nómina",
      "Hacer clic en el enlace",
      "Haz clic para desbloquear",
      "Responder SÍ o NO al banco",
      "Contestar el mensaje del banco",
      "Consultar con Banco Andino el cargo",
      "Verificarla en la app",
    ]) expect(alertInstructs(text), text).toBe(true);
  });
  it("what happened isn't one, whatever its words hold", () => {
    for (const text of [
      "Debit card ending in 4821 frozen after a $412.18 charge",
      "Payroll funding of $48,210.55 failed for insufficient funds",
      "Online transfers paused on the account ending 3307",
      "Payment for Streamly declined",
      "Tarjeta de débito terminada en 4821 bloqueada tras un cargo de $412.18",
      "Débito de nómina de $48,210.55 rechazado por fondos insuficientes",
      "Pago de Streamly rechazado",
      "Cuenta suspendida por falta de pago",
      "El acceso se detendrá si no se actualiza el método de pago",
      "No se pudo pagar la nómina del 6 de marzo",
      "Tarjeta en espera hasta confirmar una compra de $482.10",
    ]) expect(alertInstructs(text), text).toBe(false);
  });
  it("its own attribution, which the app now adds", () => {
    expect(alertAttributed("Card frozen, the email says")).toBe(true);
    expect(alertAttributed("Tarjeta bloqueada, según el correo")).toBe(true);
    expect(alertAttributed("Card frozen after a $412.18 charge")).toBe(false);
    expect(alertAttributed("Tarjeta bloqueada tras un cargo de $412.18")).toBe(false);
  });
  it("amounts and digits the mail doesn't have", () => {
    const mail = "We detected an unauthorized charge of $1,249.99 on your card ending in 7730.";
    expect(madeUpDetails("Charge of $1,249.99 on card 7730", mail)).toEqual([]);
    expect(madeUpDetails("Cargo de $1.249,99 en la tarjeta 7730", mail)).toEqual([]);
    expect(madeUpDetails("Charge of $2,500.00 on card 7731", mail)).toEqual(["2,500.00", "7731"]);
    // two digits aren't a detail ("24 hours")
    expect(madeUpDetails("Locked for 48 hours", mail)).toEqual([]);
  });
});
