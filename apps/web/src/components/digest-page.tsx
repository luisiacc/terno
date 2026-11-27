import { NOT_NEWSLETTER_NAME_MAX, type DigestItem, type DigestRow } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Checkbox } from "@terno/ui/components/checkbox";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@terno/ui/components/context-menu";
import { IconButton } from "@terno/ui/components/icon-button";
import { Spinner } from "@terno/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Archive, Ban, ChevronRight, EyeOff, Info, Mail, X } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { type MouseEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getApp } from "~/state/app";
import { leaveNewDraft } from "~/lib/compose";
import { useDesign } from "~/lib/design";
import { LIST_TITLE } from "~/lib/list-title";
import { focusReader } from "~/lib/pane-focus";
import { focusQuietly } from "~/lib/quiet-focus";
import { COLUMN as FEED_COLUMN } from "./what-matters/feed";
import { modelName, routeOf } from "~/lib/ai";
import { listDate } from "~/lib/format";
import { closeDigestPage } from "~/lib/page";
import { PANE_TITLE, PANE_TITLE_TOP } from "~/lib/pane-lines";
import { act, deferred, trackJob, undoAction, undoActions } from "~/lib/actions";
import { registerUndo, snack, snackPublication, undoNow, useSnack } from "~/lib/snack";
import { whenDay } from "~/lib/when";
import { AiErrorNotice, aiErrorCopy, errorTarget } from "~/components/ai-error";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
import { openFound } from "./settings/find-open";
import { openSettings } from "~/lib/settings-place";
import { reloadList } from "~/state/list";
import { digestKeys, digestMorph, digestPick, keepDigestPick, leaveOut, letBackIn, openFromDigest, senderKey, useToday, withoutSenders } from "~/state/today";
import { AiProvenance } from "~/components/ai-provenance";
import { AutomatedClear } from "~/components/automated-clear";

/** Plan 247: the digest's switch is What matters' (Once a day): Settings opens there, at the switch. */
function openDigestSettings() {
  openSettings("whatMatters");
  requestAnimationFrame(() => openFound({ id: "whatMatters.digest", tab: "whatMatters", page: null, scope: null, under: null }));
}

/**
 * Plan 161, pass 2: what each row is, said on it. To archive (ticked), kept (unticked), opened (read: plan 145 archives
 * only unread mail, so it stays), or archived (out of the Inbox).
 */

export type DigestRowState = "archive" | "keep" | "opened" | "archived";

const STATE_LABEL: Partial<Record<DigestRowState, () => string>> = { keep: () => t("today.digest.state.kept"), opened: () => t("today.digest.state.opened"), archived: () => t("today.digest.state.archived") };

/**
 * Plan 145 §4: the digest in the reader's column. Plain text, never links: a line is a model's rewording of mail. With the
 * digest off nothing has said what these are, so they're automated mail, unticked (revision 3).
 */
/**
 * Plan 166: a row's menu, the row's own (right-click, or ⇧F10 on it). A digest's: Open, Not a newsletter. Plan 235:
 * Automated mail's: Open, Archive, Hide sender, for the ticked rows when it's opened on one of several ticked.
 */
