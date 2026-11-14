/**
 * Plan 204's eval, what it asks of an alert's words (prompt v7): what the mail says happened, never an instruction (in
 * English or Spanish, imperative or infinitive: the app's Spanish tasks are infinitives, "Pagar…"), never its own
 * attribution (the app adds it), and no amount or card digits the mail doesn't have. Pure, so its matchers have tests.
 */

const INSTRUCTION_EN = String.raw`reply|respond|click|tap|wire|transfer|send|pay|call|phone|verify|confirm|contact|log ?in|sign ?in|update|check with`;
// imperative (tú, usted) and infinitive, an enclitic allowed ("verificarla", "pagarlo")
const INSTRUCTION_ES = String.raw`respond(?:a|e|er)|contest(?:a|e|ar)|(?:haz|haga|hacer) clic|puls(?:a|e|ar)|transfier(?:a|e)|transferir|envi(?:a|e|ar)|enví(?:a|e)|pag(?:a|ue|ar)|llam(?:a|e|ar)|verific(?:a|ar)|verifique|confirm(?:a|e|ar)|contact(?:a|e|ar)|inici(?:a|e|ar) sesión|actualiz(?:a|ar)|actualice|consult(?:a|e|ar) con|deposit(?:a|e|ar)`;
// "no se actualiza", "no se pudo pagar", "hasta confirmar": a Spanish passive, impersonal or infinitive after a preposition says what happens, not what to do
const INSTRUCTION = new RegExp(`(?<![\\p{L}\\p{N}])(?<!(?<![\\p{L}])se )(?<!pudo )(?<!(?<![\\p{L}])(?:hasta|para|sin|al|de|por) )(?:${INSTRUCTION_EN}|${INSTRUCTION_ES})(?:l[oa]s?|le|les|me|nos)?(?![\\p{L}\\p{N}])`, "iu");

/** An alert that tells the reader to act: "Call the bank", "Pagar $1,249.99 para desbloquear la tarjeta". */
export const alertInstructs = (text: string): boolean => INSTRUCTION.test(text);

const SAYS = /(?<![\p{L}])(?:says|said|according|reports|claims|según|dice|informa|indica)(?![\p{L}])/iu;

/** An alert that says whose word it is: the app's job since prompt v7, so the model's text never does. */
export const alertAttributed = (text: string): boolean => SAYS.test(text);

const digits = (t: string) => t.replace(/[,.]/g, "");

/** Amounts and card or account digits in an alert that the mail doesn't have ("$1,249.99", "7730"); three digits or more. */
export function madeUpDetails(text: string, mail: string): string[] {
  const said = digits(mail);
  return (text.match(/\d[\d,.]*\d/g) ?? []).filter((n) => digits(n).length >= 3 && !said.includes(digits(n)));
}
