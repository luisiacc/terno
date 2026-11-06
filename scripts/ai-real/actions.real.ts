import { describe, expect, it } from "vitest";
import { realTasks, spendReport } from "./harness";

/**
 * Plan 143's eval: the planner on 40 sentences in English and Spanish, and the check on a labelled set of groups, under
 * the harness's hard cap, on synthetic mail only. Needs the owner's go-ahead: run alone with TERNO_AI_ACTIONS=1.
 * Precision on trash and spam is the bar: a row it keeps there that doesn't fit is mail thrown away.
 */
interface Sentence { text: string; action: string; meaning: boolean; future?: boolean; refuse?: boolean }
const SENTENCES: Sentence[] = [
  { text: "Archive shipping notices older than a month, except Amazon", action: "archive", meaning: true },
  { text: "Send recruiters to a Recruiting category", action: "createCategory", meaning: true, future: true },
  { text: "Archive everything from ups.com", action: "archive", meaning: false },
  { text: "Delete mail from noreply@spam.test", action: "trash", meaning: false },
  { text: "Mark newsletters as read", action: "markRead", meaning: true },
  { text: "Star mail from my accountant at books.test", action: "star", meaning: false },
  { text: "Mark everything from lottery-win.test as spam", action: "spam", meaning: false },
  { text: "Trash old calendar invitations", action: "trash", meaning: true },
  { text: "Always archive receipts from uber.com", action: "archive", meaning: false, future: true },
  { text: "From now on send invoices to Work", action: "moveToCategory", meaning: true, future: true },
  { text: "Move flight confirmations to Work", action: "moveToCategory", meaning: true },
  { text: "Move my bank statements to the Old folder", action: "moveToFolder", meaning: true },
  { text: "Archive promotions older than two weeks", action: "archive", meaning: true },
  { text: "Delete social notifications", action: "trash", meaning: true },
  { text: "Mark as read anything with Unsubscribe in the subject", action: "markRead", meaning: false },
  { text: "Forward recruiters to my boss", action: "other", meaning: true, refuse: true },
  { text: "Unsubscribe me from everything", action: "other", meaning: true, refuse: true },
  { text: "Remind me about invoices on Friday", action: "other", meaning: true, refuse: true },
  { text: "Archive mail with attachments from acme.test", action: "archive", meaning: false },
  { text: "Trash password reset emails", action: "trash", meaning: true },
  { text: "Archiva los avisos de envío de hace más de un mes, excepto Amazon", action: "archive", meaning: true },
  { text: "Manda a los reclutadores a una categoría Reclutamiento", action: "createCategory", meaning: true, future: true },
  { text: "Archiva todo lo de correos.es", action: "archive", meaning: false },
  { text: "Borra el correo de noreply@spam.test", action: "trash", meaning: false },
  { text: "Marca los boletines como leídos", action: "markRead", meaning: true },
  { text: "Destaca lo que venga de mi contable en books.test", action: "star", meaning: false },
  { text: "Marca como spam todo lo de premio-gordo.test", action: "spam", meaning: false },
  { text: "Borra las invitaciones de calendario antiguas", action: "trash", meaning: true },
  { text: "Archiva siempre los recibos de uber.com", action: "archive", meaning: false, future: true },
  { text: "A partir de ahora manda las facturas a Work", action: "moveToCategory", meaning: true, future: true },
  { text: "Mueve las confirmaciones de vuelo a Work", action: "moveToCategory", meaning: true },
  { text: "Mueve mis extractos bancarios a la carpeta Old", action: "moveToFolder", meaning: true },
  { text: "Archiva las promociones de hace más de dos semanas", action: "archive", meaning: true },
  { text: "Borra las notificaciones de redes sociales", action: "trash", meaning: true },
  { text: "Marca como leído lo que tenga Oferta en el asunto", action: "markRead", meaning: false },
  { text: "Reenvía los reclutadores a mi jefe", action: "other", meaning: true, refuse: true },
  { text: "Date de baja de todo", action: "other", meaning: true, refuse: true },
  { text: "Recuérdame las facturas el viernes", action: "other", meaning: true, refuse: true },
  { text: "Archiva el correo con adjuntos de acme.test", action: "archive", meaning: false },
  { text: "Borra los correos de restablecer la contraseña", action: "trash", meaning: true },
];

