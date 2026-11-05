import { describe, expect, it } from "vitest";
import { isOwnName, leadOfMail, readCorpus, reduceMail, repeatedTrailers, TemplateFinder, trailerBlock, TrailerCounter, withoutTrailers, writtenText } from "./extract";
import { detectWritingLanguage } from "./language";
import { computeHabits, habitsOf, mailFeatures, mergeHabits, mergePhrases, phraseSteps, stockPhrases } from "./habits";
import { canonicalAuthored, classifyEdit, repeatedCorrections } from "./provenance";
import { scopeKeys, type SentMail } from "./types";

const AT = Date.UTC(2026, 10, 1);
const sent = (id: number, body: string, over: Partial<SentMail> = {}): SentMail => ({ id, to: [`p${id % 4}@x.test`], cc: [], at: AT - id, body, isReply: false, ...over });

const BODIES = Array.from({ length: 30 }, (_, i) => `Hi there,\n\nThat works for the ${["plan", "launch", "budget", "copy"][i % 4]}, thanks a lot for this!\n\nOn Friday Tom wrote:\n> hello ${i}\n\nBest,\nMe\n\n--\nMe\nFounder at Acme Inc`);
const MAILS = BODIES.map((b, i) => sent(i, b));

describe("what a learner in slices does gives what the whole-corpus functions give", () => {
  it("trailers, counted a message at a time", () => {
    const counter = new TrailerCounter();
    for (const body of BODIES) counter.add(writtenText(body));
    expect([...counter.trailers()].sort()).toEqual([...repeatedTrailers(BODIES)].sort());
  });

  it("the text, when trailers come off afterwards", () => {
    const counter = new TrailerCounter();
    const written = BODIES.map((b) => writtenText(b));
    for (const w of written) counter.add(w);
    const trailers = counter.trailers();
    const stepped = MAILS.map((m, i) => reduceMail(m, withoutTrailers(written[i]!, trailers)));
    expect(stepped).toEqual(readCorpus(MAILS));
  });

  it("habits from features, phrases by steps", () => {
    const mails = readCorpus(MAILS);
    expect(habitsOf(mails.map(mailFeatures))).toEqual(computeHabits(mails));
    const steps = phraseSteps(mails);
    let yields = 0;
    let step = steps.next();
    while (!step.done) {
      yields++;
      step = steps.next();
    }
    expect(step.value).toEqual(stockPhrases(mails));
    expect(yields).toBeGreaterThanOrEqual(mails.length);
  });
});

describe("'you' from the accounts", () => {
  const a = computeHabits(readCorpus(Array.from({ length: 30 }, (_, i) => sent(i, "Thanks!\n\nThat works for me"))));
  const b = computeHabits(readCorpus(Array.from({ length: 10 }, (_, i) => sent(i, "Hola Ana,\n\nMe parece muy bien todo lo que me cuentas sobre esto, un saludo muy cordial para ti"))));

  it("weighs by volume: the bigger account decides the median, rates are exact", () => {
    const m = mergeHabits([a, b]);
    expect(m.messages).toBe(40);
    expect(m.words.median).toBe(a.words.median);
    expect(m.exclamation).toBeCloseTo((a.exclamation * 30 + b.exclamation * 10) / 40, 2);
    expect(m.oneToOne).toBe(1);
    expect(m.languages.reduce((n, l) => n + l.share, 0)).toBeLessThanOrEqual(1.01);
  });

  it("one account is itself, and none is nothing", () => {
    const one = mergeHabits([a]);
    expect(one.words).toEqual(a.words);
    expect(one.exclamation).toBe(a.exclamation);
    expect(mergeHabits([]).messages).toBe(0);
  });

  it("phrases in more accounts come first, once each, whatever the case", () => {
    expect(mergePhrases([["Let me know", "only here"], ["let me know", "and here"]])).toEqual(["Let me know", "only here", "and here"]);
    expect(mergePhrases([Array.from({ length: 30 }, (_, i) => `p${i}`)]).length).toBe(20);
  });
});

