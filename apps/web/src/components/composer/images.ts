import { IMAGE_MAX_WIDTH, schema } from "@terno/richtext";
import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import { closeHistory } from "prosemirror-history";
import { Plugin, PluginKey, Selection, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "prosemirror-view";
import { MAX_ATTACHMENT_BYTES } from "@terno/core";
import { inlineRaster } from "~/lib/cid";
import { markInText, releaseImageUrl } from "~/lib/inline-images";

/**
 * Plan 76: images in the composer's text. A node view shows a placed image
 * (its file, by cid, through the draft's hooks); a dropped one shows at the
 * drop point at once, dimmed, while its bytes are staged (a placeholder that
 * follows the edits around it); a pasted image whose file isn't this draft's
 * doesn't come in.
 */

export interface ImageHooks {
  /** the URL to show an image of this draft's by (null: it can't be shown) */
  url(cid: string): Promise<string | null> | null;
  /** whether this cid is one of the draft's files */
  known(cid: string): boolean;
}

export function imageView(node: PMNode, hooks: () => ImageHooks | undefined): NodeView {
  const dom = document.createElement("img");
  dom.className = "rt-image";
  dom.draggable = true;
  let cid = "";
  const apply = (n: PMNode) => {
    dom.alt = n.attrs.alt as string;
    if (n.attrs.width) dom.width = n.attrs.width as number;
    else dom.removeAttribute("width");
    if (n.attrs.cid === cid) return;
    cid = n.attrs.cid as string;
    markInText(cid);
    const at = cid;
    dom.removeAttribute("src");
    dom.dataset.state = "loading";
    void Promise.resolve(hooks()?.url(at) ?? null).then((url) => {
      if (cid !== at) return;
      if (url) { dom.src = url; delete dom.dataset.state; }
      else dom.dataset.state = "missing";
    });
  };
  apply(node);
  return {
    dom,
    update(n) {
      if (n.type !== schema.nodes.image) return false;
      apply(n);
      return true;
    },
    ignoreMutation: () => true,
    destroy: () => { if (dom.src) releaseImageUrl(dom.src); },
  };
}

/** A paste brings only images that are this draft's own (an image copied from another draft, or a mail, would send nothing). */
export function knownImagesOnly(slice: Slice, known: (cid: string) => boolean): Slice {
  let dropped = false;
  const walk = (f: Fragment): Fragment => {
    const out: PMNode[] = [];
    f.forEach((n) => {
      if (n.type === schema.nodes.image && !known(n.attrs.cid as string)) { dropped = true; return; }
      out.push(n.isLeaf ? n : n.copy(walk(n.content)));
    });
    return Fragment.from(out);
  };
  const content = walk(slice.content);
  return dropped ? new Slice(content, slice.openStart, slice.openEnd) : slice;
}

// ── placeholders: a dropped image at its spot while it is staged

type Pending = { id: string; url: string; width: number | null };
type Meta = { add: { pos: number; images: Pending[] } } | { remove: string[] };
export const placeholderKey = new PluginKey<DecorationSet>("rt-image-placeholders");

export const placeholderPlugin = new Plugin<DecorationSet>({
  key: placeholderKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      set = set.map(tr.mapping, tr.doc);
      const meta = tr.getMeta(placeholderKey) as Meta | undefined;
      if (meta && "add" in meta) {
        // before the caret (what is typed meanwhile goes after them), in the order dropped
        const n = meta.add.images.length;
        set = set.add(tr.doc, meta.add.images.map((p, i) => Decoration.widget(meta.add.pos, () => placeholderDom(p), { id: p.id, side: i - n, ignoreSelection: true, key: p.id })));
      } else if (meta && "remove" in meta) {
        set = set.remove(set.find(undefined, undefined, (spec) => meta.remove.includes(spec.id as string)));
      }
      return set;
    },
  },
  props: { decorations: (state) => placeholderKey.getState(state) },
});

function placeholderDom(p: Pending): HTMLElement {
  const img = document.createElement("img");
  img.className = "rt-image";
  img.dataset.state = "adding";
  img.dataset.testid = "compose-image-adding";
  img.src = p.url;
  img.alt = "";
  if (p.width) img.width = p.width;
  return img;
}

