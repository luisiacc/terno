/** Plan 133 through the real backend (RPC, settings, limiter, SQLite), with a scripted model: nothing leaves this process. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, promptText, type AiOptions, type Completion, type CompletionRequest, type ProviderConfig, type StreamEvent } from "@terno/ai";
import { createMemoryTransportPair, RpcClient, type ParamsOf } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import { msg } from "@terno/store/conformance";
import type { IncomingMessage } from "@terno/store";
import { Backend, plaintextCipher } from "../backend";

export const START = new Date(2026, 10, 4, 12).getTime();
export const TOM = { name: "Tom Reed", email: "tom@acme.test" };

export interface Model {
  requests: CompletionRequest[];
  /** a structured request's answer (judgment, intent) */
  answer: (req: CompletionRequest) => Promise<Completion> | Completion;
  /** a draft's stream */
  stream: (req: CompletionRequest) => AsyncGenerator<StreamEvent>;
}

export const textOf = (req: CompletionRequest): string => `${promptText(req.system)}\n${req.messages.map((m) => promptText(m.content)).join("\n")}`;

export async function* say(text: string): AsyncGenerator<StreamEvent> {
  for (const chunk of text.match(/[\s\S]{1,8}/g) ?? []) yield { type: "delta", text: chunk };
  yield { type: "done", stop: "end", usage: { inputTokens: 1, outputTokens: 1 } };
}

const cleanups: (() => Promise<void> | void)[] = [];

export async function cleanUp(): Promise<void> {
  for (const c of cleanups.splice(0).reverse()) await c();
}

export async function setup(o: { dir?: string; keep?: boolean; provider?: "fake" | "none"; accounts?: number } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "terno-writing-"));
  const model: Model = {
    requests: [],
    answer: () => ({ text: JSON.stringify({ traits: { formality: 2, warmth: 3, directness: 4, detail: 2, humor: 1 }, notes: ["Answers first, adds nothing"] }), stop: "end" }),
    stream: () => say("<email>Fine by me.</email>"),
  };
  const clock = { now: START };
  const factory = (config: ProviderConfig, options: AiOptions) =>
    createAi(config, {
      ...options,
      transport: {
        complete: async (req) => {
          model.requests.push(req);
          return model.answer(req);
        },
        stream: (req) => {
          model.requests.push(req);
          return model.stream(req);
        },
      },
    });
  const logs: string[] = [];
  const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, now: () => clock.now, log: (_level, message, extra) => void logs.push(`${message} ${JSON.stringify(extra ?? null)}`) });
  await backend.store.ready;
  await backend.ready;
  // a later launch of the same profile: what a host does at start
  if (o.dir) await backend.start();
  const connect =(clientId: string, origin: "renderer" | "mcp") => {
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId, origin });
    return new RpcClient(c);
  };
  const client = connect("renderer", "renderer");
  const mcp = connect("mcp", "mcp");
  const accounts = await backend.store.accounts.list();
  for (let i = accounts.length; i < (o.accounts ?? 1); i++) {
    const { account } = await backend.store.accounts.create({ kind: "gmail", email: `me${i}@terno.test`, displayName: `Me ${i}`, color: "indigo", now: 0 });
    accounts.push(account);
  }
  const account = accounts[0]!;
  if (!o.dir && (o.provider ?? "fake") === "fake") await client.call("settings.update", { ai: { provider: "fake" } });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await backend.stop();
  };
  cleanups.push(async () => {
    await stop();
    if (!o.keep) rmSync(dir, { recursive: true, force: true });
  });

  /** mail the user sent, as a sync would bring it */
  const sent = async (over: Partial<IncomingMessage> & { to?: IncomingMessage["to"] } = {}) => {
    const accountId = over.accountId ?? account.id;
    const me = accounts.find((a) => a.id === accountId)!;
    const m = msg({ accountId, from: { name: me.displayName, email: me.email }, to: [TOM], isSent: true, isRead: true, inInbox: false, bodyText: "Sounds good to me.", date: clock.now - 3600_000, ...over });
    const { inserted } = await backend.store.sync.ingest([m], { applyFilters: false, now: clock.now, classifier: null });
    return { id: inserted[0]!, m };
  };
  const sentMany = async (n: number, make: (i: number) => Partial<IncomingMessage> = () => ({})) => {
    const accountId = make(0).accountId ?? account.id;
    const me = accounts.find((a) => a.id === accountId)!;
    const batch = Array.from({ length: n }, (_, i) => msg({ accountId, from: { name: me.displayName, email: me.email }, to: [TOM], isSent: true, isRead: true, inInbox: false, bodyText: `Sounds good to me, thanks for the update ${i % 7 ? "" : "on this"}.`, date: clock.now - 3600_000 - i * 1000, ...make(i) }));
    return (await backend.store.sync.ingest(batch, { applyFilters: false, now: clock.now, classifier: null })).inserted;
  };
  /** mail arriving */
  const received = async (over: Partial<IncomingMessage> = {}) => {
    const m = msg({ accountId: account.id, from: TOM, to: [{ name: account.displayName, email: account.email }], inInbox: true, bodyText: "Can we meet on Friday?", date: clock.now - 60_000, ...over });
    const { inserted } = await backend.store.sync.ingest([m], { applyFilters: false, now: clock.now, classifier: null });
    const thread = (await backend.store.debug.snapshot()).messages.find((x) => x.providerMsgId === m.providerMsgId)!.threadId;
    return { id: inserted[0]!, thread, m };
  };
  /** learner runs to the end, whatever its throttle */
  const learned = async () => {
    await backend.writing.learner.activate();
    backend.writing.learner.wake({ force: true });
    await backend.writing.learner.idle();
  };
  let nextRequest = 1;
  const requestId = () => `req-${nextRequest++}`;
  const compose = (over: Partial<ParamsOf<"ai.compose">> = {}, c: RpcClient = client) => c.call("ai.compose", { requestId: requestId(), session: "s1", accountId: account.id, kind: "new", to: [TOM], instruction: "tell tom that this is just fine", timezone: "UTC", ...over });
  return { backend, client, mcp, connect, model, clock, account, accounts, dir, stop, logs, sent, sentMany, received, learned, compose, requestId };
}

export const errorOf = (p: Promise<unknown>): Promise<{ code?: string; details?: { aiErrorKind?: string }; message: string }> =>
  p.then(
    () => {
      throw new Error("expected a failure");
    },
    (e) => e,
  );