function DigestRowMenu({ onOpen, archive, leave, children }: { onOpen: () => void; archive: { label: string; run: () => void } | null; leave: { label: string; icon: React.ReactNode; testId: string; help?: string; run: () => void } | null; children: React.ReactElement }) {
  const helpId = useId();
  // the help shows on the icon's hover, and while the row is reached by the keys (Codex review: a keyboard has no hover)
  const [hoverHelp, setHoverHelp] = useState(false);
  const [keyHelp, setKeyHelp] = useState(false);
  // what last moved in the menu: a key (seen before the menu moves focus for it) or the pointer
  const viaKeys = useRef(false);
  return (
    <ContextMenu onOpenChange={(open) => setApp({ menuOpen: open })}>
      <ContextMenuTrigger data-context-menu render={children} />
      <ContextMenuContent className="w-52" data-testid="digest-item-menu" onKeyDownCapture={() => (viaKeys.current = true)} onPointerMove={() => (viaKeys.current = false)}>
        {/* each row with its icon, so the labels share one column */}
        <ContextMenuItem data-testid="digest-menu-open" onClick={onOpen}>
          <Mail />
          {t("common.open")}
        </ContextMenuItem>
        {archive && (
          <ContextMenuItem data-testid="digest-menu-archive" onClick={archive.run}>
            <Archive />
            {archive.label}
          </ContextMenuItem>
        )}
        {leave && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid={leave.testId}
              aria-describedby={leave.help ? helpId : undefined}
              onFocus={() => setKeyHelp(viaKeys.current)}
              onBlur={() => setKeyHelp(false)}
              onClick={() => {
                // the rows (and this menu with them) go at once: its close never comes, so the keys come back to the page now
                setApp({ menuOpen: false });
                leave.run();
              }}
            >
              {leave.icon}
              {leave.label}
              {leave.help && (
                // plan 235: what Hide does to mail still to come, on the row's end where a shortcut would be. Neither the icon
                // nor its tooltip (portaled, but the row's child for React's events: Codex review) is the row: a click there
                // hides nothing
                <ContextMenuShortcut className="flex" data-testid="digest-menu-hide-help" onClick={(e) => (e.preventDefault(), e.stopPropagation())} onPointerUp={(e) => e.stopPropagation()} onMouseUp={(e) => e.stopPropagation()}>
                  <Tooltip open={hoverHelp || keyHelp} onOpenChange={setHoverHelp}>
                    <TooltipTrigger render={<span className="flex" />}>
                      <Info aria-hidden />
                    </TooltipTrigger>
                    <TooltipContent side="right">{leave.help}</TooltipContent>
                  </Tooltip>
                </ContextMenuShortcut>
              )}
            </ContextMenuItem>
            {/* read with the row by a screen reader: the tooltip is the pointer's */}
            {leave.help && <span id={helpId} hidden>{leave.help}</span>}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A row's place on screen, for the other form to land it at the same height (plan 251). */
const anchorOf = (el: Element | null | undefined, id: number) => (el ? { id, y: el.getBoundingClientRect().top } : null);

/**
 * Plan 251: the page has two forms. `page`, in the reader's column (plan 145); `column`, in the list column beside the
 * newsletter it opened (Split), where What matters' feed was: the same rows, ticks and foot, the open one marked, and the
 * list's keys (j/k open the next or previous). Both read and write the one pick (`useToday.pick`), so either takes up
 * where the other was left.
 */
export default function DigestPage({ place = "page" }: { place?: "page" | "column" }) {
  const beside = place === "column";
  const digest = useToday((s) => s.digest);
  const [row, setRow] = useState<DigestRow | null>(digest);
  const ai = useApp((s) => s.settings?.ai);
  // plan 251 (Codex critique): what's live from the first paint, so a form mounted for a transition's new snapshot doesn't
  // show an archived row as live for its first frame
  const [liveIds, setLive] = useState<ReadonlySet<number> | null>(() => (digest ? new Set(digest.liveIds) : null));
  // the newsletter open beside the column form; none on the page
  const current = useToday((s) => (beside ? s.fromDigest : null));
  const listTitle = LIST_TITLE[useDesign().variants.listHeader === "title" ? "title" : "display"];
  useEffect(() => {
    let current = true;
    // plan 166 (Codex critique): only the newest of the page's own reads lands, so an older one can't bring back a row
    let asked = 0;
    let landed = 0;
    const read = () => {
      const mine = ++asked;
      void client.call("today.digest", {}).then((r) => {
        if (!current || mine < landed) return;
        landed = mine;
        setRow(r);
      }, () => {});
    };
    read();
    const off = client.on("todayDigest", read);
    return () => {
      current = false;
      off();
    };
  }, []);
  // plan 166: a sender just said not to be a newsletter is gone at once, whatever a read brings, until its Undo
  const notNewsletters = useToday((s) => s.notNewsletters);
  const items = useMemo(() => (row ? withoutSenders(row, notNewsletters).items : []), [row, notNewsletters]);
  const automated = row?.automated === true;
  // plan 161: what was unticked, and where the page was, outlive it: opening a newsletter and coming back finds them.
  // Kept by digest: its day and what kind it is (a set means the unticked in one, the ticked in automated mail)
  const day = row ? `${row.day}|${automated ? "automated" : "digest"}` : "";
  const [toggled, setToggled] = useState<ReadonlySet<number>>(() => digestPick(day).toggled);
  const [readTicked, setReadTicked] = useState<ReadonlySet<number>>(() => digestPick(day).readTicked ?? new Set());
  // pass 2: what this page archived (its rows leave, the header says it's done), held with the rest of the pick
  const batches = useToday((s) => (s.pick?.day === day ? (s.pick.done ?? null) : null));
  // plan 162 (after ai162-r02): what was opened from here, kept the moment it opened, whichever way the page is come back to
  const openedHere = useToday((s) => (s.pick?.day === day ? s.pick.opened : undefined));
  // plan 162: the snack on screen carries this page's last Undo: the page doesn't show a second one beside it
  const lastUndo = batches?.at(-1)?.undo ?? null;
  const undoInSnack = useSnack((s) => lastUndo !== null && s.current?.action?.undo === lastUndo);
  const scroller = useRef<HTMLDivElement>(null);
  // plan 286 (Codex review): the foot itself, not whether there's a row: it goes with the rows when they all go (clear
  // skies) and comes back with their Undo, and each one mounted is the one measured
  const [foot, setFoot] = useState<HTMLElement | null>(null);
  const [footHeight, setFootHeight] = useState(0);
  const [atEnd, setAtEnd] = useState(false);
  useLayoutEffect(() => {
    const el = foot;
    if (!el) return;
    const set = () => {
      setFootHeight(el.offsetHeight);
      // the snacks stand on the page's foot; beside, they're over the reader (Split's dock), clear of the column
      if (!beside) useSnack.setState({ pageLift: el.offsetHeight });
      const sc = scroller.current;
      if (sc) setAtEnd(sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1);
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (!beside) useSnack.setState({ pageLift: 0 });
    };
  }, [foot]);
  const scrollAt = useRef(digestPick(day).scroll);
  // back where it was left, once its rows are there: once a digest
  const restored = useRef<string | null>(null);
  const [pickOf, setPickOf] = useState(day);
  // Shift with a tick gives the rows from the last one ticked to it that row's new state, as a list's range does
  const [anchor, setAnchor] = useState<number | null>(null);
  if (pickOf !== day) {
    setPickOf(day);
    setAnchor(null);
    setToggled(digestPick(day).toggled);
    setReadTicked(digestPick(day).readTicked ?? new Set());
  }
  /** Plan 251: the row back at the height it was left at in the other form, when it's here; whether it was. */
  const land = (id: number | null | undefined): boolean => {
    const sc = scroller.current;
    const { anchor } = digestPick(day);
    const el = id != null && anchor?.id === id ? rowEl(id) : null;
    if (!sc || !el || !anchor) return false;
    sc.scrollTop += el.getBoundingClientRect().top - anchor.y;
    return true;
  };
  const rowEl = (id: number) => scroller.current?.querySelector<HTMLElement>(`[data-digest-open="${id}"]`)?.closest("li") ?? null;
  useLayoutEffect(() => {
    if (restored.current === day || !scroller.current || !row?.items.length) return;
    restored.current = day;
    const pick = digestPick(day);
    if (beside) {
      // plan 251: the open row where the page had it, and the keys on it (a program's focus: no ring) unless they're
      // somewhere already (the reader, a field); the way back's row (`from`) is the page's to use
      // never under the foot bar (the forms' feet differ in height)
      land(current);
      if (current !== null) rowEl(current)?.scrollIntoView({ block: "nearest" });
      settled.current = { top: scroller.current.scrollTop, current };
      const at = document.activeElement;
      if (current !== null && (!at || at === document.body)) focusQuietly(scroller.current.querySelector<HTMLElement>(`[data-digest-open="${current}"]`));
      return;
    }
    scrollAt.current = pick.scroll;
    scroller.current.scrollTop = scrollAt.current;
    // plan 251: back from the list beside, the row it was on where the list had it
    if (land(pick.from)) scrollAt.current = scroller.current.scrollTop;
    // pass 2: back from a newsletter, the row it was opened from is the cursor again (a program's focus: no ring). Plan 162
    // (after ai162-r02): opened afresh, the first row is, so the page has the keys (j moved Today's list behind it)
    const at = (pick.from != null && scroller.current.querySelector<HTMLElement>(`[data-digest-open="${pick.from}"]`)) || scroller.current.querySelector<HTMLElement>("[data-digest-open]");
    const elsewhere = document.activeElement && document.activeElement !== document.body && !document.activeElement.closest("[data-testid=list-header], [data-testid=thread-list], [data-testid=wm-feed]");
    if (at && (pick.from != null || !elsewhere)) at.focus({ preventScroll: true });
    if (pick.from != null) keepDigestPick({ day, toggled: pick.toggled, readTicked: pick.readTicked, scroll: scrollAt.current, from: null });
  }, [row, day]);
  // plan 251: beside, the open row stays in view as j/k or a click move it
  const shownAt = useRef<number>(-1);
  /** where the column landed: moved from there (scrolled, or another row open), the page lands where the column is */
  const settled = useRef<{ top: number; current: number | null } | null>(null);
  useLayoutEffect(() => {
    if (!beside || current === null || settled.current === null || settled.current.current === current) return;
    rowEl(current)?.scrollIntoView({ block: "nearest" });
  }, [current]);
  useEffect(() => {
    if (day && restored.current === day) keepDigestPick({ day, toggled, readTicked, scroll: scrollAt.current });
  }, [day, toggled, readTicked]);
  const ticked = (i: DigestItem) => (automated ? toggled.has(i.threadId) : !toggled.has(i.threadId));
  // the list's refresh brings what changed anywhere: an Undo, a read in another window
  useEffect(() => {
    if (digest) setRow(digest);
  }, [digest]);
  // what's already archived or read elsewhere stays listed, muted, and out of the count, so the page doesn't reshuffle
  useEffect(() => {
    if (row) setLive(new Set(row.liveIds));
  }, [row]);
  const readIds = useMemo(() => new Set(row?.readIds ?? []), [row]);
  const movedTo = useToday((s) => s.movedTo);
  const live = (i: DigestItem) => liveIds === null || liveIds.has(i.threadId);
  const opened = (i: DigestItem) => openedHere?.has(i.threadId) === true;
  // pass 2: what this page archived leaves it; what was archived elsewhere stays, muted and said so (plan 145)
  const archivedHere = new Set((batches ?? []).flatMap((b) => b.ids));
  // read and still in the Inbox: opened here, or read anywhere (out of the Inbox is archived whatever was opened here: the
  // backend's read state says which stayed, Codex review); archived here is archived before the next read says so
  const read = (i: DigestItem) => (live(i) ? opened(i) : readIds.has(i.threadId) && !archivedHere.has(i.threadId));
  // plan 235: an opened row starts unticked, and the person can tick it. Automated mail's ticks are all the person's, read or
  // not (so one kept through a read or a Mark unread stays); a digest's read rows are apart from its pre-ticked unread ones
  const pickedRead = (i: DigestItem) => (automated ? toggled : readTicked).has(i.threadId);
  // one keep state: unticked or opened stays (plan 145: opened is read), and Archive takes only what's ticked
  const stateOf = (i: DigestItem): DigestRowState => (read(i) ? (pickedRead(i) ? "archive" : "opened") : live(i) ? (ticked(i) ? "archive" : "keep") : "archived");
  const tickable = (i: DigestItem) => live(i) || read(i);
  const shown = items.filter((i) => !(archivedHere.has(i.threadId) && stateOf(i) === "archived"));
  const chosen = items.filter((i) => stateOf(i) === "archive");
  const staying = shown.filter((i) => stateOf(i) === "keep" || stateOf(i) === "opened").length;
  const readNow = new Set(shown.filter(read).map((i) => i.threadId));
  // the rows Tick all and a Shift range take: a digest's opened ones stay unless ticked one by one
  const rangeable = (i: DigestItem) => (automated ? tickable(i) : live(i) && !read(i));
  /** Ticks (or unticks) these rows. A set means the ticked ones in automated mail and the unticked ones in a digest; a
   * digest's read row is in both, so the person's choice holds if it's marked unread again (Codex review). */
  const setTicks = (ids: readonly number[], on: boolean) => {
    const add = on === automated;
    setToggled((held) => new Set(add ? [...held, ...ids] : [...held].filter((id) => !ids.includes(id))));
    if (automated) return;
    const readOnes = ids.filter((id) => readNow.has(id));
    if (readOnes.length) setReadTicked((held) => new Set(on ? [...held, ...readOnes] : [...held].filter((id) => !readOnes.includes(id))));
  };
  const toggle = (id: number, range = false) => {
    const at = shown.findIndex((i) => i.threadId === id);
    if (at < 0) return;
    const on = stateOf(shown[at]!) !== "archive";
    const from = range && anchor !== null ? shown.findIndex((i) => i.threadId === anchor) : -1;
    const ids = from < 0 ? [id] : shown.slice(Math.min(from, at), Math.max(from, at) + 1).filter((i) => i.threadId === id || rangeable(i)).map((i) => i.threadId);
    setAnchor(id);
    setTicks(ids, on);
  };
  // Shift's press selects no text, and still focuses the tick it pressed (Codex review: Space then toggled the last one)
  const shiftDown = (e: MouseEvent<HTMLElement>) => {
    if (!e.shiftKey) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
  };
  // plan 162: the ticks reset at once, both ways (Atelier codex): every live row ticked, or none. Plan 235: Automated mail's
  // Tick all takes the opened ones too (the person picks everything there); a digest's leaves them (opened stays, its hint says)
  const anyTicked = chosen.length > 0;
  const allTickable = shown.filter(rangeable);
  const tickAll = (on: boolean) => {
    const ids = allTickable.map((i) => i.threadId);
    // a set means the unticked ones in a digest and the ticked ones in automated mail. Plan 166 (Codex critique): only the
    // rows shown change; one left out as not a newsletter keeps its tick, so its Undo brings it back as it was
    const here = new Set(shown.map((i) => i.threadId));
    setToggled((held) => new Set([...[...held].filter((id) => !here.has(id)), ...(on === automated ? ids : [])]));
    if (!on) setReadTicked((held) => new Set([...held].filter((id) => !here.has(id))));
  };
  const heading = useRef<HTMLHeadingElement>(null);
  const open = (threadId: number) => {
    // plan 251: beside, the open row's Open is the way into it (as the list's Enter on its open row); with a new message
    // over it, the way back to it (Codex review: the message is put aside, as opening a conversation does)
    if (beside && threadId === current) {
      const s = getApp();
      if (!s.compose && s.heldView === null) return void focusReader();
      if (s.compose) leaveNewDraft();
      if (getApp().heldView !== null) setApp({ heldView: null });
      return;
    }
    const opening = () => {
      // the ticks as they are now: from the page this runs on the transition's frame (Codex review)
      const ticks = { toggled: keys.current.toggled, readTicked: keys.current.readTicked };
      openFromDigest(day, threadId, beside ? digestPick(day).scroll : (scroller.current?.scrollTop ?? scrollAt.current), ticks, anchorOf(rowEl(threadId), threadId));
      // plan 162 (after ai162-r02): opened from here is read now (plan 145), not after the reader's dwell: that's for j held
      // down a list, and back in under it the newsletter stayed unread while the page said it was opened
      if (liveIds?.has(threadId) !== false) void act("markRead", [threadId], { quiet: true });
    };
    if (beside) return opening();
    // plan 251: from the page, the list glides into the list column beside the newsletter (Split), on the transition's
    // frame: only if nothing else was opened, and no new message started, by then
    const was = getApp();
    digestMorph(() => {
      const now = getApp();
      if (now.selectedId === was.selectedId && now.compose === was.compose) opening();
    });
  };
  // plan 162 (after ai162-r02): the page's own keys, the list's: the cursor is the row holding the focus. Plan 251: beside,
  // the open row is the cursor when the keys are elsewhere (the reader)
  const keys = useRef({ toggle, open, current, day, toggled, readTicked });
  keys.current = { toggle, open, current, day, toggled, readTicked };
  // plan 251 (Codex critique): the open row's place, kept, so j/k go on from there when it leaves the list (hidden, archived)
  const shownIds = shown.map((i) => i.threadId);
  if (beside && current !== null && shownIds.includes(current)) shownAt.current = shownIds.indexOf(current);
  const tickableIds = new Set(shown.filter(tickable).map((i) => i.threadId));
  const canTick = useRef(tickableIds);
  canTick.current = tickableIds;
  useEffect(() => {
    const rows = () => [...(scroller.current?.querySelectorAll<HTMLElement>("[data-digest-open]") ?? [])];
    const cursor = () => {
      const li = document.activeElement?.closest("[data-testid=digest-item]");
      const at = li?.querySelector<HTMLElement>("[data-digest-open]");
      return at ? Number(at.dataset.digestOpen) : null;
    };
    const go = (el: HTMLElement | undefined) => {
      if (!el) return;
      el.focus({ preventScroll: true });
      // the whole row, its hairline too, above the foot bar (the scroller's padding is the bar's height)
      (el.closest("li") ?? el).scrollIntoView({ block: "nearest" });
    };
    /** Plan 251: beside, the next or previous row opens; the keys stay where they were (moved along, in the column). */
    const stepBeside = (delta: 1 | -1) => {
      const all = rows();
      const ids = all.map((el) => Number(el.dataset.digestOpen));
      const at = keys.current.current === null ? -1 : ids.indexOf(keys.current.current);
      // the open row left the list: the row that took its place is next, the one above it previous (none past either
      // end: Codex review)
      const i = at >= 0 ? Math.max(0, Math.min(all.length - 1, at + delta)) : Math.min(shownAt.current, ids.length) + (delta > 0 ? 0 : -1);
      const to = all[i];
      if (!to || Number(to.dataset.digestOpen) === keys.current.current) return;
      const before = document.activeElement;
      const inColumn = scroller.current?.contains(before) === true;
      keys.current.open(Number(to.dataset.digestOpen));
      if (inColumn) return void to.focus({ preventScroll: true });
      // the keys were in the reader on a control of the conversation that went (Codex review): into the one that came, as
      // the list's own j does
      requestAnimationFrame(() => {
        const now = document.activeElement;
        if (before && before !== document.body && (!now || now === document.body)) focusReader();
      });
    };
    digestKeys.current = {
      beside,
      has: () => {
        const at = document.activeElement;
        const s = getApp();
        if (s.dialog !== null || s.menuOpen) return false;
        // plan 251: beside, the list's keys wherever focus is, as the mail list has them in Split (fields keep theirs)
        if (beside) return true;
        return at === null || at === document.body ? true : scroller.current?.contains(at) === true;
      },
      step: (delta) => {
        if (beside) return stepBeside(delta);
        const all = rows();
        const id = cursor();
        const i = id === null ? -1 : all.findIndex((el) => Number(el.dataset.digestOpen) === id);
        go(all[i < 0 ? 0 : Math.max(0, Math.min(all.length - 1, i + delta))]);
      },
      toggle: () => {
        const id = cursor() ?? keys.current.current;
        if (id !== null && canTick.current.has(id)) keys.current.toggle(id);
      },
      open: () => {
        const id = cursor() ?? keys.current.current ?? (rows()[0] ? Number(rows()[0]!.dataset.digestOpen) : null);
        if (id !== null) keys.current.open(id);
      },
      leave: () => {
        // plan 251: going back to the page, the column says where its open row is, if it moved from where it landed (else
        // the page lands where it was left: the column may have clamped it)
        const id = keys.current.current;
        const was = settled.current;
        const sc = scroller.current;
        if (!beside || id === null || !was || !sc || (was.current === id && was.top === sc.scrollTop)) return;
        const anchor = anchorOf(rowEl(id), id);
        if (!anchor) return;
        // scrolled away from it: the page brings it back into view, at the column's edge it went past (Codex review)
        const box = sc.getBoundingClientRect();
        const tall = rowEl(id)!.getBoundingClientRect().height;
        anchor.y = Math.max(box.top, Math.min(box.bottom - tall, anchor.y));
        keepDigestPick({ ...digestPick(keys.current.day), anchor });
      },
      focus: () => {
        const id = keys.current.current;
        const el = (id !== null && scroller.current?.querySelector<HTMLElement>(`[data-digest-open="${id}"]`)) || scroller.current?.querySelector<HTMLElement>("[data-digest-open]") || heading.current;
        if (!el) return false;
        focusQuietly(el);
        // in view (the column may have been scrolled away from it)
        (el.closest("li") ?? el).scrollIntoView({ block: "nearest" });
        return document.activeElement === el;
      },
    };
    return () => {
      digestKeys.current = null;
    };
  }, []);
  /** The ticked rows (the foot's Archive), or the menu's. A read one goes only because the person picked it (plan 235). */
  const archive = async (targets: readonly DigestItem[] = chosen) => {
    if (!row || !targets.length) return;
    const job = trackJob(t("today.digest.archiving"));
    const pickDay = day;
    // pressed before the answer is in, it waits for it; run here or from the snack, it ends the finished state
    const undoId = deferred<{ id: number | null; n: number }>();
    const undo = registerUndo(() =>
      undoId.promise.then(async (u) => {
        if (u.id === null) return;
        await undoActions([u.id], u.n, undefined, true, snackPublication(), (count) => t(automated ? "actions.restored" : "today.digest.restored", { count }));
        // only this Archive's rows come back (Codex review): an earlier one stays done. And only on its own day's page: a
        // later day's (or automated mail's) choices aren't this one's to touch
        const pick = useToday.getState().pick;
        if (pick?.day === pickDay) keepDigestPick({ ...pick, done: (pick.done ?? []).filter((b) => b.undo !== undo) });
      }),
    );
    try {
      const r = await client.call("today.digestArchive", { items: targets.map((i) => ({ threadId: i.threadId, lastDate: i.lastDate, messageCount: i.messageCount, ...(i.fromEmail !== undefined ? { fromEmail: i.fromEmail } : {}), ...(read(i) ? { read: true as const } : {}) })), jobId: job.jobId });
      undoId.resolve({ id: r.undoId, n: r.archived });
      const notes = r.changed + r.spared > 0 ? t("today.digest.leftAlone", { count: r.changed + r.spared }) : undefined;
      snack.success(t(automated ? "today.digest.archivedSelected" : "today.digest.archived", { count: r.archived }), { id: job.snackId, duration: 8000, description: notes, action: r.undoId !== null ? undoAction(undo, t("today.digest.undoName")) : undefined });
      setLive((held) => new Set([...(held ?? items.map((i) => i.threadId))].filter((id) => !targets.some((i) => i.threadId === id))));
      // plan 162: the keys stay on the page (the button that had them is gone): the first row still here, else the title
      requestAnimationFrame(() => {
        const at = document.activeElement;
        if (at && at !== document.body && at.isConnected) return;
        const next = scroller.current?.querySelector<HTMLElement>("[data-digest-open]");
        (next ?? heading.current)?.focus({ preventScroll: true });
      });
      // what the backend really archived: one archived or changed elsewhere meanwhile stays listed, said so (Codex review)
      const pick = useToday.getState().pick;
      if (r.archivedIds.length && pick?.day === pickDay) keepDigestPick({ ...pick, done: [...(pick.done ?? []), { ids: r.archivedIds, undo: r.undoId !== null ? undo : null }] });
    } catch (error) {
      undoId.resolve({ id: null, n: 0 });
      snack.error(error instanceof Error ? error.message : String(error), { id: job.snackId });
    } finally {
      job.stop();
      void reloadList({ keepSelection: true });
    }
  };
  /**
   * Plan 166: "Not a newsletter": every row from that sender leaves the page, its Archive and Today's header at once, and
   * the sender stays out of the digests to come (the backend's list, on this machine). No model, no check. Exact Undo.
   * Plan 235: Automated mail's Hide sender is the same list, for one row's sender or the ticked rows', in one unit.
   */
  const leaveOutSenders = async (targets: readonly DigestItem[]) => {
    const senders = [...new Map(targets.filter((i) => i.fromEmail).map((i) => [senderKey(i), i])).values()];
    if (!senders.length) return;
    const keys = senders.map(senderKey);
    const gone = new Set(keys);
    const one = senders.length === 1 ? senders[0]!.from : undefined;
    const copy = (key: "Done" | "Undo" | "Failed") =>
      automated ? t(`today.digest.hide${key}`, { count: senders.length, sender: one ?? "" }) : t(`today.digest.notNewsletter${key}`, { sender: senders[0]!.from });
    // the keys stay on the page: the next row still there (after the first one going, else before it), else the title
    const rest = shown.filter((i) => !gone.has(senderKey(i)));
    const at = shown.findIndex((i) => gone.has(senderKey(i)));
    const next = rest.find((i) => shown.indexOf(i) > at) ?? rest.findLast((i) => shown.indexOf(i) < at);
    const had = document.activeElement;
    const inRow = had instanceof HTMLElement && had.closest("[data-testid=digest-item]") !== null;
    leaveOut(keys);
    requestAnimationFrame(() => {
      const now = document.activeElement;
      if (!inRow && now && now !== document.body && now.isConnected) return;
      const to = next && scroller.current?.querySelector<HTMLElement>(`[data-digest-open="${next.threadId}"]`);
      (to || heading.current)?.focus({ preventScroll: true });
    });
    try {
      // a sender's name is kept to its first 200 characters (a longer one was refused, Codex review)
      const r = await client.call("today.notNewsletter", { senders: senders.map((i) => ({ email: i.fromEmail!, name: i.from.slice(0, NOT_NEWSLETTER_NAME_MAX) })) });
      // what the cap dropped is in the digest again: it isn't hidden here any more either (Codex review)
      const evicted = r.evicted.map((e) => senderKey({ fromEmail: e.email }));
      letBackIn(evicted);
      const undo = registerUndo(async () => {
        // in one unit: only the entries this added (one said again since stays), and what the cap dropped back as it was
        await client.call("today.notNewslettersUndo", { remove: r.added.map((e) => ({ email: e.email, id: e.id })), restore: r.evicted });
        letBackIn(keys);
        leaveOut(evicted);
        await reloadList({ keepSelection: true });
      });
      snack.success(copy("Done"), { duration: 8000, action: undoAction(undo, copy("Undo")) });
    } catch {
      letBackIn(keys);
      void reloadList({ keepSelection: true });
      snack.error(copy("Failed"));
    }
  };
  /** Plan 235: what a row's menu acts on: the ticked rows when it's one of several ticked, else the row. */
  const menuTargets = (i: DigestItem) => (stateOf(i) === "archive" && chosen.length > 1 ? chosen : [i]);
  const sendersIn = (targets: readonly DigestItem[]) => new Set(targets.filter((i) => i.fromEmail).map(senderKey)).size;
  // plan 286: nothing left to review (no row, or a ready one whose rows all went before this page archived any: every sender
  // hidden, a kept digest's mail gone): clear skies, in either form, the column's on its own surface
  if (!row || (row.state === "ready" && shown.length === 0 && !batches?.length))
    return (
      <AutomatedClear heading={heading} className={beside ? "bg-pane" : undefined} data-testid="digest-page" data-empty="" {...(beside ? { "data-place": "column" } : {})}>
        {!beside && <DigestClose />}
      </AutomatedClear>
    );
  const done = batches?.length ? { count: batches.reduce((n, b) => n + b.ids.length, 0), undo: batches.at(-1)!.undo } : null;
  const finished = done !== null;
  // plan 162 (Codex review): a provider that answered with an error is stored apart from one out of reach
  const answered = row.errorKind === "provider_error" ? "errors.ai.providerError" : row.errorKind === "provider_not_found" ? "errors.ai.notFound" : row.errorKind === "provider_no_permission" ? "errors.ai.noPermission" : undefined;
  const failure = row.state === "failed" ? aiErrorCopy({ message: answered ? "" : t("today.digest.failed"), kind: (answered ? (answered === "errors.ai.noPermission" ? "auth" : "unavailable") : row.errorKind) as never, key: answered }, ai ? errorTarget(routeOf("digest", ai).provider, ai) : null) : null;
  // plan 251: the rows and the foot, the same in both forms
  const list = shown.length > 0 && (
    <ul>
      {shown.map((i) => {
        const state = stateOf(i);
        // owner's decisions (2): one sent to Trash or Spam from the reader says where it went, as its snack did
        const moved = state === "archived" ? movedTo.get(i.threadId) : undefined;
        // plan 251: beside, an opened row is the one open or one already read there (it's quiet): the page says it stays
        const label = moved ? () => t(moved === "trash" ? "actions.done.trash" : "actions.done.spam") : (automated && state === "keep") || (beside && state === "opened") ? undefined : STATE_LABEL[state];
        const quiet = state === "opened" || state === "archived";
        // plan 235: Automated mail's menu acts on the ticked rows when it's opened on one of several ticked
        const targets = automated ? menuTargets(i) : [i];
        const archivable = targets.filter(tickable);
        const hidden = sendersIn(targets);
        return (
          // plan 166: each row has a menu, as rows do: a digest's says "Not a newsletter"; Automated mail has claimed
          // nothing is a newsletter, so its menu hides the sender instead (plan 235), and it has no row control. Plan 251:
          // each row glides on its own between the forms (`morph`), its images cropped, not scaled
          <DigestRowMenu
            key={i.threadId}
            onOpen={() => open(i.threadId)}
            archive={automated && archivable.length ? { label: archivable.length > 1 ? t("today.digest.archiveAll", { count: archivable.length }) : t("actions.archive"), run: () => void archive(archivable) } : null}
            leave={
              // an item stored with no sender address has nothing to keep out
              !hidden
                ? null
                : automated
                  ? { label: t("today.digest.hideSender", { count: hidden }), icon: <EyeOff />, testId: "digest-menu-hide", help: t("today.digest.hideHelp", { count: hidden }), run: () => void leaveOutSenders(targets) }
                  : { label: t("today.digest.notNewsletter"), icon: <Ban />, testId: "digest-menu-not-newsletter", run: () => void leaveOutSenders([i]) }
            }
          >
          <li data-testid="digest-item" data-live={live(i)} data-state={state} data-current={(beside && i.threadId === current) || undefined} data-morph={`digest-row-${i.threadId}`} data-morph-class="morph-crop" className="group/item relative flex items-start gap-1 border-b border-hairline py-1">
            {/* pass 2: a 24 px box of its own, so a near miss doesn't open the newsletter beside it */}
            <Checkbox target="quiet" data-testid="digest-tick" aria-label={t("today.digest.tick", { subject: i.subject })} checked={state === "archive"} disabled={!tickable(i)} className="mt-1.5" onMouseDown={shiftDown} onCheckedChange={(_, how) => toggle(i.threadId, (how.event as { shiftKey?: boolean }).shiftKey === true)} />
            {/* plan 161: reading is as plain as archiving: the whole row opens the newsletter, and says so on hover */}
            {/* plan 251: beside, the open row is marked as the list marks its open conversation */}
            <button type="button" data-digest-open={i.threadId} aria-current={(beside && i.threadId === current) || undefined} className="group/open flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors group-has-[[data-not-newsletter]:hover]/item:bg-row-hover hover:bg-row-hover focus:bg-row-selected aria-[current]:bg-row-selected focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" data-testid="digest-open" onClick={() => open(i.threadId)}>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2 text-xs">
                  {/* plan 251 (Codex critique): in the narrow column the sender and what happened to the row give way too, so
                      the subject keeps room */}
                  <span className={cn("font-medium", beside ? "max-w-[45%] min-w-0 truncate" : "max-w-[60%] shrink-0", quiet ? "text-muted-foreground" : "text-foreground")} data-testid="digest-from">{i.from}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" data-testid="digest-subject">{i.subject}</span>
                  {label && <span className={cn("font-medium text-muted-foreground", beside ? "max-w-[35%] min-w-0 truncate" : "shrink-0")} data-testid="digest-state">{label()}</span>}
                  {/* plan 166: the date gives its place to the row's control while it shows */}
                  <span className={cn("shrink-0 text-muted-foreground tabular", !automated && "group-hover/item:invisible group-has-[[data-not-newsletter]:focus-visible]/item:invisible")} data-testid="digest-date">{listDate(i.lastDate)}</span>
                </span>
                {i.line !== null && <span className={cn("mt-0.5 block text-sm", beside && "line-clamp-2", quiet ? "text-muted-foreground" : "text-foreground")} data-testid="digest-line">{i.line}</span>}
              </span>
              {/* pass 3: at rest, so opening one is as visible as ticking it, its edge the Archive button's */}
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-colors group-hover/open:text-foreground" />
            </button>
            {!automated && (
              // plan 166: beside Open, never inside it (Codex critique): on the first line where the date is, at the chevron's
              // inset, shown with the row's hover or its own Tab focus; quiet, icon-only, named in its tooltip
              <IconButton
                label={t("today.digest.notNewsletter")}
                size="icon-xs"
                data-not-newsletter=""
                data-testid="digest-not-newsletter"
                className="absolute top-1.5 right-8 opacity-0 group-hover/item:opacity-100 focus-reveal:opacity-100"
                onClick={() => void leaveOutSenders([i])}
              >
                <Ban />
              </IconButton>
            )}
          </li>
          </DigestRowMenu>
        );
      })}
    </ul>
  );
  const footer = (
  <footer
    ref={setFoot}
    // plan 251: the foot glides with the list between the forms; beside, it closes the column under its rows
    data-morph="digest-foot"
    data-morph-class="morph-crop"
    data-morph-pinned=""
    className={cn(
      "z-10 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-hairline pt-3 pb-4",
      beside ? cn(FEED_COLUMN, "max-w-none shrink-0 justify-end gap-x-2 bg-pane") : "sticky bottom-0 mt-auto bg-background before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-6 before:bg-linear-to-t before:from-background before:to-transparent group-data-[end]/digest:before:hidden",
    )}
    data-testid="digest-actions"
  >
    {/* plan 251: beside, what it says on a line of its own, the buttons under it at the column's end (the column is narrow) */}
    {finished ? (
      <p role="status" className={cn("me-auto text-sm", beside && "basis-full")} data-testid="digest-done">
        {t(automated ? "today.digest.archivedSelected" : "today.digest.archived", { count: done.count })}.
        {shown.every((i) => stateOf(i) === "archived") && <span className="ml-1 text-muted-foreground" data-testid="digest-all-done">{t("today.digest.allDone")}</span>}
      </p>
    ) : (
      <p className={cn("me-auto text-sm text-muted-foreground tabular", beside && "basis-full")} data-testid="digest-count">
        {automated ? (
          chosen.length < allTickable.length ? t("today.digest.countSelected", { count: allTickable.length, selected: chosen.length }) : t("today.digest.automatedCount", { count: allTickable.length })
        ) : (
          <>
            {/* pass 2: what Archive will do, in words: how many go, and how many stay; a status, not a button */}
            <span data-testid="digest-to-archive">{t("today.digest.toArchive", { count: chosen.length })}</span>
            {staying > 0 && <span data-testid="digest-staying"> · {t("today.digest.staying", { count: staying })}</span>}
          </>
        )}
      </p>
    )}
    {(anyTicked || allTickable.length > 0) && (
      <Button size="sm" variant="outline" className="text-foreground" data-testid="digest-tick-all" onClick={() => tickAll(!anyTicked)}>
        {t(anyTicked ? "today.digest.untickAll" : "today.digest.tickAll")}
      </Button>
    )}
    {/* pass 2: done, its Undo here once the snack that carries the same one is gone (plan 162: one Undo at a time) */}
    {finished && done.undo && !undoInSnack && (
      <Button size="sm" variant="outline" className="text-foreground" data-testid="digest-undo" aria-label={t("today.digest.undoName")} onClick={() => undoNow(done.undo!)}>
        {t("common.undo")}
      </Button>
    )}
    {automated && sendersIn(chosen) > 0 && (
      // plan 235: the ticked rows' senders out of Automated mail, as the row's menu does it
      // what it does to mail still to come, in its tooltip, as the menu's Hide says it
      <Tooltip>
        <TooltipTrigger render={<Button size="sm" variant="outline" className="text-foreground" data-testid="digest-hide" onClick={() => void leaveOutSenders(chosen)} />}>
          {t("today.digest.hideSender", { count: sendersIn(chosen) })}
        </TooltipTrigger>
        <TooltipContent>{t("today.digest.hideHelp", { count: sendersIn(chosen) })}</TooltipContent>
      </Tooltip>
    )}
    {(!finished || chosen.length > 0) && (
      // the count is what goes, always: what was opened or unticked isn't in it, and its row says so
      <Button size="sm" data-testid="digest-archive" disabled={!chosen.length} onClick={() => void archive()}>
        {automated ? t("today.digest.archiveSelected", { count: chosen.length }) : t("today.digest.archiveAll", { count: chosen.length })}
      </Button>
    )}
  </footer>
  );
  if (beside)
    return (
      // plan 251: the list column's form: the list's header line and title type, the rows in the feed's column, the foot
      // under them. The page's hints (coverage, the tick hint, the digest's settings) stay the page's
      <section data-testid="digest-page" data-place="column" data-finished={finished || undefined} aria-label={t(automated ? "today.digest.automatedTitle" : "today.digest.title")} className="flex h-full min-h-0 flex-col bg-pane">
        <header className="drag-region shrink-0 pb-2" data-testid="digest-header">
          <div className={cn(FEED_COLUMN, "max-w-none flex h-(--pane-bar) items-center gap-2")}>
            <h1 ref={heading} tabIndex={-1} className={cn("min-w-0 flex-1 truncate outline-none", listTitle)} data-testid="digest-title" data-morph="digest-title" data-morph-class="morph-crop">
              {t(automated ? "today.digest.automatedTitle" : "today.digest.title")}
            </h1>
            {!automated && row.model && <AiProvenance model={row.model} at={0} detail={t("today.digest.writtenBy", { model: modelName(row.model) })} testId="digest-provenance" className="-me-1.5" />}
          </div>
        </header>
        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
          data-testid="digest-scroller"
          data-morph-clip=""
        >
          <div className={cn(FEED_COLUMN, "max-w-none")}>
            {finished && shown.length > 0 && <h2 className="pt-2 pb-1 text-xs font-medium text-muted-foreground" data-testid="digest-still-here">{t("today.digest.stillHere")}</h2>}
            {list}
          </div>
        </div>
        {footer}
      </section>
    );
  return (
    // ai-r03: the pane scrolls, bounded to the reader's height, and the page is a column in it. The page itself scrolled
    // with no height to scroll in, so it grew past the window and the parent clipped its last rows (every style, since
    // plan 145); the wheel works anywhere over the pane, and the scrollbar sits at its edge
    <div
      ref={scroller}
      className="group/digest h-full min-h-0 overflow-y-auto [scrollbar-gutter:stable]"
      data-testid="digest-scroller"
      data-morph-clip=""
      data-end={atEnd || undefined}
      style={{ scrollPaddingBottom: footHeight }}
      onScroll={(e) => {
        const el = e.currentTarget;
        setAtEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
        if (restored.current !== day) return;
        scrollAt.current = e.currentTarget.scrollTop;
        keepDigestPick({ day, toggled, scroll: scrollAt.current });
      }}
    >
    <section
      data-testid="digest-page"
      data-finished={finished || undefined}
      aria-label={t("today.digest.title")}
      className="@container relative mx-auto flex min-h-full w-full max-w-(--reader-max,48rem) flex-col gap-3 px-8"
    >
      <DigestClose />
      {/* plan 162 (after ai162-r01): the title on every pane title's line (it sat 15 px low), what the batch is and who wrote
          its lines under it; the decision is at the pane's foot, after the list, where reading ends */}
      <header className={cn(PANE_TITLE_TOP, "space-y-1")} data-testid="digest-header">
        <h1 ref={heading} tabIndex={-1} className={cn(PANE_TITLE, "outline-none")} data-testid="digest-title" data-morph="digest-title" data-morph-class="morph-crop">{t(automated ? "today.digest.automatedTitle" : "today.digest.title")}</h1>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {!automated && items.length > 0 && (
            <p className="text-sm text-muted-foreground" data-testid="digest-coverage">
              {t("today.digest.coverage", { count: items.length, date: whenDay(Math.min(...items.map((i) => i.lastDate))) })}
            </p>
          )}
          {!automated && row.model && (
            // pass 3: who wrote the lines, the one control every AI surface has, at its line's end
            <AiProvenance model={row.model} at={0} detail={t("today.digest.writtenBy", { model: modelName(row.model) })} testId="digest-provenance" className="-me-1.5 ms-auto" />
          )}
        </div>
        {!finished && !automated && chosen.length > 0 && <p className="text-xs text-muted-foreground" data-testid="digest-tick-hint">{t("today.digest.tickHint")}</p>}
      </header>
      {row.state === "pending" && <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="digest-preparing"><Spinner className="size-3" /> {t("today.digest.preparing")}</p>}
      {row.state === "failed" && (
        // plan 162: the one AI error (ai-error.tsx), with Try again
        <div data-testid="digest-failed">
          <AiErrorNotice
            copy={failure!}
            textTestId="digest-failed-text"
            actions={
              <>
                <Button size="sm" variant="outline" data-testid="digest-retry" onClick={() => void client.call("today.digestRetry", {}).catch(() => {})}>{t("ask.tryAgain")}</Button>
                {/* when the fix is in Settings (a key, a model), the way there, as every AI error offers it (Codex review) */}
                {failure!.settings && (
                  <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground" data-testid="digest-error-settings" onClick={() => openSettings("ai")}>{t("ai.error.settings")}</Button>
                )}
              </>
            }
          />
        </div>
      )}
      {automated && (
        <p className="text-xs text-muted-foreground" data-testid="digest-off">
          {t("today.digest.offHint")}{" "}
          <Button variant="link-secondary" size="xs" data-testid="digest-turn-on" onClick={openDigestSettings}>{t("today.digest.offLink")}</Button>
        </p>
      )}
      {finished && shown.length > 0 && <h2 className="pt-2 text-xs font-medium text-muted-foreground" data-testid="digest-still-here">{t("today.digest.stillHere")}</h2>}
      {list}
      {/* plan 162 (after ai162-r01): the decision, sticky at the pane's foot: what Archive will do, the reset, then Archive
          last, so the page reads, then acts (Archive led the page, darkest, before anything was read) */}
      {/* plan 162 (after ai162-r02): rows going on under it fade into its edge (one was cut in half by it, at rest); the
          list keeps its height as scroll padding, so the cursor and Tab stop above it; and the snack stands on it */}
      {footer}
    </section>
    </div>
  );
}

/**
 * The page's Close, as Esc (and the reader's ×): on the pane's bar at the column's right edge, where the reader's sits, full
 * or emptied.
 */
function DigestClose() {
  return (
    <div className="absolute top-0 right-6 flex h-(--pane-bar) items-center">
      <IconButton label={t("common.close")} shortcut="escape" aria-keyshortcuts="Escape" data-testid="digest-close" onClick={closeDigestPage}>
        <X />
      </IconButton>
    </div>
  );
}
