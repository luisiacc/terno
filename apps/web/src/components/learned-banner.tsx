import { capFilterName, LEARNED_FILTER_NAME, type LearnedProposal } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { Sparkles, X } from "lucide-react";
import { t } from "@terno/i18n";
import { useEffect, useState } from "react";
import { richT } from "~/lib/i18n";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";

const SENTENCE = { archive: "list.learned.archive", trash: "list.learned.trash", spam: "list.learned.spam" } as const;
const ACTION = { archive: "list.learned.action.archive", trash: "list.learned.action.trash", spam: "list.learned.action.spam" } as const;

/** Surfaces one learned-filter proposal at the top of the inbox. */
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
  return (
    <div data-testid="learned-banner" className="mx-3 mt-1 mb-1 flex items-start gap-2.5 rounded-[calc(var(--radius-lg)+2px)] bg-tint p-2.5 text-xs">
      <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-foreground">
          {richT(SENTENCE[proposal.action], { who, count: proposal.support, b: (text) => <span className="font-medium">{text}</span> })}
        </p>
        <div className="mt-1.5 flex gap-1.5">
          {/* a suggestion, not the screen's main action: a quiet raised button */}
          <Button
            size="xs"
            variant="outline"
            data-testid="learned-accept"
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
            {action}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={async () => {
              await client.call("learning.dismiss", { key: proposal.key });
              setProposal(null);
            }}
          >
            {t("list.learned.notNow")}
          </Button>
        </div>
      </div>
      <button type="button" aria-label={t("common.close")} className="text-muted-foreground hover:text-foreground" onClick={() => setProposal(null)}>
        <X className="size-3.5" />
      </button>
    </div>
  );
}
