import { describe, expect, it } from "vitest";
import { buildReport } from "./report";
import { createReporter, fetchTransport } from "./sentry";
import type { ErrorRecord } from "./types";

declare const TextDecoder: { new (): { decode(b: Uint8Array): string } };

const DSN = "http://publickey@127.0.0.1:9/42";

function record(id: string): ErrorRecord {
  return {
    id,
    ts: 1_700_000_000_000,
    kind: "error",
    proc: "main",
    code: "export.failed",
    fields: { errno: "ENOSPC" },
    fatal: false,
    error: { name: "Error", code: "ENOSPC", frames: [{ fn: "w", file: "dist/main.cjs", line: 3, col: 7 }] },
    crumbs: [{ ts: 1_699_999_000_000, cat: "ui", code: "ui.dialog", level: "info", fields: { dialog: "settings" } }],
    context: { version: "0.1.0", build: "0.1.0+abc", channel: "test", session: "s", os: "darwin" },
  };
}

/** Decodes what a fake network received: every item of every envelope. */
function sink(delayMs = 0, respond: () => { status: number; headers?: Record<string, string> } = () => ({ status: 200 })) {
  const envelopes: { header: Record<string, unknown>; items: { header: Record<string, unknown>; payload: unknown }[] }[] = [];
  const fetchImpl = async (_url: string, init: { body: string | Uint8Array }) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const text = typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body);
    const lines = text.split("\n").filter(Boolean);
    const header = JSON.parse(lines[0]!);
    const items = [];
    for (let i = 1; i < lines.length; i += 2) items.push({ header: JSON.parse(lines[i]!), payload: JSON.parse(lines[i + 1]!) });
    envelopes.push({ header, items });
    const r = respond();
    return { status: r.status, headers: { get: (name: string) => r.headers?.[name.toLowerCase()] ?? null } };
  };
  return { envelopes, fetchImpl };
}

const options = { installId: "install-1" };
const RELEASE = "terno@0.1.0+abc";

describe("reporter under rate limits", () => {
  it("a rate-limited report is not sent, and neither is the next one the SDK holds back (review finding 3)", async () => {
    const s = sink(0, () => ({ status: 429, headers: { "retry-after": "60" } }));
    const reporter = createReporter({ dsn: DSN, release: RELEASE, environment: "test", transport: fetchTransport(s.fetchImpl), allow: () => true });
    expect(await reporter.send(buildReport(record("1".repeat(32)), options))).toEqual({ sent: false, reason: "rate" });
    // the transport now suppresses requests for 60 s and resolves {}: that is not a send
    expect(await reporter.send(buildReport(record("2".repeat(32)), options))).toEqual({ sent: false, reason: "rate" });
    expect(s.envelopes).toHaveLength(1);
  });
});
