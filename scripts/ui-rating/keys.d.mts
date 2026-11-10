// Types for keys.mjs (plain JS: a round's frozen runtime has no TypeScript), for the site's AI pictures (apps/site/shots/ai-shots.ts).

export const DEFAULT_ENV_FILE: string;
export function envFile(env?: Record<string, string | undefined>): string;
export const PROVIDERS: Record<"anthropic" | "openai" | "jev", { env: string; host: string; required: boolean }>;
export const PRO_ROUTING: Record<string, string>;

export interface Keys {
  /** variable name → key, for one process's environment or memory only */
  env: Record<string, string>;
  providers: string[];
  hosts: string[];
  /** for redaction */
  secrets: string[];
}

export function readKeys(file?: string): Keys;
export const REDACTED: string;
export function redact(text: unknown, secrets?: string[]): string;
export function holdsKey(data: string | Uint8Array, secrets: string[]): boolean;
export function guardOutput(secrets: string[]): void;
export function writeRedacted(file: string, data: string | Uint8Array, secrets: string[]): void;
export function copyRedacted(src: string, dest: string, secrets: string[]): void;
export function filesHoldingKeys(dir: string, secrets: string[]): string[];
