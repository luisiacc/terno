import { JEV_DEFAULT_MODEL } from "@terno/core";
import type { AiTestResult, AppSettings } from "@terno/core/rpc";
import { Button } from "@terno/ui/components/button";
import { Input } from "@terno/ui/components/input";
import { CircleCheck } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { useState } from "react";
import { reconcileSettings } from "~/lib/appearance";
import { localized } from "~/lib/i18n";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp } from "~/state/app";
import { SettingsGroup, SettingsRow } from "./parts";

/**
 * Plan 134: the key that makes categorization run on JEV. A provider key, so it lives in Settings → AI with the others;
 * Categories keeps the switch that uses it. Never prefilled; the backend only says it's saved and its last 4.
 */
function JevKeyRow({ saved, hint }: { saved: boolean; hint: string | null }) {
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<AiTestResult | null>(null);
  const save = async (value: string) => {
    try {
      setApp({ settings: reconcileSettings(await client.call("ai.setKey", { provider: "jev", value })) });
      setKey("");
      setTest(null);
      snack.success(value ? t("ai.key.savedSnack") : t("ai.key.removedSnack"));
    } catch (error) {
      snack.error(error instanceof Error ? error.message : String(error));
    }
  };
  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await client.call("ai.test", { provider: "jev", model: JEV_DEFAULT_MODEL }));
    } finally {
      setTesting(false);
    }
  };
  return (
    <SettingsRow find="ai.jev" stacked labelFor={!saved} label={t("ai.jev")} hint={t("ai.jev.hint")} testId="jev-key-row">
      {(a) =>
        saved ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="jev-key-saved">
              <span className="text-success-ink">{hint ? t("ai.key.savedHint", { hint }) : t("ai.key.saved")}</span>
              <Button variant="outline" size="xs" loading={testing} data-testid="jev-key-test" onClick={() => void runTest()}>
                {t("ai.test")}
              </Button>
              <Button variant="ghost" size="xs" aria-label={t("ai.key.remove", { provider: "JEV" })} data-testid="jev-key-remove" onClick={() => void save("")}>
                {t("common.remove")}
              </Button>
              <span role="status" aria-live="polite" className="text-xs">
                {test?.ok && (
                  <span className="flex items-center gap-1.5 text-success-ink" data-testid="jev-key-test-result">
                    <CircleCheck className="size-3.5" aria-hidden /> {t("ai.test.connected")}
                  </span>
                )}
              </span>
            </div>
            {test && !test.ok && (
              <p role="alert" className="text-xs text-destructive-ink" data-testid="jev-key-test-error">
                {localized(test.error?.message, test.error?.i18n)}
              </p>
            )}
          </div>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim()) void save(key.trim());
            }}
          >
            <Input {...a} data-testid="jev-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className="h-7 bg-background dark:bg-input/30" />
            <Button type="submit" size="sm" disabled={!key.trim()} data-testid="jev-key-save">
              {t("common.save")}
            </Button>
          </form>
        )
      }
    </SettingsRow>
  );
}

/** Settings → AI → Categories: the JEV key. Dev mode's keys come from the environment (plan 146), so it shows none. */
export function CategorizingGroup({ settings }: { settings: AppSettings }) {
  if (settings.ai.fromEnv) return null;
  const jev = settings.ai.keys.jev;
  return (
    <SettingsGroup title={t("ai.categorize.title")} testId="ai-categorize">
      <JevKeyRow saved={!!jev?.hasKey} hint={jev?.keyHint ?? null} />
    </SettingsGroup>
  );
}