/** a meaning, the groups that fit it, and the ones a broad rule also catches */
const CHECKS = [
  { sentence: "Trash shipping notices", fit: [["UPS", "ups.com", "your parcel is on its way"], ["DHL", "dhl.com", "delivery scheduled for #"], ["FedEx", "fedex.com", "tracking number #"]], not: [["Ana Ruiz", "acme.test", "shipping the prototype to the client"], ["Tom", "studio.test", "who is delivering the talk?"]] },
  { sentence: "Mark recruiters as spam", fit: [["Sara from TalentCo", "talentco.test", "an exciting role at a fast growing startup"], ["Hiring Team", "jobs.test", "your profile caught our eye"]], not: [["Mum", "gmail.com", "are you coming on sunday"], ["HR", "myemployer.test", "open enrollment for benefits"]] },
  { sentence: "Borra los avisos de envío", fit: [["Correos", "correos.es", "tu paquete está en camino"], ["SEUR", "seur.com", "entrega prevista el #"]], not: [["Marta", "estudio.test", "te envío el presupuesto"], ["Juan", "acme.test", "envío de la propuesta al cliente"]] },
];

describe.skipIf(process.env.TERNO_AI_ACTIONS !== "1")("actions in plain English on a small model", () => {
  const tasks = () => realTasks({ provider: "anthropic", model: "claude-haiku-5-5" }, "actions-eval");
  const input = (sentence: string) => ({
    sentence,
    today: "2026-03-02",
    timezone: "UTC",
    accounts: [{ id: 1, email: "me@example.com", displayName: "Me" }],
    categories: [{ id: 7, name: "Work" }],
    folders: [{ accountId: 1, key: "Old", name: "Old" }],
    now: Date.UTC(2026, 2, 2),
  });

  it("plans the right action, tells meanings from words, refuses what's not on the list", async () => {
    let rightAction = 0, rightMeaning = 0, rightFuture = 0, refused = 0;
    const toRefuse = SENTENCES.filter((s) => s.refuse).length;
    for (const s of SENTENCES) {
      const plan = await tasks().planAction(input(s.text));
      if (s.refuse) {
        if (plan === null) refused++;
        continue;
      }
      if (plan?.action.type === s.action) rightAction++;
      if (plan?.meaning === s.meaning) rightMeaning++;
      if (plan?.future === (s.future ?? false)) rightFuture++;
    }
    const n = SENTENCES.length - toRefuse;
    process.stderr.write(`right action ${rightAction}/${n}, meaning ${rightMeaning}/${n}, future ${rightFuture}/${n}, refused ${refused}/${toRefuse}\n${spendReport()}\n`);
    expect(refused).toBe(toRefuse);
    expect(rightAction / n).toBeGreaterThanOrEqual(0.9);
  }, 600_000);

  it("the check removes what doesn't fit and keeps what does", async () => {
    let keptFit = 0, fit = 0, keptWrong = 0, wrong = 0;
    for (const c of CHECKS) {
      const groups = [...c.fit, ...c.not].map(([name, domain, subject], i) => ({ label: `g${i + 1}`, name: name!, domain: domain!, subject: subject!, count: 3 }));
      const drop = new Set(await tasks().checkCandidates({ sentence: c.sentence, groups }, { outputTokens: 500, budget: { left: 6 } }));
      groups.forEach((g, i) => {
        const fits = i < c.fit.length;
        if (fits) {
          fit++;
          if (!drop.has(g.label)) keptFit++;
        } else {
          wrong++;
          if (!drop.has(g.label)) keptWrong++;
        }
      });
    }
    process.stderr.write(`kept what fits ${keptFit}/${fit}, kept what doesn't ${keptWrong}/${wrong}\n${spendReport()}\n`);
    expect(keptWrong / wrong).toBeLessThanOrEqual(0.1);
    expect(keptFit / fit).toBeGreaterThanOrEqual(0.8);
  }, 600_000);
});
