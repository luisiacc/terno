import { describe, expect, it } from "vitest";
import { bodyAction, bodyReady, readBody, settleBody, type BodyRead } from "./body";

const kind = (text: string, o?: { images?: boolean }) => readBody(text, o).kind;
const gapsOf = (text: string) => readBody(text).gaps.map((g) => g.text);
const maybeOf = (text: string) => readBody(text).maybe.map((g) => g.text);

describe("readBody: instruction or email (plan 163)", () => {
  it("nothing is the one-tap draft", () => {
    expect(kind("")).toBe("empty");
    expect(kind("  \n\n ")).toBe("empty");
    expect(bodyAction(readBody(""))).toBe("oneTap");
  });

  it("the owner's two examples", () => {
    const order = readBody("friday works for me, ask him to send the address of the flat");
    expect([order.kind, order.rule]).toEqual(["instruction", "directive"]);
    expect(bodyAction(order)).toBe("write");
    const draft = readBody("Hi Arjun, the flat's address is [address from his last mail], see you [day we agreed]");
    expect([draft.kind, draft.rule]).toEqual(["email", "greeting"]);
    expect(draft.gaps.map((g) => g.text)).toEqual(["[address from his last mail]", "[day we agreed]"]);
    expect(bodyAction(draft)).toBe("fill");
  });

  it.each([
    "tell tom that this is just fine",
    "Tell Tom that this is just fine",
    "say yes, thursday at 4 works",
    "let them know the 19th is fine",
    "thanks for the notes, remind her the contract ends in March",
    "reply that the invoice is paid",
    "thank Ana for the photos and ask about the next event",
    "Please tell Tom the 19th is fine",
  ])("an instruction in English: %s", (text) => {
    expect(kind(text)).toBe("instruction");
  });

  it.each([
    "dile que sí, el viernes me viene bien",
    "pregúntale si puede mandar la dirección del departamento",
    "Pídele la factura de marzo",
    "el viernes me sirve, avísale a Arjun",
    "responde que ya lo revisé y está bien",
    "di que no puedo esa semana",
    "agradécele por las fotos",
  ])("an instruction in Spanish: %s", (text) => {
    expect(kind(text)).toBe("instruction");
  });

  it.each([
    "Tell me what you think about the draft when you have a minute, and whether the dates work for the team.",
    "Thank you for the photos, they look great and the team loved them, I'll share them around on Monday.",
    "Let me know if Friday works for you, otherwise we can move it to the week after without trouble.",
    "Write back when you can, there's no rush on this one at all and the rest can wait for later.",
  ])("speaking to the reader isn't an instruction: %s", (text) => {
    expect(kind(text)).not.toBe("instruction");
  });

  it("brevity decides nothing: a short email to the reader, or a short note, goes to the fast model (Codex review 1)", () => {
    expect(kind("Friday works for me. Can you send the address?")).toBe("unsure");
    expect(kind("El viernes me viene bien, ¿me pasas la dirección?")).toBe("unsure");
    expect(kind("sounds good, see you friday")).toBe("unsure");
    expect(kind("el jueves a las 4 me viene bien")).toBe("unsure");
    expect(kind("please decline politely, I'm away that week")).toBe("unsure");
  });

  it("a bare imperative could be to the reader: with a gap it's the user's email (Codex review 1)", () => {
    const read = readBody("Confirm the appointment at [time] please");
    expect([read.kind, bodyAction(read)]).toEqual(["email", "fill"]);
  });

  it("a greeting or a sign-off makes it the user's email", () => {
    expect(readBody("Hi Tom,\n\nThat works for me.").rule).toBe("greeting");
    expect(readBody("Hola Arjun:\nEl viernes me sirve.").rule).toBe("greeting");
    expect(readBody("Estimada Sra. Ferrer, le escribo por el contrato.").rule).toBe("greeting");
    expect(readBody("That works for me, see you then.\n\nThanks,\nLuis").rule).toBe("signoff");
    expect(readBody("El viernes me sirve.\nUn abrazo").rule).toBe("signoff");
    expect(bodyAction(readBody("Hi Tom,\n\nThat works for me."))).toBe("expand");
  });

  it("\"hey can you…\" isn't a greeting line, and speaks to someone: the model decides", () => {
    expect(readBody("hey can you tell him friday works").kind).toBe("unsure");
  });

  it("an image, a long text or three paragraphs are the user's email", () => {
    expect(readBody("tell him yes", { images: true }).rule).toBe("image");
    expect(readBody(`tell him ${"yes ".repeat(300)}`).rule).toBe("long");
    expect(readBody("one thing.\n\nanother.\n\nand a third.").rule).toBe("paragraphs");
    expect(readBody("", { images: true }).kind).toBe("email");
  });

  it("mixed: a greeting, a gap and an instruction sentence is the email; only the gap is filled", () => {
    const read = readBody("Hi Arjun,\n\nThe address is [address]. also ask him about parking\n\nLuis");
    expect(read.kind).toBe("email");
    expect(read.gaps.map((g) => g.text)).toEqual(["[address]"]);
    expect(bodyAction(read)).toBe("fill");
  });

  it("an instruction keeps its brackets as part of what to say", () => {
    const read = readBody("tell him the address is [from his last mail]");
    expect(read.kind).toBe("instruction");
    expect(bodyAction(read)).toBe("write");
  });

  it("a gap without a greeting is still the user's text with a hole in it", () => {
    const read = readBody("The flat is at [address] and the key is with the porter until six in the evening on Friday.");
    expect([read.kind, read.rule]).toEqual(["email", "gap"]);
  });

  it("longer, with nothing to go on, is unsure: the fast model is asked", () => {
    const read = readBody("I'm happy to go ahead with the contract as it is. Nothing in it changes what we agreed, so the 19th is fine.");
    expect(read.kind).toBe("unsure");
    expect(bodyAction(read)).toBe("ask");
  });
});

