import { rmSync } from "node:fs";
import { log } from "@terno/core/diag";
import { startAgentSocket, type AgentEndpoint } from "./agent-socket";
import type { BackendCore } from "./core";
import { readAgents } from "./settings";

export interface AgentPaths {
  socketPath: string;
  tokenPath: string;
}

/**
 * Plan 183: the MCP socket exists only while the user has agents on. Every
 * change goes through one chain, so toggling fast can't leave two listeners
 * or a token file behind, and stop() fences a start still in flight.
 */
export class AgentConnector implements NonNullable<BackendCore["agentConnector"]> {
  private endpoint: AgentEndpoint | null = null;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private startFailed = false;

  constructor(
    private readonly backend: BackendCore,
    private readonly paths: AgentPaths,
    private readonly start: typeof startAgentSocket = startAgentSocket,
  ) {}

  sync(): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return;
      const { enabled } = await readAgents(this.backend.store);
      if (enabled && !this.endpoint) await this.open();
      else if (!enabled) await this.close();
    });
  }

  failed(): boolean {
    return this.startFailed;
  }

  stop(): Promise<void> {
    this.stopped = true;
    return this.enqueue(() => this.close());
  }

  private enqueue(step: () => Promise<void>): Promise<void> {
    // a failed step never blocks the next (Codex review #9)
    const next = this.chain.then(step);
    this.chain = next.catch(() => {});
    return next;
  }

  private async open(): Promise<void> {
    try {
      this.endpoint = await this.start(this.backend, this.paths.socketPath, this.paths.tokenPath);
      this.startFailed = false;
    } catch (error) {
      this.startFailed = true;
      log.warn("agents.socket_failed", { errno: (error as { code?: string }).code });
    }
  }

  private async close(): Promise<void> {
    this.startFailed = false;
    const endpoint = this.endpoint;
    this.endpoint = null;
    if (endpoint) await endpoint.close();
    else {
      // off: files an older build or a crash left must not suggest agents can connect
      rmSync(this.paths.tokenPath, { force: true });
      rmSync(this.paths.socketPath, { force: true });
    }
  }
}
