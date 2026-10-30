import { t } from "@terno/i18n";
import { cn } from "@terno/ui/lib/utils";
import { ImagePlus, Paperclip } from "lucide-react";
import { useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { attachFilesInTurn } from "~/lib/attachments";
import { isInlineImage } from "~/lib/inline-images";
import { controllerFor } from "./composer/controller";

/**
 * Plan 76: files dragged into a composer. While a file is dragged anywhere
 * in the window an open composer says it takes files; over it, it lights up
 * and says what a drop does: over the text, images go where the pointer is
 * (a caret shows the spot) and anything else attaches; elsewhere everything
 * attaches. A file dropped outside a composer is refused (it never navigates
 * the app away, and the draft with it).
 */

/** what a drag carries, as far as the browser tells before the drop (a file's type can be unknown until then) */
export interface DragFiles { images: number; others: number; unknown: number }

/** a drag that started in the page (an image in the text being moved carries "Files" too): never a file coming in */
let pageDrag = false;
export const draggingInPage = (): boolean => pageDrag;

export function dragFiles(data: DataTransfer | null): DragFiles | null {
  if (pageDrag || !data || !Array.from(data.types).includes("Files")) return null;
  const out: DragFiles = { images: 0, others: 0, unknown: 0 };
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    if (!item.type) out.unknown++;
    else if (isInlineImage(item)) out.images++;
    else out.others++;
  }
  // some browsers list no items while dragging: one file of unknown type
  if (!out.images && !out.others && !out.unknown) out.unknown = 1;
  return out;
}

export type DropZone = { text: boolean; files: DragFiles; blocked: boolean };

/** What the pill says for a drag over the composer. */
export function dropLabel(z: DropZone): { label: string; hint?: string; inline: boolean } {
  if (z.blocked) return { label: t("compose.drop.blocked"), inline: false };
  const { images, others, unknown } = z.files;
  if (z.text && images && !others && !unknown) return { label: t(images === 1 ? "compose.drop.inlineOne" : "compose.drop.inlineMany"), inline: true };
  if (z.text && images) return { label: t("compose.drop.inlineMixed"), inline: true };
  if (z.text && unknown) return { label: t("compose.drop.add"), inline: true };
  return { label: t("compose.drop.attach"), hint: images || unknown ? t("compose.drop.inlineHint") : undefined, inline: false };
}

// ── a file dragged anywhere in the window (one listener set, installed with the first composer)

let windowDepth = 0;
let windowDrag = false;
const listeners = new Set<() => void>();
const setWindowDrag = (on: boolean) => {
  if (on === windowDrag) return;
  windowDrag = on;
  for (const l of listeners) l();
};
let installed = false;
function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const hasFiles = (e: globalThis.DragEvent) => !pageDrag && Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const reset = () => { windowDepth = 0; setWindowDrag(false); };
  window.addEventListener("dragstart", () => { pageDrag = true; }, true);
  window.addEventListener("dragend", () => { pageDrag = false; }, true);
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    windowDepth++;
    setWindowDrag(true);
  });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    // leaving the window (no element under the pointer) ends it whatever the count says
    if (--windowDepth <= 0 || e.relatedTarget === null && (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight)) reset();
  });
  // outside a composer a file has nowhere to go: refused, so the browser doesn't open it in place of the app
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  });
  window.addEventListener("drop", (e) => {
    if (hasFiles(e)) e.preventDefault();
    pageDrag = false;
    reset();
  });
  window.addEventListener("dragend", reset);
}
const subscribe = (l: () => void) => {
  install();
  listeners.add(l);
  return () => listeners.delete(l);
};
const useWindowDrag = () => useSyncExternalStore(subscribe, () => windowDrag, () => false);

/**
 * The composer form's drop target: its handlers, and the layer that shows
 * the drag (render it inside the form, which must be `relative`).
 */
export function useComposerDrop(draftKey: string, blocked: boolean) {
  const anywhere = useWindowDrag();
  const [zone, setZone] = useState<DropZone | null>(null);
  const depth = useRef(0);
  const frame = useRef(0);
  const last = useRef<{ x: number; y: number } | null>(null);

  const caret = (coords: { x: number; y: number } | null) => {
    last.current = coords;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      controllerFor(draftKey)?.dropCaret(last.current);
    });
  };
  const clear = () => {
    depth.current = 0;
    caret(null);
    setZone(null);
  };
  const track = (e: DragEvent<HTMLElement>) => {
    const files = dragFiles(e.dataTransfer);
    if (!files) return false;
    e.preventDefault();
    const text = !blocked && (e.target as Element).closest?.("[data-testid=compose-body]") !== null;
    e.dataTransfer.dropEffect = blocked ? "none" : "copy";
    setZone((z) => (z && z.text === text && z.blocked === blocked && z.files.images === files.images && z.files.others === files.others && z.files.unknown === files.unknown ? z : { text, files, blocked }));
    caret(text && (files.images || files.unknown) ? { x: e.clientX, y: e.clientY } : null);
    return true;
  };

  const handlers = {
    onDragEnter: (e: DragEvent<HTMLElement>) => { if (track(e)) depth.current++; },
    onDragOver: (e: DragEvent<HTMLElement>) => { track(e); },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!dragFiles(e.dataTransfer)) return;
      if (--depth.current <= 0) clear();
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      clear();
      // the text took them (images at the pointer, ProseMirror's handler), or it isn't a file drop
      if (e.defaultPrevented || !files.length) return;
      e.preventDefault();
      if (blocked) return;
      void attachFilesInTurn(draftKey, files);
    },
  };

  const layer = zone || anywhere ? <DropLayer zone={zone} /> : null;
  return { handlers, layer };
}

function DropLayer({ zone }: { zone: DropZone | null }) {
  const what = zone ? dropLabel(zone) : null;
  const Icon = what?.inline ? ImagePlus : Paperclip;
  return (
    <div aria-hidden="true" data-testid="compose-drop" data-state={!zone ? "available" : zone.blocked ? "blocked" : zone.text ? "text" : "attach"} className="pointer-events-none absolute inset-0 z-20 rounded-[inherit]">
      <div className={cn("absolute inset-0 rounded-[inherit] ring-inset", !zone ? "ring-1 ring-primary/30" : zone.blocked ? "ring-1 ring-border" : "bg-primary/[0.04] ring-2 ring-primary/55")} />
      <div className="absolute inset-x-0 top-2 flex justify-center px-3">
        <div className={cn("flex max-w-full items-center gap-2 rounded-full bg-popover px-3 py-1.5 text-xs shadow-md ring-1 ring-border", zone && !zone.blocked ? "text-foreground" : "text-muted-foreground")} data-testid="compose-drop-label">
          <Icon className={cn("size-3.5 shrink-0", zone && !zone.blocked && "text-primary")} />
          <span className="truncate font-medium">{what ? what.label : t("compose.drop.available")}</span>
          {what?.hint && <span className="truncate text-muted-foreground">{what.hint}</span>}
        </div>
      </div>
    </div>
  );
}
