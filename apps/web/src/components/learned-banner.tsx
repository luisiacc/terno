import { capFilterName, LEARNED_FILTER_NAME, type LearnedProposal } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { Announcement } from "@terno/ui/components/announcement";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { t } from "@terno/i18n";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { create } from "zustand";
import { richT } from "~/lib/i18n";
import { registerUndo, snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";

const SENTENCE = { archive: "list.learned.archive", trash: "list.learned.trash", spam: "list.learned.spam" } as const;
const LINE = { archive: "list.learned.line.archive", trash: "list.learned.line.trash", spam: "list.learned.line.spam" } as const;
const CREATED = { archive: "list.learned.created.archive", trash: "list.learned.created.trash", spam: "list.learned.created.spam" } as const;

/** Its height: one line in every window, so the rows under it start where they always do (the list's first item) */
export const LEARNED_H = 32;

/**
 * The offer shown, kept while the backend says the same one (counts change often: the list renders only when the offer
 * does). Plan 158: `hushed` once it's been answered (×, or a rule made): no offer takes its place until the next launch
 */
const HUSH_KEY = "terno:learned-hushed";
const useOffer = create<{ proposal: LearnedProposal | null; hushed: boolean }>(() => ({ proposal: null, hushed: readHush() }));
function readHush(): boolean {
  try {
    return sessionStorage.getItem(HUSH_KEY) === "1";
  } catch {
    return false;
  }
}
/** Answered, or not any more (Undo): kept for the session, a reload of the window included */
function hush(on: boolean, proposal: LearnedProposal | null = null): void {
  useOffer.setState({ proposal, hushed: on });
  try {
    if (on) sessionStorage.setItem(HUSH_KEY, "1");
    else sessionStorage.removeItem(HUSH_KEY);
  } catch {
    // private mode: this window only
  }
}
const setProposal = (p: LearnedProposal | null) => useOffer.setState((s) => (s.proposal?.key === p?.key && s.proposal?.support === p?.support ? s : { proposal: p }));

/** Asks for the inbox's first learned-rule offer whenever the counts change; renders nothing (its own renders stay its own). */
export function LearnedSource() {
  const view = useApp((s) => s.view);
  const query = useApp((s) => s.query);
  const counts = useApp((s) => s.counts);
  const hushed = useOffer((s) => s.hushed);
  useEffect(() => {
    if (view !== "inbox" || query || hushed) return;
    let alive = true;
    void client.call("learning.proposals", {}).then((ps) => alive && setProposal(ps[0] ?? null)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [view, query, counts, hushed]);
  return null;
}

/** The offer to show: none in a search or another mailbox. */
export function useLearnedProposal() {
  const here = useApp((s) => s.view === "inbox" && !s.query);
  const proposal = useOffer((s) => (s.hushed ? null : s.proposal));
  return { proposal: here ? proposal : null, setProposal };
}

/**
 * One learned rule's offer, as the list's first item (plan 158): one quiet line under the mail's rank, that goes up with
 * the rows as they scroll, its reason on hover. It lies over the room the list leaves above its first row, outside the
 * listbox (which holds only options), and follows the scroller's offset: a plain transform, not an animation, so it
 * holds with motion off. Its button says what it does: a rule for new mail, no mail touched, and Undo (or z) takes the
 * rule back and brings the offer back. The × is "not now", for the session (plan 158): one click and the line is gone,
 * no other offer taking its place until the next launch; the same once a rule is made.
 */
export function LearnedBanner({ proposal, scroller }: { proposal: LearnedProposal; scroller: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const self = ref.current;
    if (!el || !self) return;
    // past its own height there's nothing to move: it's gone, out of the keyboard's way too
    const follow = () => {
      const y = Math.min(el.scrollTop, LEARNED_H);
      self.style.transform = y ? `translateY(${-y}px)` : "";
      self.style.visibility = y >= LEARNED_H ? "hidden" : "";
    };
    follow();
    el.addEventListener("scroll", follow, { passive: true });
    return () => el.removeEventListener("scroll", follow);
  }, [scroller]);
  const who = proposal.scope === "list" ? t("list.learned.list", { value: proposal.value }) : proposal.scope === "domain" ? t("list.learned.domain", { value: proposal.value }) : proposal.value;
  const line = t(LINE[proposal.action], { who: proposal.value });
  const sentence = richT(SENTENCE[proposal.action], { who, count: proposal.support, b: (text) => <span className="font-medium">{text}</span> });
  return (
    // it lies over the scroller, not in it: a wheel over it still moves the list. Clipped to its room, as the rows are
    // Its room takes no pointer itself: only the part of the offer still showing does (a hidden one none), so a row scrolled under it is clicked
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 overflow-hidden" style={{ height: LEARNED_H }} onWheel={(e) => scroller.current?.scrollBy(0, e.deltaY)}>
    <div
      ref={ref}
      className="pointer-events-auto h-full"
      // reached by Tab while partly scrolled away: the list comes back to its top, so what has the focus shows whole
      onFocus={() => {
        const el = scroller.current;
        if (el && el.scrollTop > 0) el.scrollTop = 0;
      }}
    >
    <Announcement
      data-testid="learned-banner"
      inline
      // quieter than any row: small, muted, on no fill, its button the quietest kind
      className="my-0 h-full bg-transparent py-0 pr-1.5 pl-3 text-muted-foreground"
      title={
        <Tooltip>
          {/* one line: a long name truncates, said whole on hover and in the button's name */}
          <TooltipTrigger render={<span data-testid="learned-line" className="block min-w-0 truncate" />}>
            {line}
          </TooltipTrigger>
          <TooltipContent className="max-w-72">{sentence}</TooltipContent>
        </Tooltip>
      }
      titleProps={{ className: "font-normal text-muted-foreground" }}
      closeLabel={t("list.learned.notNow")}
      closeProps={{ "data-testid": "learned-dismiss" }}
      onClose={() => hush(true)}
      actions={
        <>
          {/* a suggestion, not the screen's main action: the quiet button, its words in the ink */}
          <Button
            size="xs"
            variant="ghost"
            data-testid="learned-accept"
            className="text-foreground"
            aria-label={t("list.learned.acceptName", { line })}
            onClick={async () => {
              let id: number;
              try {
                ({ id } = await client.call("learning.accept", { key: proposal.key, name: capFilterName(t(LEARNED_FILTER_NAME[proposal.action], { value: proposal.value })) }));
              } catch (error) {
                snack.error(error instanceof Error ? error.message : String(error));
                return;
              }
              hush(true);
              const undo = registerUndo(async () => {
                await client.call("filters.delete", { id });
                hush(false, proposal);
              });
              snack.success(t("list.learned.created"), { description: t(CREATED[proposal.action], { who: proposal.value }), action: { label: t("common.undo"), name: t("list.learned.undo", { who: proposal.value }), undo } });
            }}
          >
            {t("list.learned.accept")}
          </Button>
        </>
      }
    />
    </div>
    </div>
  );
}
