import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A stand-in for Ollama on 127.0.0.1: model list, model details and an OpenAI-compatible chat endpoint. */
export async function startOllamaStub(options: { chatDelayMs?: number; chatHeld?: Promise<void>; summaryFails?: () => number | null } = {}): Promise<{ url: string; requests: string[]; summaries: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  /** what each thread_summary request carried */
  const summaries: string[] = [];
  const server: Server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      const json = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.url === "/api/tags") return json({ models: [{ name: "qwen3:8b", size: 5_225_000_000 }, { name: "llama3.2:3b", size: 2_019_000_000 }] });
      if (req.url === "/api/ps") return json({ models: [{ name: "qwen3:8b" }] });
      if (req.url === "/api/show") return json({ model_info: { "qwen3.context_length": 40960 } });
      if (req.url === "/v1/chat/completions") {
        if (options.chatHeld) return void options.chatHeld.then(() => answerChat());
        if (options.chatDelayMs) return void setTimeout(() => answerChat(), options.chatDelayMs);
        return answerChat();
      }
      res.writeHead(404).end();
      function answerChat() {
        const body = JSON.parse(data);
        const probe = body.response_format?.json_schema?.name === "probe";
        const summary = body.response_format?.json_schema?.name === "thread_summary";
        if (summary) {
          summaries.push(JSON.stringify(body.messages));
          const failure = options.summaryFails?.();
          if (failure) return void res.writeHead(failure, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "The stub says no.", type: "error", code: null } }));
        }
        const content = probe
          ? '{"ok":true}'
          : summary
          ? JSON.stringify({ summary: "The stub read the conversation and wrote this.", items: [{ kind: "action", text: "Reply to the stub", message: "m1" }] })
          : JSON.stringify({ name: "Uber", explanation: "Archiva los recibos de uber.com.", match: "all", conditions: [{ field: "fromDomain", op: "equals", value: "uber.com", negate: false }], actions: [{ type: "archive", categoryId: null }] });
        json({ id: "c", object: "chat.completion", created: 0, model: body.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, refusal: null } }] });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    summaries,
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}
