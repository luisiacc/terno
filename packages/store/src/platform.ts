/** What the backend needs from its host that differs between Node and the browser. */
export interface Platform {
  /** a globally unique id (op ids, RFC Message-IDs, the owner's user id) */
  uuid(): string;
  /** yields to the event loop (macrotask) so interactive work interleaves with background slices */
  yield(): Promise<void>;
  /** private files beside the database (the search snapshot); absent where there is no file system */
  files?: PlatformFiles;
}

/** Whole-file access for caches that can always be rebuilt: never the source of truth. */
export interface PlatformFiles {
  /** the file's bytes, or null if it doesn't exist */
  read(path: string): Promise<Uint8Array | null>;
  /** replaces the file atomically (readers see the old or the new bytes, never a mix); a crash may lose it, so readers verify */
  replace(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}
