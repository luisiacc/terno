import type { Platform, PlatformFiles } from "@terno/store";

/**
 * A macrotask yield without setTimeout's 4 ms clamp (nested timers in a
 * worker are clamped like on a page): one MessageChannel, resolved in order.
 */
function channelYield(): () => Promise<void> {
  const channel = new MessageChannel();
  const waiting: (() => void)[] = [];
  channel.port1.onmessage = () => waiting.shift()?.();
  return () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
      channel.port2.postMessage(0);
    });
}

const notFound = (e: unknown) => e instanceof DOMException && (e.name === "NotFoundError" || e.name === "TypeMismatchError");

/**
 * Caches beside the database (the instant index's snapshot) as OPFS files,
 * in their own directory (the sahpool VFS owns its directory). Replacing goes
 * through createWritable(), which writes a swap file and swaps it in on
 * close: readers see the old or the new bytes, never a mix.
 */
export async function opfsFiles(dirName = "unica-files"): Promise<PlatformFiles> {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(dirName, { create: true });
  const name = (path: string) => path.replace(/^\/+/, "").replace(/[/\\]/g, "_");
  return {
    async read(path) {
      try {
        const file = await (await dir.getFileHandle(name(path))).getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async replace(path, bytes) {
      const writable = await (await dir.getFileHandle(name(path), { create: true })).createWritable();
      try {
        await writable.write(bytes as Uint8Array<ArrayBuffer>);
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => {});
        throw error;
      }
    },
    async remove(path) {
      await dir.removeEntry(name(path)).catch((error) => {
        if (!notFound(error)) throw error;
      });
    },
  };
}

export function webPlatform(files: PlatformFiles | undefined): Platform {
  return { uuid: () => crypto.randomUUID(), yield: channelYield(), files };
}
