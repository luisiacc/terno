/**
 * Pulls the JSON object out of a free-form model reply: reasoning models wrap
 * answers in <think>…</think>, chat models in ```json fences or prose. Returns
 * the first balanced {...} (string-aware), or null when there is none.
 */
export function extractJsonObject(text: string): string | null {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "") // an unclosed opening tag was cut by the server
    .replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return cleaned.slice(start, i + 1);
  }
  return null;
}

/** JSON.parse of the reply, falling back to the extracted object. */
export function parseModelJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    const candidate = extractJsonObject(text);
    if (candidate === null) return { ok: false, error: "the reply contained no JSON object" };
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (error) {
      return { ok: false, error: `malformed JSON (${error instanceof Error ? error.message : String(error)})` };
    }
  }
}
