import { shortcutsFor, type Command, type ThreadAction } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Archive, CheckCheck, FolderInput, Inbox, Mail, MailOpen, OctagonAlert, ShieldCheck, Star, Tag, Trash2, X } from "lucide-react";
import { formatNumber, t } from "@terno/i18n";
import { act } from "~/lib/actions";
import { clearSelection, isMac, selectAll } from "~/lib/select";
import { setApp, useApp } from "~/state/app";
import { useList } from "~/state/list";

function BarButton({ label, command, onClick, children, testId, disabled }: { label: string; command?: Command; onClick: () => void; children: React.ReactNode; testId: string; disabled?: boolean }) {
  const keys = command ? shortcutsFor(command, undefined, isMac)[0] : undefined;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="outline" size="sm" data-testid={testId} disabled={disabled} onClick={onClick} className="justify-start gap-2">
            {children}
            {label}
          </Button>
        }
      />
      {keys && (
        <TooltipContent>
          <Shortcut keys={keys} />
        </TooltipContent>
      )}
    </Tooltip>
  );
}

/**
 * With two or more conversations selected (or "all N" of a view) the reader
 * area shows what they are and what to do with them, like Apple Mail.
 */
export function SelectionBar() {
  const count = useApp((s) => s.scope?.count ?? s.checked.size);
  const scope = useApp((s) => s.scope);
  const view = useApp((s) => s.view);
  const loaded = useList((s) => s.items.length);
  const run = (a: ThreadAction) => () => void act(a);
  return (
    <section data-testid="selection-bar" className="flex h-full min-h-0 flex-col items-center justify-center gap-6 bg-background p-10 text-center">
      <div>
        <div className="mb-3 inline-flex h-10 min-w-10 items-center justify-center rounded-xl bg-tint px-2.5 text-xl font-semibold tracking-display text-foreground tabular" data-testid="selection-count">
          {count > 999 ? `${formatNumber(999)}+` : formatNumber(count)}
        </div>
        <p className="text-lg font-semibold tracking-tight">{scope ? t("selection.scope", { count, label: scope.label }) : t("selection.count", { count })}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t("selection.hint")}</p>
      </div>
      <div className="grid w-full max-w-md grid-cols-2 gap-2">
        {view === "trash" || view === "spam" || view === "archive" ? (
          <BarButton label={view === "spam" ? t("actions.notSpam") : t("actions.moveToInbox")} onClick={run(view === "spam" ? "notSpam" : "moveToInbox")} testId="bar-inbox">
            {view === "spam" ? <ShieldCheck /> : <Inbox />}
          </BarButton>
        ) : (
          <BarButton label={t("actions.archive")} command="thread.archive" onClick={run("archive")} testId="bar-archive">
            <Archive />
          </BarButton>
        )}
        <BarButton label={t("actions.trash")} command="thread.trash" onClick={run("trash")} testId="bar-trash" disabled={view === "trash"}>
          <Trash2 />
        </BarButton>
        <BarButton label={t("actions.markRead")} command="thread.markRead" onClick={run("markRead")} testId="bar-read">
          <MailOpen />
        </BarButton>
        <BarButton label={t("actions.markUnread")} command="thread.markUnread" onClick={run("markUnread")} testId="bar-unread">
          <Mail />
        </BarButton>
        <BarButton label={t("actions.star")} command="thread.star" onClick={run("star")} testId="bar-star">
          <Star />
        </BarButton>
        <BarButton label={t("actions.spam")} command="thread.spam" onClick={run("spam")} testId="bar-spam" disabled={view === "spam"}>
          <OctagonAlert />
        </BarButton>
        <BarButton label={t("actions.category")} command="thread.category" onClick={() => setApp({ dialog: "categoryPicker", pickerMode: "toggle" })} testId="bar-category">
          <Tag />
        </BarButton>
        <BarButton label={t("actions.moveTo")} command="thread.move" onClick={() => setApp({ dialog: "categoryPicker", pickerMode: "move" })} testId="bar-move" disabled={scope !== null}>
          <FolderInput />
        </BarButton>
      </div>
      <div className="flex items-center gap-2">
        {!scope && count < loaded && (
          <Button variant="ghost" size="sm" data-testid="bar-select-all" onClick={selectAll}>
            <CheckCheck /> {t("actions.selectAll")} <Shortcut keys="mod+a" className="ml-1" />
          </Button>
        )}
        <Button variant="ghost" size="sm" data-testid="bar-clear" onClick={clearSelection}>
          <X /> {t("selection.deselect")} <Shortcut keys="escape" className="ml-1" />
        </Button>
      </div>
    </section>
  );
}
