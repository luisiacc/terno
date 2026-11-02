import { LOCALES, type LocaleId } from "@terno/i18n";

/**
 * Each language's date formats, like Mail: English "9:34 AM", "Yesterday",
 * "Oct 22", "Oct 22, 2024"; Spanish as Terno always wrote it ("09:34",
 * "22 oct", "22 oct 2024", no "Ayer"). A language without an entry gets
 * its locale's defaults. Shared by the renderer's dates and the backend's
 * forwards (plan 116), so both write a quoted date the same way.
 */
export interface DateStyle {
  tag: string;
  time: Intl.DateTimeFormatOptions;
  yesterday: boolean;
  /** Spanish's short months carry a period ("oct.") that the list never showed */
  stripPeriod: boolean;
}

export const DATE_STYLES: Partial<Record<LocaleId, DateStyle>> = {
  en: { tag: "en-US", time: { hour: "numeric", minute: "2-digit" }, yesterday: true, stripPeriod: false },
  es: { tag: "es", time: { hour: "2-digit", minute: "2-digit" }, yesterday: false, stripPeriod: true },
};

export function dateStyle(id: LocaleId): DateStyle {
  return DATE_STYLES[id] ?? { tag: LOCALES[id]?.tag ?? id, time: { hour: "2-digit", minute: "2-digit" }, yesterday: false, stripPeriod: false };
}

/** The full date a quote's header carries ("Tue, Oct 22, 2024, 9:34 AM"). */
export function fullDateFormat(id: LocaleId): Intl.DateTimeFormat {
  const style = dateStyle(id);
  return new Intl.DateTimeFormat(style.tag, { weekday: "short", day: "numeric", month: "short", year: "numeric", ...style.time });
}
