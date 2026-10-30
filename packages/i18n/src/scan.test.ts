import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatFindings, scannedFiles, scanRepo, scanSource, type FindingKind } from "../scripts/scan";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** `kind text` of each finding in a .tsx fixture */
const scan = (code: string, file = "fixture.tsx"): string[] => scanSource(code, file).map((f) => `${f.kind} ${f.text}`);
const kinds = (code: string): FindingKind[] => scanSource(code, "fixture.tsx").map((f) => f.kind);

describe("JSX text", () => {
  it("flags text with letters", () => {
    expect(scan(`const A = () => <button>Archivar</button>;`)).toEqual(["jsx-text Archivar"]);
    expect(scan(`const A = ({ n }) => <p>{n} conversaciones</p>;`)).toEqual(["jsx-text conversaciones"]);
    expect(scan(`const A = () => <p>\n  Nada por\n  aquí\n</p>;`)).toEqual(["jsx-text Nada por aquí"]);
  });

  it("flags string children, also through conditionals", () => {
    expect(scan(`const A = ({ open }) => <p>{"Hola"}{open ? "Cerrar" : "Abrir"}</p>;`)).toEqual(["jsx-text Hola", "jsx-text Cerrar", "jsx-text Abrir"]);
    expect(scan("const A = ({ n }) => <p>{`${n} mensajes`}</p>;")).toEqual(["jsx-text mensajes"]);
  });

  it("reports the line the words are on", () => {
    expect(scanSource(`const A = () => (\n  <p>\n    Archivar\n  </p>\n);`, "a.tsx")[0]?.line).toBe(3);
  });

  it("leaves punctuation, numbers, brands and key caps alone", () => {
    for (const text of ["·", "→", "…", "—", "42", "(", "Terno", "Gmail", "Claude Code", "IMAP", "Cc", "Bcc", "⌘K", "G I", "⇧U", "Esc", "Enter", "⌘⇧P", "Ctrl+K", "JSON", "PDF", "API", "URL", "ID"]) {
      expect(scan(`const A = () => <kbd>${text}</kbd>;`), text).toEqual([]);
    }
    expect(scan(`const A = () => <p>Terno · Gmail</p>;`)).toEqual([]);
  });

  it("still flags words beside a brand, and lone lowercase words", () => {
    expect(scan(`const A = () => <p>Conectar con Gmail</p>;`)).toEqual(["jsx-text Conectar con Gmail"]);
    expect(scan(`const A = () => <p>o</p>;`)).toEqual(["jsx-text o"]);
  });
});

describe("attributes and object properties", () => {
  it("flags words in naming attributes", () => {
    expect(
      scan(`const A = () => <><button aria-label="Archivar" title="Archivar (E)" /><input placeholder="Buscar…" /><img alt="Avatar de Ana" /><Row label="Firma" hint="Se añade al final" description="Texto" heading="Cuentas" /></>;`),
    ).toEqual(["attr Archivar", "attr Archivar (E)", "attr Buscar…", "attr Avatar de Ana", "attr Firma", "attr Se añade al final", "attr Texto", "attr Cuentas"]);
    expect(scan(`const A = () => <div aria-description="Pulsa para abrir" />;`)).toEqual(["attr Pulsa para abrir"]);
  });

  it("flags expressions that evaluate to words", () => {
    expect(scan(`const A = ({ on }) => <button title={on ? "Quitar destacado" : "Destacar"} />;`)).toEqual(["attr Quitar destacado", "attr Destacar"]);
    expect(scan("const A = ({ name }) => <button aria-label={`Quitar ${name}`} />;")).toEqual(["attr Quitar"]);
    expect(scan(`const A = ({ x }) => <button title={x ?? "Sin nombre"} />;`)).toEqual(["attr Sin nombre"]);
  });

  it("flags words in object properties (menus, dialogs, errors)", () => {
    expect(scan(`const items = () => [{ id: "archive", label: "Archivar" }, { title: "Ajustes" }];`)).toEqual(["prop Archivar", "prop Ajustes"]);
    expect(scan(`dialog.showMessageBox({ type: "warning", message: "¿Salir?", detail: "Se perderá el borrador." });`, "main.ts")).toEqual(["prop ¿Salir?", "prop Se perderá el borrador."]);
    expect(scan(`const o = { "aria-label": "Cerrar", description: "Una descripción", hint: "Pista", heading: "Título" };`)).toEqual(["prop Cerrar", "prop Una descripción", "prop Pista", "prop Título"]);
  });

  it("skips `name`, other keys and computed keys", () => {
    expect(scan(`const A = () => <><input name="Nombre completo" /><div data-x="Hola mundo" /></>;`)).toEqual([]);
    expect(scan(`const o = { name: "Bandeja de entrada", value: "Hola mundo", [label]: "Hola mundo" };`)).toEqual([]);
  });

  it("allows identifiers, enum values, URLs, paths, emails, CSS classes and test ids", () => {
    const values = ["inbox", "comfortable", "list.toggleUnread", "thread-row", "is_read", "NOT_FOUND", "https://terno.app/docs", "mailto:a@b.c", "/settings/ai", "./icon.svg", "#reader", "text/plain", "you@example.com", "flex items-center gap-2", "sr-only", "hover:bg-muted px-2", "sk-ant-…", "Gmail", "LM Studio", "⌘K"];
    for (const v of values) {
      expect(scan(`const A = () => <Row label="${v}" description={"${v}"} />; const o = { label: "${v}", message: "${v}" };`), v).toEqual([]);
    }
    expect(scan("const A = ({ n }) => <Row label={`item-${n}`} />;")).toEqual([]);
  });

  it("counts a lone lowercase word as words in attributes only people read", () => {
    expect(scan(`const A = () => <><input placeholder="texto" /><img alt="avatar" /><span title="inbox" /></>;`)).toEqual(["attr texto", "attr avatar", "attr inbox"]);
    expect(scan(`const A = () => <Row label="inbox" />;`)).toEqual([]);
  });

  it("ignores type positions", () => {
    expect(scan(`type P = { label: "Archivar" }; interface Q { title: "Hola mundo" }`, "types.ts")).toEqual([]);
  });
});

