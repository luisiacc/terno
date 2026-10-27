import { t } from "@terno/i18n";
import { cn } from "@terno/ui/lib/utils";
import { PenLine } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { openStoredDraft } from "~/lib/compose";
import { draftPresentationThread, authored, shownDraftKey, useDrafts, type LocalDraft } from "~/lib/drafts";
import { useApp } from "~/state/app";
import { useList } from "~/state/list";

const SHOWN = 3;

/** Who a draft goes to, for its one line. */
function recipientsLine(d: LocalDraft): string {
  const first = d.toText.split(",")[0]?.trim();
  if (!first) return t("compose.strip.noRecipients");
  const name = first.replace(/<.*$/, "").replace(/"/g, "").trim() || first.replace(/[<>]/g, "");
  const more = d.toText.split(",").length - 1;
  return more > 0 ? t("compose.strip.andMore", { name, count: more }) : name;
}

/**
 * Drafts that aren't on screen otherwise, above the list (outside the
 * virtualizer, where the banners sit): new messages, drafts whose
 * conversation isn't in this list (archived, moved, another view) and older
 * drafts of a conversation that has a newer one. One click away each.
 */
export function DraftsStrip() {
  const compose = useApp((s) => s.compose?.key ?? null);
  const shown = useApp((s) => s.draftShown);
  const index = useList((s) => s.index);
  const [expanded, setExpanded] = useState(false);
  const items = useDrafts(
    useShallow((s) => {
      const out: LocalDraft[] = [];
      for (const d of Object.values(s.drafts)) {
        const thread = draftPresentationThread(d);
        if (thread === null) {
          if (authored(d) || d.key === compose) out.push(d);
        } else if (authored(d)) {
          const inline = index.has(thread) && shownDraftKey(s.drafts, thread, shown) === d.key;
          if (!inline) out.push(d);
        }
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    }),
  );
  if (items.length === 0) return null;
  const visible = expanded ? items : items.slice(0, SHOWN);

  return (
    <div className="hairline-b shrink-0 py-1" data-testid="drafts-strip" role="group" aria-label={t("compose.strip.label")}>
      {visible.map((d) => (
        <button
          key={d.key}
          type="button"
          data-testid="strip-item"
          data-key={d.key}
          aria-current={compose === d.key || undefined}
          onClick={() => void openStoredDraft(d.key)}
          className={cn(
            "relative flex h-9 w-full items-center gap-2 px-5 text-left text-sm",
            "before:absolute before:inset-x-2 before:inset-y-px before:rounded-md",
            compose === d.key ? "text-row-selected-foreground before:bg-row-selected" : "hover:before:bg-row-hover",
          )}
        >
          <PenLine className="relative size-3.5 shrink-0 text-primary" />
          <span className="relative min-w-0 shrink-0 truncate font-medium">{d.subject || t(d.mode === "new" ? "compose.untitled" : "common.noSubject")}</span>
          <span className="relative min-w-0 truncate text-muted-foreground">{t("compose.strip.to", { recipients: recipientsLine(d) })}</span>
        </button>
      ))}
      {!expanded && items.length > SHOWN && (
        <button type="button" onClick={() => setExpanded(true)} className="h-7 w-full px-5 text-left text-xs font-medium text-muted-foreground hover:text-foreground" data-testid="strip-more">
          {t("compose.strip.more", { count: items.length - SHOWN })}
        </button>
      )}
    </div>
  );
}
