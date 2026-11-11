import type { MethodName } from "./rpc/contract";

/** Plan 183: what a connected agent may do, lowest first. Each level includes the ones before it. */
export const AGENT_ACCESS = ["read", "organize", "send"] as const;
export type AgentAccess = (typeof AGENT_ACCESS)[number];

/** Whether agents can connect at all (the connector exists only while on), and at which level. */
export interface AgentsSetting {
  enabled: boolean;
  access: AgentAccess;
}

export const DEFAULT_AGENTS: AgentsSetting = { enabled: false, access: "read" };

export function accessAllows(access: AgentAccess, needed: AgentAccess): boolean {
  return AGENT_ACCESS.indexOf(access) >= AGENT_ACCESS.indexOf(needed);
}

/** Sending, and filing into a category that forwards: only while agents are on, at the top level. */
export function agentsMaySend(agents: AgentsSetting): boolean {
  return agents.enabled && agents.access === "send";
}

/**
 * Every method an agent may call, with the lowest level that may call it.
 * A method not here is refused at every level (settings, accounts, secrets…).
 */
export const AGENT_METHODS: Partial<Record<MethodName, AgentAccess>> = {
  "app.bootstrap": "read",
  "threads.list": "read",
  "threads.search": "read",
  "threads.get": "read",
  "threads.bodyPart": "read",
  "counts.get": "read",
  "filters.list": "read",
  "filters.preview": "read",
  "drafts.list": "read",
  // what the engine thinks, and what a filing would take: questions, not changes
  "categorize.predict": "read",
  "categorize.suggestions": "read",
  "categorize.count": "read",
  "categorize.preview": "read",
  "threads.act": "organize",
  "categories.addThreads": "organize",
  "categories.removeThreads": "organize",
  "categories.create": "organize",
  // as agents: half weight
  "categorize.apply": "organize",
  "filters.save": "organize",
  "drafts.save": "organize",
  "compose.send": "send",
};

/** The level's name as Settings → Agents shows it, for messages to agents (English: agents read it, not the UI). */
export const AGENT_ACCESS_LABEL: Record<AgentAccess, string> = {
  // i18n-ignore: for agents, matching the English label in Settings
  read: "Read only",
  // i18n-ignore: as above
  organize: "Read and organize",
  // i18n-ignore: as above
  send: "Read, organize and send",
};

/** Why an agent was refused, for it to tell the user (English: the agent reads it). */
export function agentRefusal(needed: AgentAccess): string {
  // i18n-ignore: for the agent, which tells the user
  if (needed === "send") return `Not allowed: sending needs '${AGENT_ACCESS_LABEL.send}' access, which the user hasn't given. Create a draft with create_draft instead and ask the user to review and send it in Terno, or to change the access in Terno → Settings → Agents.`;
  // i18n-ignore: as above
  return `Not allowed: Terno lets agents only read. Archiving, marking, categorizing, filters and drafts need '${AGENT_ACCESS_LABEL[needed]}' access: ask the user to change it in Terno → Settings → Agents.`;
}
