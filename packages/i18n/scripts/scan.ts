/**
 * The regression guard of plan 14 §7.11: finds user-facing text that skipped
 * the catalog. It parses each source file and reports
 *   - JSX text with letters,
 *   - words in the attributes and object properties that name things for people,
 *   - the message argument of snack()/toast() and of the expected-error classes,
 *   - t()/L()/rich() evaluated at module load (before a locale is set).
 * It's a guard against regressions, not a proof of completeness: text built
 * elsewhere and passed in as a variable is out of its reach.
 *
 * Escape hatch: `// i18n-ignore: <reason>` (or `{/* i18n-ignore: <reason> *\/}`)
 * on the finding's line or the line before. The reason is required.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse } from "@babel/parser";

export type FindingKind = "jsx-text" | "attr" | "prop" | "call" | "error" | "module-load" | "ignore-without-reason" | "parse-error";

export interface Finding {
  file: string;
  line: number;
  kind: FindingKind;
  text: string;
}

/** JSX attributes and object keys whose string value is shown to (or read to) the user. `name` is too noisy. */
const TEXT_KEYS = new Set(["aria-label", "aria-description", "title", "placeholder", "alt", "label", "hint", "description", "heading", "detail", "message"]);
/** the HTML attributes among them: only people read these, so even a lone lowercase word is a word */
const HUMAN_ATTRS = new Set(["aria-label", "aria-description", "title", "placeholder", "alt"]);

/** snack.*() and toast.*(): which argument is the message */
const SNACK_CALLEES = new Set(["snack", "toast"]);
const SNACK_METHODS: Record<string, number> = { success: 0, error: 0, warning: 0, info: 0, loading: 0, progress: 1 };

/** expected errors whose message reaches the user: the message's argument index */
const ERROR_MESSAGE_ARG: Record<string, number> = { SettingsError: 0, AiError: 0, NetworkPolicyError: 0, RpcError: 1 };

/** catalog lookups: called at module load they freeze English before the locale is known */
const I18N_FUNCTIONS = new Set(["t", "L", "rich"]);

/**
 * Words that are the same in every language: brands, products, protocols and
 * fixed tokens. A string made only of these (and punctuation) isn't flagged.
 */
const ALLOWED_TOKENS = [
  // the product and the services it talks to
  "Terno",
  "Gmail",
  "Google",
  "Outlook",
  "iCloud",
  "Ollama",
  "LM Studio",
  "OpenAI",
  "OpenRouter",
  "Groq",
  "Together",
  "Azure",
  "Anthropic",
  "Claude Code",
  "Claude",
  "Codex",
  "Sentry",
  "macOS",
  "SQLite",
  "OPFS",
  "IndexedDB",
  // protocols, formats and abbreviations nobody translates
  "IMAP",
  "SMTP",
  "OAuth",
  "MCP",
  "JSON",
  "PDF",
  "HTML",
  "Cc",
  "Bcc",
  "API",
  "URL",
  "ID",
  "ms",
];

