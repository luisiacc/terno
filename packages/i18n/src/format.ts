/**
 * The message grammar, compiled once per message: text, `{name}`
 * placeholders, `#` (a plural's count) and flat `<tag>…</tag>` rich text.
 * Tags are found before values go in, so a value containing "<b>" (a name,
 * a subject) is always text.
 */
export type Part = string | { readonly arg: string } | { readonly tag: string; readonly children: readonly Part[] };

const TOKEN = /\{([A-Za-z_][\w]*)\}|<([A-Za-z][\w-]*)>([\s\S]*?)<\/\2>|#/g;

export function compile(message: string, plural = false): readonly Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of message.matchAll(TOKEN)) {
    if (m[0] === "#" && !plural) continue;
    if (m.index > last) parts.push(message.slice(last, m.index));
    if (m[1]) parts.push({ arg: m[1] });
    else if (m[2]) parts.push({ tag: m[2], children: compile(m[3] ?? "", plural) });
    else parts.push({ arg: "#" });
    last = m.index + m[0].length;
  }
  if (last < message.length) parts.push(message.slice(last));
  return parts;
}

export type Values = Readonly<Record<string, unknown>>;

/** Renders parts to text: tags keep their children's text. */
export function renderText(parts: readonly Part[], values: Values, number: (n: number) => string): string {
  let out = "";
  for (const p of parts) {
    if (typeof p === "string") out += p;
    else if ("arg" in p) out += show(p.arg === "#" ? values.count : values[p.arg], p.arg, number);
    else out += renderText(p.children, values, number);
  }
  return out;
}

/** Renders parts with each tag through its renderer (a tag without one stays text). */
export function renderRich<R>(parts: readonly Part[], values: Values, number: (n: number) => string): (string | R)[] {
  const out: (string | R)[] = [];
  for (const p of parts) {
    if (typeof p === "object" && "tag" in p) {
      const render = values[p.tag];
      const text = renderText(p.children, values, number);
      if (typeof render === "function") out.push((render as (children: string) => R)(text));
      else pushText(out, text);
    } else pushText(out, renderText([p], values, number));
  }
  return out;
}

function pushText<R>(out: (string | R)[], text: string): void {
  if (typeof out[out.length - 1] === "string") out[out.length - 1] += text;
  else out.push(text);
}

function show(value: unknown, name: string, number: (n: number) => string): string {
  if (typeof value === "number") return number(value);
  if (typeof value === "string") return value;
  // a missing value shows its placeholder: visible in the UI, never a crash
  return name === "#" ? "#" : `{${name}}`;
}
