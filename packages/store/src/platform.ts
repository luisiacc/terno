/** What the backend needs from its host that differs between Node and the browser. */
export interface Platform {
  /** a globally unique id (op ids, RFC Message-IDs, the owner's user id) */
  uuid(): string;
  /** yields to the event loop (macrotask) so interactive work interleaves with background slices */
  yield(): Promise<void>;
}