const LETTER = /\p{L}/u;
const allowedRe = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[...ALLOWED_TOKENS].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`,
  "gu",
);

/** One key cap: ⌘K, ⇧U, G, Esc, Enter, ↑… (single letters only in capitals: a lone "o" is a word). */
const KEY = String.raw`[⌘⇧⌥⌃]*(?:[A-Z0-9]|Esc|Enter|Return|Tab|Space|Backspace|Delete|Del|Shift|Ctrl|Alt|Cmd|Option|Home|End|PgUp|PgDn|F\d{1,2}|[↑↓←→↵⏎⌫⌦␣/?,.;'\[\]\\=+-])`;
/** a whole shortcut: one key cap or a sequence/chord of them ("G I", "⌘⇧P", "Ctrl+K") */
const KEY_COMBO = new RegExp(String.raw`^${KEY}(?:(?:\s+|\s*\+\s*)${KEY})*$`, "u");

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether the text says something in a language: it has letters, and not only brands or key caps. */
export function hasWords(text: string): boolean {
  const s = text.trim();
  if (!LETTER.test(s)) return false;
  if (KEY_COMBO.test(s)) return false;
  return LETTER.test(s.replace(allowedRe, ""));
}

const IDENTIFIER = /^[a-z][a-zA-Z0-9_.-]*$/; // "inbox", "comfortable", "list.toggleUnread"
const CONSTANT = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/; // "NOT_FOUND"
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|data:|blob:|file:|\/|\.\.?\/|#)/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Tailwind-ish utility tokens: ASCII, no capitals (arbitrary values aside) */
const CSS_TOKEN = /^[!a-z0-9@[\]():/._%#&>*=,+~'"-]+$/;

/**
 * Words rather than a machine value. Identifiers and enum-like values, URLs
 * and paths, emails, constant names and CSS class lists are values.
 * `humanOnly`: the value is only ever read by people (`aria-label`, `title`…),
 * so a lone lowercase word ("contiene") counts as words.
 */
export function looksLikeWords(text: string, humanOnly = false): boolean {
  const s = text.trim();
  if (!hasWords(s)) return false;
  if (humanOnly && /^\p{Ll}+$/u.test(s)) return true;
  if (IDENTIFIER.test(s.replace(/…$/, "")) || CONSTANT.test(s)) return false; // "sk-ant-…" is a key's prefix
  if (URL_LIKE.test(s) || EMAIL.test(s)) return false;
  if (!/\s/.test(s) && s.includes("/")) return false; // a path or a MIME type
  const tokens = s.split(/\s+/);
  if (tokens.every((x) => CSS_TOKEN.test(x)) && tokens.some((x) => /[-:[]/.test(x))) return false;
  return true;
}

// A loose view of Babel's nodes: the walker only needs `type`, `loc` and children.
interface Loc {
  start: { line: number; column: number };
  end: { line: number; column: number };
}
interface Node {
  type: string;
  loc?: Loc | null;
  [key: string]: unknown;
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);
const CLASS_FIELDS = new Set(["ClassProperty", "ClassPrivateProperty", "ClassAccessorProperty"]);
const SKIPPED_KEYS = new Set(["loc", "start", "end", "extra", "leadingComments", "trailingComments", "innerComments", "range"]);

/** The static text of a string or template literal (expressions become a space), or null. */
function literalText(node: Node): string | null {
  if (node.type === "StringLiteral") return node.value as string;
  if (node.type === "TemplateLiteral") {
    return (node.quasis as Node[]).map((q) => (q.value as { cooked?: string | null; raw: string }).cooked ?? (q.value as { raw: string }).raw).join(" ");
  }
  return null;
}

/** The literals an expression can evaluate to: through `a ? "x" : "y"`, `a ?? "x"`, `"x" as T`, parentheses. */
function candidates(node: unknown, out: Node[] = []): Node[] {
  if (!isNode(node)) return out;
  switch (node.type) {
    case "StringLiteral":
    case "TemplateLiteral":
      out.push(node);
      break;
    case "ConditionalExpression":
      candidates(node.consequent, out);
      candidates(node.alternate, out);
      break;
    case "LogicalExpression":
      if (node.operator !== "&&") candidates(node.left, out);
      candidates(node.right, out);
      break;
    case "JSXExpressionContainer":
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      candidates(node.expression, out);
      break;
  }
  return out;
}

/** The line of a literal's first non-blank character (JSX text usually starts with the previous line's newline). */
function firstLine(node: Node, text: string): number {
  const line = node.loc?.start.line ?? 0;
  const lead = /^\s*/.exec(text)?.[0] ?? "";
  return line + (lead.match(/\n/g)?.length ?? 0);
}

function keyName(node: Node): string | null {
  if (node.computed) return null;
  const key = node.key;
  if (!isNode(key)) return null;
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "StringLiteral") return key.value as string;
  return null;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Scans one file's source. `file` is only used to label findings and pick the parser's JSX mode. */
export function scanSource(code: string, file: string): Finding[] {
  let ast: Node;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: file.endsWith(".ts") ? ["typescript"] : ["typescript", "jsx"],
      errorRecovery: true,
    }) as unknown as Node;
  } catch (e) {
    return [{ file, line: (e as { loc?: { line: number } }).loc?.line ?? 0, kind: "parse-error", text: (e as Error).message }];
  }

  const raw: Finding[] = [];
  const report = (node: Node, kind: FindingKind, text: string, line = node.loc?.start.line ?? 0) => raw.push({ file, line, kind, text: oneLine(text) });

  const checkValue = (value: unknown, kind: "attr" | "prop", humanOnly = false) => {
    for (const lit of candidates(value)) {
      const text = literalText(lit);
      if (text !== null && looksLikeWords(text, humanOnly)) report(lit, kind, text, firstLine(lit, text));
    }
  };
  const checkMessage = (value: unknown, kind: "call" | "error") => {
    for (const lit of candidates(value)) {
      const text = literalText(lit);
      if (text !== null && hasWords(text)) report(lit, kind, text, firstLine(lit, text));
    }
  };

  // local names of the catalog functions (`import { t as tr } from "@terno/i18n"`)
  const i18nNames = new Set(I18N_FUNCTIONS);
  for (const stmt of (ast.program as Node).body as Node[]) {
    if (stmt.type !== "ImportDeclaration" || (stmt.source as Node).value !== "@terno/i18n") continue;
    for (const spec of stmt.specifiers as Node[]) {
      const imported = spec.imported as Node | undefined;
      if (spec.type === "ImportSpecifier" && imported && I18N_FUNCTIONS.has((imported.name ?? imported.value) as string)) i18nNames.add((spec.local as Node).name as string);
    }
  }

  /** `deferred`: inside a function (or an instance field), so not run at module load */
  const walk = (node: Node, deferred: boolean, parent: Node | null): void => {
    const t = node.type;
    if (t.startsWith("TS") && t !== "TSAsExpression" && t !== "TSSatisfiesExpression" && t !== "TSNonNullExpression") {
      // types carry no runtime text; enums' and namespaces' values aren't shown either
      return;
    }

    if (t === "JSXText") {
      const text = node.value as string;
      if (hasWords(text)) report(node, "jsx-text", text, firstLine(node, text));
    } else if (t === "JSXExpressionContainer" && parent && (parent.type === "JSXElement" || parent.type === "JSXFragment")) {
      // {"Archivar"} or {open ? "Cerrar" : "Abrir"} as a child
      for (const lit of candidates(node.expression)) {
        const text = literalText(lit);
        if (text !== null && hasWords(text)) report(lit, "jsx-text", text, firstLine(lit, text));
      }
    } else if (t === "JSXAttribute") {
      const name = node.name as Node;
      if (name.type === "JSXIdentifier" && TEXT_KEYS.has(name.name as string)) checkValue(node.value, "attr", HUMAN_ATTRS.has(name.name as string));
    } else if (t === "ObjectProperty") {
      const key = keyName(node);
      if (key && TEXT_KEYS.has(key)) checkValue(node.value, "prop");
    } else if (t === "CallExpression") {
      const callee = node.callee as Node;
      const args = node.arguments as Node[];
      if (callee.type === "Identifier" && SNACK_CALLEES.has(callee.name as string)) checkMessage(args[0], "call");
      else if (callee.type === "MemberExpression" && !callee.computed) {
        const object = callee.object as Node;
        const method = (callee.property as Node).name as string;
        if (object.type === "Identifier" && SNACK_CALLEES.has(object.name as string) && method in SNACK_METHODS) checkMessage(args[SNACK_METHODS[method]!], "call");
      }
      if (!deferred && callee.type === "Identifier" && i18nNames.has(callee.name as string)) {
        const first = args[0];
        report(node, "module-load", `${callee.name as string}(${first && first.type === "StringLiteral" ? JSON.stringify(first.value) : "…"})`);
      }
    } else if (t === "NewExpression") {
      const callee = node.callee as Node;
      if (callee.type === "Identifier" && Object.hasOwn(ERROR_MESSAGE_ARG, callee.name as string)) {
        checkMessage((node.arguments as Node[])[ERROR_MESSAGE_ARG[callee.name as string]!], "error");
      }
    }

    const inner = deferred || FUNCTIONS.has(t) || (CLASS_FIELDS.has(t) && !node.static);
    for (const key in node) {
      if (SKIPPED_KEYS.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) walk(item, inner, node);
      } else if (isNode(value)) {
        walk(value, inner, node);
      }
    }
  };
  walk(ast.program as Node, false, null);

  // the escape hatch: an ignore with a reason covers its line and the next
  const ignored = new Set<number>();
  const findings: Finding[] = [];
  for (const comment of (ast.comments as Node[] | undefined) ?? []) {
    const m = /^\s*\*?\s*i18n-ignore\b(.*)$/s.exec(comment.value as string);
    if (!m) continue;
    const line = comment.loc!.end.line;
    const reason = /^\s*:\s*(\S[\s\S]*?)\s*$/.exec(m[1]!)?.[1];
    if (reason) {
      ignored.add(line);
      ignored.add(line + 1);
    } else {
      findings.push({ file, line, kind: "ignore-without-reason", text: oneLine(comment.value as string) });
    }
  }
  for (const f of raw) if (!ignored.has(f.line)) findings.push(f);
  return findings.sort((a, b) => a.line - b.line);
}

