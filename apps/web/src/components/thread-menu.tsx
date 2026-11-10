import { remindPresets, separatesTabs, shortcutsFor, subjectTemplate, TAB_CODE, type Category, type CategoryColor, type ReminderKind, type Tab, type Command, type SimilarAction, type SimilarOffers, type SimilarScope, type ThreadAction, type ThreadSummary, type UnsubscribeOffer, type View } from "@terno/core";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Shortcut } from "@terno/ui/components/shortcut";
import { cn } from "@terno/ui/lib/utils";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@terno/ui/components/context-menu";
import {
  Archive,
  Bell,
  BellOff,
  CalendarClock,
  Check,
  CheckCheck,
  Copy,
  Ellipsis,
  Filter,
  Forward,
  Folder as FolderIcon,
  FolderInput,
  Inbox,
  Mail,
  MailMinus,
  MailOpen,
  MessageSquareReply,
  OctagonAlert,
  Plus,
  Pin,
  PinOff,
  Printer,
  Repeat,
  Reply,
  ReplyAll,
  Search,
  ShieldCheck,
  Star,
  StarOff,
  Tag,
  Trash2,
  Users,
} from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { FLOAT_INSET } from "@terno/ui/lib/float-inset";
import { snack } from "~/lib/snack";
import { openLink } from "~/lib/open-link";
import { create } from "zustand";
import { act, openCompose, tabbedTest, targetRows } from "~/lib/actions";
import { pinThreads, unpinThreads } from "~/lib/pins";
import { usePins } from "~/state/pins";
import { addScopeToCategory, addToCategory, answerReview, fileAlways, filterNameOf, isExclusivelyIn, moveToCategory, removeFromCategory, removeSenderFromCategory } from "~/lib/categorize";
import { rowSelector, setRule } from "~/lib/flash";
import { renderProbe } from "~/lib/render-probe";
import { isMac, scopeRows, selectAll } from "~/lib/select";
import { openThread } from "~/lib/page";
import { menuTargets } from "~/lib/selection";
import { ROW_OUTLINE } from "./thread-row";
import { openPrint } from "~/lib/print-open";
import { useFolderRows } from "~/lib/account-folders";
import { moveToFolder } from "~/lib/folder-move";
import { factsOf, listingFolder } from "~/lib/folder-rules";
import { getApp, inSeparateTab, setApp, useApp, type ScopeSelection } from "~/state/app";
import { shownDraftKey, useDrafts } from "~/lib/drafts";
import { listKey, useList } from "~/state/list";
import { actionView, placeActions } from "~/lib/places";
import { applyScope, formatCount } from "./category-snackbar";
import { actSimilar, offerSentence, scopeLabel, visibleOffers } from "~/lib/similar";
import { orderOffers } from "~/lib/offers";
import { client } from "~/rpc/connection";
import { codeKey, copyCode, threadCode } from "~/lib/codes";
import { copyThreadText } from "~/lib/copy-thread";
import { listScroller } from "./thread-list";
import { useAlwaysOffers } from "./review-actions";
import { clearReminder, openRemind, presetLabel, presetWhen, reminderWhen, setReminder, useReminders } from "~/lib/reminders";
import { reachesSeveral } from "~/lib/compose-fields";
import { loadThread, useThreads } from "~/state/threads";
import { fitWholeRows } from "@terno/ui/lib/whole-rows";

/** What the open menu acts on: explicit threads, or a "select all N" scope. Set at right-click; rows never read it. */
interface MenuTarget {
  ids: number[];
  scope: ScopeSelection | null;
}
const useMenuTarget = create<MenuTarget>(() => ({ ids: [], scope: null }));

/** Which row a menu on one conversation is about: for a screen reader always, on screen when it isn't the open one (plan 158). */
function targetName(t: Pick<ThreadSummary, "fromName" | "fromEmail" | "subject">): string {
  return `${t.fromName || t.fromEmail}: ${t.subject || noSubject()}`;
}
const noSubject = () => t("common.noSubject");

const hint = (command: Command) => {
  const keys = shortcutsFor(command, undefined, isMac)[0];
  return keys ? <ContextMenuShortcut><Shortcut keys={keys} /></ContextMenuShortcut> : null;
};

/** Where the right-click landed: the selection when the row is part of it, else that row alone (the selection stays). */
function targetFor(row: number): MenuTarget {
  const s = getApp();
  if (s.scope && s.scope.key === listKey()) return { ids: [], scope: s.scope };
  const { items, index } = useList.getState();
  return { ids: menuTargets(row, s.checked, { ids: items.map((t) => t.id), index }), scope: null };
}

/** Where ⇧F10 opens: on the selection when there is one (the open thread if it is part of it, else its first row), else the open thread. */
export function menuAnchor(selectedId: number | null, checked: ReadonlySet<number>, index: ReadonlyMap<number, number>): number | null {
  if (checked.size === 0) return selectedId;
  if (selectedId !== null && checked.has(selectedId)) return selectedId;
  let first: number | null = null;
  for (const id of checked) if (index.has(id) && (first === null || index.get(id)! < index.get(first)!)) first = id;
  return first;
}

/**
 * Plan 106: ⇧F10 / the ContextMenu key on a row with a menu of its own (a sidebar account or category, marked
 * `data-context-menu`) opens that one, as a right-click at the row's start would. False: none has focus.
 */
export function openFocusedMenu(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !el.closest("[data-context-menu]")) return false;
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: Math.round(r.left + 24), clientY: Math.round(r.top + r.height / 2), button: 2 }));
  return true;
}

/**
 * ⇧F10 / the ContextMenu key: the menu opens on the selection (or the open
 * thread), as a right-click there would (the row is scrolled into view first).
 */
