/**
 * Plan 212: which attachments open in place instead of downloading. The OS picks the app by the file's extension, so the
 * extension decides, never the message's declared type. A closed list of documents: nothing that runs code or could
 * (apps, scripts, macro formats, HTML, SVG), nothing whose default app acts on it (a calendar invite, a contact, mail,
 * an archive), and no video or audio.
 */
import { attachmentFilename } from "./attachments";

const OS_TYPES = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "txt", "csv", "rtf", "docx", "xlsx", "pptx", "pages", "numbers", "key"]);

/**
 * What a browser shows itself, and the type its blob is given. A blob URL shares the app's origin, so the type comes from
 * this list and never from the message: one that said `text/html` or `image/svg+xml` could run script there.
 */
const BROWSER_TYPES: ReadonlyMap<string, string> = new Map([
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
]);

/** the cleaned name's last extension, lowercased; "" when it has none */
function extension(filename: string): string {
  const name = attachmentFilename(filename);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Whether the desktop app hands this file to the OS to open (main checks it again on its own). */
export const opensInPlace = (filename: string): boolean => OS_TYPES.has(extension(filename));

/** The type a browser tab shows this file as, or null when the web build downloads it. */
export const browserPreviewType = (filename: string): string | null => BROWSER_TYPES.get(extension(filename)) ?? null;
