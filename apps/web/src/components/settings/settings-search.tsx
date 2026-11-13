import { t } from "@terno/i18n";
import { Combobox, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxPopup } from "@terno/ui/components/combobox";
import { ChevronRight } from "@terno/ui/icons";
import { Fragment } from "react";
import { create } from "zustand";
import { summariesOffered } from "~/lib/ai";
import { badgeSupported, pageNotificationsSupported } from "~/lib/notify";
import { findSettings, type Found, type Range } from "~/lib/settings-find";
import { StorageSection } from "~/lib/web-parts";
import { useHasUpdates, useUpdates } from "~/lib/updates";
import { useApp } from "~/state/app";
import { openFound } from "./find-open";
import { findEntries, type FindContext, type FindTarget } from "./search-index";
import { DEV_TAB, SETTINGS_TABS } from "./tabs";

/** The query: outside the component, so a language switch (which remounts the app) keeps it (plan 203). */
export const useSettingsFind = create<{ query: string }>(() => ({ query: "" }));

const ICONS = new Map([...SETTINGS_TABS, DEV_TAB].map((tab) => [tab.value, tab.icon]));

/** Text with its matched words in the foreground's medium weight (no colour: the row's own ink, AA on every fill). */
function Marked({ text, ranges }: { text: string; ranges: readonly Range[] }) {
  if (!ranges.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) parts.push(text.slice(at, a));
    parts.push(
      <mark key={i} className="bg-transparent font-semibold text-foreground">
        {text.slice(a, b)}
      </mark>,
    );
    at = b;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** One result. Base UI clicks the highlighted one on Enter, so its click opens it either way. */
function Result({ found }: { found: Found<FindTarget> }) {
  const { entry, reason } = found;
  const Icon = ICONS.get(entry.data.tab);
  return (
    // named by all it says (axe's label-in-name: a name of the setting alone left its visible placement out); the
    // hidden commas make it read as phrases
    <ComboboxItem value={found} data-testid="settings-find-result" data-setting-id={entry.data.id} onClick={() => openFound(entry.data)}>
      {Icon && <Icon aria-hidden className="mt-0.5 size-4 text-muted-foreground" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium" data-testid="settings-find-name">
          <Marked text={entry.name} ranges={found.name} />
        </span>
        <span className="sr-only">, </span>
        <span className="flex min-w-0 items-center gap-0.5 text-xs text-muted-foreground" data-testid="settings-find-where">
          {entry.place.map((crumb, i) => (
            <Fragment key={i}>
              {i > 0 && <ChevronRight aria-hidden className="size-3" />}
              {/* a screen reader hears the path as words, not as glyphs */}
              {i > 0 && <span className="sr-only">, </span>}
              <span className="truncate first:shrink-0">
                <Marked text={crumb.text} ranges={found.place[i] ?? []} />
              </span>
            </Fragment>
          ))}
        </span>
        {reason && (
          <>
            <span className="sr-only">, </span>
            <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground" data-testid="settings-find-why">
              {reason.kind === "hint" ? <Marked text={reason.text} ranges={reason.ranges} /> : t("settings.find.matches", { word: reason.word })}
            </span>
          </>
        )}
      </span>
    </ComboboxItem>
  );
}

/**
 * Plan 203: Settings' search, at the top of its sidebar. Every setting on every page, found by its name, where it is,
 * its description and related words; each result says where it is and, when it isn't on screen, why it matched.
 * Choosing one opens it (find-open.ts).
 */
export function SettingsSearch() {
  const query = useSettingsFind((s) => s.query);
  const settings = useApp((s) => s.settings);
  const accounts = useApp((s) => s.accounts);
  const categories = useApp((s) => s.categories);
  const devMode = useApp((s) => s.devAi !== null);
  const agents = useApp((s) => s.host?.capabilities.agents ?? true);
  const summaries = useApp(summariesOffered);
  const updater = useHasUpdates();
  const updateState = useUpdates((s) => s.state);
  if (!settings) return null;
  const desktop = !!window.ternoDesktop;
  const ctx: FindContext = {
    settings,
    desktop,
    devMode,
    notifications: desktop || pageNotificationsSupported(),
    badge: desktop || badgeSupported(),
    summaries,
    webStorage: StorageSection !== null,
    agents,
    updater: updater && updateState !== null,
  };
  // nothing is built until something is typed
  const results = query.trim() ? findSettings(findEntries(ctx, accounts, categories), query) : [];
  return (
    <Combobox<Found<FindTarget>>
      value={query}
      onValueChange={(next) => useSettingsFind.setState({ query: next })}
      items={results}
      itemToStringValue={(found) => found.entry.name}
    >
      <ComboboxInput
        aria-label={t("settings.find.label")}
        placeholder={t("settings.find.placeholder")}
        clearLabel={t("settings.find.clear")}
        data-testid="settings-find"
        className="mb-3"
        fieldClassName="h-7"
      />
      <ComboboxPopup aria-label={t("settings.find.results")} className="w-[22rem]" data-testid="settings-find-popup">
        <ComboboxEmpty data-testid="settings-find-none">{query.trim() && t("settings.find.none", { query: query.trim() })}</ComboboxEmpty>
        {results.map((found) => (
          <Result key={found.entry.key} found={found} />
        ))}
      </ComboboxPopup>
    </Combobox>
  );
}