describe("readBody: what counts as a gap (plan 163)", () => {
  it("brackets with words or nothing, never a link, a footnote or a task box", () => {
    expect(gapsOf("Hi, see you [day] at [ ] or […] or [...] with [NAME]")).toEqual(["[day]", "[ ]", "[…]", "[...]", "[NAME]"]);
    expect(gapsOf("Hi, the doc is [here](https://example.com) and see note [1].")).toEqual([]);
    expect(gapsOf("Hi,\n- [ ] buy milk\n- [x] send it")).toEqual([]);
    expect(gapsOf("Hi, the date is []")).toEqual(["[]"]);
  });

  it("double braces are certain; a single pair holding a short name only maybe; never code (Codex review 10)", () => {
    expect(gapsOf("Hi {first name}, see {{date}}")).toEqual(["{{date}}"]);
    expect(maybeOf("Hi {first name}, see you\nLuis")).toEqual(["{first name}"]);
    expect(maybeOf('Hi, send {"a": 1} and function() { return 1 } or {12}\nLuis')).toEqual([]);
  });

  it("[sic] is a writer's mark, not a hole; a bare XX may be twenty (Codex review 10)", () => {
    expect(gapsOf("Hi, he wrote \"their\" [sic] and Super Bowl XX")).toEqual([]);
    expect(maybeOf("Hi, he wrote \"their\" [sic] and Super Bowl XX\nLuis")).toEqual(["XX"]);
  });

  it("double angle brackets, runs of X and underscores", () => {
    expect(gapsOf("Hi, the address is <<address>>")).toEqual(["<<address>>"]);
    expect(gapsOf("Hi, it costs $XX and is on XX/XX/XXXX at XX:XX, ref XXX")).toEqual(["$XX", "XX/XX/XXXX", "XX:XX", "XXX"]);
    expect(gapsOf("Hi, size XXL, a XXX-rated film")).toEqual([]);
    expect(gapsOf("Hi, call ___ before noon")).toEqual(["___"]);
  });

  it("maybe-gaps: an ellipsis standing alone, ??, TBD, xx; never kisses on the last line", () => {
    expect(maybeOf("Hi Arjun,\nsee you … at the flat, address: ... and the time ?? TBD, ref xx\nLuis")).toEqual(["…", "...", "??", "TBD", "xx"]);
    expect(maybeOf("Hi Bea,\nwell... I don't know, really??\n\nlove, Ivy xx")).toEqual([]);
    expect(bodyAction(readBody("Hi Arjun,\nsee you … at the flat"))).toBe("ask");
  });

  it("gaps marked the certain way make a stray ellipsis punctuation", () => {
    const read = readBody("Hi Arjun, see you … at [address]");
    expect(read.gaps.map((g) => g.text)).toEqual(["[address]"]);
    expect(read.maybe).toEqual([]);
  });

  it("positions are the text's own", () => {
    const text = "Hi Arjun, the address is [address].";
    const [gap] = readBody(text).gaps;
    expect(text.slice(gap!.from, gap!.to)).toBe("[address]");
  });

  it("Spanish brackets", () => {
    expect(gapsOf("Hola Arjun, la dirección es [dirección de su último correo] y nos vemos el [día que acordamos]")).toEqual(["[dirección de su último correo]", "[día que acordamos]"]);
  });
});

describe("settleBody: after the fast model, or without it", () => {
  const unsure = readBody("I'm happy to go ahead with the contract as it is. Nothing in it changes what we agreed, so the 19th is fine.");
  const maybe: BodyRead = readBody("Hi Arjun,\nsee you … at the flat, around ??");

  it("unsure becomes what the model said, or an email without it", () => {
    expect(settleBody(unsure, { kind: "instruction", gaps: [] }).action).toBe("write");
    expect(settleBody(unsure, { kind: "email", gaps: [] }).action).toBe("expand");
    expect(settleBody(unsure, null).action).toBe("expand");
  });

  it("maybe-gaps are filled only where the model said so; the rules' email stays an email", () => {
    expect(settleBody(maybe, { kind: "email", gaps: [1] }).gaps.map((g) => g.text)).toEqual(["??"]);
    expect(settleBody(maybe, { kind: "instruction", gaps: [0] }).action).toBe("fill");
    expect(settleBody(maybe, null)).toEqual({ action: "expand", gaps: [] });
    expect(settleBody(maybe, { kind: "email", gaps: [7] }).action).toBe("expand");
  });
});

describe("bodyReady: the Sparkles' glance", () => {
  it("lit for an instruction or a certain gap; quiet for an ordinary email or nothing", () => {
    expect(bodyReady("tell him friday works")).toBe("write");
    expect(bodyReady("Hi Arjun, see you [day]")).toBe("fill");
    expect(bodyReady("Hi Arjun,\n\nFriday works for me. See you then.\n\nLuis")).toBeNull();
    expect(bodyReady("")).toBeNull();
    expect(bodyReady("Hi Arjun,\nsee you … at the flat")).toBeNull();
    expect(bodyReady("Friday works for me. Can you send the address?")).toBeNull();
  });

  it("bounded: 100,000 characters read in a few milliseconds", () => {
    const text = `Hi Arjun,\n\n${"Friday works for me, [x] the flat is ready … see you XX ___. ".repeat(1700)}`;
    const t0 = performance.now();
    readBody(text);
    bodyReady(text);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