describe("provenance's comparison (§8)", () => {
  it("line endings, trailing space and blank runs aren't editing; a word is", () => {
    const form = "Hi Tom,\n\nThat works.";
    expect(canonicalAuthored("Hi Tom,\r\n\r\n\r\nThat works.  \n\n")).toBe(form);
    expect(canonicalAuthored("  Hi Tom, \n\nThat works.\n".trim())).toBe(form);
    expect(canonicalAuthored("Hi Tom,\n\nThat works!")).not.toBe(form);
  });

  it("says what changed in manner, never what the mail's about", () => {
    const generated = "Hi Tom,\n\nThat works, thanks for sending it over today!\n\nBest,\nMe";
    expect(classifyEdit(generated, "That works, thanks for sending it over today!\n\nBest,\nMe").map((c) => c.kind)).toEqual(["dropped-greeting"]);
    expect(classifyEdit(generated, "Hey Tom,\n\nThat works, thanks for sending it over today!\n\nBest,\nMe")[0]).toMatchObject({ kind: "changed-greeting" });
    expect(classifyEdit(generated, "Hi Tom,\n\nThat works, thanks for sending it over today!", ["Me"]).map((c) => c.kind)).toContain("dropped-sign-off");
    expect(classifyEdit(generated, generated.replace("Best,", "Cheers,"), ["Me"])[0]).toMatchObject({ kind: "changed-sign-off", value: "Cheers,\nMe" });
    expect(classifyEdit(generated, generated.replace("!", ".")).map((c) => c.kind)).toEqual(["removed-exclamation"]);
    expect(classifyEdit(generated, "Hi Tom,\n\nFine.\n\nBest,\nMe").map((c) => c.kind)).toContain("shorter");
    expect(classifyEdit("One two three four five six seven eight nine ten", `${"One two three four five six seven eight nine ten "}eleven twelve thirteen fourteen`).map((c) => c.kind)).toEqual(["longer"]);
    expect(classifyEdit(generated, generated)).toEqual([]);
  });

  it("a change counts from the third time, and backs off when it stops recurring", () => {
    const dropped = { generated: "Hi Tom,\n\nThat works.", final: "That works." };
    const kept = { generated: "Hi Tom,\n\nThat works.", final: "Hi Tom,\n\nWorks." };
    expect(repeatedCorrections([dropped, dropped])).toEqual([]);
    expect(repeatedCorrections([dropped, dropped, dropped])).toEqual(["when editing drafts they remove the greeting (3 times)"]);
    expect(repeatedCorrections([kept, dropped, kept, dropped, dropped])).toEqual(["when editing drafts they remove the greeting (3 times)"]);
    // newest first: six newer pairs without it
    expect(repeatedCorrections([kept, kept, kept, kept, kept, kept, dropped, dropped, dropped])).toEqual([]);
  });

  it("different changes of the same kind don't add up", () => {
    const to = (greeting: string) => ({ generated: "Hi Tom,\n\nThat works.", final: `${greeting},\n\nThat works.` });
    expect(repeatedCorrections([to("Hey Tom"), to("Dear Tom"), to("Hello Tom")])).toEqual([]);
  });
});

describe("scope keys", () => {
  it("is the one format, lowercased", () => {
    expect(scopeKeys.you).toBe("you");
    expect(scopeKeys.account(3)).toBe("account:3");
    expect(scopeKeys.domain(3, "ACME.com")).toBe("domain:3:acme.com");
    expect(scopeKeys.person(3, "Tom@Acme.com")).toBe("person:3:tom@acme.com");
  });
});

