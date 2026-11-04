import { t } from "@terno/i18n";
import { IconButton } from "@terno/ui/components/icon-button";
import { Sparkles } from "@terno/ui/icons";
import { lazy, Suspense } from "react";
import { openAiDraft, useAiDraftUi } from "~/lib/ai-draft-state";

/**
 * Plan 133: the entry chunk's doors to the lazy AI row and preview: each renders nothing, and loads nothing, until the
 * draft has the row up. The Sparkles button is the only one always there.
 */

const Row = lazy(() => import("./ai-draft").then((m) => ({ default: m.AiRow })));
const Preview = lazy(() => import("./ai-draft").then((m) => ({ default: m.AiPreview })));

export function AiRowSlot({ draftKey }: { draftKey: string }) {
  const up = useAiDraftUi((s) => s.rows[draftKey] !== undefined);
  if (!up) return null;
  return (
    <Suspense fallback={null}>
      <Row draftKey={draftKey} />
    </Suspense>
  );
}

export function AiPreviewSlot({ draftKey, className }: { draftKey: string; className?: string }) {
  const up = useAiDraftUi((s) => s.rows[draftKey] !== undefined);
  if (!up) return null;
  return (
    <Suspense fallback={null}>
      <Preview draftKey={draftKey} className={className} />
    </Suspense>
  );
}

// a click here mustn't take the caret away from the text the row will come back to
const keepSelection = (e: React.MouseEvent) => e.preventDefault();

/** The quiet Sparkles in a draft's footer and on the reply bar. */
export function AiDraftButton({ draftKey, threadId, disabled, testId }: { draftKey?: string; threadId?: number; disabled?: boolean; testId: string }) {
  const enabled = useAiDraftUi((s) => s.enabled);
  if (!enabled) return null;
  return (
    <IconButton label={t("aiDraft.button")} shortcut="mod+j" disabled={disabled} onMouseDown={keepSelection} onClick={() => openAiDraft({ ...(draftKey ? { key: draftKey } : {}), ...(threadId !== undefined ? { threadId } : {}) })} data-testid={testId} className="[&_svg]:[--icon-line:var(--icon-line-toolbar)]">
      <Sparkles />
    </IconButton>
  );
}
