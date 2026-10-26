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

type Variant = "pane" | "toolbar";

function BarButton({ label, command, onClick, children, testId, disabled, bar }: { label: string; command?: Command; onClick: () => void; children: React.ReactNode; testId: string; disabled?: boolean; bar: Variant }) {
  const keys = command ? shortcutsFor(command, undefined, isMac)[0] : undefined;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          bar === "pane" ? (
            <Button variant="outline" size="sm" data-testid={testId} disabled={disabled} onClick={onClick} className="justify-start gap-2">
              {children}
              {label}
            </Button>
          ) : (
            // the toolbar's: the icon, named; the name and key in the tooltip
            <Button variant="ghost" size="icon-sm" data-testid={testId} disabled={disabled} onClick={onClick} aria-label={label} className="text-muted-foreground hover:text-foreground">
              {children}
            </Button>
          )
        }
      />
      {(keys || bar === "toolbar") && (
        <TooltipContent className="flex items-center gap-2">
          {bar === "toolbar" && label}
          {keys && <Shortcut keys={keys} />}
        </TooltipContent>
      )}
    </Tooltip>
  );
}

/**
 * With two or more conversations selected (or "all N" of a view): what they
 * are and what to do with them. Split shows it in the reader pane, like
 * Apple Mail; List (plan 24), which has no side pane, as a toolbar over the
 * rows. The same actions, names, test ids and shortcuts in both.
 */
export function SelectionBar({ variant = "pane" }: { variant?: Variant }) {
  const count = useApp((s) => s.scope?.count ?? s.checked.size);
  const scope = useApp((s) => s.scope);
  const view = useApp((s) => s.view);
  const loaded = useList((s) => s.items.length);
  const run = (a: ThreadAction) => () => void act(a);
  const bar = variant;
  const title = scope ? t("selection.scope", { count, label: scope.label }) : t("selection.count", { count });
  const actions = (
    <>
      {view === "trash" || view === "spam" || view === "archive" ? (
        <BarButton bar={bar} label={view === "spam" ? t("actions.notSpam") : t("actions.moveToInbox")} onClick={run(view === "spam" ? "notSpam" : "moveToInbox")} testId="bar-inbox">
          {view === "spam" ? <ShieldCheck /> : <Inbox />}
        </BarButton>
      ) : (
        <BarButton bar={bar} label={t("actions.archive")} command="thread.archive" onClick={run("archive")} testId="bar-archive">
          <Archive />
        </BarButton>
      )}
      <BarButton bar={bar} label={t("actions.trash")} command="thread.trash" onClick={run("trash")} testId="bar-trash" disabled={view === "trash"}>
        <Trash2 />
      </BarButton>
      <BarButton bar={bar} label={t("actions.markRead")} command="thread.markRead" onClick={run("markRead")} testId="bar-read">
        <MailOpen />
      </BarButton>
      <BarButton bar={bar} label={t("actions.markUnread")} command="thread.markUnread" onClick={run("markUnread")} testId="bar-unread">
        <Mail />
      </BarButton>
      <BarButton bar={bar} label={t("actions.star")} command="thread.star" onClick={run("star")} testId="bar-star">
        <Star />
      </BarButton>
      <BarButton bar={bar} label={t("actions.spam")} command="thread.spam" onClick={run("spam")} testId="bar-spam" disabled={view === "spam"}>
        <OctagonAlert />
      </BarButton>
      <BarButton bar={bar} label={t("actions.category")} command="thread.category" onClick={() => setApp({ dialog: "categoryPicker", pickerMode: "toggle" })} testId="bar-category">
        <Tag />
      </BarButton>
      <BarButton bar={bar} label={t("actions.moveTo")} command="thread.move" onClick={() => setApp({ dialog: "categoryPicker", pickerMode: "move" })} testId="bar-move" disabled={scope !== null}>
        <FolderInput />
      </BarButton>
    </>
  );
  const more = !scope && count < loaded;
  if (bar === "toolbar")
    return (
      <div role="toolbar" aria-label={title} data-testid="selection-bar" data-variant="toolbar" className="hairline-b flex shrink-0 items-center gap-0.5 bg-tint px-3 py-1">
        <span className="mr-2 min-w-0 truncate text-xs font-medium text-foreground tabular" data-testid="selection-count">
          {title}
        </span>
        {actions}
        <span className="ml-auto flex items-center gap-0.5">
          {more && (
            <BarButton bar={bar} label={t("actions.selectAll")} command="list.selectAll" onClick={selectAll} testId="bar-select-all">
              <CheckCheck />
            </BarButton>
          )}
          <BarButton bar={bar} label={t("selection.deselect")} command="reader.close" onClick={clearSelection} testId="bar-clear">
            <X />
          </BarButton>
        </span>
      </div>
    );
  return (
    <section data-testid="selection-bar" className="flex h-full min-h-0 flex-col items-center justify-center gap-6 bg-background p-10 text-center">
      <div>
        <div className="mb-3 inline-flex h-10 min-w-10 items-center justify-center rounded-xl bg-tint px-2.5 text-xl font-semibold tracking-display text-foreground tabular" data-testid="selection-count">
          {count > 999 ? `${formatNumber(999)}+` : formatNumber(count)}
        </div>
        <p className="text-lg font-semibold tracking-tight">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t("selection.hint")}</p>
      </div>
      <div className="grid w-full max-w-md grid-cols-2 gap-2">{actions}</div>
      <div className="flex items-center gap-2">
        {more && (
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
