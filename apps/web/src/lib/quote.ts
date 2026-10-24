/**
 * Quoted history in a plain-text reply. Only a trailing block counts as
 * history: a reply that answers between quoted lines (an inline reply) keeps
 * every line, or its answers would go with the quotes. The reader folds what
 * this returns, and printing leaves it out.
 */

const ATTRIBUTION = /(escribió|wrote|a écrit|schrieb):\s*$/i;
/** Outlook's plain-text history: a rule (or "Original Message"), then its own From/De header. */
const OUTLOOK_RULE = /^(_{8,}|-{2,}\s*(original message|mensaje original)\s*-{2,})\s*$/i;
const OUTLOOK_FROM = /^(from|de):\s/i;

const blank = (l: string | undefined) => !l?.trim();
const quoted = (l: string) => l.startsWith(">");

export function splitTextQuote(text: string): { main: string; quoted: string } {
  const lines = text.split("\n");
  const none = { main: text, quoted: "" };
  let end = lines.length;
  while (end > 0 && blank(lines[end - 1])) end--;

  let cut = -1;
  // Outlook: the rule and everything after it (always the end of the message)
  for (let i = 0; i < end - 1; i++) {
    if (!OUTLOOK_RULE.test(lines[i]!.trim())) continue;
    // its next non-blank line, looked up in place (copying the rest per rule would be quadratic)
    let j = i + 1;
    while (j < end && blank(lines[j])) j++;
    if (j < end && OUTLOOK_FROM.test(lines[j]!.trim())) {
      cut = i;
      break;
    }
  }
  if (cut === -1) {
    // the trailing run of "> " lines (blank lines inside it belong to it)
    let start = end;
    while (start > 0 && (quoted(lines[start - 1]!) || blank(lines[start - 1]))) start--;
    while (start < end && blank(lines[start])) start++;
    if (start === end) return none;
    cut = start;
    // its "El … escribió:" line, which Gmail may wrap onto two lines
    let k = start - 1;
    while (k >= 0 && blank(lines[k])) k--;
    if (k >= 0 && ATTRIBUTION.test(lines[k]!.trim())) {
      cut = k;
      if (k > 0 && !blank(lines[k - 1]) && /^(el|on|le|am) /i.test(lines[k - 1]!.trim()) && !/^(el|on|le|am) /i.test(lines[k]!.trim())) cut = k - 1;
    }
  }
  // quotes above the history: an inline reply, kept whole
  if (lines.slice(0, cut).some(quoted)) return none;
  const main = lines.slice(0, cut).join("\n").trimEnd();
  // nothing but history (a bare forward): nothing to fold
  if (!main.trim()) return none;
  return { main, quoted: lines.slice(cut).join("\n").trim() };
}
