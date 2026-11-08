// Types for model-stub.mjs (plain JS: a round's frozen runtime has no TypeScript), for the e2e specs and the stub's tests.

export interface ModelStubOptions {
  /** 0: a free port */
  port?: number;
  /** spacing between a stream's pieces */
  paceMs?: number;
  chatDelayMs?: number;
  chatHeld?: Promise<void>;
  /** an HTTP status to fail a summary with, or null to answer */
  summaryFails?: () => number | null;
}

export interface ModelStub {
  url: string;
  port: number;
  /** "METHOD /path" of every request */
  requests: string[];
  /** the task of every chat request ("unknown" for one the stub can't name) */
  tasks: string[];
  /** what each thread_summary request carried */
  summaries: string[];
  /** the start of every request the stub had no answer for */
  unknown: string[];
  /** the last request of each task */
  last: Record<string, { messages: { role: string; content: string }[] }>;
  /** chat requests not yet answered */
  readonly active: number;
  close(): Promise<void>;
}

export const MODELS: { name: string; size: number }[];
export const MODEL: string;
export function startModelStub(options?: ModelStubOptions): Promise<ModelStub>;
export function taskOf(body: unknown): string | null;
export function answerFor(body: unknown): { task: string; content: string } | null;
export function chunksOf(content: string): string[];
export function longDate(ms: number, es?: boolean): string;
export function person(from: string | undefined): { name: string; first: string };
