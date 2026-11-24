/**
 * Plan 252: how a website's icon sits in its avatar, measured once from its pixels. A circle, or a
 * square whose mark sits inside the circle, fills the disc; anything else is a mark on the plate. The
 * content box trims a favicon's own transparent padding, so either way the icon is drawn by what it shows.
 */
export interface IconFit {
  /** drawn edge to edge, cropped to the disc */
  fill: boolean;
  /** a filled icon whose edge is near white or near black: a hairline keeps it off a card of its color */
  ring: boolean;
  /** the content box, as fractions of the image drawn `contain` into a square */
  box: readonly [x: number, y: number, w: number, h: number];
}

export const WHOLE: IconFit = { fill: false, ring: false, box: [0, 0, 1, 1] };

/** the measuring square: enough to tell a crop from a mark, cheap to read */
export const FIT_PX = 48;
const SEEN = 32;
const SOLID = 128;

/** The fit of an n × n RGBA image (drawn `contain`, transparent around it). */
export function classify(rgba: ArrayLike<number>, n: number): IconFit {
  const a = (x: number, y: number) => rgba[(y * n + x) * 4 + 3]!;
  let [x0, y0, x1, y1] = [n, n, -1, -1];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (a(x, y) > SEEN) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  if (x1 < 0) return WHOLE;
  const [bw, bh] = [x1 - x0 + 1, y1 - y0 + 1];
  const box = [x0 / n, y0 / n, bw / n, bh / n] as const;
  const mark: IconFit = { fill: false, ring: false, box };
  // a crop needs something round or square, and big enough to judge
  if (Math.abs(bw - bh) > Math.max(2, 0.08 * Math.max(bw, bh)) || Math.min(bw, bh) < 12) return mark;

  // the background a crop would show at its edge: the commonest solid color on the box's border
  const counts = new Map<number, number>();
  const at = (x: number, y: number) => (y * n + x) * 4;
  const border = (x: number, y: number) => {
    const i = at(x, y);
    if (rgba[i + 3]! < SOLID) return;
    const key = ((rgba[i]! >> 4) << 8) | ((rgba[i + 1]! >> 4) << 4) | (rgba[i + 2]! >> 4);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let x = x0; x <= x1; x++) {
    border(x, y0);
    border(x, y1);
  }
  for (let y = y0 + 1; y < y1; y++) {
    border(x0, y);
    border(x1, y);
  }

  const cx = x0 + bw / 2;
  const cy = y0 + bh / 2;
  const r = Math.min(bw, bh) / 2;
  let [insideA, inside, cut, lost] = [0, 0, 0, 0];
  let [edgeR, edgeG, edgeB, edge] = [0, 0, 0, 0];
  const bg = counts.size ? [...counts].reduce((m, c) => (c[1] > m[1] ? c : m))[0] : -1;
  const bgRgb = [((bg >> 8) & 15) * 16 + 8, ((bg >> 4) & 15) * 16 + 8, (bg & 15) * 16 + 8];
  const differs = (i: number, rgb: ArrayLike<number>, j = 0) => Math.abs(rgba[i]! - rgb[j]!) + Math.abs(rgba[i + 1]! - rgb[j + 1]!) + Math.abs(rgba[i + 2]! - rgb[j + 2]!) > 64;
  /** the first solid pixel walking from the nearer edge of its row (or column) toward (x, y): the tile's edge there */
  const edgeOf = (x: number, y: number, across: boolean) => {
    const [from, to] = across ? (x - x0 < x1 - x ? [x0, x] : [x1, x]) : y - y0 < y1 - y ? [y0, y] : [y1, y];
    for (let v = from; v !== to; v += Math.sign(to - from)) {
      const j = across ? at(v, y) : at(x, v);
      if (rgba[j + 3]! >= SOLID) return j;
    }
    return -1;
  };
  /**
   * Drawn, not background: unlike the tile's commonest border color and unlike the tile's edge beside it (along
   * its row and its column), so a gradient's corner reads as background and a mark in a corner doesn't.
   */
  const drawnHere = (i: number, x: number, y: number) => {
    if (bg >= 0 && !differs(i, bgRgb)) return false;
    for (const j of [edgeOf(x, y, true), edgeOf(x, y, false)]) if (j >= 0 && !differs(i, rgba, j)) return false;
    return true;
  };
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
      const i = at(x, y);
      const alpha = rgba[i + 3]!;
      if (d <= 0.92) {
        insideA += alpha;
        inside++;
      }
      // just inside the crop's edge: the color the disc's edge will have
      if (d > 0.8 && d <= 0.95 && alpha >= SOLID) {
        edgeR += rgba[i]!;
        edgeG += rgba[i + 1]!;
        edgeB += rgba[i + 2]!;
        edge++;
      }
      if (d > 1) {
        cut++;
        if (alpha >= SOLID && drawnHere(i, x, y)) lost++;
      }
    }
  // solid inside the circle, and a crop loses nothing but background
  if (insideA / (inside * 255) < 0.97 || (cut > 0 && lost / cut > 0.04)) return mark;
  const luma = edge ? (0.2126 * edgeR + 0.7152 * edgeG + 0.0722 * edgeB) / (edge * 255) : 0.5;
  return { fill: true, ring: luma > 0.86 || luma < 0.14, box };
}

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;

/** The fit of an icon's `data:` URL; the whole image as a mark when it can't be measured (no DOM, a bad image). */
export async function measureIcon(url: string): Promise<IconFit> {
  if (typeof Image === "undefined" || typeof document === "undefined" || typeof document.createElement !== "function") return WHOLE;
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const [w, h] = [img.naturalWidth || FIT_PX, img.naturalHeight || FIT_PX];
    if (!ctx) {
      canvas = document.createElement("canvas");
      canvas.width = canvas.height = FIT_PX;
      ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return WHOLE;
    }
    const s = FIT_PX / Math.max(w, h);
    ctx.clearRect(0, 0, FIT_PX, FIT_PX);
    ctx.drawImage(img, (FIT_PX - w * s) / 2, (FIT_PX - h * s) / 2, w * s, h * s);
    return classify(ctx.getImageData(0, 0, FIT_PX, FIT_PX).data, FIT_PX);
  } catch {
    return WHOLE;
  }
}
