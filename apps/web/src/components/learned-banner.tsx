import { capFilterName, LEARNED_FILTER_NAME, type LearnedProposal } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { Announcement } from "@terno/ui/components/announcement";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Route } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { useEffect, useState } from "react";
import { richT } from "~/lib/i18n";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";

const SENTENCE = { archive: "list.learned.archive", trash: "list.learned.trash", spam: "list.learned.spam" } as const;
const LINE = { archive: "list.learned.line.archive", trash: "list.learned.line.trash", spam: "list.learned.line.spam" } as const;
const ACTION = { archive: "list.learned.action.archive", trash: "list.learned.action.trash", spam: "list.learned.action.spam" } as const;
const ACCEPT = { archive: "list.learned.accept.archive", trash: "list.learned.accept.trash", spam: "list.learned.accept.spam" } as const;

/**
 * One learned rule's offer, above the inbox: one line that doesn't outrank the mail, its reason on hover, and it gives
 * way as the list scrolls. The × is "not now": the offer doesn't come back.
 */
export function LearnedBanner() {
  const view = useApp((s) => s.view);
  const query = useApp((s) => s.query);
  const counts = useApp((s) => s.counts);
  const [proposal, setProposal] = useState<LearnedProposal | null>(null);

  useEffect(() => {
    if (view !== "inbox" || query) return;
    let alive = true;
    void client.call("learning.proposals", {}).then((ps) => alive && setProposal(ps[0] ?? null)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [view, query, counts]);

  if (!proposal || view !== "inbox" || query) return null;
  const who = proposal.scope === "list" ? t("list.learned.list", { value: proposal.value }) : proposal.scope === "domain" ? t("list.learned.domain", { value: proposal.value }) : proposal.value;
  const action = t(ACTION[proposal.action]);
  const sentence = richT(SENTENCE[proposal.action], { who, count: proposal.support, b: (text) => <span className="font-medium">{text}</span> });
  return (
    <Announcement
      data-testid="learned-banner"
      inline
      // at once, not on a transition: moving through a list never animates
      className="py-1 pr-1.5 pl-3 text-muted-foreground group-data-scrolled/list:not-focus-within:hidden"
      icon={<Route className="text-muted-foreground" />}
      title={
        <Tooltip>
          <TooltipTrigger render={<span className="block truncate" />}>
            {t(LINE[proposal.action], { who: proposal.value })}
          </TooltipTrigger>
          <TooltipContent className="max-w-72">{sentence}</TooltipContent>
        </Tooltip>
      }
      titleProps={{ className: "font-normal" }}
      closeLabel={t("list.learned.notNow")}
      closeProps={{ "data-testid": "learned-dismiss" }}
      onClose={() => {
        setProposal(null);
        void client.call("learning.dismiss", { key: proposal.key }).catch(() => {});
      }}
      actions={
        <>
          {/* a suggestion, not the screen's main action: a quiet raised button */}
          <Button
            size="xs"
            variant="outline"
            data-testid="learned-accept"
            aria-label={action}
            onClick={async () => {
              try {
                await client.call("learning.accept", { key: proposal.key, name: capFilterName(t(LEARNED_FILTER_NAME[proposal.action], { value: proposal.value })) });
              } catch (error) {
                snack.error(error instanceof Error ? error.message : String(error));
                return;
              }
              snack.success(t("list.learned.created", { action }));
              setProposal(null);
            }}
          >
            {t(ACCEPT[proposal.action])}
          </Button>
        </>
      }
    />
  );
}
