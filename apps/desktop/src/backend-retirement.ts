import { BACKEND_GRACE_MS } from "./shutdown";

export interface OwnedUtility {
  once(event: "exit", listener: () => void): unknown;
  kill(): boolean;
}

/** A kill request is not exit. The owner must retain this generation until exited. */
export class BackendRetirement {
  retiring = false;
  exited = false;
  private observed: Promise<void>;
  private result: Promise<boolean> | null = null;

  constructor(private child: OwnedUtility) {
    this.observed = new Promise((resolve) => child.once("exit", () => {
      this.exited = true;
      resolve();
    }));
  }

  retire(): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    if (this.result) return this.result;
    this.retiring = true;
    this.result = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), BACKEND_GRACE_MS);
      void this.observed.then(() => { clearTimeout(timer); resolve(true); });
      try { this.child.kill(); } catch { /* Ownership survives failed signalling. */ }
    });
    return this.result;
  }
}
