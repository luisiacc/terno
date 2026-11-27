// Tests only: an agent on the app's agent socket, speaking what the bridge (apps/desktop/native/terno-mcp.c) carries.
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** Connects with the token file's token and waits for the app's `{"ok":true}`; the socket is then the session's. */
export function handshake(paths: { socketPath: string; tokenPath: string }): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(paths.socketPath);
    socket.once("error", reject);
    let got = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      got = Buffer.concat([got, chunk]);
      const nl = got.indexOf(0x0a);
      if (nl === -1) return;
      socket.off("data", onData);
      const line = got.subarray(0, nl).toString("utf8");
      if (line !== '{"ok":true}') return reject(new Error(`refused: ${line}`));
      if (got.length > nl + 1) socket.unshift(got.subarray(nl + 1));
      resolve(socket);
    };
    socket.on("data", onData);
    socket.once("connect", () => socket.write(`${readFileSync(paths.tokenPath, "utf8").trim()}\n`));
  });
}

class SocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly buffer = new ReadBuffer();
  constructor(private readonly socket: Socket) {}
  async start(): Promise<void> {
    this.socket.on("data", (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (let m = this.buffer.readMessage(); m; m = this.buffer.readMessage()) this.onmessage?.(m);
    });
    this.socket.on("close", () => this.onclose?.());
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.socket.write(serializeMessage(message));
  }
  async close(): Promise<void> {
    this.socket.end();
  }
}

/** An MCP client on the agent socket. */
export async function connectAgent(paths: { socketPath: string; tokenPath: string }): Promise<{ client: Client; socket: Socket }> {
  const socket = await handshake(paths);
  const client = new Client({ name: "agent", version: "1" });
  await client.connect(new SocketTransport(socket));
  return { client, socket };
}
