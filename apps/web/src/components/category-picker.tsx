import { CATEGORY_COLORS, normalizeText, type CategoryColor } from "@unica/core";
import { CategoryDot } from "@unica/ui/components/category-dot";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@unica/ui/components/command";
import { Dialog, DialogContent, DialogTitle } from "@unica/ui/components/dialog";
import { Check, Plus } from "lucide-react";
import { useState } from "react";
import { addToCategory, removeFromCategory } from "~/lib/categorize";
import { client } from "~/rpc/connection";
import { getApp, setApp, useApp } from "~/state/app";
import { useList } from "~/state/list";

/** "l": toggle categories on the selected/checked threads; adding one offers the snackbar's bulk actions. */
export function CategoryPicker() {
  const open = useApp((s) => s.dialog === "categoryPicker");
  const categories = useApp((s) => s.categories);
  const [search, setSearch] = useState("");
  const s = getApp();
  const targets = s.checked.size ? [...s.checked] : s.selectedId !== null ? [s.selectedId] : [];
  const rows = useList.getState();
  const current = new Set(targets.flatMap((id) => rows.items[rows.index.get(id) ?? -1]?.categoryIds ?? []));
  const close = () => {
    setSearch("");
    setApp({ dialog: null });
  };

  const apply = async (categoryId: number, on: boolean) => {
    close();
    if (on) await addToCategory(categoryId, targets, { source: "picker" });
    else await removeFromCategory(categoryId, targets);
  };

  const create = async () => {
    const name = search.trim();
    if (!name) return;
    const c = await client.call("categories.create", { name, color: CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length]! });
    setApp({ categories: [...getApp().categories.filter((x) => x.id !== c.id), c] });
    await apply(c.id, true);
  };

  const exact = categories.some((c) => normalizeText(c.name) === normalizeText(search.trim()));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="top-[20%] translate-y-0 overflow-hidden p-0 sm:max-w-sm" showCloseButton={false} data-testid="category-picker">
        <DialogTitle className="sr-only">Categorías</DialogTitle>
        <Command>
          <CommandInput placeholder="Categoría…" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>Sin coincidencias</CommandEmpty>
            <CommandGroup>
              {categories.map((c) => (
                <CommandItem key={c.id} value={c.name} onSelect={() => apply(c.id, !current.has(c.id))} data-testid={`pick-category-${c.id}`}>
                  <CategoryDot color={c.color as CategoryColor} />
                  {c.name}
                  {current.has(c.id) && <Check className="ml-auto size-4 text-primary" />}
                </CommandItem>
              ))}
              {search.trim() && !exact && (
                <CommandItem value={`__create ${search}`} onSelect={create} data-testid="create-category">
                  <Plus className="size-4" /> Crear «{search.trim()}»
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
