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
    error: { name: "Error", message: "write failed for ana@example.org", frames: [{ fn: "w", file: "dist/main.cjs", line: 3, col: 7 }] },
    crumbs: [{ ts: 1_699_999_000_000, cat: "ui", code: "ui.dialog", level: "info", fields: { dialog: "settings" } }],
    context: { version: "0.1.0", build: "0.1.0+abc", channel: "test", session: "s", os: "darwin" },
  };
}

/** Decodes what a fake network received: every item of every envelope. */
function sink(delayMs = 0) {
  const envelopes: { header: Record<string, unknown>; items: { header: Record<string, unknown>; payload: unknown }[] }[] = [];
  const fetchImpl = async (_url: string, init: { body: string | Uint8Array }) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const text = typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body);
    const lines = text.split("\n").filter(Boolean);
    const header = JSON.parse(lines[0]!);
    const items = [];
    for (let i = 1; i < lines.length; i += 2) items.push({ header: JSON.parse(lines[i]!), payload: JSON.parse(lines[i + 1]!) });
    envelopes.push({ header, items });
    return { status: 200, headers: { get: () => null } };
  };
  return { envelopes, fetchImpl };
}

const options = { installId: "install-1", release: "terno@0.1.0+abc", environment: "test" };

describe("reporter", () => {
  it("sends exactly the built event, nothing else, as one event envelope", async () => {
    const s = sink();
    const reporter = createReporter({ dsn: DSN, release: options.release, environment: "test", transport: fetchTransport(s.fetchImpl), allow: () => true });
    const event = buildReport(record("a".repeat(32)), options);
    await expect(reporter.send(event)).resolves.toMatchObject({ sent: true });
    expect(s.envelopes).toHaveLength(1);
    const [env] = s.envelopes;
    expect(env!.header.event_id).toBe(event.event_id);
    expect(env!.items).toHaveLength(1);
    expect(env!.items[0]!.header.type).toBe("event");
    // what "Ver qué se envía" shows is what went out
    expect(env!.items[0]!.payload).toEqual(event);
    expect(JSON.stringify(env)).not.toContain("example.org");
    await reporter.close();
  });

  it("asks the policy per envelope: a refusal never reaches the network", async () => {
    const s = sink();
    let allowed = false;
    const results: string[] = [];
    const reporter = createReporter({ dsn: DSN, release: options.release, environment: "test", transport: fetchTransport(s.fetchImpl), allow: () => allowed, onResult: (_id, r) => results.push(r.sent ? "sent" : r.reason) });
    await expect(reporter.send(buildReport(record("b".repeat(32)), options))).resolves.toEqual({ sent: false, reason: "policy" });
    allowed = true;
    await reporter.send(buildReport(record("c".repeat(32)), options));
    expect(results).toEqual(["policy", "sent"]);
    expect(s.envelopes.map((e) => e.header.event_id)).toEqual(["c".repeat(32)]);
  });

  it("revoking consent stops the next report; one already on the wire finishes", async () => {
    const s = sink(50);
    const approved = new Set(["d".repeat(32), "e".repeat(32)]);
    let localMode = false;
    const reporter = createReporter({ dsn: DSN, release: options.release, environment: "test", transport: fetchTransport(s.fetchImpl), allow: (id) => !localMode && approved.has(id) });
    const first = reporter.send(buildReport(record("d".repeat(32)), options));
    await new Promise((r) => setTimeout(r, 5));
    localMode = true;
    const second = reporter.send(buildReport(record("e".repeat(32)), options));
    expect(await second).toEqual({ sent: false, reason: "policy" });
    expect(await first).toMatchObject({ sent: true });
    expect(s.envelopes.map((e) => e.header.event_id)).toEqual(["d".repeat(32)]);
  });
});
