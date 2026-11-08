import { t } from "@terno/i18n";
import { IconButton } from "@terno/ui/components/icon-button";
import { Sparkles } from "@terno/ui/icons";
import { useAiDraftUi, useCanDraft } from "~/lib/ai-draft-state";
import { openAiDraft } from "~/lib/ai-draft";
import { AiPreview, AiRow } from "./ai-draft";

/**
 * Plan 133: the doors to the AI row and preview: each renders nothing until the draft has the row up. The Sparkles
 * button is the only one always there.
 */

export function AiRowSlot({ draftKey }: { draftKey: string }) {
  const up = useAiDraftUi((s) => s.rows[draftKey] !== undefined);
  if (!up) return null;
  return <AiRow draftKey={draftKey} />;
}

export function AiPreviewSlot({ draftKey, className }: { draftKey: string; className?: string }) {
  const up = useAiDraftUi((s) => s.rows[draftKey] !== undefined);
  if (!up) return null;
  return <AiPreview draftKey={draftKey} className={className} />;
}

// a click here mustn't take the caret away from the text the row will come back to
const keepSelection = (e: React.MouseEvent) => e.preventDefault();

/**
 * The quiet Sparkles in a draft's footer and on the reply bar. Plan 161, pass 3: each says what it does, beside the reader's
 * own Sparkles (Summarize this conversation): the reply bar's starts a reply ("Reply with AI"), a draft's writes in it.
 */
export function AiDraftButton({ draftKey, threadId, disabled, testId }: { draftKey?: string; threadId?: number; disabled?: boolean; testId: string }) {
  const offered = useCanDraft();
  if (!offered) return null;
  return (
    <IconButton label={draftKey === undefined && threadId !== undefined ? t("aiDraft.buttonReply") : t("aiDraft.button")} shortcut="mod+j" disabled={disabled} onMouseDown={keepSelection} onClick={() => openAiDraft({ ...(draftKey ? { key: draftKey } : {}), ...(threadId !== undefined ? { threadId } : {}) })} data-testid={testId} className="[&_svg]:[--icon-line:var(--icon-line-toolbar)]">
      <Sparkles />
    </IconButton>
  );
}
