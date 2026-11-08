import { shortcutsFor, type Command, type ThreadAction } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { Archive, Bell, CheckCheck, FolderInput, Inbox, Mail, MailOpen, OctagonAlert, ShieldCheck, Star, StarOff, Tag, Trash2, X } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { act, tabbedTest, targetRows } from "~/lib/actions";
import { openRemind } from "~/lib/reminders";
import { actionView, placeActions } from "~/lib/places";
import { clearSelection, isMac, selectAll } from "~/lib/select";
import { setApp, useApp } from "~/state/app";
import { useList } from "~/state/list";
import { PANE_TITLE, PANE_TITLE_TOP, READING_COLUMN } from "~/lib/pane-lines";
import { LIST_TITLE } from "~/lib/list-title";
import { useDesign } from "~/lib/design";

type Variant = "pane" | "toolbar";

const SHOWN_ROWS = 8;

/** The menu's destructive row, on a secondary button: red text and icon, the red's wash under the pointer */
const DANGER =
  "text-destructive hover:bg-destructive/10 hover:text-destructive active:bg-destructive/10 aria-expanded:text-destructive dark:hover:bg-destructive/20 dark:active:bg-destructive/20 [&_svg:not([class*='text-'])]:text-destructive hover:[&_svg:not([class*='text-'])]:text-destructive unavailable:text-muted-foreground unavailable:[&_svg:not([class*='text-'])]:text-muted-foreground";
/** A key on the primary, as on Send */
const LEAD = "[&_kbd]:bg-primary-foreground/15 [&_kbd]:text-primary-foreground [&_svg:not([class*='text-'])]:text-primary-foreground";

/**
 * In List's toolbar, which words a narrow bar lets go first (their icon stays, the name in its tooltip and to a screen
 * reader): 1 never (Archive, Delete), 2 below 60rem, 3 below 78rem
 */
type Rank = 1 | 2 | 3;
const FOLD: Record<Rank, string> = { 1: "", 2: "@max-[60rem]/bar:sr-only", 3: "@max-[78rem]/bar:sr-only" };
const FOLD_PAD: Record<Rank, string> = { 1: "", 2: "@max-[60rem]/bar:px-2", 3: "@max-[78rem]/bar:px-2" };

function BarButton({ label, command, onClick, children, testId, disabled, bar, tone, rank = 2 }: { label: string; command?: Command; onClick: () => void; children: React.ReactNode; testId: string; disabled?: boolean; bar: Variant; tone?: "lead" | "danger"; rank?: Rank }) {
  const keys = command ? shortcutsFor(command, undefined, isMac)[0] : undefined;
  // plan 158: the toolbar's are the pane's buttons, smaller and side by side: the same words, tones and order; the key on hover
  if (bar === "toolbar")
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant={tone === "lead" ? "default" : "ghost"} size="sm" data-testid={testId} disabled={disabled} onClick={onClick} aria-label={label} aria-keyshortcuts={keys} className={cn("shrink-0 gap-1.5", tone === "lead" && LEAD, tone === "danger" && DANGER, FOLD_PAD[rank])}>
              {children}
              <span className={FOLD[rank]}>{label}</span>
            </Button>
          }
        />
        <TooltipContent>
          {label}
          {keys && <Shortcut keys={keys} />}
        </TooltipContent>
      </Tooltip>
    );
  // the pane's says its name and its key
  return (
    <Button variant={tone === "lead" ? "default" : "outline"} data-testid={testId} disabled={disabled} onClick={onClick} aria-label={label} aria-keyshortcuts={keys} className={cn("justify-start gap-2", tone === "lead" && LEAD, tone === "danger" && DANGER)}>
      {children}
      {label}
      {keys && <Shortcut keys={keys} className="ms-auto" />}
    </Button>
  );
}

/**
 * With two or more conversations selected (or "all N" of a view): what they
 * are and what to do with them. Split shows it in the reader pane, like
 * Apple Mail; List (plan 24), which has no side pane, as a toolbar over the
 * header's line, so no row moves under the pointer. The same actions, names, test ids and shortcuts in both.
 */
