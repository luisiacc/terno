import { describe, expect, it } from "vitest";
import { normalizeText } from "../text";
import { evaluateRule, type RuleMessage } from "./evaluate";
import { checkPattern, patternMatches, patternTemplate, subjectGeneralizes, subjectKey, subjectPattern, subjectTemplate } from "./pattern";
import { compileRegex } from "./regex";

/** what the native engine says, for the subset both accept */
const native = (pattern: string, text: string) => new RegExp(pattern, "iu").test(text);

describe("the linear matcher (plan 84)", () => {
  const cases: [string, string[]][] = [
    ["pedido", ["tu pedido 1", "pedidos", "pedid", ""]],
    ["^tu pedido [0-9]+ esta en camino$", ["tu pedido 43790 esta en camino", "tu pedido x esta en camino", "re: tu pedido 1 esta en camino", "tu pedido 12 esta en camino ya"]],
    ["(?:factura|recibo)\\s+#?\\d{3,}", ["factura 1234", "recibo #998", "factura 12", "tu recibo  0001 listo"]],
    ["^(a|b)*c$", ["ababc", "c", "abab", "abcc"]],
    ["\\bpago\\b", ["el pago", "pagos", "apago", "pago."]],
    ["[^a-z0-9 ]", ["abc 123", "abc!", "ñ"]],
    ["colou?r", ["color", "colour", "colouur"]],
    ["x{2,3}y", ["xy", "xxy", "xxxy", "xxxxy"]],
    ["[A-Z]{2}-\\d+", ["mx-43", "MX-43", "m-43"]],
    ["(?<order>\\d+)", ["n 5", "none"]],
    ["\\.$", ["fin.", "fin"]],
    ["", ["anything"]],
  ];
  for (const [pattern, texts] of cases) {
    it(`agrees with RegExp on /${pattern}/`, () => {
      const re = compileRegex(pattern);
      for (const text of texts) expect(re.test(text), text).toBe(native(pattern, text));
    });
  }

  it("refuses what it can't run in linear time or doesn't support", () => {
    expect(checkPattern("(?=a)b")).toBe("unsupported");
    expect(checkPattern("(?<!a)b")).toBe("unsupported");
    expect(checkPattern("(a)\\1")).toBe("unsupported");
    expect(checkPattern("(a")).toBe("syntax");
    expect(checkPattern("a**")).toBe("syntax");
    expect(checkPattern("\\q")).toBe("syntax");
    expect(checkPattern("a{2,1}")).toBe("syntax");
    expect(checkPattern("a{1000}")).toBe("complex");
    expect(checkPattern("(?:(?:abcdefghij){100}){100}")).toBe("complex");
    expect(checkPattern("")).toBe("length");
    expect(checkPattern("a".repeat(501))).toBe("length");
  });

  it("stays linear on patterns that make a backtracking engine explode", () => {
    const text = `${"a".repeat(5000)}!`;
    for (const pattern of ["(a|aa)+$", "(a+)+$", "(a*)*b", "a*a*a*a*a*a*a*a*b", "(?:a|a)*$"]) {
      expect(checkPattern(pattern)).toBeNull();
      const start = performance.now();
      patternMatches(pattern, text);
      expect(performance.now() - start, pattern).toBeLessThan(250);
    }
  });

  it("keeps the case of escapes and ignores the case of letters", () => {
    expect(patternMatches("\\D+", "abc")).toBe(true);
    expect(patternMatches("^\\d+$", "abc")).toBe(false);
    expect(patternMatches("PEDIDO", "tu pedido")).toBe(true);
    // accents fold like the text's
    expect(patternMatches("está", normalizeText("Está en camino"))).toBe(true);
  });
});

describe("subject keys and patterns", () => {
  const subjects = [
    "Tu pedido 43790 está en camino",
    "Tu pedido 3052 está en camino",
    "Tu pedido 1 está en camino ya",
    "Order #12 (2 items) [x] $5.00 / a+b?",
    "Order #99 (7 items) [x] $10.25 / a+b?",
    "Order #99 (7 items) [x] $10.25 / a+b",
    "100% \\ 2026",
    "1",
    "12345678901234567890",
    "issue #",
    "issue 5",
    "back\\slash 3",
    "back#slash 3",
    "mark ⁣ 3",
    "mark 3 3",
  ].map(normalizeText);

  it("two subjects share a key exactly when each matches the other's pattern", () => {
    for (const a of subjects)
      for (const b of subjects) {
        if (!subjectGeneralizes(a) || !subjectGeneralizes(b)) continue;
        const same = subjectKey(a) === subjectKey(b);
        expect(patternMatches(subjectPattern(a), b), `${a} ~ ${b}`).toBe(same);
      }
  });

  it("reads a generated pattern back as its template, and nothing else", () => {
    expect(subjectTemplate("Tu pedido 43790 está en camino")).toBe("Tu pedido # está en camino");
    expect(patternTemplate(subjectPattern(normalizeText("Tu pedido 43790 está en camino")))).toBe("tu pedido # esta en camino");
    expect(patternTemplate(subjectPattern("order #12 (2 items) $5.00"))).toBe("order ## (# items) $#.#");
    expect(patternTemplate("^tu pedido \\d+$")).toBeNull();
    expect(patternTemplate("pedido [0-9]+")).toBeNull();
    expect(patternTemplate("^(a|b)[0-9]+$")).toBeNull();
  });

  it("a subject whose pattern would be too long stays exact", () => {
    const long = `${"(".repeat(260)}1`;
    expect(subjectGeneralizes(long)).toBe(false);
    expect(subjectGeneralizes("tu pedido 1")).toBe(true);
    expect(subjectGeneralizes("tu pedido")).toBe(false);
  });
});

describe("the text field (plan 84)", () => {
  const msg = (over: Partial<RuleMessage>): RuleMessage => ({
    accountId: 1, fromName: "Mercado Libre", fromEmail: "info@mercadolibre.com", recipients: "luis@example.com", subject: "Tu pedido está en camino",
    bodyText: "Tu paquete con número de guía llegará pronto", listId: null, hasAttachments: false, date: 0, ...over,
  });
  const rule = (...words: string[]) => ({ match: "all" as const, conditions: words.map((value) => ({ field: "text" as const, op: "contains" as const, value })), actions: [{ type: "star" as const }] });

  it("mentions: subject, sender, recipients, and a complete body", () => {
    expect(evaluateRule(rule("pedido", "camino"), msg({}), 0)).toBe(true);
    expect(evaluateRule(rule("mercadolibre"), msg({}), 0)).toBe(true);
    expect(evaluateRule(rule("guia"), msg({}), 0)).toBe(true);
    expect(evaluateRule(rule("guia"), msg({ bodyComplete: false }), 0)).toBe(false);
    // the subject decides before the body comes
    expect(evaluateRule(rule("pedido"), msg({ bodyComplete: false, bodyText: null }), 0)).toBe(true);
    expect(evaluateRule(rule("factura"), msg({}), 0)).toBe(false);
  });
});
