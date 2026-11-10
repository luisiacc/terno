import { capFilterName, LEARNED_FILTER_NAME, type LearnedProposal } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { Announcement } from "@terno/ui/components/announcement";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { t } from "@terno/i18n";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { hush, LEARNED_H, learnedCreated, learnedLine, learnedWhy, noteShown, offerOf, setOfferHeight, setProposals, unhush, useOffer } from "~/lib/learned";
import { registerUndo, snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp, useApp } from "~/state/app";
import { forwardWheel } from "~/lib/wheel";

export { LEARNED_H };

/** Asks for the inbox's learned-rule offers whenever the counts change; renders nothing (its own renders stay its own). */
export function LearnedSource() {
  const view = useApp((s) => s.view);
  const query = useApp((s) => s.query);
  const counts = useApp((s) => s.counts);
  const hushed = useOffer((s) => s.hushed);
  useEffect(() => {
    if (view !== "inbox" || query || hushed) return;
    let alive = true;
    void client.call("learning.proposals", {}).then((ps) => alive && setProposals(ps)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [view, query, counts, hushed]);
  return null;
}

/** The offer to show, and the room it takes above the rows: none in a search or another mailbox. */
export function useLearnedProposal() {
  const here = useApp((s) => s.view === "inbox" && !s.query);
  const proposal = useOffer(offerOf);
  const height = useOffer((s) => s.height);
  return { proposal: here ? proposal : null, height };
}

/**
 * One learned rule's offer, as the list's first item (plans 158, 159): a quiet line under the mail's rank that goes up
 * with the rows as they scroll. It says the rule whole ("Always archive mail from anyone at x.com?"), wrapping in a
 * narrow list rather than cutting it, its button right after it at the text's own weight, and why on hover. It lies
 * over the room the list leaves above its first row, outside the listbox (which holds only options), as tall as it's
 * laid out (measured: a wrapped line makes room), and follows the scroller's offset on its scroll timeline
 * (`data-scroll-follow`): the compositor moves it in the frame the rows move, where a scroll event comes a frame late
 * and the line trailed them. That holds with motion off too; without scroll timelines, the scroll event moves it. Shown in the Inbox once (lib/learned): seen as it first shows, kept while you
 * stay, not offered in a list again. The × and a rule made end it at once; Undo (or z) takes the rule back and brings
 * the offer back, while you're still there.
 */
export function LearnedBanner({ proposal, scroller }: { proposal: LearnedProposal; scroller: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  // on screen: seen, for good
  useEffect(() => noteShown(proposal.key, getApp()), [proposal.key]);
  useLayoutEffect(() => {
    const el = scroller.current;
    const self = ref.current;
    if (!el || !self) return;
    const linked = typeof CSS !== "undefined" && CSS.supports?.("animation-timeline: scroll()");
    // past its own height there's nothing to move: it's gone, out of the keyboard's way too
    const follow = () => {
      const h = self.offsetHeight;
      self.style.setProperty("--follow-h", `${h}px`);
      if (linked) return;
      const y = Math.min(el.scrollTop, h);
      self.style.transform = y ? `translateY(${-y}px)` : "";
      self.style.visibility = y >= h ? "hidden" : "";
    };
    // its height as laid out (a width, a language or a design that wraps it): the rows' room above them follows
    const ro = new ResizeObserver(() => {
      setOfferHeight(Math.max(LEARNED_H, Math.ceil(self.offsetHeight)));
      follow();
    });
    ro.observe(self);
    follow();
    if (!linked) el.addEventListener("scroll", follow, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", follow);
    };
  }, [scroller]);
  const line = learnedLine(proposal);
  return (
    // it lies over the scroller, not in it: a wheel over it still moves the list. Clipped to its room, as the rows are
    // Its room takes no pointer itself: only the part of the offer still showing does (a hidden one none), so a row scrolled under it is clicked
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 overflow-hidden" onWheel={(e) => forwardWheel(e, scroller.current)}>
    <div
      ref={ref}
      data-scroll-follow
      className="pointer-events-auto"
      // reached by Tab while partly scrolled away: the list comes back to its top, so what has the focus shows whole
      onFocus={() => {
        const el = scroller.current;
        if (el && el.scrollTop > 0) el.scrollTop = 0;
      }}
    >
    <Announcement
      data-testid="learned-banner"
      inline
      wrap
      // quieter than any row: small, muted, on no fill; 32 px for one line or two (the × is the line's height), more past that
      className="my-0 min-h-8 bg-transparent py-0 pr-1.5 pl-3 text-muted-foreground"
      title={
        <>
          <Tooltip>
            {/* the rule whole, never cut: it wraps instead */}
            <TooltipTrigger render={<span data-testid="learned-line" />}>{line}</TooltipTrigger>
            <TooltipContent className="max-w-72">{learnedWhy(proposal)}</TooltipContent>
          </Tooltip>{" "}
          {/* a suggestion, not the screen's main action: BoardUI's secondary link, at the line's own size and weight, right after what it does */}
          <Button
            variant="link-secondary"
            data-testid="learned-accept"
            className="align-baseline text-[length:inherit] leading-[inherit] font-normal whitespace-nowrap"
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
                unhush(proposal.key);
              });
              snack.success(t("list.learned.created"), { description: learnedCreated(proposal), action: { label: t("common.undo"), name: t("list.learned.undo", { who: proposal.value }), undo } });
            }}
          >
            {t("list.learned.accept")}
          </Button>
        </>
      }
      titleProps={{ className: "font-normal text-muted-foreground" }}
      closeLabel={t("list.learned.notNow")}
      closeProps={{ "data-testid": "learned-dismiss" }}
      onClose={() => hush(true)}
    />
    </div>
    </div>
  );
}
