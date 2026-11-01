// plan 96: the waitlist as CSV (`pnpm waitlist:csv`). Pure, so a test checks the query and the escaping.

export const PLATFORMS = ["windows", "linux", "mac", "mac-intel"];

/** The query for one platform, or every one. `platform` is checked against the list, never interpolated raw. */
export function waitlistQuery(platform) {
  if (platform && !PLATFORMS.includes(platform)) throw new Error(`unknown platform "${platform}": use one of ${PLATFORMS.join(", ")}`);
  return `SELECT email, platform, created_at FROM waitlist${platform ? ` WHERE platform = '${platform}'` : ""} ORDER BY platform, created_at`;
}

/**
 * One cell: quoted when it holds a comma, quote or line break; a leading = + - @ (or tab / CR) gets a ' first, so a
 * spreadsheet never runs a sign-up as a formula.
 */
export function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Rows from D1 (`created_at` in ms) to CSV text with a header; dates in ISO 8601, UTC. */
export function toCsv(rows) {
  const lines = [["email", "platform", "joined"].join(",")];
  for (const r of rows) lines.push([r.email, r.platform, new Date(Number(r.created_at)).toISOString()].map(csvCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** The rows out of `wrangler d1 execute --json` output (an array of statement results), or an error saying why not. */
export function rowsFromWrangler(stdout) {
  const start = stdout.indexOf("[");
  if (start < 0) throw new Error(`wrangler printed no results:\n${stdout.trim()}`);
  const parsed = JSON.parse(stdout.slice(start));
  const result = Array.isArray(parsed) ? parsed[0] : null;
  if (!result?.success || !Array.isArray(result.results)) throw new Error(`the query failed:\n${stdout.trim()}`);
  return result.results;
}