export function openMenuForSelection(): void {
  const s = getApp();
  const id = menuAnchor(s.selectedId, s.checked, useList.getState().index);
  if (id === null) return;
  const i = useList.getState().index.get(id);
  if (i === undefined) return;
  listScroller.scrollToIndex?.(i);
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(`[role=listbox] [data-thread-id="${Math.trunc(id)}"]`);
    if (!row) return;
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: Math.round(r.left + 24), clientY: Math.round(r.top + r.height / 2), button: 2 }));
  });
}

/**
 * A menu item that moves focus itself (Reply, Reply all, Forward: into the composer) asks the closing menu not
 * to hand focus back to the list. That hand-back lands while the reply is still opening, reads as the user going
 * elsewhere, and makes the reply give up (its focus lease), so nothing opened.
 */
// (a property, not a reassigned module let: the React Compiler folds a local copy of such a let into its later
// reads, so "read, then clear" compiled to "clear, then read")
const handOff = { pending: false };

/**
 * Whether a reply from the menu opened (and so takes focus itself, maybe a frame later):
 * inline in its conversation, or, for a stored draft whose source moved, in the reader pane. Read from state, not
 * the DOM.
 */
export function replyOpened(threadId: number, paneBefore: ReturnType<typeof getApp>["compose"]): boolean {
  const key = shownDraftKey(useDrafts.getState().drafts, threadId, getApp().draftShown);
  return (key !== null && useDrafts.getState().drafts[key]?.uiState === "open") || getApp().compose !== paneBefore;
}

/** Plan 160: the menu's gap to its row: the row's outline and the panel's edge apart, still read as one */
const ROW_GAP = 4;

/** A place for the menu to stand by, as Base UI reads one (no element renders for it) */
const virtual = (rect: DOMRect) => ({ getBoundingClientRect: () => rect });

/**
 * Plan 160: where its row leaves room on neither side, the menu still shows whole when the window can hold it: it stands
 * at the window's foot, over its row (revision 4: only then may it cover it). A window too short for it lets it scroll,
 * ending on a whole row. Read when it's placed (its height bounded by --available-height), never per row.
 */
function placeWhole(menu: HTMLElement, x: number, stand: (rect: DOMRect) => void): void {
  const need = menu.scrollHeight;
  if (need <= menu.clientHeight + 1) return;
  // (2 px: the positioner's flip asks a pixel more than its padding)
  const top = innerHeight - FLOAT_INSET - need - 2;
  if (top >= FLOAT_INSET) stand(DOMRect.fromRect({ x, y: top - ROW_GAP, width: 0, height: 0 }));
  else fitWholeRows(menu, "[role=menuitem]", true);
}

/** The list the menu's row scrolls in and where it stood when the menu opened (a property bag, not a module let: React Compiler) */
const rowList: { scroller: HTMLElement | null; top: number } = { scroller: null, top: 0 };

/**
 * The thread context menu: one Base UI ContextMenu around the whole list (no
 * per-row trigger, so opening it renders no row). The clicked row gets a
 * ring from a keyed CSS rule; global shortcuts wait while it is open.
 */
