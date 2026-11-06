import { t } from "@terno/i18n";
import { ListChecks, Check } from "@terno/ui/icons";
import { Tip } from "./tip";
import { TipMenu, TipMenuItem, TipPicture } from "./tip-picture";

/** Plan 113 and 142: the first time a follow-up shows on an open thread: the line, and how it ends. */
export default function FollowupsTip() {
  return (
    <Tip
      id="followups-first"
      anchor='[data-testid="thread-followups"]'
      ended={false}
      title={t("followups.tip.title")}
      body={t("followups.tip.body")}
      picture={
        <TipPicture className="h-[92px]">
          <TipMenu>
            <TipMenuItem icon={<ListChecks className="size-3.5" />} label={t("followup.promise", { name: "Tom", text: t("followups.tip.example") })} />
            <TipMenuItem icon={<Check className="size-3.5" />} label={t("followup.done")} pointer />
          </TipMenu>
        </TipPicture>
      }
    />
  );
}
