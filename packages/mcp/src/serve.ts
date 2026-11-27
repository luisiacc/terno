import type { Duplex } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, type AgentCalls } from "./server";

/**
 * The SDK's stdio framing on any stream, counting the requests it hasn't answered yet, so a session can end once
 * every one has been (plan 293).
 */
class CountingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** requests read and not yet answered (a cancelled one is never answered, so it's dropped here too) */
  private readonly open = new Set<string | number>();
  private idle: (() => void)[] = [];
  private readonly inner: StdioServerTransport;

  constructor(stream: Duplex) {
    this.inner = new StdioServerTransport(stream, stream);
    this.inner.onmessage = (message: JSONRPCMessage) => {
      if ("method" in message && "id" in message) this.open.add(message.id);
      else if ("method" in message && message.method === "notifications/cancelled") this.answered((message.params as { requestId?: string | number } | undefined)?.requestId);
      this.onmessage?.(message);
    };
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    try {
      await this.inner.send(message);
    } finally {
      if ("result" in message || "error" in message) this.answered(message.id);
    }
  }

  private answered(id: string | number | undefined): void {
    if (id === undefined || !this.open.delete(id) || this.open.size) return;
    for (const done of this.idle.splice(0)) done();
  }

  /** Resolves once every request read so far has its answer written. */
  settled(): Promise<void> {
    return this.open.size === 0 ? Promise.resolve() : new Promise((resolve) => this.idle.push(resolve));
  }
}

/**
 * Plan 293: one agent's MCP session on `stream`, the agent socket after its token line, which carries exactly what
 * the agent writes on the bridge's stdin (one JSON-RPC message per line). The tools reach the backend through `app`.
 * When the bridge half-closes (its stdin ended), the session answers what it has already read, then ends the stream.
 * Resolves once the session is reading.
 */
export async function serveMcp(stream: Duplex, app: AgentCalls, version: string): Promise<void> {
  const server = createMcpServer(app, version);
  const transport = new CountingTransport(stream);
  // a request read in the same chunk as the end is dispatched before "end" fires; its answer is awaited like the rest
  stream.once("end", () => void transport.settled().then(() => stream.end()));
  stream.once("close", () => void server.close().catch(() => {}));
  await server.connect(transport);
}
