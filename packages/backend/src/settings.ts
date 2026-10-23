import type { AppSettings } from "@unica/core/rpc";
import { getSecret, getSetting, setSetting, type Db } from "@unica/db";
import { DEFAULT_ANTHROPIC_MODEL } from "@unica/ai";

type StoredSettings = Omit<AppSettings, "hasAiKey">;

export const DEFAULT_SETTINGS: StoredSettings = {
  // new installs start local; migration v3 writes false for installs that predate it
  localMode: true,
  theme: "system",
  density: "comfortable",
  remoteImages: "ask",
  aiProvider: "anthropic",
  aiModel: DEFAULT_ANTHROPIC_MODEL,
  allowAgentSend: false,
  gmailClientId: "",
  syncWindowDays: 90,
};

export function readSettings(db: Db): AppSettings {
  const stored = getSetting<Partial<StoredSettings>>(db, "app", {});
  return { ...DEFAULT_SETTINGS, ...stored, hasAiKey: getSecret(db, "ai:anthropic:apiKey") !== null };
}

export function updateSettings(db: Db, patch: Partial<StoredSettings>): AppSettings {
  const stored = getSetting<Partial<StoredSettings>>(db, "app", {});
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  setSetting(db, "app", { ...stored, ...defined });
  return readSettings(db);
}