export function addPlaceholders(view: EditorView, pos: number, images: Pending[]): void {
  view.dispatch(view.state.tr.setMeta(placeholderKey, { add: { pos, images } } satisfies Meta).setMeta("addToHistory", false));
}

const placeholderAt = (state: EditorState, id: string): number | null => {
  const found = placeholderKey.getState(state)?.find(undefined, undefined, (spec) => spec.id === id);
  return found?.length ? found[0]!.from : null;
};

/** The staged images in their placeholders' place (one undo step); a placeholder whose spot is gone puts its image at the end. */
export function placeImages(view: EditorView, placed: { id: string; node: PMNode }[]): void {
  let tr: Transaction = view.state.tr;
  for (const { id, node } of placed) {
    const at = placeholderAt(view.state, id);
    tr = tr.insert(at === null ? Selection.atEnd(tr.doc).from : tr.mapping.map(at), node);
  }
  tr.setMeta(placeholderKey, { remove: placed.map((p) => p.id) } satisfies Meta);
  // its own undo step: ⌘Z takes the images out, nothing typed before or after them
  view.dispatch(closeHistory(tr));
  view.dispatch(closeHistory(view.state.tr));
}

export function dropPlaceholders(view: EditorView, ids: string[]): void {
  if (view.isDestroyed) return;
  view.dispatch(view.state.tr.setMeta(placeholderKey, { remove: ids } satisfies Meta).setMeta("addToHistory", false));
}

/** what our reader shows inline (lib/cid.ts): at most 4 MB, 4096 px a side, 16 million pixels */
const READER_BYTES = 4 * 1024 * 1024;
/** a photo too big for that is scaled down to this on its long side (still sharp at twice the width it is shown at) */
const SCALED_SIDE = 2400;

/**
 * An image as it goes into the text, with the width it is shown at: the
 * file itself when the reader shows it inline, else scaled down (a GIF
 * would lose its motion: it attaches). Null: it attaches as it is.
 */
export function inlineFile(file: File): Promise<{ file: File; width: number } | null> {
  // one image decoded at a time, whatever was dropped (a batch of full-size photos is a lot of memory at once)
  const next = decoding.then(() => (file.size > MAX_ATTACHMENT_BYTES ? null : prepare(file)));
  decoding = next;
  return next;
}
let decoding: Promise<unknown> = Promise.resolve();

async function prepare(file: File): Promise<{ file: File; width: number } | null> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { return null; }
  try {
    const { width, height } = bitmap;
    if (!width || !height) return null;
    if (file.size <= READER_BYTES && inlineRaster(file.type, new Uint8Array(await file.arrayBuffer()))) return { file, width: Math.min(width, IMAGE_MAX_WIDTH) };
    if (file.type === "image/gif" || typeof OffscreenCanvas === "undefined") return null;
    const scale = Math.min(1, SCALED_SIDE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
    let blob = await canvas.convertToBlob({ type: file.type, quality: 0.88 });
    // a big screenshot can stay too heavy as PNG: as JPEG it fits
    if (blob.size > READER_BYTES && file.type === "image/png") blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
    if (blob.size > READER_BYTES) return null;
    const name = blob.type === file.type ? file.name : `${file.name.replace(/\.[^.]*$/, "")}.jpg`;
    return { file: new File([blob], name, { type: blob.type }), width: Math.min(w, IMAGE_MAX_WIDTH) };
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

/** Where an image dropped at these coordinates goes: an inline position (never inside an image). */
export function dropPos(view: EditorView, coords: { x: number; y: number } | null): number {
  const sel = view.state.selection;
  if (!coords) return sel.to;
  const at = view.posAtCoords({ left: coords.x, top: coords.y });
  if (!at) return sel.to;
  const $pos = view.state.doc.resolve(at.pos);
  if ($pos.parent.inlineContent) return at.pos;
  // between blocks: the nearest text position
  const near = view.state.doc.resolve(Math.min(at.pos + 1, view.state.doc.content.size));
  return near.parent.inlineContent ? near.pos : sel.to;
}