describe("snack and toast", () => {
  it("flags the message argument of every variant", () => {
    expect(
      scan(`function f(id) { snack("Copiado"); snack.success("Guardado"); snack.error("No se pudo"); snack.warning("Cuidado"); snack.info("Hecho"); snack.loading("Enviando…"); snack.progress(id, "Moviendo"); toast("Listo"); toast.error("Falló"); }`, "a.ts"),
    ).toEqual(["call Copiado", "call Guardado", "call No se pudo", "call Cuidado", "call Hecho", "call Enviando…", "call Moviendo", "call Listo", "call Falló"]);
  });

  it("flags templates with static letters, even a lowercase word", () => {
    expect(scan("function f(e) { snack.error(`No se pudo mover: ${e.message}`); snack(`copiado`); }", "a.ts")).toEqual(["call No se pudo mover:", "call copiado"]);
  });

  it("flags `message` in the object form; lets catalog calls and variables through", () => {
    expect(scan(`function f() { snack({ message: "Deshecho", tone: "success" }); }`, "a.ts")).toEqual(["prop Deshecho"]);
    expect(scan("function f(e, n) { snack(t(\"snack.copied\")); snack.error(e.message); snack(`${n}`); snack.progress(\"id-1\", t(\"x\")); }", "a.ts")).toEqual([]);
  });
});

describe("expected errors", () => {
  it("flags the message of SettingsError, AiError and NetworkPolicyError (first argument)", () => {
    expect(
      scan(`function f(p, h) { throw new SettingsError("Tema desconocido"); throw new AiError("La IA está desactivada.", "config"); throw new NetworkPolicyError(\`El modo local bloquea \${h}\`, p, h); }`, "a.ts"),
    ).toEqual(["error Tema desconocido", "error La IA está desactivada.", "error El modo local bloquea"]);
  });

  it("flags RpcError's second argument, not its code", () => {
    expect(scan(`function f(id) { throw new RpcError("not_found", "Cuenta no encontrada"); throw new RpcError("invalid", \`Falta \${id}\`); }`, "a.ts")).toEqual(["error Cuenta no encontrada", "error Falta"]);
  });

  it("lets L() descriptors, variables and other errors through", () => {
    expect(scan(`function f(m) { throw new RpcError("not_found", L("errors.notFound")); throw new AiError(L("ai.off"), "config"); throw new SettingsError(m); throw new Error("Hola mundo"); }`, "a.ts")).toEqual([]);
  });

  it("treats a lone word as a message too (it reaches the user as is)", () => {
    expect(scan(`function f() { throw new AiError("cancelado", "abort"); }`, "a.ts")).toEqual(["error cancelado"]);
  });
});

