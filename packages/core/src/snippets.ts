import { z } from "zod";

/**
 * Plan 93: snippets, saved pieces of an email (Superhuman's): a name, a rich
 * body and, optionally, the subject and recipients they fill in. Kept on this
 * device with the rest of the settings; they never leave it but in a backup.
 */
export interface Snippet {
  /** made by the renderer when the editor opens ("s_…"), so every autosave is the same snippet */
  id: string;
  /** "" shows as "Untitled snippet" */
  name: string;
  /** mail HTML from the editor, never with images (they belong to a draft's attachments); "" = empty */
  bodyHtml: string;
  /** its plain text: previews and search */
  bodyText: string;
  subject: string;
  /** addresses as typed in a draft */
  to: string;
  cc: string;
  bcc: string;
  createdAt: number;
  updatedAt: number;
}

export const SNIPPETS_MAX = 200;
export const SNIPPET_HTML_MAX = 32 * 1024;
export const SNIPPET_TEXT_MAX = 16 * 1024;
/** every snippet's text together (JSON), so the settings value stays small to parse and write in both stores */
export const SNIPPETS_BYTES_MAX = 1024 * 1024;

export const snippetIdSchema = z.string().regex(/^s_[A-Za-z0-9_-]{6,40}$/);

/** What a save carries (the fields a user edits). */
export const snippetFieldsSchema = z.object({
  name: z.string().max(80),
  bodyHtml: z
    .string()
    .max(SNIPPET_HTML_MAX)
    .refine((html) => !/<img\b/i.test(html), "A snippet can't hold images"),
  bodyText: z.string().max(SNIPPET_TEXT_MAX),
  subject: z.string().max(300),
  to: z.string().max(2000),
  cc: z.string().max(2000),
  bcc: z.string().max(2000),
});
export type SnippetFields = z.output<typeof snippetFieldsSchema>;

/** A snippet as an export file carries it (checked item by item on import). */
export const snippetSchema = snippetFieldsSchema.extend({
  id: snippetIdSchema,
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
});

/** What a list of snippets weighs against SNIPPETS_BYTES_MAX. */
export const snippetsBytes = (list: readonly Snippet[]): number => new TextEncoder().encode(JSON.stringify(list)).length;

/** The first line of a snippet's text, for previews. */
export function snippetPreview(s: Pick<Snippet, "bodyText">, max = 120): string {
  const line = s.bodyText.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// ── variables

export const SNIPPET_VARIABLES = ["first_name", "last_name", "full_name", "email", "my_first_name", "my_name"] as const;
export type SnippetVariable = (typeof SNIPPET_VARIABLES)[number];
export type SnippetValues = Partial<Record<SnippetVariable, string>>;

/** `{first_name}`: any case, spaces inside the braces allowed. Only the known names (any other `{word}` is text). */
export const VARIABLE_RE = new RegExp(`\\{\\s*(${SNIPPET_VARIABLES.join("|")})\\s*\\}`, "gi");

export interface VariableMatch {
  from: number;
  to: number;
  name: SnippetVariable;
  /** null: no value (left in the text, selected after an insert) */
  value: string | null;
}

/** The variables in a text, with their values. */
export function findVariables(text: string, values: SnippetValues): VariableMatch[] {
  const out: VariableMatch[] = [];
  for (const m of text.matchAll(VARIABLE_RE)) {
    const name = m[1]!.toLowerCase() as SnippetVariable;
    const value = values[name]?.trim();
    out.push({ from: m.index, to: m.index + m[0].length, name, value: value ? value : null });
  }
  return out;
}

/** A text with its variables filled (those without a value stay as written). */
export function fillText(text: string, values: SnippetValues): string {
  return text.replace(VARIABLE_RE, (whole, name: string) => values[name.toLowerCase() as SnippetVariable]?.trim() || whole);
}

/**
 * A display name as first and last name ("Ana García" → Ana, García; "García,
 * Ana" → Ana, García). No name: nothing (never guessed from an address: a
 * wrong name is worse than a visible blank).
 */
export function nameParts(displayName: string | null | undefined): { first: string; last: string; full: string } | null {
  const raw = (displayName ?? "").replace(/^["']+|["']+$/g, "").replace(/\s+/g, " ").trim();
  if (!raw || raw.includes("@")) return null;
  const comma = raw.match(/^([^,]+),\s*(.+)$/);
  const full = comma ? `${comma[2]} ${comma[1]}` : raw;
  const words = full.split(" ");
  return { first: words[0]!, last: words.length > 1 ? words.slice(1).join(" ") : "", full };
}
