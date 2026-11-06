import { WRITING_CLAUDE_MODEL, WRITING_INSTRUCTIONS_MAX, type WritingPrefs } from "@terno/core";
import type { AppSettings } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Switch } from "@terno/ui/components/switch";
import { useEffect, useState } from "react";
import { modelName, providerLabel, writingTarget } from "~/lib/ai";
import { useAiDraftUi } from "~/lib/ai-draft-state";
import { isMac } from "~/lib/select";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { CommitInput, SettingsGroup, SettingsNote, SettingsRow, type SettingsUpdate } from "./parts";

/** Plan 133 §7: what the renderer reads through `writing.prefs.*`, never `AppSettings`: nothing here reaches MCP. */
function usePrefs(): [WritingPrefs | null, (patch: Parameters<typeof client.call<"writing.prefs.set">>[1]) => Promise<void>] {
  const [prefs, setPrefs] = useState<WritingPrefs | null>(null);
  useEffect(() => {
    let current = true;
    void client.call("writing.prefs.get", {}).then((p) => current && setPrefs(p), () => {});
    return () => { current = false; };
  }, []);
  const save = async (patch: Parameters<typeof client.call<"writing.prefs.set">>[1]) => {
    const next = await client.call("writing.prefs.set", patch);
    setPrefs(next);
    useAiDraftUi.setState({ enabled: next.global.enabled });
  };
  return [prefs, save];
}

const failed = (e: unknown): void => { snack.error(e instanceof Error ? e.message : String(e)); };

/** The model drafts run on, as the backend picks it: Sonnet 5.5 on Claude unless the user chose another (§6.6). */
function writingModel(ai: AppSettings["ai"]): string {
  return ai.tasks.writing?.model ?? (ai.provider === "anthropic" ? WRITING_CLAUDE_MODEL : ai.model);
}

/** Settings → AI → Drafting. It starts nothing: the local learner runs from the first draft or the Writing style page, not from looking at the AI tab. */
export function DraftingGroup({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const { ai } = settings;
  const repliesOn = settings.replies?.enabled === true;
  const [prefs, save] = usePrefs();
  const target = writingTarget(ai);
  return (
    <SettingsGroup title={t("aiDraft.settings.title")} testId="ai-drafting">
      <SettingsRow label={t("aiDraft.settings.enabled")} hint={t("aiDraft.settings.enabledHint", { key: isMac ? "⌘J" : "Ctrl+J" })}>
        {(a) => <Switch {...a} checked={prefs?.global.enabled ?? true} data-testid="ai-drafting-enabled" onCheckedChange={(enabled) => void save({ global: { enabled } }).catch(failed)} />}
      </SettingsRow>
      {(prefs?.global.enabled ?? true) && (
        <>
          <SettingsRow stacked labelFor label={t("aiDraft.settings.instructions")} hint={t("aiDraft.settings.instructionsHint")}>
            {(a) => <CommitInput multiline a11y={a} data-testid="ai-drafting-instructions" value={prefs?.global.instructions ?? ""} placeholder={t("aiDraft.settings.instructionsPlaceholder")} maxLength={WRITING_INSTRUCTIONS_MAX} onCommit={(instructions) => save({ global: { instructions } })} />}
          </SettingsRow>
          <SettingsRow label={t("aiDraft.settings.sentMail")} hint={t("aiDraft.settings.sentMailHint")}>
            {(a) => <Switch {...a} checked={prefs?.global.useSentMail ?? true} data-testid="ai-drafting-sent-mail" onCheckedChange={(useSentMail) => void save({ global: { useSentMail } }).catch(failed)} />}
          </SettingsRow>
          <SettingsRow label={t("replies.settings.switch")} hint={target.provider === "none" ? t("replies.settings.noProvider") : t("replies.settings.hint", { provider: providerLabel(target.provider, ai) })} testId="replies-setting">
            {(a) => <Switch {...a} checked={repliesOn} disabled={target.provider === "none"} data-testid="replies-switch" onCheckedChange={(enabled) => void update({ replies: { enabled } })} />}
          </SettingsRow>
          <SettingsRow label={t("aiDraft.style.title")} hint={t("aiDraft.settings.styleHint")} testId="ai-drafting-style">
            {({ id: _id, "aria-labelledby": _l, "aria-describedby": described }) => (
              <Button variant="outline" size="sm" aria-describedby={described} data-testid="ai-drafting-style-open" onClick={() => useAiDraftUi.setState({ stylePage: true })}>
                {t("aiDraft.settings.styleOpen")}
              </Button>
            )}
          </SettingsRow>
          {target.ready && (
            <SettingsNote testId="ai-drafting-model">
              {t("aiDraft.settings.model", { model: modelName(writingModel(ai)), provider: providerLabel(target.provider, ai) })}
              {target.local ? "" : ` ${t("aiDraft.settings.sends", { provider: providerLabel(target.provider, ai) })}`}
            </SettingsNote>
          )}
        </>
      )}
    </SettingsGroup>
  );
}

/** Settings → Accounts, after Signature (§7): this account's own instructions, on top of the general ones. */
export function AccountWriting({ accountId }: { accountId: number }) {
  const [prefs, save] = usePrefs();
  if (!prefs?.global.enabled) return null;
  const own = prefs.accounts[String(accountId)];
  // each sends only its own field: the backend merges, so a save in flight from the other is never overwritten with what this render saw
  return (
    <>
      <SettingsRow stacked labelFor label={t("aiDraft.account.instructions")} hint={t("aiDraft.account.instructionsHint")}>
        {(a) => <CommitInput multiline a11y={a} data-testid="account-writing-instructions" value={own?.instructions ?? ""} placeholder={t("aiDraft.account.instructionsPlaceholder")} maxLength={WRITING_INSTRUCTIONS_MAX} onCommit={(instructions) => save({ account: { accountId, prefs: { instructions } } })} />}
      </SettingsRow>
      <SettingsRow label={t("replies.account")} hint={t("replies.accountHint")}>
        {(a) => <Switch {...a} checked={own?.prepareReplies ?? true} data-testid="account-prepare-replies" onCheckedChange={(prepareReplies) => void save({ account: { accountId, prefs: { prepareReplies } } }).catch(failed)} />}
      </SettingsRow>
      <SettingsRow label={t("aiDraft.account.useGeneral")} hint={t("aiDraft.account.useGeneralHint")}>
        {(a) => <Switch {...a} checked={own?.useGeneral ?? true} data-testid="account-writing-general" onCheckedChange={(useGeneral) => void save({ account: { accountId, prefs: { useGeneral } } }).catch(failed)} />}
      </SettingsRow>
    </>
  );
}
