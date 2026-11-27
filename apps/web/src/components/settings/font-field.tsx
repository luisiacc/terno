import { isLocalFamily, localFont, type FontId, type StyleFont } from "@terno/core";
import type { AppSettings } from "@terno/core/rpc";
import { Button } from "@terno/ui/components/button";
import { ComboboxPicker, ComboboxPickerEmpty, ComboboxPickerInput, ComboboxPickerItem, ComboboxPickerPopup } from "@terno/ui/components/combobox-picker";
import { designById, fontPaint, withFont, type DesignDefinition } from "@terno/ui/designs/index";
import { Undo2 } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { setStyleFont, styleFont } from "~/lib/appearance";
import { fontItem, fontItems, fontName, matchFonts, type FontItem } from "~/lib/fonts";
import { installedFamilies } from "~/lib/local-fonts";
import type { RowA11y } from "./parts";

const ROW_H = 32;

/**
 * Settings → Appearance → Font (plan 248): the font the style in use draws in. A field showing it; opened, every font
 * (Terno's, then the computer's), each in its own face. Typing finds; Enter or a click keeps it for this style, and only
 * then does the app change (the owner found a look on every highlight jumpy); Esc or leaving keeps the font in use. Under
 * it, while the style has another font, a button back to the style's own.
 */
export function FontField({ settings, a }: { settings: AppSettings; a: RowA11y }) {
  const design = designById(settings.design);
  const own = design.fonts.typeface as StyleFont;
  const chosen = styleFont(settings, design);
  const current = fontItem(chosen ?? own);
  /** the computer's families: undefined until read, null when it can't list them */
  const [families, setFamilies] = useState<readonly string[] | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(current.name);
  /** the field has been typed in since it opened: only then does it filter */
  const [typed, setTyped] = useState(false);
  /** open now (a highlight can come before React has the open state) */
  const isOpen = useRef(false);
  /** the list's scroll box, as state: Base UI mounts the popup after this renders, and its arrival must draw the rows */
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  /** the row to bring into view once the scroll box is there: the font in use, on opening */
  const anchor = useRef<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const all = useMemo(() => fontItems(families ?? null), [families]);
  const shown = useMemo(() => {
    if (!typed) return all;
    const found = matchFonts(all, query);
    // no list to look in (a browser without one, or a refusal): the typed name itself, drawn in its face like any other
    const name = query.trim();
    if (!families && isLocalFamily(name) && !found.some((f) => f.name.toLowerCase() === name.toLowerCase())) found.push({ font: localFont(name), name, kind: "typed" });
    return found;
  }, [all, families, query, typed]);

  /** the computer's families, read once (the field's focus starts it, so a click finds them there) */
  const load = (): Promise<readonly string[] | null> =>
    families !== undefined
      ? Promise.resolve(families)
      : installedFamilies().then((list) => {
          setFamilies(list);
          return list;
        });
  /** counts openings: a list that arrives after the field was closed again opens nothing */
  const opening = useRef(0);

  const virtualizer = useVirtualizer({ count: shown.length, getScrollElement: () => scroller, estimateSize: () => ROW_H, overscan: 6 });

  useEffect(() => {
    if (!scroller || anchor.current === null) return;
    virtualizer.scrollToIndex(anchor.current, { align: "center" });
    anchor.current = null;
  }, [scroller, virtualizer]);

  const onOpenChange = (next: boolean, details: { reason: string }) => {
    const seq = ++opening.current;
    if (!next) {
      isOpen.current = false;
      setOpen(false);
      return;
    }
    // opened by typing in the closed field: what's typed is the query (Codex code review #3)
    const byTyping = details.reason === "input-change";
    if (!byTyping) {
      setTyped(false);
      setQuery(current.name);
      // opened by a click in the field it already had focus in: typing still replaces the name
      requestAnimationFrame(() => input.current?.select());
    }
    // the first opening waits for the computer's list (tens of ms here; a browser may ask), so the list opens on the font
    // in use, highlighted, and the arrows go on from it (Codex code review #4)
    void load().then((list) => {
      if (seq !== opening.current) return;
      isOpen.current = true;
      setOpen(true);
      const at = fontItems(list).findIndex((f) => f.font === current.font);
      anchor.current = !byTyping && at >= 0 ? at : null;
    });
  };

  // the field first, the way back under it (owner, 2026-11-26), its icon on the field's text line
  return (
    <div className="flex w-56 flex-col items-start gap-1">
      <ComboboxPicker<FontItem>
        items={all}
        filteredItems={shown}
        virtualized
        value={current}
        isItemEqualToValue={(x, y) => x.font === y.font}
        itemToStringLabel={(item) => item.name}
        open={open}
        onOpenChange={onOpenChange}
        // closed, the field shows the font in use; open, what's typed (the font's name until then)
        inputValue={open ? query : current.name}
        onInputValueChange={(value, details) => {
          setQuery(value);
          if (details.reason === "input-change") setTyped(true);
        }}
        onValueChange={(item, details) => {
          if (!item) {
            // Esc in the closed field would clear it: the font stays, and the Esc goes on to close Settings (Codex code review #2)
            details.cancel();
            if (details.reason === "escape-key") details.allowPropagation();
            return;
          }
          void setStyleFont(design.id, item.font);
          // the field keeps focus with the chosen name selected: typing again starts a new search
          requestAnimationFrame(() => input.current?.select());
        }}
        onItemHighlighted={(item, details) => {
          // the keyboard's and typing's highlight are brought into view (Enter clicks a drawn row: Codex code review #1);
          // a highlight change as the list closes has no list to scroll
          if (item && isOpen.current && details.reason !== "pointer") virtualizer.scrollToIndex(details.index);
        }}
      >
        <ComboboxPickerInput ref={input} {...a} onFocus={() => void load()} className="w-56" spellCheck={false} autoComplete="off" data-testid="font-field" />
        <ComboboxPickerPopup ref={setScroller} aria-label={t("settings.appearance.font.list")} className="w-(--anchor-width)" data-testid="font-list">
          <ComboboxPickerEmpty>{typed && query.trim() && families ? t("settings.appearance.font.none", { name: query.trim() }) : null}</ComboboxPickerEmpty>
          <div style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const item = shown[row.index]!;
              return (
                <ComboboxPickerItem key={item.font} index={row.index} value={item} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${row.start}px)` }} data-testid="font-option" data-font-option={item.font}>
                  <FontName design={design} item={item} />
                  <span className="ml-auto shrink-0 ps-3 text-xs text-muted-foreground">
                    {item.font === own ? t("settings.appearance.font.own") : item.kind === "builtIn" ? t("settings.appearance.font.builtIn") : item.kind === "typed" ? t("settings.appearance.font.ifInstalled") : null}
                  </span>
                </ComboboxPickerItem>
              );
            })}
          </div>
        </ComboboxPickerPopup>
      </ComboboxPicker>
      {chosen && (
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void setStyleFont(design.id, null)} data-testid="font-reset">
          <Undo2 aria-hidden /> {t("settings.appearance.font.reset", { font: fontName(design.fonts.typeface as FontId) })}
        </Button>
      )}
    </div>
  );
}

/** A font's name in its own face, inside the style's design (its sizes; the font's features). */
function FontName({ design, item }: { design: DesignDefinition; item: FontItem }) {
  const paint = fontPaint(withFont(design, item.font));
  return (
    <span data-design={design.id} {...paint} className="min-w-0 truncate font-sans">
      {item.kind === "typed" ? t("settings.appearance.font.use", { name: item.name }) : item.name}
    </span>
  );
}