describe("t() at module load", () => {
  it("flags calls with no enclosing function", () => {
    expect(scan(`import { t } from "@terno/i18n";\nconst LABEL = t("a");\nexport const ITEMS = [{ label: t("b") }];\nt("c");\nconst x = cond ? L("d") : null;`, "a.ts")).toEqual([
      'module-load t("a")',
      'module-load t("b")',
      'module-load t("c")',
      'module-load L("d")',
    ]);
  });

  it("flags static class fields and blocks, and aliased imports", () => {
    expect(scan(`import { t as tr, rich } from "@terno/i18n";\nclass A { static label = t("a"); static { tr("b"); } }\nconst r = rich("c");`, "a.ts")).toEqual(['module-load t("a")', 'module-load tr("b")', 'module-load rich("c")']);
  });

  it("allows calls deferred into functions, arrows, methods, instance fields and components", () => {
    const code = `
      import { t, L } from "@terno/i18n";
      const label = () => t("a");
      const items = () => [{ label: t("b") }];
      function f(x = t("c")) { return t("d"); }
      const o = { get title() { return t("e"); }, m() { return L("f"); } };
      class A { label = t("g"); m() { return t("h"); } static s() { return t("i"); } }
      export function View() { return <button title={t("j")}>{t("k")}</button>; }
      const lazy = function () { return t("l"); };
    `;
    expect(scan(code)).toEqual([]);
  });

  it("ignores other functions named like the catalog's", () => {
    expect(kinds(`const v = translate("a"); const w = obj.t("b");`)).toEqual([]);
  });
});

describe("i18n-ignore", () => {
  it("suppresses a finding on the same line or the line after, with a reason", () => {
    expect(scan(`const A = () => <p>Hola mundo</p>; // i18n-ignore: a sample sentence\nconst o = { label: "Adiós mundo" };`)).toEqual([]);
    expect(scan(`// i18n-ignore: the PDF metadata field is English by spec\nconst o = { title: "Hola mundo" };\nconst p = { title: "Adiós mundo" };`)).toEqual(["prop Adiós mundo"]);
    expect(scan(`const A = () => (\n  <p>\n    {/* i18n-ignore: a sample sentence in the theme preview */}\n    El veloz murciélago\n  </p>\n);`)).toEqual([]);
  });

  it("fails an ignore without a reason (and doesn't honor it)", () => {
    expect(kinds(`// i18n-ignore\nconst o = { label: "Hola mundo" };`)).toEqual(["ignore-without-reason", "prop"]);
    expect(kinds(`const o = { label: "Hola mundo" }; // i18n-ignore:   `)).toEqual(["ignore-without-reason", "prop"]);
  });
});

describe("the repo walk", () => {
  it("reads sources and skips tests, fixtures, mock data, catalogs and declarations", () => {
    const files = scannedFiles(ROOT);
    expect(files).toContain("apps/web/src/components/reader.tsx");
    expect(files).toContain("packages/backend/src/handlers.ts");
    const skipped = files.filter((f) => /\.test\.tsx?$|\.d\.ts$|\/(e2e|e2e-web|fixtures|conformance|test)\/|^packages\/(mock-data|mcp)\/|^packages\/i18n\/src\/locales\//.test(f));
    expect(skipped).toEqual([]);
  });

  // enabled once the extraction lands (plan 14)
  it("no hard-coded user-facing strings in apps/*/src and packages/*/src", () => {
    // file:line kind text, one per line; fix by moving the text into the catalog (t()/L()), or `// i18n-ignore: <reason>`
    expect(formatFindings(scanRepo(ROOT))).toBe("");
  });
});

it("excludes test-directory helpers while retaining production label violations", () => {
  const root = mkdtempSync(join(tmpdir(), "terno-i18n-scan-"));
  try {
    const src = join(root, "apps/web/src/lib");
    mkdirSync(join(src, "test"), { recursive: true });
    const source = 'const View = () => <input aria-label="Body" />;';
    writeFileSync(join(src, "test/helper.tsx"), source);
    writeFileSync(join(src, "production.tsx"), source);
    expect(scannedFiles(root)).toEqual(["apps/web/src/lib/production.tsx"]);
    expect(scanRepo(root).map((f) => [f.file, f.kind, f.text])).toEqual([["apps/web/src/lib/production.tsx", "attr", "Body"]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
