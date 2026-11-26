import { t } from "@terno/i18n";
import { Announcement } from "@terno/ui/components/announcement";
import { Button } from "@terno/ui/components/button";
import { useEffect, type RefObject } from "react";
import { richT } from "~/lib/i18n";
import { putAwayNews, refreshNotice, seeNotice } from "~/lib/put-away";
import { client } from "~/rpc/connection";
import { navigate, useApp } from "~/state/app";
import { NOTICE_H, usePutAway } from "~/state/put-away";
import { ListLead } from "./learned-banner";

/**
 * Plan 282: asks for the Inbox's line when the Inbox shows, when the backend says something was put away or seen in
 * another window (a rule's archive moves no unread count), and after a reconnect; Put away opened marks what it counted
 * as seen. Renders nothing.
 */
export function PutAwaySource() {
  const inbox = useApp((s) => s.view === "inbox" && !s.query && !s.putAway);
  const putAway = useApp((s) => s.putAway);
  useEffect(() => {
    if (inbox) void refreshNotice();
  }, [inbox]);
  useEffect(() => {
    const offEvent = client.on("putAwayChanged", ({ rules }) => {
      void refreshNotice();
      // only a rule's change reads boxes and Put away again (new mail put away is the line's alone: Codex review)
      if (rules) putAwayNews();
    });
    const offAttach = client.onAttach(() => void refreshNotice());
    return () => {
      offEvent();
      offAttach();
    };
  }, []);
  useEffect(() => {
    if (putAway) void seeNotice();
  }, [putAway]);
  return null;
}

/** The line to show, and the room it takes above the rows: the Inbox only, while someone you've written to needs a look. */
export function usePutAwayNotice(): { shown: boolean; height: number } {
  const here = useApp((s) => s.view === "inbox" && !s.query && s.categoryId === null && s.gmailTab === null && s.actionPreview === null);
  const count = usePutAway((s) => s.notice?.count ?? 0);
  const height = usePutAway((s) => s.noticeHeight);
  return { shown: here && count > 0, height };
}

/**
 * The Inbox's one line about Put away (plan 282): only when Terno or a rule put away mail from someone you've written to,
 * since you last looked. Quieter than any row, as the learned offer is: Review opens Put away, × lets it be. No count
 * anywhere else, no notification.
 */
export function PutAwayNotice({ scroller }: { scroller: RefObject<HTMLElement | null> }) {
  const notice = usePutAway((s) => s.notice);
  if (!notice || notice.count === 0) return null;
  // the person's name stands out from the line's quiet words: it isn't a rule offer (which shares this place)
  const line = notice.count === 1 && notice.first ? richT("putAway.notice.one", { name: notice.first.name, b: (s) => <strong className="font-medium text-foreground">{s}</strong> }) : t("putAway.notice.many", { count: notice.count });
  return (
    <ListLead scroller={scroller} onHeight={(h) => usePutAway.setState({ noticeHeight: Math.max(NOTICE_H, Math.ceil(h)) })}>
      <Announcement
        data-testid="put-away-notice"
        inline
        wrap
        className="my-0 min-h-8 bg-transparent py-0 pr-1.5 pl-3 text-muted-foreground"
        title={
          <>
            <span data-testid="put-away-notice-line">{line}</span>{" "}
            {/* the owner (after the UI rating): text right after the line, in the link's blue, so it reads as the line's action */}
            <Button
              variant="link"
              data-testid="put-away-review"
              className="align-baseline text-[length:inherit] leading-[inherit] font-normal whitespace-nowrap text-link press:text-link"
              aria-label={t("putAway.notice.reviewName")}
              onClick={() => {
                navigate({ putAway: true });
                // the list takes the keyboard, on the person's mail (Needs a look leads)
                requestAnimationFrame(() => document.querySelector<HTMLElement>("[role=listbox]")?.focus({ preventScroll: true }));
              }}
            >
              {t("putAway.notice.review")}
            </Button>
          </>
        }
        titleProps={{ className: "font-normal text-muted-foreground" }}
        closeLabel={t("common.dismiss")}
        closeProps={{ "data-testid": "put-away-notice-dismiss" }}
        onClose={() => {
          // the list's top keeps the keyboard when the line goes from under it
          scroller.current?.focus({ preventScroll: true });
          void seeNotice();
        }}
      />
    </ListLead>
  );
}
