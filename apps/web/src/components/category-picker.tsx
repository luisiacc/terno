import { CATEGORY_COLORS, normalizeText, type CategoryColor } from "@unica/core";
import { CategoryDot } from "@unica/ui/components/category-dot";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@unica/ui/components/command";
import { Dialog, DialogContent, DialogTitle } from "@unica/ui/components/dialog";
import { Check, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { addScopeToCategory, addToCategory, isExclusivelyIn, moveToCategory, removeFromCategory } from "~/lib/categorize";
import { currentTargets } from "~/lib/select";
import { client } from "~/rpc/connection";
import { getApp, setApp, useApp } from "~/state/app";
import { useList } from "~/state/list";

/** Creates a category (the next palette color) and adds it to the sidebar right away. */
export async function createCategory(name: string): Promise<number> {
  const categories = getApp().categories;
  const c = await client.call("categories.create", { name, color: CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length]! });
  setApp({ categories: [...getApp().categories.filter((x) => x.id !== c.id), c] });
  return c.id;
}

/**
 * "l": toggle categories on the selection (adding one offers the snackbar's
 * bulk actions). "v" / "Mover a…": move the selection to one category,
 * exclusively, like a drop. On a "select all N" scope, toggling adds the
 * whole scope (moves stay per thread).
 */
export function CategoryPicker() {
  const open = useApp((s) => s.dialog === "categoryPicker");
  const mode = useApp((s) => s.pickerMode);
  const categories = useApp((s) => s.categories);
  const [search, setSearch] = useState("");
  const t = currentTargets();
  const targets = "ids" in t ? t.ids : [];
  const rows = useList.getState();
  const current = new Set(targets.flatMap((id) => rows.items[rows.index.get(id) ?? -1]?.categoryIds ?? []));
  const close = () => {
    setSearch("");
    // a move is asked for each time (v, "Mover a…"): whatever opens the picker next toggles unless it says otherwise
    setApp({ dialog: null, pickerMode: "toggle" });
  };

  const apply = async (categoryId: number, on: boolean) => {
    close();
    if ("scope" in t) {
      if (mode === "move") toast("Para mover, selecciona conversaciones de la lista (hasta 5 000)");
      else await addScopeToCategory(categoryId, t.scope);
      return;
    }
    if (mode === "move") await moveToCategory(categoryId, targets, { source: "picker" });
    else if (on) await addToCategory(categoryId, targets, { source: "picker" });
    else await removeFromCategory(categoryId, targets);
  };

  const create = async () => {
    const name = search.trim();
    if (!name) return;
    await apply(await createCategory(name), true);
  };

  const exact = categories.some((c) => normalizeText(c.name) === normalizeText(search.trim()));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="top-[20%] translate-y-0 overflow-hidden p-0 sm:max-w-sm" showCloseButton={false} data-testid="category-picker" data-mode={mode}>
        <DialogTitle className="sr-only">{mode === "move" ? "Mover a" : "Categorías"}</DialogTitle>
        <Command>
          <CommandInput placeholder={mode === "move" ? "Mover a…" : "Categoría…"} value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>Sin coincidencias</CommandEmpty>
            <CommandGroup>
              {categories.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.name}
                  disabled={mode === "move" && targets.length > 0 && isExclusivelyIn(c.id, targets)}
                  onSelect={() => apply(c.id, !current.has(c.id))}
                  data-testid={`pick-category-${c.id}`}
                >
                  <CategoryDot color={c.color as CategoryColor} />
                  {c.name}
                  {current.has(c.id) && <Check className="ml-auto size-4 text-primary" />}
                </CommandItem>
              ))}
              {search.trim() && !exact && (
                <CommandItem value={`__create ${search}`} onSelect={create} data-testid="create-category">
                  <Plus className="size-4" /> {mode === "move" ? `Crear «${search.trim()}» y mover` : `Crear «${search.trim()}»`}
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
