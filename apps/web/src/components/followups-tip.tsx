import type { FollowupKind } from "@terno/core";
import { t } from "@terno/i18n";
import { Check, Clock, ListChecks, PenLine } from "@terno/ui/icons";
import { Tip } from "./tip";
import { TipMenu, TipMenuItem, TipPicture } from "./tip-picture";

/**
 * Plan 113 and 142: the first time a follow-up shows on an open thread: the line, and how it ends. Plan 161: it teaches
 * the kind the line is (a wait shows Write a follow-up, a promise Done) and points at the line, from below.
 */
export default function FollowupsTip({ kind, name }: { kind: FollowupKind; name: string | null }) {
  // plan 280: what's owed to you is taught as a wait is: the line, and Received
  if (kind === "theirs") return <OwedTip name={name} />;
  const awaiting = kind === "awaiting";
  return (
    <Tip
      id="followups-first"
      anchor='[data-testid="followup-line"]'
      side="bottom"
      ended={false}
      title={t(awaiting ? "followups.tip.awaitingTitle" : "followups.tip.title")}
      body={t(awaiting ? "followups.tip.awaitingBody" : "followups.tip.body")}
      picture={
        <TipPicture className="h-[92px]">
          <TipMenu className={awaiting ? "w-56" : undefined}>
            {awaiting ? (
              <>
                <TipMenuItem icon={<Clock className="size-3.5" />} label={t("followup.awaitingYet", { name: name ?? "Ana" })} />
                <TipMenuItem icon={<PenLine className="size-3.5" />} label={t("followup.nudge")} pointer />
              </>
            ) : (
              <>
                <TipMenuItem icon={<ListChecks className="size-3.5" />} label={t("followup.promise", { name: "Tom", text: t("followups.tip.example") })} />
                <TipMenuItem icon={<Check className="size-3.5" />} label={t("followup.done")} pointer />
              </>
            )}
          </TipMenu>
        </TipPicture>
      }
    />
  );
}

/** Plan 280: the first promise of theirs on an open conversation: what it says, and Received. */
function OwedTip({ name }: { name: string | null }) {
  return (
    <Tip
      id="followups-first"
      anchor='[data-testid="followup-line"]'
      side="bottom"
      ended={false}
      title={t("followups.tip.owedTitle")}
      body={t("followups.tip.owedBody")}
      picture={
        <TipPicture className="h-[92px]">
          <TipMenu className="w-60">
            <TipMenuItem icon={<Clock className="size-3.5" />} label={t("followup.theirs", { name: name ?? "Alex", text: t("followups.tip.owedExample") })} />
            <TipMenuItem icon={<Check className="size-3.5" />} label={t("followup.received")} pointer />
          </TipMenu>
        </TipPicture>
      }
    />
  );
}
