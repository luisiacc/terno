import { useSyncExternalStore } from "react";
import { useApp } from "~/state/app";

/**
 * Exploration (branch explore/ai-card-variations), to be removed once the owner picks one: four looks for the reader's AI
 * cards (the summary and Reply ready) beside today's, chosen in Settings → Dev mode, so only a local build ever sees one.
 * Kept in this window's storage: a choice of the developer's, never the profile's.
 */
export const AI_LOOKS = ["current", "whisper", "whisperTint", "whisperMuted", "whisperField", "ledger", "float", "edge"] as const;
export type AiLook = (typeof AI_LOOKS)[number];

const KEY = "terno.dev.aiLook";
const isLook = (v: unknown): v is AiLook => AI_LOOKS.includes(v as AiLook);

function stored(): AiLook {
  try {
    const v = localStorage.getItem(KEY);
    return isLook(v) ? v : "current";
  } catch {
    return "current";
  }
}

// an object, not a module let (React Compiler: read-then-reset of a module let miscompiles)
const state = { look: null as AiLook | null };
const listeners = new Set<() => void>();
const current = (): AiLook => (state.look ??= stored());

function subscribe(fn: () => void) {
  listeners.add(fn);
  // another window, or a capture script setting the key and dispatching `storage`
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    state.look = isLook(e.newValue) ? e.newValue : "current";
    fn();
  };
  addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    removeEventListener("storage", onStorage);
  };
}

export function setAiLook(look: AiLook) {
  state.look = look;
  try {
    localStorage.setItem(KEY, look);
  } catch {
    /* the choice lasts this session */
  }
  for (const fn of listeners) fn();
}

/** The look in use: always today's outside a local build (no Dev mode). */
export function useAiLook(): AiLook {
  const dev = useApp((s) => s.devAi !== null);
  const look = useSyncExternalStore(subscribe, current, () => "current" as const);
  return dev ? look : "current";
}
