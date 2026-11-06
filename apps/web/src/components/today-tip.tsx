import { t } from "@terno/i18n";
import { Sun } from "@terno/ui/icons";
import { Tip } from "./tip";
import { TipMenu, TipMenuItem, TipPicture } from "./tip-picture";

/** Plan 113 and 145: the first time the row appears: where it is, and what it holds. */
export default function TodayTip() {
  return (
    <Tip
      id="today-first"
      anchor='[data-testid="nav-today"]'
      ended={false}
      title={t("today.tip.title")}
      body={t("today.tip.body")}
      picture={
        <TipPicture className="h-[64px]">
          <TipMenu>
            <TipMenuItem icon={<Sun className="size-3.5" />} label={t("today.title")} pointer />
          </TipMenu>
        </TipPicture>
      }
    />
  );
}