export function ThreadMenu({ children }: { children: ReactElement }) {
  const [open, setOpen] = useState(false);
  // plan 160: under (or over) the right-clicked row at the pointer's x, so the row it's about stays in view
  const [anchor, setAnchor] = useState(() => virtual(new DOMRect()));
  const pointerX = anchor.getBoundingClientRect().x;
  const wholeRows = useCallback(
    (menu: HTMLDivElement | null) => {
      if (!menu) return;
      // when it's placed, whenever its height changes (the window's bound arrives with its position), and when its rows do
      // (Reply all once the conversation loads: a menu already capped keeps its box, so only its rows tell): never per row
      const place = () => placeWhole(menu, pointerX, (rect) => setAnchor(virtual(rect)));
      const ro = new ResizeObserver(place);
      ro.observe(menu);
      const mo = new MutationObserver(place);
      mo.observe(menu, { childList: true, subtree: true });
      return () => {
        ro.disconnect();
        mo.disconnect();
      };
    },
    [pointerX],
  );
  const name = useMenuTarget((m) => (!m.scope && m.ids.length === 1 ? targetRows(m.ids)[0] : undefined));
  const change = (next: boolean) => {
    setOpen(next);
    setApp({ menuOpen: next });
    if (!next) setRule("menu-target", null);
  };
  // plan 160: a resize or a scroll moves the row out from under the menu: it goes rather than stay where the row was
  useEffect(() => {
    const scroller = rowList.scroller;
    if (!open) return;
    const close = () => change(false);
    // a scroll that landed before the right-click (its event arrives a frame later) leaves the row where it was: only a move closes
    const moved = () => scroller && Math.abs(scroller.scrollTop - rowList.top) > 1 && close();
    window.addEventListener("resize", close);
    scroller?.addEventListener("scroll", moved, { passive: true });
    return () => {
      window.removeEventListener("resize", close);
      scroller?.removeEventListener("scroll", moved);
    };
  }, [open]);
  return (
    <ContextMenu open={open} onOpenChange={change}>
      <ContextMenuTrigger
        render={children}
        onContextMenu={(e) => {
          const el = (e.target as Element).closest<HTMLElement>("[data-thread-id]");
          if (!el) {
            // empty space under the rows: no menu
            (e as unknown as { preventBaseUIHandler(): void }).preventBaseUIHandler();
            return;
          }
          if (import.meta.env.VITE_RENDER_PROBE) performance.mark("menu:open");
          // plan 160: one read, of this row
          const r = el.getBoundingClientRect();
          setAnchor(virtual(DOMRect.fromRect({ x: e.clientX, y: r.top, width: 0, height: r.height })));
          rowList.scroller = e.currentTarget as HTMLElement;
          rowList.top = rowList.scroller.scrollTop;
          const row = Number(el.dataset.threadId);
          const target = targetFor(row);
          useMenuTarget.setState(target);
          // the ring follows the row's inset, rounded selection shape. Plan 158: what the menu is for is outlined in the focus
          // ring, as j/k's place among several is; the open row keeps its fill and rail (it's still what the reader shows)
          setRule("menu-target", `${rowSelector([row], "::before")}{box-shadow:${ROW_OUTLINE}}`);
        }}
      />
      <ContextMenuContent
        ref={wholeRows}
        className="relative w-64"
        data-testid="thread-menu"
        anchor={anchor}
        side="bottom"
        align="start"
        sideOffset={ROW_GAP}
        // below the row, else above it; only a window too short for either lets it cover the row
        collisionAvoidance={{ side: "flip", align: "shift" }}
        aria-label={name ? targetName(name) : undefined}
        finalFocus={() => {
          const handedOff = handOff.pending;
          handOff.pending = false;
          if (handedOff) return false;
          // Base UI's own rule, which a callback opts out of: focus the user already moved elsewhere (a click into
          // search) stays there; from the menu itself (or nowhere) it goes back to the list
          const active = document.activeElement;
          return !active || active === document.body || active.closest("[role=menu]") !== null;
        }}
      >
        <MenuItems />
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface MenuEntry {
  icon: ReactNode;
  label: string;
  command?: Command;
  onClick: () => void;
  testId: string;
  variant?: "destructive";
}

function Item({ icon, label, command, onClick, testId, variant }: MenuEntry) {
  return (
    <ContextMenuItem data-testid={testId} onClick={onClick} variant={variant}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {command && hint(command)}
    </ContextMenuItem>
  );
}

/** One sender shared by every target (case-insensitive), or null. */
function sharedSender(rows: readonly ThreadSummary[]): { email: string; name: string } | null {
  const first = rows[0];
  if (!first?.fromEmail) return null;
  const email = first.fromEmail.toLowerCase();
  return rows.every((t) => t.fromEmail.toLowerCase() === email) ? { email, name: first.fromName || first.fromEmail } : null;
}

/** The view decides what "out of here" means in Archive, Trash and Spam; what can't apply there isn't offered. */
function placeItems(view: View, run: (a: ThreadAction) => void): MenuEntry[] {
  const archive = { icon: <Archive />, label: t("actions.archive"), command: "thread.archive" as Command, onClick: () => run("archive"), testId: "menu-archive" };
  const trash = { icon: <Trash2 />, label: t("actions.trash"), command: "thread.trash" as Command, onClick: () => run("trash"), testId: "menu-trash", variant: "destructive" as const };
  const spam = { icon: <OctagonAlert />, label: t("actions.markSpam"), command: "thread.spam" as Command, onClick: () => run("spam"), testId: "menu-spam" };
  const toInbox = (label: string) => ({ icon: <Inbox />, label, onClick: () => run("moveToInbox"), testId: "menu-inbox" });
  switch (view) {
    case "trash":
      return [toInbox(t("actions.restoreToInbox")), spam];
    case "spam":
      return [{ icon: <ShieldCheck />, label: t("actions.notSpam"), onClick: () => run("notSpam"), testId: "menu-not-spam" }, trash];
    case "archive":
      return [toInbox(t("actions.moveToInbox")), trash, spam];
    case "inbox":
      return [archive, trash, spam];
    default:
      return [archive, trash, spam, toInbox(t("actions.moveToInbox"))];
  }
}

/** A row that holds several answers: an ordinary submenu, opened by hover, → or a click (the owner's call over unfolding in place). */
function SubRow({ icon, label, testId, variant, children }: { icon: ReactNode; label: string; testId: string; variant?: "destructive"; children: ReactNode }) {
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger data-testid={testId} variant={variant}>
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-max max-w-96 min-w-60" data-testid={`${testId}-list`}>
        {children}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/** A panel's quiet section label; what's under it names itself (plan 158: the labels are small, the rows carry the words). */
function Section({ label, testId, children }: { label: string; testId?: string; children: ReactNode }) {
  return (
    <ContextMenuGroup>
      <ContextMenuLabel data-testid={testId} className="h-6 truncate text-xs" title={label}>
        <span className="truncate">{label}</span>
      </ContextMenuLabel>
      {children}
    </ContextMenuGroup>
  );
}

/** Plan 87: a kind's presets with their moments, a moment of your own, Clear. */
function RemindItems({ kind, ids, inset }: { kind: ReminderKind; ids: number[]; inset?: boolean }) {
  const current = useReminders((s) => (ids.length === 1 ? s.byThread.get(ids[0]!) : undefined));
  const anySet = useReminders((s) => ids.some((id) => s.byThread.has(id)));
  const presets = remindPresets(new Date(), kind);
  return (
    <>
      {current && (
        <div className={cn("max-w-72 px-2 py-1 text-xs text-muted-foreground", inset && "ps-[calc(1rem+1.15em)]")} data-testid="menu-remind-current">
          {t(current.kind === "noReply" ? "remind.currentNoReply" : "remind.current", { when: reminderWhen(current.dueAt) })}
        </div>
      )}
      {presets.map((p) => (
        <ContextMenuItem key={p.id} inset={inset} data-testid={`menu-remind-${kind}-${p.id}`} onClick={() => void setReminder(ids, p.at, kind)}>
          <span className="min-w-0 flex-1 truncate">{presetLabel(p.id)}</span>
          <ContextMenuShortcut className="tracking-normal tabular-nums">{presetWhen(p)}</ContextMenuShortcut>
        </ContextMenuItem>
      ))}
      <ContextMenuItem inset={inset} data-testid={`menu-remind-${kind}-pick`} onClick={() => openRemind({ kind, custom: true, ids })}>
        {!inset && <CalendarClock />}
        <span className="min-w-0 flex-1 truncate">{t("remind.pick")}</span>
      </ContextMenuItem>
      {anySet && (
        <ContextMenuItem inset={inset} data-testid={`menu-remind-${kind}-clear`} onClick={() => void clearReminder(ids)}>
          {!inset && <BellOff />}
          <span className="min-w-0 flex-1 truncate">{t("remind.clear")}</span>
        </ContextMenuItem>
      )}
    </>
  );
}

/** "Remind me ▸": when, and "Remind me if no reply ▸" beside it. */
function RemindSub({ ids, disabled }: { ids: number[]; disabled: boolean }) {
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger data-testid="menu-remind-always" disabled={disabled}>
        <Bell />
        <span className="min-w-0 flex-1 truncate">{t("remind.menu")}</span>
        {hint("thread.remind")}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-max min-w-60" data-testid="menu-remind-always-list">
        <RemindItems kind="always" ids={ids} />
        <ContextMenuSeparator />
        <SubRow icon={<MessageSquareReply />} label={t("remind.menuNoReply")} testId="menu-remind-noReply">
          <RemindItems kind="noReply" ids={ids} />
        </SubRow>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

const SIMILAR_LABEL = { archive: "threadMenu.similar.archive", trash: "threadMenu.similar.trash", spam: "threadMenu.similar.spam" } as const;
const SIMILAR_ICON = { archive: <Archive />, trash: <Trash2 />, spam: <OctagonAlert /> };

/** More's "Similar mail": one row per action that still applies here, each a submenu of what it would take. */
function SimilarSection({ view, ids }: { view: View; ids: number[] }) {
  const actions: SimilarAction[] = [];
  if (view === "inbox" || view === "all" || view === "starred" || view === "sent") actions.push("archive");
  if (view !== "trash") actions.push("trash");
  if (view !== "spam" && view !== "trash") actions.push("spam");
  if (actions.length === 0) return null;
  return (
    <Section label={t("threadMenu.similar")} testId="menu-similar">
      {actions.map((action) => (
        <SubRow key={action} icon={SIMILAR_ICON[action]} label={t(SIMILAR_LABEL[action])} testId={`menu-${action}-similar`} variant={action === "trash" ? "destructive" : undefined}>
          <SimilarItems action={action} ids={ids} />
        </SubRow>
      ))}
    </Section>
  );
}

/** What a similar row holds: read when its submenu opens (plan 91: the snackbar's lines, in its order, its sentences). */
function SimilarItems({ action, ids }: { action: SimilarAction; ids: number[] }) {
  const [offers, setOffers] = useState<SimilarOffers | null>(null);
  useEffect(() => {
    let alive = true;
    void client.call("offers.forAction", { threadIds: ids, action }).then(
      (o) => alive && setOffers(o),
      () => alive && setOffers({ senderName: null, offers: [] }),
    );
    return () => {
      alive = false;
    };
  }, [action, ids]);
  const shown = offers ? orderOffers(visibleOffers(action, offers.offers)) : [];
  // what a delete would take reads as one, however many it is
  const variant = action === "trash" ? "destructive" : undefined;
  return (
    <>
      {/* plan 91: the plain action first, said as plainly as the snackbar's "No, only …" (no default, no sweep) */}
      <ContextMenuItem data-testid="menu-similar-only" variant={variant} onClick={() => void act(action, ids, { automation: "none" })}>
        <span className="min-w-0 flex-1 truncate">{t(`offers.onlyThis.${action}`, { count: ids.length })}</span>
      </ContextMenuItem>
      {action === "spam" && (
        <div className="max-w-80 px-2 py-1 text-xs text-muted-foreground" data-testid="menu-spam-similar-note">
          {t("similar.spamFuture")}
        </div>
      )}
      {!offers ? (
        <ContextMenuItem disabled data-testid="menu-similar-counting">
          {t("similar.counting")}
        </ContextMenuItem>
      ) : shown.length === 0 ? (
        <ContextMenuItem disabled data-testid="menu-similar-nothing">
          {t("similar.nothing")}
        </ContextMenuItem>
      ) : (
        shown.map((o) => {
          const sentence = offerSentence(action, o, offers.senderName);
          return (
            <ContextMenuItem key={o.scope.kind} data-testid={`menu-similar-${o.scope.kind}`} variant={variant} title={sentence} onClick={() => void actSimilar(action, ids, o.scope, offers.senderName)}>
              <span className="min-w-0 flex-1 truncate">
                {sentence}
                {/* a named sender carries its address, muted, so same-named senders tell apart */}
                {o.scope.kind === "sender" && offers.senderName && offers.senderName !== o.scope.email && <span className="font-normal text-muted-foreground"> {o.scope.email}</span>}
              </span>
            </ContextMenuItem>
          );
        })
      )}
    </>
  );
}

/**
 * Plan 96: "Unsubscribe", shown once the conversation is known to offer it (read from the store when its submenu
 * opens, no network). Last among the sender's, so appearing moves nothing above it.
 */
function UnsubscribeItem({ threadId }: { threadId: number }) {
  const [offer, setOffer] = useState<UnsubscribeOffer | null>(null);
  useEffect(() => {
    let alive = true;
    void client.call("unsubscribe.find", { threadId }).then(
      (o) => alive && setOffer(o),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [threadId]);
  if (!offer) return null;
  return (
    <ContextMenuItem data-testid="menu-unsubscribe" title={offer.target} onClick={() => unsubscribe(threadId, offer)}>
      <MailMinus />
      <span className="min-w-0 flex-1 truncate">
        {t("threadMenu.unsubscribe")}
        <span className="text-muted-foreground"> {offer.target}</span>
      </span>
    </ContextMenuItem>
  );
}

function unsubscribe(threadId: number, offer: UnsubscribeOffer) {
  // a page opens in the click itself: a browser blocks a window opened after a wait
  if (offer.method === "page" && offer.url) {
    openLink(offer.url);
    snack(t("unsubscribe.opened", { host: offer.target }));
    return;
  }
  void client.call("unsubscribe.run", { threadId, messageId: offer.messageId, method: offer.method, target: offer.target }).then(
    (r) => {
      if (r.outcome === "open") {
        // after a wait: the user opens it (an action is a click of its own)
        const url = r.url;
        return snack({ message: t(r.failed ? "unsubscribe.notTaken" : "unsubscribe.onPage", { host: r.target }), action: { label: t("unsubscribe.openPage"), onClick: () => openLink(url) } });
      }
      if (r.outcome === "queued") return snack(t("unsubscribe.queued", { address: r.target }));
      return snack(r.outcome === "unsubscribed" ? t("unsubscribe.done", { name: offer.name }) : t("unsubscribe.requested", { host: r.target }));
    },
    (error: unknown) => snack.error(error instanceof Error ? error.message : String(error)),
  );
}

/** Plan 64: a search's rows, each action for the rows it fits (a selection can span places). */
function searchPlaceItems(p: NonNullable<ReturnType<typeof placeActions>>, runOn: (a: ThreadAction, ids: number[]) => void) {
  const item = (action: ThreadAction, ids: number[], o: { icon: ReactNode; label: string; testId: string; command?: Command; variant?: "destructive" }) => ({ ...o, onClick: () => runOn(action, ids) });
  const items = [];
  if (p.notSpam.length) items.push(item("notSpam", p.notSpam, { icon: <ShieldCheck />, label: t("actions.notSpam"), testId: "menu-not-spam" }));
  if (p.toInbox.length) items.push(item("moveToInbox", p.toInbox, { icon: <Inbox />, label: t(p.restoreOnly ? "actions.restoreToInbox" : "actions.moveToInbox"), testId: "menu-inbox" }));
  if (p.archive.length) items.push(item("archive", p.archive, { icon: <Archive />, label: t("actions.archive"), command: "thread.archive", testId: "menu-archive" }));
  if (p.trash.length) items.push(item("trash", p.trash, { icon: <Trash2 />, label: t("actions.trash"), command: "thread.trash", testId: "menu-trash", variant: "destructive" }));
  if (p.spam.length) items.push(item("spam", p.spam, { icon: <OctagonAlert />, label: t("actions.markSpam"), command: "thread.spam", testId: "menu-spam" }));
  return items;
}

/**
 * Plan 80: a Review row's answers, the keyboard's way to its ✓ and Always ▾
 * (one conversation only: the offers are what its own mail shares).
 */
/** Plan 127: "Move to"'s folders: those of the one account the rows are in (mounted while the submenu is open). */
function MoveToFolderItems({ rows, ids }: { rows: readonly ThreadSummary[]; ids: readonly number[] }) {
  const facts = factsOf(rows);
  const accountId = facts.accounts.size === 1 ? [...facts.accounts][0]! : null;
  const folders = useApp((s) => s.folders);
  const here = useApp((s) => (accountId !== null && s.folder !== null && listingFolder(s, accountId, s.folder) ? s.folder : null));
  const list = useFolderRows(folders, accountId ?? -1, accountId !== null);
  const own = list.filter((f) => f.selectable && f.key !== null).slice(0, 250);
  if (accountId === null || facts.disposed || own.length === 0) return null;
  return (
    <>
      <ContextMenuSeparator />
      {own.map((f) => (
        <ContextMenuItem key={f.id} data-testid={`menu-move-folder-${f.key}`} disabled={f.key === here} onClick={() => void moveToFolder({ accountId, key: f.key!, name: f.name }, ids)}>
          <FolderIcon />
          <span className="truncate" style={{ paddingInlineStart: `${f.depth * 0.75}rem` }}>
            {f.name}
          </span>
        </ContextMenuItem>
      ))}
    </>
  );
}

function ReviewItems({ thread }: { thread: ThreadSummary }) {
  const category = useApp((s) => s.categories.find((c) => c.id === s.reviewCategoryId));
  const offers = useAlwaysOffers(category ? thread.id : null, category?.id ?? null);
  if (!category) return null;
  return (
    <>
      <Item icon={<Check />} label={t("review.accept", { category: category.name })} testId="menu-review-accept" onClick={() => void answerReview(thread.id, category.id, true)} />
      <ContextMenuSub>
        <ContextMenuSubTrigger data-testid="menu-review-always">
          <Repeat />
          <span className="min-w-0 flex-1 truncate">{t("review.always", { category: category.name })}</span>
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-max min-w-64 max-w-md" data-testid="menu-review-always-list">
          {offers === null ? (
            <ContextMenuItem disabled>
              <span className="h-3 w-40 animate-pulse rounded bg-muted" />
            </ContextMenuItem>
          ) : offers.offers.length === 0 ? (
            <ContextMenuItem disabled>{t("review.always.none")}</ContextMenuItem>
          ) : (
            offers.offers.map((o) => (
              <ContextMenuItem
                key={o.scope.kind}
                data-testid={`menu-review-always-${o.scope.kind}`}
                title={o.scope.kind === "subject" ? o.scope.subject : undefined}
                onClick={() => void fileAlways(category.id, o.scope, thread.id, filterNameOf(o.scope, offers.senderName, category.name))}
              >
                <ScopeLabel scope={o.scope} senderName={offers.senderName} />
                <span className="font-mono text-2xs text-muted-foreground tabular">{formatCount(o)}</span>
              </ContextMenuItem>
            ))
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
    </>
  );
}

/**
 * Reply all, only where it reaches more than one other person: read from the conversation (cached when it's the open
 * one, else one local read). A conversation that can't be read keeps the row: Reply all says what's wrong itself.
 */
function useReplyAllOffered(id: number | undefined): boolean {
  const detail = useThreads((s) => (id === undefined ? undefined : s.details.get(id)));
  const accounts = useApp((s) => s.accounts);
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    if (id === undefined || detail) return;
    let alive = true;
    void loadThread(id).then((d) => {
      if (alive && !d) setUnread(id);
    });
    return () => {
      alive = false;
    };
  }, [id, detail]);
  if (id === undefined) return false;
  return detail ? reachesSeveral(detail, accounts.map((a) => a.email)) : unread === id;
}

function MenuItems() {
  renderProbe("ThreadMenu");
  const { ids, scope } = useMenuTarget();
  const categories = useApp((s) => s.categories);
  const rows = scope ? scopeRows(useList.getState().items, scope.scope) : targetRows(ids);
  // plan 64: in a search (it looks everywhere) the rows' places decide, not the sidebar ("select all N": every action)
  const view = useApp((s) => actionView(s.view, s.query, scope ? [] : rows));
  // a search's explicit rows: each action for the rows it fits ("select all N" acts on the scope: the view's actions)
  const searching = useApp((s) => s.query.trim() !== "");
  const searchPlaces = searching && !scope ? placeActions(rows, tabbedTest()) : null;
  // plan 86: Gmail's tabs. Out of one into the Inbox; into one, for rows of accounts that keep them apart
  const gmailTab = useApp((s) => s.gmailTab);
  const accounts = useApp((s) => s.accounts);
  const tabbed = scope ? [] : rows.filter((r) => inSeparateTab(r, accounts)).map((r) => r.id);
  const tabbable = !scope && rows.length > 0 && rows.every((r) => { const a = accounts.find((x) => x.id === r.accountId); return !!a && separatesTabs(a) && r.inInbox !== false && !r.inTrash && !r.inSpam; });
  const intoTab = (tab: Tab) => (scope ? gmailTab !== null && gmailTab !== tab : tabbable && rows.some((r) => r.tab !== TAB_CODE[tab]));
  const single = !scope && ids.length === 1 ? rows[0] : undefined;
  // plan 158: a row that isn't the one open says itself: the reader beside the menu shows another conversation
  const openId = useApp((s) => s.selectedId);
  const elsewhere = single !== undefined && single.id !== openId ? single : null;
  // and what's done to it is said, as nothing beside the menu shows it (a star on a row the reader isn't on)
  const run = (action: ThreadAction) => void act(action, scope ? undefined : ids, { announce: elsewhere !== null });
  const anyUnread = scope !== null || rows.some((t) => t.unread);
  const anyRead = scope !== null || rows.some((t) => !t.unread);
  const anyStarred = scope !== null || rows.some((t) => t.starred);
  const anyPlain = scope !== null || rows.some((t) => !t.starred);
  // plan 177: pins need ids (a "select all N" has none, and pins are a few): offered only for picked rows
  const pins = usePins((s) => s.ids);
  const anyPinned = !scope && rows.some((t) => pins.has(t.id));
  const anyUnpinned = !scope && rows.some((t) => !pins.has(t.id));
  // under More (the top level stays short, plan 158), first: P and the palette reach it in one step
  const pinItems = (
    <>
      {anyUnpinned && <Item icon={<Pin />} label={t("actions.pin")} command="thread.pin" onClick={() => void pinThreads(ids)} testId="menu-pin" />}
      {anyPinned && <Item icon={<PinOff />} label={t("actions.unpin")} command={anyUnpinned ? undefined : "thread.pin"} onClick={() => void unpinThreads(ids)} testId="menu-unpin" />}
    </>
  );
  const sender = scope ? null : sharedSender(rows);
  const filedIn = sender ? categories.filter((c) => rows.some((r) => r.categoryIds.includes(c.id))) : [];
  const fileTo = categories.filter((c) => !filedIn.includes(c));
  const reply = (mode: "reply" | "replyAll" | "forward") => {
    if (!single) return;
    // the menu's own thread, passed explicitly (the selection follows, it isn't read back); the composer takes focus
    handOff.pending = true;
    openThread(single.id);
    // a reply that didn't open (refused, failed) leaves focus nowhere: it goes back to the list. One that opened
    // takes focus itself, maybe a frame later, so that is read from the drafts, not the DOM
    const id = single.id;
    const pane = getApp().compose;
    void openCompose(mode, id).then(() => {
      if (!replyOpened(id, pane) && document.activeElement === document.body) document.querySelector<HTMLElement>("[data-testid=thread-list] [data-keep-scroll=list]")?.focus({ preventScroll: true });
    });
  };
  const inAll = (categoryId: number) => rows.length > 0 && rows.every((t) => t.categoryIds.includes(categoryId));
  const toggleCategory = (categoryId: number) => {
    if (scope) return void addScopeToCategory(categoryId, scope);
    if (inAll(categoryId)) void removeFromCategory(categoryId, ids);
    else void addToCategory(categoryId, ids, { source: "picker" });
  };
  const picker = (mode: "toggle" | "move") => {
    // the picker acts on the checked rows or the open thread: make the menu's target that selection
    if (!scope && ids.length === 1) setApp({ selectedId: ids[0]!, checked: getApp().checked.has(ids[0]!) ? getApp().checked : new Set() });
    setApp({ dialog: "categoryPicker", pickerMode: mode });
  };
  const count = scope ? scope.count : ids.length;
  // plan 72: the keyboard's (and screen readers') way to the code a row's chip copies
  const code = single ? threadCode(single, Date.now()) : null;
  const replyAllOffered = useReplyAllOffered(single?.id);

  // what the view offers, sorted by where it goes; the way back leads only where it replaces Archive
  const placed: MenuEntry[] = searchPlaces ? searchPlaceItems(searchPlaces, (a) => run(a)) : placeItems(view, run);
  const wayBack = placed.filter((it) => it.testId === "menu-inbox" || it.testId === "menu-not-spam");
  const spam = placed.find((it) => it.testId === "menu-spam");
  const triage = placed.filter((it) => it !== spam && !wayBack.includes(it));
  const archivable = triage.some((it) => it.testId === "menu-archive");
  const moves = [
    ...(archivable ? wayBack : []),
    ...(!searchPlaces && view === "inbox" && (gmailTab !== null || tabbed.length > 0) ? [{ icon: <Inbox />, label: t("actions.moveToInbox"), testId: "menu-inbox", onClick: () => run("moveToInbox") }] : []),
    ...(intoTab("promotions") ? [{ icon: <Tag />, label: t("actions.toPromotions"), testId: "menu-to-promotions", onClick: () => run("toPromotions") }] : []),
    ...(intoTab("social") ? [{ icon: <Users />, label: t("actions.toSocial"), testId: "menu-to-social", onClick: () => run("toSocial") }] : []),
  ];

  return (
    <>
      {/* what the menu acts on, above its actions: the sender in the ink, the whole subject under it (two lines at most) */}
      {count > 1 && (
        <>
          <div className="px-2 pt-1 pb-1.5 text-xs font-semibold" data-testid="menu-count">
            {scope ? t("selection.scope", { count, label: scope.label }) : t("common.conversations", { count })}
          </div>
          <ContextMenuSeparator />
        </>
      )}
      {elsewhere && (
        <>
          <div className="px-2 pt-1 pb-1.5 text-xs" data-testid="menu-target" title={targetName(elsewhere)}>
            <p className="truncate font-semibold">{elsewhere.fromName || elsewhere.fromEmail}</p>
            <p className="line-clamp-2 text-muted-foreground [overflow-wrap:anywhere]">{elsewhere.subject || noSubject()}</p>
          </div>
          <ContextMenuSeparator />
        </>
      )}
      {single && <ReviewItems thread={single} />}
      {single && (
        <>
          <Item icon={<Reply />} label={t("actions.reply")} command="compose.reply" onClick={() => reply("reply")} testId="menu-reply" />
          {replyAllOffered && <Item icon={<ReplyAll />} label={t("actions.replyAll")} command="compose.replyAll" onClick={() => reply("replyAll")} testId="menu-reply-all" />}
          <Item icon={<Forward />} label={t("actions.forward")} command="compose.forward" onClick={() => reply("forward")} testId="menu-forward" />
          <ContextMenuSeparator />
        </>
      )}
      {(archivable ? triage : [...wayBack, ...triage]).map((it) => (
        <Item key={it.testId} {...it} />
      ))}
      {anyUnread && <Item icon={<MailOpen />} label={t("actions.markRead")} command="thread.markRead" onClick={() => run("markRead")} testId="menu-read" />}
      {anyRead && <Item icon={<Mail />} label={t("actions.markUnread")} command="thread.toggleRead" onClick={() => run("markUnread")} testId="menu-unread" />}
      {anyPlain && <Item icon={<Star />} label={t("actions.star")} command="thread.star" onClick={() => run("star")} testId="menu-star" />}
      {anyStarred && <Item icon={<StarOff />} label={t("actions.unstar")} command={anyPlain ? undefined : "thread.star"} onClick={() => run("unstar")} testId="menu-unstar" />}
      <ContextMenuSeparator />
      {/* plan 87: a "select all N" has no ids to set them on */}
      <RemindSub ids={ids} disabled={scope !== null} />
      <ContextMenuSub>
        <ContextMenuSubTrigger data-testid="menu-move" disabled={scope !== null && moves.length === 0}>
          <FolderInput />
          <span className="min-w-0 flex-1 truncate">{t("threadMenu.moveTo")}</span>
          {hint("thread.move")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-60" data-testid="menu-move-list">
          {moves.map((it) => (
            <Item key={it.testId} {...it} />
          ))}
          {/* a "select all N" moves nothing into a category or a folder: only out of a Gmail tab, or into one */}
          {scope === null && (
            <>
              {moves.length > 0 && <ContextMenuSeparator />}
              {categories.length > 0 && <p className="px-2 py-1 text-xs text-muted-foreground" data-testid="menu-move-note">{t("threadMenu.moveNote")}</p>}
              {categories.map((c) => (
                <ContextMenuItem key={c.id} data-testid={`menu-move-${c.id}`} disabled={isExclusivelyIn(c.id, ids)} onClick={() => void moveToCategory(c.id, ids, { source: "picker" })}>
                  <CategoryDot color={c.color as CategoryColor} className="mx-1" />
                  <span className="truncate">{c.name}</span>
                </ContextMenuItem>
              ))}
              {categories.length > 0 && <ContextMenuSeparator />}
              <ContextMenuItem data-testid="menu-move-new" onClick={() => picker("move")}>
                <Plus /> {t("threadMenu.newCategory")}
              </ContextMenuItem>
              {/* plan 127: the keyboard's way to what a drag onto a folder does */}
              <MoveToFolderItems rows={rows} ids={ids} />
            </>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger data-testid="menu-categories">
          <Tag />
          <span className="min-w-0 flex-1 truncate">{t("actions.category")}</span>
          {hint("thread.category")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-60" data-testid="menu-categories-list">
          {categories.length > 0 && <p className="px-2 py-1 text-xs text-muted-foreground" data-testid="menu-category-note">{t("threadMenu.categoryNote")}</p>}
          {categories.map((c) => (
            <ContextMenuCheckboxItem key={c.id} data-testid={`menu-category-${c.id}`} checked={!scope && inAll(c.id)} closeOnClick onClick={() => toggleCategory(c.id)}>
              <CategoryDot color={c.color as CategoryColor} className="mx-1" />
              <span className="truncate">{c.name}</span>
            </ContextMenuCheckboxItem>
          ))}
          {categories.length > 0 && <ContextMenuSeparator />}
          <ContextMenuItem data-testid="menu-category-new" onClick={() => picker("toggle")}>
            <Plus /> {t("threadMenu.newCategory")}
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger data-testid="menu-more">
          <Ellipsis />
          <span className="min-w-0 flex-1 truncate">{t("threadMenu.more")}</span>
        </ContextMenuSubTrigger>
        {/* plan 158: everything else, under small labels; a row with several answers opens them beside it */}
        <ContextMenuSubContent className="w-80" data-testid="menu-more-list">
          <MoreItems pins={pinItems} spam={spam} single={single} code={code} view={view} ids={ids} scope={scope !== null} sender={sender} categories={categories} fileTo={fileTo} filedIn={filedIn} />
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}

/** "More ▸": what a row is rarely right-clicked for; a row with several answers opens them beside it. */
function MoreItems({ pins, spam, single, code, view, ids, scope, sender, categories, fileTo, filedIn }: { pins: ReactNode; spam: MenuEntry | undefined; single: ThreadSummary | undefined; code: string | null; view: View; ids: number[]; scope: boolean; sender: { email: string; name: string } | null; categories: readonly Category[]; fileTo: readonly Category[]; filedIn: readonly Category[] }) {
  return (
    <>
      {pins}
      {spam && <Item {...spam} />}
      {single && code && (
        <Item
          icon={<Copy />}
          label={t("codes.copy", { code })}
          testId="menu-copy-code"
          onClick={() => void copyCode(codeKey(single.id, code), code).then((ok) => ok && snack(t("codes.copied", { code }), { duration: 2000 }))}
        />
      )}
      {single && (
        <>
          {/* one conversation only: printing several at once isn't a thing */}
          <Item icon={<Printer />} label={t("actions.printMore")} command="thread.print" onClick={() => openPrint({ threadId: single.id, messageId: null, intent: "print" })} testId="menu-print" />
          <Item icon={<Copy />} label={t("threadMenu.copyText")} onClick={() => copyThreadText(single.id)} testId="menu-copy-text" />
        </>
      )}
      <Item icon={<CheckCheck />} label={t("actions.selectAll")} command="list.selectAll" onClick={selectAll} testId="menu-select-all" />
      {/* plan 63: the same, for everything like it (explicit rows only: a "select all N" scope is already everything) */}
      {!scope && ids.length <= 200 && <SimilarSection view={view} ids={ids} />}
      {sender && (
        <Section label={t("threadMenu.from", { name: sender.name })} testId="menu-sender">
          {categories.length > 0 && (
            <SubRow icon={<Tag />} label={t("threadMenu.fileAll")} testId="menu-sender-file">
              {fileTo.map((c) => (
                <ContextMenuItem key={c.id} data-testid={`menu-sender-file-${c.id}`} onClick={() => void applyScope(c.id, { kind: "sender", email: sender.email })}>
                  <CategoryDot color={c.color as CategoryColor} className="mx-1" />
                  <span className="truncate">{t("threadMenu.toCategory", { category: c.name })}</span>
                </ContextMenuItem>
              ))}
              {/* plan 77: the categories this mail is in offer the way out instead */}
              {filedIn.map((c) => (
                <ContextMenuItem key={c.id} data-testid={`menu-sender-out-${c.id}`} onClick={() => void removeSenderFromCategory(c.id, sender.email)}>
                  <CategoryDot color={c.color as CategoryColor} className="mx-1" />
                  <span className="truncate">{t("threadMenu.outOfCategory", { category: c.name })}</span>
                </ContextMenuItem>
              ))}
            </SubRow>
          )}
          <Item
            icon={<Filter />}
            label={t("threadMenu.createFilter")}
            testId="menu-filter"
            onClick={() => setApp({ dialog: "filters", filterPrefill: { name: t("threadMenu.filterName", { name: sender.name }), rule: { match: "all", conditions: [{ field: "from", op: "equals", value: sender.email }], actions: [{ type: "archive" }] } } })}
          />
          <Item icon={<Search />} label={t("threadMenu.searchSender")} testId="menu-search-sender" onClick={() => setApp({ query: `from:${sender.email}`, view: "all", categoryId: null, reviewCategoryId: null, checked: new Set(), scope: null })} />
          <Item
            icon={<Copy />}
            label={t("threadMenu.copyAddress")}
            testId="menu-copy"
            onClick={() =>
              void navigator.clipboard.writeText(sender.email).then(
                () => snack(t("threadMenu.copied", { email: sender.email }), { duration: 2000 }),
                () => snack.error(t("threadMenu.copyFailed")),
              )
            }
          />
          {/* keyed: a menu moved onto another row never shows (or opens) the last row's offer while its own loads */}
          {single && <UnsubscribeItem key={single.id} threadId={single.id} />}
        </Section>
      )}
    </>
  );
}

/**
 * A scope's menu label; a named sender carries its address, muted, so same-named senders tell apart; a
 * subject its template (plan 91: "Same sender and subject · Tu pedido # está en camino", as the snackbar says it).
 */
function ScopeLabel({ scope, senderName }: { scope: SimilarScope; senderName: string | null }) {
  const email = scope.kind === "sender" && senderName && senderName !== scope.email ? scope.email : null;
  return (
    <span className="min-w-0 flex-1 truncate">
      {scopeLabel(scope, senderName)}
      {email && <span className="text-muted-foreground"> {email}</span>}
      {scope.kind === "subject" && <span className="text-muted-foreground"> · {subjectTemplate(scope.subject)}</span>}
    </span>
  );
}