/**
 * Where user-facing source lives, minus tests and their helpers, fixtures,
 * mock mail, the catalogs themselves and the service worker. MCP's tool
 * titles and descriptions are read by agents and stay English (plan 14 §3).
 */
const SKIPPED_DIRS = new Set(["node_modules", "e2e", "e2e-web", "fixtures", "conformance", "test", "__snapshots__"]);
const SKIPPED_PATHS = ["packages/mock-data/", "packages/mcp/", "packages/i18n/src/locales/", "apps/web/src/web/sw.js"];

function isScanned(path: string): boolean {
  if (!/\.tsx?$/.test(path) || path.endsWith(".d.ts")) return false;
  if (/\.test\.tsx?$/.test(path)) return false; // includes .perf.test.ts
  return !SKIPPED_PATHS.some((p) => path.startsWith(p));
}

function walkFiles(dir: string, root: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) walkFiles(path, root, out);
    } else if (entry.isFile()) {
      const rel = relative(root, path).split(sep).join("/");
      if (isScanned(rel)) out.push(rel);
    }
  }
}

/** The files scanRepo reads, relative to `root` with forward slashes. */
export function scannedFiles(root: string): string[] {
  const out: string[] = [];
  for (const group of ["apps", "packages"]) {
    let names: string[];
    try {
      names = readdirSync(join(root, group));
    } catch {
      continue;
    }
    for (const name of names.sort()) walkFiles(join(root, group, name, "src"), root, out);
  }
  return out;
}

/** Scans apps/*\/src and packages/*\/src under the monorepo root. */
export function scanRepo(root: string): Finding[] {
  return scannedFiles(root).flatMap((rel) => scanSource(readFileSync(join(root, rel), "utf8"), rel));
}

/** `file:line kind text`, one per line: what a failing test prints. */
export function formatFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `${f.file}:${f.line} ${f.kind} ${f.text}`).join("\n");
}
