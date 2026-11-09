import { BODY_GLANCE_MAX, readBody } from "@terno/core";
import { t } from "@terno/i18n";
import { IconButton } from "@terno/ui/components/icon-button";
import { Sparkles } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useState } from "react";
import { useAiDraftUi, useCanDraft } from "~/lib/ai-draft-state";
import { openAiDraft } from "~/lib/ai-draft";
import { useDrafts } from "~/lib/drafts";
import { AiPreview, AiRow } from "./ai-draft";
import { docRange } from "./body-text";
import { useController } from "./controller";

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

/** a glance while typing: at most this often, and never when nothing changes */
const GLANCE_MS = 150;

/**
 * Plan 163: what ⌘J would do with the body as it is, read on this machine (rules only): `write` from an instruction,
 * `fill:<n>` gaps, `empty`, or "" (the user's own email, or AI can't tell without asking). Reads the editor's blocks up to
 * a limit, never serializing, and only after the text changes.
 */
function useBodyGlance(draftKey: string | undefined): string {
  const c = useController(draftKey);
  const [glance, setGlance] = useState("");
  useEffect(() => {
    if (!c) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const look = () => {
      timer = null;
      const b = c.bodyText(BODY_GLANCE_MAX);
      const read = readBody(b.text, { images: b.images, limit: BODY_GLANCE_MAX });
      const gaps = read.kind === "email" ? read.gaps.filter((g) => docRange(b, g.from, g.to) !== null).length : 0;
      setGlance(read.kind === "empty" ? "empty" : read.kind === "instruction" ? "write" : gaps ? `fill:${gaps}` : "");
    };
    look();
    const off = c.subscribeDoc(() => {
      timer ??= setTimeout(look, GLANCE_MS);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [c]);
  return glance;
}

/**
 * The quiet Sparkles in a draft's footer and on the reply bar. Plan 161, pass 3: each says what it does, beside the reader's
 * own Sparkles (Summarize this conversation): the reply bar's starts a reply ("Reply with AI"), a draft's writes in it.
 * Plan 163: a draft's is quiet at rest and clearer (full ink, named for it) when the body holds an instruction or a gap;
 * an ordinary email being typed leaves it as it was.
 */
export function AiDraftButton({ draftKey, threadId, disabled, testId }: { draftKey?: string; threadId?: number; disabled?: boolean; testId: string }) {
  const offered = useCanDraft();
  const glance = useBodyGlance(offered ? draftKey : undefined);
  const reply = useDrafts((s) => (draftKey ? (s.drafts[draftKey]?.mode ?? "new") !== "new" : false));
  // over a strip, ⌘J is the strip's (Regenerate): nothing here to light up
  const strip = useAiDraftUi((s) => (draftKey ? s.rows[draftKey] === "open" : false));
  if (!offered) return null;
  const fill = /^fill:(\d+)$/.exec(glance);
  const ready = !strip && (glance === "write" || fill !== null);
  const label =
    draftKey === undefined && threadId !== undefined
      ? t("aiDraft.buttonReply")
      : ready
        ? fill
          ? t("aiDraft.button.fill", { count: Number(fill[1]) })
          : t("aiDraft.button.write")
        : glance === "empty" && reply
          ? t("aiDraft.button.reply")
          : t("aiDraft.button");
  return (
    <IconButton label={label} shortcut="mod+j" disabled={disabled} onMouseDown={keepSelection} onClick={() => openAiDraft({ ...(draftKey ? { key: draftKey } : {}), ...(threadId !== undefined ? { threadId } : {}) })} data-testid={testId} data-ready={ready || undefined} className={cn("[&_svg]:[--icon-line:var(--icon-line-toolbar)]", ready && "text-foreground")}>
      <Sparkles />
    </IconButton>
  );
}