describe("what real mailboxes hold", () => {
  const PITCH = "Our platform helps legal teams find verifiable citations in minutes instead of hours, and it drafts documents from the case law your team already relies on every single day of the week.";

  it("finds mail merge: the same words to many people, whatever the name on top", () => {
    const finder = new TemplateFinder();
    for (let i = 0; i < 5; i++) finder.add(i, [`p${i}@x.test`], `Dear Person${i},\n\n${PITCH}\n\nBest,\nMe\nFounder of X`);
    finder.add(9, ["real@x.test"], "Hi Ana,\n\nThe contract you sent on Friday looks fine to me, so please go ahead with it and tell the team that we can start whenever they like next month.\n\nThanks,\nMe");
    expect([...finder.found()].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("the same words to one person, however often, are just how they talk", () => {
    const finder = new TemplateFinder();
    for (let i = 0; i < 6; i++) finder.add(i, ["same@x.test"], `Hello,\n\n${PITCH}\n\nBest,\nMe\nFounder of X`);
    expect(finder.found().size).toBe(0);
  });

  it("a signature shared by short replies doesn't make them templates", () => {
    const finder = new TemplateFinder();
    const signature = "Saludos,\nLuis Ejemplo Ejemplar de la Cruz\nCo-Fundador de la Empresa de Ejemplo Grande";
    const said = [
      "Listo, ya quedó lo que me pidió ayer en la tarde sobre su cuenta de la plataforma, me avisa cualquier cosa si no le aparece.",
      "Sí tenemos espacio para las tres de la tarde, voy a actualizar el evento del calendario para el mismo día del mes.",
      "Puede pagar dentro de la plataforma usando otra tarjeta, por el momento no aceptamos transferencias de ningún banco del país.",
      "Ya le reenvié la factura de agosto, revise la carpeta de correo no deseado porque a lo mejor ahí fue a dar.",
      "No deja de pensar, puede moverse a otros chats e incluso a otras partes y ese chat sigue trabajando en el fondo.",
      "Gracias por la respuesta, parece que se nos escapó un correo hacia ustedes de parte del equipo de ventas la semana pasada.",
    ];
    said.forEach((text, i) => finder.add(i, [`p${i}@x.test`], `Hola Persona${i},\n${text}\n${signature}`));
    expect(finder.found().size).toBe(0);
  });

  const PERSONAL = [
    "The contract you sent on Friday looks fine to me, so please go ahead with it and tell the team that we can start whenever they like next month.",
    "I can't make it to the dinner on Saturday because my sister is visiting from out of town, but I'd love to see everyone again very soon.",
    "The car needs new brakes before the long drive, and the garage on the corner says they can have it ready by Thursday afternoon at the latest.",
    "Your photos from the wedding came out beautifully, especially the ones by the lake, and my parents have already asked for prints of two of them.",
    "We moved the kids' swimming lessons to Tuesdays this term, which means I can finally pick them up on the way back home from the office.",
  ];
  const LONG = "Ana Ejemplo\nDirector of Operations\nEjemplo Holdings Inc\n100 Main Street, Suite 400\nSpringfield, 12345\n+1 555 0100\nwww.ejemplo.test";
  const FOOTER = "This email and any files transmitted with it are confidential and intended solely for the use of the individual or entity to whom they are addressed, and if you have received this email in error please notify the sender.";

  it("a long signature on otherwise personal mail isn't a template, with a closing or without", () => {
    for (const end of [`Best,\n${LONG}\n${FOOTER}`, LONG]) {
      const finder = new TemplateFinder();
      PERSONAL.forEach((text, i) => finder.add(i, [`p${i}@x.test`], `Hi Person${i},\n\n${text}\n\n${end}`));
      expect(finder.found().size).toBe(0);
    }
  });

  it("a template under the same long signature still is", () => {
    const finder = new TemplateFinder();
    for (let i = 0; i < 5; i++) finder.add(i, [`p${i}@x.test`], `Dear Person${i},\n\n${PITCH}\n\nBest,\n${LONG}\n${FOOTER}`);
    expect(finder.found().size).toBe(5);
  });

  it("works through a window in steps", () => {
    const finder = new TemplateFinder();
    for (let i = 0; i < 5; i++) finder.add(i, [`p${i}@x.test`], `Dear Person${i},\n\n${PITCH}`);
    const steps = finder.steps();
    let yields = 0;
    let step = steps.next();
    while (!step.done) {
      yields++;
      step = steps.next();
    }
    expect(yields).toBe(5);
    expect(step.value.size).toBe(5);
  });

  it("their own name isn't a turn of phrase, in whole or in part", () => {
    const self = ["Ana María Ejemplo Pérez", "ana"];
    expect(isOwnName("Ana María Ejemplo", self)).toBe(true);
    expect(isOwnName("ana maria ejemplo perez", self)).toBe(true);
    expect(isOwnName("Espero que se encuentre", self)).toBe(false);
  });

  it("an attachment's placeholder doesn't hide the signature above it", () => {
    expect(writtenText("Hola\n\nLuis Ejemplo\n\uFFFC\uFFFC")).toBe("Hola\n\nLuis Ejemplo");
    expect(writtenText("\uFEFFHola")).toBe("Hola");
  });

  it("gives back the block a trailer took off, as typed", () => {
    const trailers = new Set(["Luis Ejemplo Ejemplar", "Co-Fundador de Ejemplo"]);
    const text = "Hola\n\nSaludos,\nLuis  Ejemplo Ejemplar\nCo-Fundador de Ejemplo";
    expect(withoutTrailers(text, trailers)).toBe("Hola\n\nSaludos,");
    expect(trailerBlock(text, trailers)).toBe("Luis Ejemplo Ejemplar\nCo-Fundador de Ejemplo");
    expect(trailerBlock("Hola\n\nSaludos,", trailers)).toBeNull();
  });

  it("a short acknowledgement says its language in the closing", () => {
    expect(detectWritingLanguage(leadOfMail("Hi Luis,\n\nThanks for sending!"))).toBe("en");
    expect(detectWritingLanguage(leadOfMail("Hola Ana,\n\nGracias por avisar."))).toBe("es");
  });

  it("reads a mail's language from what comes before they sign, not the footer", () => {
    const footer = "This email and any files transmitted with it are confidential and intended for the use of the addressee. If you have received this email in error please notify the sender and delete it from your system.";
    const mail = `Buen día Ana\n\nQuería consultarle si de por casualidad le queda la grabación de la sesión con el equipo?\n\nMuchas gracias.\nSaludos,\n\nPaula Ejemplo\nLegal Operations\n\n${footer}`;
    expect(detectWritingLanguage(mail)).toBe("en");
    expect(detectWritingLanguage(leadOfMail(mail))).toBe("es");
    expect(detectWritingLanguage(leadOfMail(`Thanks for this, it looks right to me and we will have it on the list.\n\nBest,\nAna\n\nAviso de confidencialidad: este correo es para su destinatario y no para otras personas de la empresa.`))).toBe("en");
  });
});
