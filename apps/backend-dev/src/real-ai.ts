import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { budgetedTransport, createAi, type SpendLedger } from "@terno/ai";
import type { AiFactory, Backend } from "@terno/backend";

type IncomingMessage = Parameters<Backend["store"]["sync"]["ingest"]>[0][number];

/**
 * A developer's proof run of the real app on real models (TERNO_AI_REAL=1, never
 * set by a test or a build). Every request is held to the same on-disk ledger
 * as the evals (scripts/ai-real/harness.ts), so a loop in the app can't pass it.
 */
function ledger(path: string, capUsd: number): SpendLedger {
  mkdirSync(dirname(path), { recursive: true });
  return {
    capUsd,
    spent: () => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).reduce((sum, line) => sum + (JSON.parse(line) as { usd: number }).usd, 0) : 0),
    record: (entry) => appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`),
  };
}

export function realAiFactory(): AiFactory {
  const capUsd = Number(process.env.TERNO_AI_CAP_USD ?? 5);
  if (!(capUsd > 0 && capUsd <= 5)) throw new Error("TERNO_AI_CAP_USD must be above 0 and at most 5");
  const book = ledger(process.env.TERNO_AI_LEDGER ?? "/tmp/terno-ai/spend.jsonl", capUsd);
  return (config, options) => {
    if (config.id === "fake") return createAi(config, options);
    return createAi(config, {
      ...options,
      wrapTransport: (transport) => {
        const held = budgetedTransport(transport, config.model, book, "app");
        return options.wrapTransport ? options.wrapTransport(held) : held;
      },
    });
  };
}

interface PersonaFixture {
  name: string;
  today: string;
  accounts: { id: string; address: string }[];
  sent: { id: string; account: string; to: string[]; cc: string[]; at: number; subject: string; body: string }[];
  people: { address: string; name: string }[];
  cases: { id: string; kind: string; account: string; to: { name: string; address: string }; subject: string; thread: { from: string; own: boolean; text: string }[]; instruction: string }[];
}

/** An invented person's sent mail and open threads, in the demo's first account, so the voice has something to go on. */
export async function seedPersona(backend: Backend, repoRoot: string): Promise<void> {
  const fixture = JSON.parse(readFileSync(join(repoRoot, "packages/mock-data/src/writing-personas/milo.json"), "utf8")) as PersonaFixture;
  const { store } = backend;
  const account = (await store.accounts.list())[0]!;
  const me = { name: fixture.name, email: account.email };
  const nameOf = (address: string) => fixture.people.find((p) => p.address === address)?.name ?? address.split("@")[0]!;
  const now = backend.now();
  const shift = now - Math.max(...fixture.sent.map((m) => m.at)) - 86_400_000;
  const base = (key: string, subject: string, at: number, bodyText: string): Omit<IncomingMessage, "from" | "to" | "isSent" | "inInbox"> => ({
    accountId: account.id, providerMsgId: `real-${key}`, providerThreadId: `real-${subject}`, rfcMessageId: `<real-${key}@proof.example>`, inReplyTo: null, references: [],
    cc: [], bcc: [], subject, date: at, snippet: bodyText.slice(0, 80), bodyText, bodyHtml: null, bodyState: "full", listId: null, isRead: true, isStarred: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 800,
  });
  const messages: IncomingMessage[] = fixture.sent.filter((m) => m.account === "work").map((m) => ({
    ...base(m.id, m.subject, m.at + shift, m.body),
    from: me, to: m.to.map((email) => ({ name: nameOf(email), email })), cc: m.cc.map((email) => ({ name: nameOf(email), email })), isSent: true, inInbox: false,
  }));
  fixture.cases.filter((c) => c.account === "work" && c.kind !== "attack" && c.thread.length > 0).forEach((c, i) => {
    c.thread.forEach((t, j) => {
      const at = now - (fixture.cases.length - i) * 3_600_000 + j * 60_000;
      messages.push(t.own
        ? { ...base(`${c.id}-${j}`, c.subject, at, t.text), from: me, to: [{ name: c.to.name, email: c.to.address }], isSent: true, inInbox: false }
        : { ...base(`${c.id}-${j}`, c.subject, at, t.text), from: { name: c.to.name, email: c.to.address }, to: [me], isSent: false, inInbox: true, isRead: false });
    });
  });
  await store.sync.ingest(messages, { applyFilters: false, now, classifier: null });
  // straight into the store, past what normally tells the contact index
  backend.autocomplete.notify();
}
