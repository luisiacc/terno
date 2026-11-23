import { isLocalFamily, localFont, type FontId, type StyleFont } from "@terno/core";
import type { AppSettings } from "@terno/core/rpc";
import { Button } from "@terno/ui/components/button";
import { ComboboxPicker, ComboboxPickerEmpty, ComboboxPickerInput, ComboboxPickerItem, ComboboxPickerPopup } from "@terno/ui/components/combobox-picker";
import { designById, fontPaint, withFont, type DesignDefinition } from "@terno/ui/designs/index";
import { Undo2 } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { previewStyleFont, setStyleFont, styleFont } from "~/lib/appearance";
import { fontItem, fontItems, fontName, matchFonts, type FontItem } from "~/lib/fonts";
import { installedFamilies } from "~/lib/local-fonts";
import type { RowA11y } from "./parts";

const ROW_H = 32;

/**
 * Settings → Appearance → Font (plan 248): the font the style in use draws in. A field showing it; opened, every font
 * (Terno's, then the computer's), each in its own face. Typing finds; what's highlighted shows on the whole app at once,
 * unsaved; Enter or a click keeps it for this style; Esc or leaving puts the saved one back. Beside it, while the style
 * has another font, a button back to the style's own.
 */
export function FontField({ settings, a }: { settings: AppSettings; a: RowA11y }) {
  const design = designById(settings.design);
  const own = design.fonts.typeface as StyleFont;
  const chosen = styleFont(settings, design);
  const current = fontItem(chosen ?? own);
  const [families, setFamilies] = useState<readonly string[] | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(current.name);
  /** the field has been typed in since it opened: only then does it filter */
  const [typed, setTyped] = useState(false);
  /** a choice was made: closing keeps what it shows */
  const picked = useRef(false);
  /** open now (a highlight can come before React has the open state) */
  const isOpen = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const all = useMemo(() => fontItems(families), [families]);
  const shown = useMemo(() => {
    if (!typed) return all;
    const found = matchFonts(all, query);
    // no list to look in (a browser without one, or a refusal): the typed name itself, previewed like any other
    const name = query.trim();
    if (families === null && isLocalFamily(name) && !found.some((f) => f.name.toLowerCase() === name.toLowerCase())) found.push({ font: localFont(name), name, kind: "typed" });
    return found;
  }, [all, families, query, typed]);

  // Settings closing (or the tab changing) with a look still on puts the saved font back (Codex critique #6)
  useEffect(() => () => previewStyleFont(undefined), []);

  const virtualizer = useVirtualizer({ count: shown.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 6 });

  const onOpenChange = (next: boolean) => {
    isOpen.current = next;
    setOpen(next);
    if (next) {
      picked.current = false;
      setTyped(false);
      setQuery(current.name);
      // opened by a click in the field it already had focus in: typing still replaces the name
      requestAnimationFrame(() => input.current?.select());
      void installedFamilies().then(setFamilies);
      // opened on the font in use, so the arrows go on from it
      const at = all.findIndex((f) => f.font === current.font);
      requestAnimationFrame(() => at >= 0 && virtualizer.scrollToIndex(at, { align: "center" }));
    } else if (!picked.current) previewStyleFont(undefined);
  };

  return (
    <div className="flex items-center gap-1.5">
      {chosen && (
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void setStyleFont(design.id, null)} data-testid="font-reset">
          <Undo2 aria-hidden /> {t("settings.appearance.font.reset", { font: fontName(design.fonts.typeface as FontId) })}
        </Button>
      )}
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
        onValueChange={(item) => {
          if (!item) return;
          picked.current = true;
          void setStyleFont(design.id, item.font);
        }}
        onItemHighlighted={(item, details) => {
          // a highlight change as the list closes (after a choice, or Esc) is no look of the user's
          if (!isOpen.current || picked.current) return;
          // what's highlighted shows on the whole app, unsaved; nothing highlighted shows the saved font
          previewStyleFont(item ? item.font : undefined);
          if (item && details.reason === "keyboard") virtualizer.scrollToIndex(details.index);
        }}
      >
        <ComboboxPickerInput ref={input} {...a} className="w-56" spellCheck={false} autoComplete="off" data-testid="font-field" />
        <ComboboxPickerPopup ref={scroller} aria-label={t("settings.appearance.font.list")} className="w-(--anchor-width)" data-testid="font-list">
          <ComboboxPickerEmpty>{typed && query.trim() && families !== null ? t("settings.appearance.font.none", { name: query.trim() }) : null}</ComboboxPickerEmpty>
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
