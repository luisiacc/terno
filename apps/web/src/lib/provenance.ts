import { t } from "@terno/i18n";
import { modelName } from "./ai";
import { fullDate } from "./format";

/**
 * Plan 161: who wrote an AI text, said one way on every surface. On screen, the words the ⌘J strip uses ("Written with
 * AI"); the model and when, with the caution, behind it (a tooltip), never a bare model id where the label goes.
 */
export const provenanceLabel = (): string => t("ai.provenance.label");

export const provenanceDetail = (model: string, at: number): string => t("ai.provenance.detail", { model: modelName(model), date: fullDate(at) });
