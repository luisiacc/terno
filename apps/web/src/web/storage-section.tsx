import { t } from "@terno/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { useState } from "react";
import { snack } from "~/lib/snack";
import { ConfirmDialog, SettingsGroup, SettingsRow } from "~/components/settings/parts";
import { client } from "~/rpc/connection";
import { switchStorage } from "./connect";
import { useWeb } from "./lifecycle";
import { useStorageJob } from "~/lib/storage-job";

const mib = (n: number | null) => (n === null ? "?" : t("web.storage.megabytes", { n: Math.round(n / 2 ** 20) }));

const ENGINES = [
  { value: "opfs-sqlite", label: "SQLite (OPFS)" },
  { value: "idb", label: "IndexedDB" },
] as const;
const engineLabel = (id: string | null) => ENGINES.find((e) => e.value === id)?.label ?? id ?? "?";

/** OPFS (its sync handles exist only inside the worker; the page can see the directory API); IndexedDB is everywhere. */
const opfsAvailable = () => typeof navigator.storage?.getDirectory === "function";

/** Settings → Storage on the web: whether the browser may evict the mailbox, and which engine holds it. */
export function StorageSection() {
  const persistence = useWeb((s) => s.persistence);
  const storage = useWeb((s) => s.storage);
  const [target, setTarget] = useState<string | null>(null);
  // a switch reloads the backend: never in the middle of freeing up space (plan 69)
  const removing = useStorageJob((s) => s.removing);
  const state = persistence?.state ?? "unsupported";
  return (
    <SettingsGroup title={t("web.storage.title")} testId="storage-section">
      <div data-persisted={persistence?.state} data-testid="storage-persistence">
        <SettingsRow
          label={state === "granted" ? t("web.storage.persistent") : t("web.storage.evictable")}
          hint={state === "granted" ? t("web.storage.persistentHint") : t("web.storage.evictableHint")}
        >
          {() => (
            <span className="text-xs text-muted-foreground tabular-nums" data-testid="storage-usage">
              {t("web.storage.usage", { used: mib(persistence?.usage ?? null), quota: mib(persistence?.quota ?? null) })}
            </span>
          )}
        </SettingsRow>
      </div>
      <SettingsRow label={t("web.storage.engine")} hint={t("web.storage.engineHint")}>
        {({ id: _id, ...a }) => (
          <Select value={storage ?? undefined} onValueChange={(v) => v !== storage && setTarget(v as string)} items={ENGINES.map((e) => ({ ...e }))} disabled={removing}>
            <SelectTrigger {...a} size="sm" className="w-40" data-testid="storage-engine">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENGINES.map((e) => (
                <SelectItem key={e.value} value={e.value} disabled={e.value === "opfs-sqlite" && !opfsAvailable()} data-testid={`storage-engine-${e.value}`}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </SettingsRow>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        testId="storage-switch-dialog"
        title={t("web.storage.switchTitle", { engine: engineLabel(target) })}
        description={t("web.storage.switchBody", { engine: engineLabel(target), current: engineLabel(storage) })}
        confirm={t("web.storage.switchConfirm", { engine: engineLabel(target) })}
        onConfirm={async () => {
          if (!target) return;
          try {
            await switchStorage(client, target);
          } catch (e) {
            snack.error(e instanceof Error ? e.message : String(e));
          }
        }}
      />
    </SettingsGroup>
  );
}
