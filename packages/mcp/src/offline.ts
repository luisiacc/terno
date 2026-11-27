import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { RpcError } from "@terno/core/rpc";
import { createMcpServer } from "./server";

/** What a tool call answers while Terno can't be reached: closed, or agents off (plan 183: no socket says neither). */
export const NOT_RUNNING = "Can't reach Terno. Open Terno and turn on Settings → Agents → Allow agents, then try again.";
/** What a tool call answers when the connection dropped before its answer: it may have run (plan 293, Codex critique #3). */
export const LOST = "Terno closed before answering, so this may or may not have happened. Open Terno and check before trying it again.";
/** What it answers when the app refused the token (it changed between the read and the handshake). */
export const REJECTED = "Terno rejected the connection (stale token). Restart Terno.";

/**
 * Plan 293: what the agents' bridge (apps/desktop/native/terno-mcp.c) answers on its own while Terno can't be
 * reached, taken from the server itself so it can't drift: its initialize result (all but the negotiated version) and
 * its tool list. Written into the bridge at packaging.
 */
export interface OfflineManifest {
  /** the initialize result's members other than protocolVersion */
  initialize: { capabilities: unknown; serverInfo: unknown; instructions?: string };
  tools: unknown[];
  latestVersion: string;
  supportedVersions: string[];
  notRunning: string;
  lost: string;
  rejected: string;
}

export async function offlineManifest(version: string): Promise<OfflineManifest> {
  // the manifest reads the server's surface only: no tool is called
  const unreachable = { call: () => Promise.reject(new RpcError("UNAVAILABLE", NOT_RUNNING)) };
  const server = createMcpServer(unreachable, version);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "terno-mcp-manifest", version });
  await client.connect(b);
  try {
    const instructions = client.getInstructions();
    return {
      initialize: { capabilities: client.getServerCapabilities(), serverInfo: client.getServerVersion(), ...(instructions ? { instructions } : {}) },
      tools: (await client.listTools()).tools,
      latestVersion: LATEST_PROTOCOL_VERSION,
      supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      notRunning: NOT_RUNNING,
      lost: LOST,
      rejected: REJECTED,
    };
  } finally {
    await client.close();
    await server.close();
  }
}
