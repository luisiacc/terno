import { afterEach, describe, expect, it } from "vitest";
import { breadcrumb, breadcrumbs, captureError, installDiag, log, mirrorBreadcrumbs } from "./diag";
import { normalizeError } from "./error";
import { buildReport } from "./report";
import { createReporter } from "./envelope";
import type { Crumb, DiagEntry, ErrorRecord } from "./types";
import { sanitizeEntry, sanitizeRecord } from "./validate";


const MARKERS = {
  secret: "S51SyntheticSecret",
  address: "s51-recipient@example.invalid",
  subject: "S51ConfidentialSubject",
  body: "S51PrivateResponseBody",
  header: "S51PrivateRetryHeader",
  cause: "S51PrivateNestedCause",
};
const providerUrl = `https://provider.invalid/messages?access_token=${MARKERS.secret}&to=${MARKERS.address}`;
const responseEvidence = {
  source: "http-response",
  request: { endpoint: "gmail-api", purpose: "mail" },
  status: 429,
  quotaScope: "unknown",
  received: { source: "date-now", kind: "wall", wallMs: 1_700_000_000_000 },
  retryAfter: { kind: "value", value: MARKERS.header },
  serverDate: { kind: "value", value: MARKERS.address },
};

function providerError(message: string, expected = false) {
  const error = Object.assign(new Error(message, { cause: new Error(MARKERS.cause) }), {
    name: "ProviderError",
    code: "ECONNRESET",
    status: 429,
    expected,
    body: MARKERS.body,
    headers: { authorization: `Bearer ${MARKERS.secret}` },
    url: providerUrl,
  });
  // ProviderError's local evidence is nonenumerable; enumerable extras also must not survive.
  Object.defineProperty(error, "httpResponse", { value: responseEvidence });
  return error;
}

function capture() {
  const entries: DiagEntry[] = [];
  const records: ErrorRecord[] = [];
  const mirrors: Crumb[][] = [];
  installDiag({ proc: "backend", version: "1", build: "1+s51", channel: "test", session: "s51", sink: { write: (e) => entries.push(e), capture: (r) => records.push(r), mirror: (c) => mirrors.push(c) } });
  return { entries, records, mirrors };
}

function containsNoMarkers(value: unknown) {
  const text = JSON.stringify(value);
  for (const marker of Object.values(MARKERS)) expect(text).not.toContain(marker);
}

afterEach(() => installDiag({ proc: "backend", version: "1", build: "1", channel: "test" }));

describe("S51 provider failures at diagnostic boundaries", () => {
  it.each([true, false])("drops HTTP bodies, headers, URLs and nested causes (expected=%s)", (expected) => {
    const m = capture();
    const error = providerError(`${MARKERS.subject}: ${MARKERS.body} ${providerUrl}`, expected);
    const fields = { accountKind: "gmail", retryable: expected, body: MARKERS.body, httpResponse: responseEvidence, cause: error.cause } as const;
    log.warn("sync.failed", fields);
    breadcrumb("sync", "sync.failed", fields);
    captureError(error, { code: "sync.failed", fields });
    mirrorBreadcrumbs();
    expect(m.entries.at(-1)).toMatchObject({ level: expected ? "warn" : "error", code: "sync.failed", err: { name: "ProviderError", code: "ECONNRESET", status: 429 } });
    expect(m.records).toHaveLength(expected ? 0 : 1);
    containsNoMarkers({ ...m, crumbs: breadcrumbs() });
    if (!expected) {
      const record = m.records[0]!;
      expect(record.error!.frames.length).toBeGreaterThan(0);
      // Old/forged serialized records must drop the new provider evidence, too.
      const extra = { message: error.message, body: error.body, headers: error.headers, httpResponse: responseEvidence, cause: error.cause, url: providerUrl };
      const clean = sanitizeRecord({ ...record, ...extra, error: { ...record.error, ...extra }, crumbs: [...record.crumbs, { ...record.crumbs[0], fields }] })!;
      containsNoMarkers([clean, sanitizeEntry({ ...m.entries.at(-1), ...extra }, "backend"), buildReport(clean, { installId: "synthetic-install" })]);
      expect(clean.error).toMatchObject({ name: "ProviderError", code: "ECONNRESET", status: 429 });
    }
  });

  it.each([
    ["Error: ordinary failure\n    at genuine (/x/app.asar/dist/backend.cjs:7:8)", { fn: "genuine", file: "dist/backend.cjs", line: 7, col: 8 }],
    ["genuine@app://terno/assets/main.js:7:8", { fn: "genuine", file: "renderer/assets/main.js", line: 7, col: 8 }],
  ] as const)("keeps genuine V8 and headerless Gecko frames: %s", (stack, frame) => {
    const error = new Error("ordinary failure");
    error.stack = stack;
    expect(normalizeError(error).frames).toEqual([frame]);
  });

  it.each(["v8", "gecko"])("does not reinterpret multiline provider message text as %s frames", (format) => {
    const m = capture();
    const frame = format === "v8" ? `    at ${MARKERS.subject} (${MARKERS.address}:1:2)` : `${MARKERS.subject}@${MARKERS.address}:1:2`;
    const error = providerError(`malformed response: ${MARKERS.body}\n${frame}`);
    captureError(error, { code: "sync.failed", fields: { accountKind: "gmail", retryable: false }, fatal: true });
    mirrorBreadcrumbs();
    expect(m.mirrors).toHaveLength(1);
    expect(m.records).toHaveLength(1);
    const record = m.records[0]!;
    expect(record.error!.frames.length).toBeGreaterThan(0);
    containsNoMarkers([m.entries, m.records, m.mirrors, buildReport(record, { installId: "synthetic-install" })]);
  });

  it("keeps credential-bearing provider URLs out of the actual upload URL and every envelope item", async () => {
    const m = capture();
    captureError(providerError(`${providerUrl}\n    at ${MARKERS.subject} (${MARKERS.address}:1:2)`), { code: "sync.failed", fields: { accountKind: "gmail" } });
    const uploads: { url: string; headers: Record<string, string>; body: string }[] = [];
    const reporter = createReporter({
      dsn: "https://publickey@diagnostics.invalid/42",
      client: "terno/1",
      allow: () => true,
      fetch: async (url, init) => {
        uploads.push({ url, headers: init.headers, body: init.body });
        return { status: 200, headers: { get: () => null } };
      },
    });
    try {
      const event = buildReport(m.records[0]!, { installId: "synthetic-install" });
      await expect(reporter.send(event)).resolves.toMatchObject({ sent: true });
      expect(uploads).toHaveLength(1);
      expect(uploads[0]!.url).toMatch(/^https:\/\/diagnostics\.invalid\/api\/42\/envelope\//);
      const lines = uploads[0]!.body.trim().split("\n").map((line) => JSON.parse(line));
      expect(lines).toHaveLength(3);
      expect(lines[1]).toMatchObject({ type: "event" });
      expect(lines[2]).toEqual(event);
      containsNoMarkers(uploads);
    } finally {
      reporter.close();
    }
  });
});