export function SelectionBar({ variant = "pane" }: { variant?: Variant }) {
  const count = useApp((s) => s.scope?.count ?? s.checked.size);
  const scope = useApp((s) => s.scope);
  // plan 64: in a search (it looks everywhere) the selected rows' places decide, not the sidebar
  const view = useApp((s) => actionView(s.view, s.query, s.scope ? [] : targetRows()));
  const loaded = useList((s) => s.items.length);
  const run = (a: ThreadAction) => () => void act(a);
  // plan 64: a search's checked rows can span places: each action for the rows it fits ("select all N": the view's)
  const searching = useApp((s) => s.query.trim() !== "");
  const places = searching && !scope ? placeActions(targetRows(), tabbedTest()) : null;
  // plan 86: Promotions or Social: Move to Inbox takes them out of the tab
  const gmailTab = useApp((s) => s.gmailTab);
  // re-read whenever the selection changes (a same-size selection too); act() takes the rows each action fits when it runs
  useApp((s) => s.checked);
  const runOn = (a: ThreadAction, _fits: number[]) => () => void act(a);
  const bar = variant;
  const listHeader = useDesign().variants.listHeader;
  // only what would change something, as in the row menu ("select all N" holds rows it hasn't loaded: both);
  // read again when a row changes under the selection (mail read elsewhere)
  useList((s) => s.items);
  const rows = scope ? [] : targetRows();
  const anyUnread = scope !== null || rows.some((r) => r.unread);
  const anyRead = scope !== null || rows.some((r) => !r.unread);
  const allStarred = scope === null && rows.length > 0 && rows.every((r) => r.starred);
  const title = scope ? t("selection.scope", { count, label: scope.label }) : t("selection.count", { count });
  const placeButtons = places && (
    <>
      {places.notSpam.length > 0 && (
        <BarButton bar={bar} label={t("actions.notSpam")} onClick={runOn("notSpam", places.notSpam)} testId="bar-not-spam" rank={3}>
          <ShieldCheck />
        </BarButton>
      )}
      {places.toInbox.length > 0 && (
        <BarButton bar={bar} label={t(places.restoreOnly ? "actions.restoreToInbox" : "actions.moveToInbox")} onClick={runOn("moveToInbox", places.toInbox)} testId="bar-inbox">
          <Inbox />
        </BarButton>
      )}
      <BarButton bar={bar} tone="lead" label={t("actions.archive")} command="thread.archive" onClick={runOn("archive", places.archive)} testId="bar-archive" rank={1} disabled={places.archive.length === 0}>
        <Archive />
      </BarButton>
      <BarButton bar={bar} tone="danger" label={t("actions.trash")} command="thread.trash" onClick={runOn("trash", places.trash)} testId="bar-trash" rank={1} disabled={places.trash.length === 0}>
        <Trash2 />
      </BarButton>
    </>
  );
  const actions = (
    <>
      {placeButtons ? placeButtons : view === "trash" || view === "spam" || view === "archive" ? (
        <BarButton bar={bar} label={view === "spam" ? t("actions.notSpam") : t("actions.moveToInbox")} onClick={run(view === "spam" ? "notSpam" : "moveToInbox")} testId="bar-inbox">
          {view === "spam" ? <ShieldCheck /> : <Inbox />}
        </BarButton>
      ) : (
        <>
          {gmailTab && (
            <BarButton bar={bar} label={t("actions.moveToInbox")} onClick={run("moveToInbox")} testId="bar-inbox">
              <Inbox />
            </BarButton>
          )}
          <BarButton bar={bar} tone="lead" label={t("actions.archive")} command="thread.archive" onClick={run("archive")} testId="bar-archive" rank={1}>
            <Archive />
          </BarButton>
        </>
      )}
      {!placeButtons && (
        <BarButton bar={bar} tone="danger" label={t("actions.trash")} command="thread.trash" onClick={run("trash")} testId="bar-trash" rank={1} disabled={view === "trash"}>
          <Trash2 />
        </BarButton>
      )}
      {/* plan 158: as the row menu says them: what it's marked, then where it goes, spam last */}
      {anyUnread && (
        <BarButton bar={bar} label={t("actions.markRead")} command="thread.markRead" onClick={run("markRead")} testId="bar-read">
          <MailOpen />
        </BarButton>
      )}
      {anyRead && (
        <BarButton bar={bar} label={t("actions.markUnread")} command="thread.toggleRead" onClick={run("markUnread")} testId="bar-unread">
          <Mail />
        </BarButton>
      )}
      <BarButton bar={bar} label={t(allStarred ? "actions.unstar" : "actions.star")} command="thread.star" onClick={run(allStarred ? "unstar" : "star")} testId="bar-star" rank={3}>
        {allStarred ? <StarOff /> : <Star />}
      </BarButton>
      {/* a "select all N" has no ids to set it on (the row menu's rule) */}
      <BarButton bar={bar} label={t("remind.menu")} command="thread.remind" onClick={() => openRemind({ kind: "always" })} testId="bar-remind" rank={3} disabled={scope !== null}>
        <Bell />
      </BarButton>
      <BarButton bar={bar} label={t("actions.moveTo")} command="thread.move" onClick={() => setApp({ dialog: "categoryPicker", pickerMode: "move" })} testId="bar-move" disabled={scope !== null}>
        <FolderInput />
      </BarButton>
      <BarButton bar={bar} label={t("actions.category")} command="thread.category" onClick={() => setApp({ dialog: "categoryPicker", pickerMode: "toggle" })} testId="bar-category">
        <Tag />
      </BarButton>
      <BarButton bar={bar} label={t("actions.markSpam")} command="thread.spam" onClick={places ? runOn("spam", places.spam) : run("spam")} testId="bar-spam" rank={3} disabled={places ? places.spam.length === 0 : view === "spam"}>
        <OctagonAlert />
      </BarButton>
    </>
  );
  const more = !scope && count < loaded;
  if (bar === "toolbar")
    return (
      // over the list's title line: nothing moves under the pointer of whoever is ⌘-clicking rows (plan 158)
      <div role="toolbar" aria-label={title} data-testid="selection-bar" data-variant="toolbar" className="no-drag hairline-b @container/bar absolute inset-x-0 top-0 z-20 flex h-(--pane-bar) items-center gap-1 bg-pane pr-4 pl-5">
        {/* plan 160: the header's title, replaced: its type and line (a smaller count would sit on its own baseline) */}
        <span className={cn("mr-2 min-w-0 shrink truncate text-foreground tabular", LIST_TITLE[listHeader === "title" ? "title" : "display"])} data-testid="selection-count">
          {title}
        </span>
        {actions}
        <span className="ml-auto flex items-center gap-0.5">
          {more && (
            <BarButton bar={bar} label={t("actions.selectAll")} command="list.selectAll" onClick={selectAll} testId="bar-select-all" rank={3}>
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
    // where the reader's column starts, so the actions sit where the eye was, not across an empty pane
    // plan 160: its title on the reader subject's line and column
    <section data-testid="selection-bar" className="@container h-full min-h-0 overflow-y-auto bg-background [scrollbar-gutter:stable]">
      <div data-reader-column className={cn(READING_COLUMN, PANE_TITLE_TOP, "flex flex-col items-start gap-5 pb-16")}>
        <div>
          <h2 className={cn(PANE_TITLE, "tabular")} data-testid="selection-count">
            {title}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("selection.hint")}</p>
        </div>
        {/* a mixed read state adds a button: the last one alone takes the row rather than leave a hole */}
        <div className="grid w-full max-w-md grid-cols-2 gap-2 [&>:last-child:nth-child(odd)]:col-span-2">{actions}</div>
        <div className="-ml-2.5 flex items-center gap-2">
          {more && (
            <Button variant="ghost" size="sm" data-testid="bar-select-all" onClick={selectAll}>
              <CheckCheck /> {t("actions.selectAll")} <Shortcut keys="mod+a" className="ml-1" />
            </Button>
          )}
          <Button variant="ghost" size="sm" data-testid="bar-clear" onClick={clearSelection}>
            <X /> {t("selection.deselect")} <Shortcut keys="escape" className="ml-1" />
          </Button>
        </div>
        {/* plan 158: what they are, to check before acting on them */}
        {rows.length > 0 && (
          <ul data-testid="selection-rows" className="hairline-t flex w-full flex-col gap-1.5 pt-4 text-sm">
            {rows.slice(0, SHOWN_ROWS).map((r) => (
              <li key={r.id} className="flex min-w-0 gap-2">
                <span className="max-w-[40%] shrink-0 truncate font-medium">{r.fromName || r.fromEmail}</span>
                <span className="min-w-0 truncate text-muted-foreground">{r.subject || t("common.noSubject")}</span>
              </li>
            ))}
            {rows.length > SHOWN_ROWS && <li className="text-muted-foreground">{t("selection.andMore", { count: rows.length - SHOWN_ROWS })}</li>}
          </ul>
        )}
      </div>
    </section>
  );
}
