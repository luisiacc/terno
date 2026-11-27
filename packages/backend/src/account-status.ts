import type { AccountSyncState } from "@terno/core";
import { keychainRefusal } from "./keychain";

export interface StatusAuthority {
  generation: number;
  live(): boolean;
}
export interface StatusFailure {
  message: string;
  i18n?: AccountSyncState["lastErrorI18n"];
  /** plan 293: a saved secret that wouldn't open, and why (the message alone can't tell: it's one for every cause) */
  secretFailure?: "keychain" | "legacy" | null;
}

/** One account-stamp authority survives provider replacement and orders every status write. */
export class AccountStatus {
  private state: AccountSyncState;
  private whole: { failure: StatusFailure; scope: null; source: "account" | "incoming" } | undefined;
  private send: { failure: StatusFailure; scope: "send" } | undefined;
  private get auth() { return this.whole ?? this.send; }
  private policy: { failure: StatusFailure } | undefined;
  private run: symbol | undefined;
  private constraint: { failure: StatusFailure; active(): boolean } | undefined;
  private revision = 0;
  private persisted: string;
  private visible: string;
  private writing: Promise<void> | undefined;
  private recovery = 0;
  private refusal = 0;
  /** plan 293: a secret failure's flag was stored: clearing it must be written (the store merges a patch) */
  private secretStored: boolean;

  constructor(private readonly options: {
    initial: AccountSyncState;
    generation(): number;
    write(state: AccountSyncState): Promise<void>;
    changed(): void;
    admissionChanged?(): void;
    failed?(): void;
  }) {
    this.state = { ...options.initial };
    this.secretStored = !!options.initial.lastErrorSecret;
    if (this.state.status === "syncing") this.state = { ...this.state, status: this.state.lastError ? "error" : "idle", progress: null };
    if (this.state.authRequired) {
      const failure = { message: this.state.lastError ?? "", i18n: this.state.lastErrorI18n, secretFailure: this.state.lastErrorSecret };
      if (this.state.authScope === "send") this.send = { scope: "send", failure };
      else this.whole = { scope: null, source: "account", failure };
    }
    this.persisted = JSON.stringify(this.project());
    this.visible = this.persisted;
  }

  private current(authority: StatusAuthority): boolean {
    return authority.live() && authority.generation === this.options.generation();
  }

  get signInRequired(): boolean { return this.auth?.scope === null; }
  /** What lifts a whole-account refusal besides a sign-in: IMAP accepting its own refusal again, else IMAP and SMTP. */
  get recheck(): "incoming" | "account" | null { return this.whole?.source ?? null; }
  /** the whole-account refusal's catalog key */
  get refusalKey(): string | undefined { return this.whole?.failure.i18n?.key; }
  /** plan 264: the whole-account refusal is our keychain's, rechecked locally (plan 293: by its flag, not its message) */
  get keychainRefused(): boolean { return keychainRefusal(this.whole?.failure); }
  holds(kind: string): boolean { return !!this.auth && (this.auth.scope === null || kind === "send"); }
  get policyPaused(): boolean { return this.policy !== undefined; }
  get policyRevision(): number { return this.recovery; }

  project(): AccountSyncState {
    const { lastErrorSecret: _secret, ...rest } = this.state;
    const state = { ...rest, ...(this.auth ? { authRequired: true, authScope: this.auth.scope } : {}) };
    const failure = this.signInRequired ? this.auth!.failure : this.policyPaused ? this.policy!.failure : this.constraint?.active() ? this.constraint.failure : this.auth?.failure;
    const secret = failure?.secretFailure ?? null;
    if (secret) this.secretStored = true;
    const flag = secret || this.secretStored ? { lastErrorSecret: secret } : {};
    if (failure) return { ...state, ...(this.auth?.scope !== "send" || this.policyPaused || this.constraint?.active() ? { status: "error" as const, connection: null } : {}), lastError: failure.message, lastErrorI18n: failure.i18n ?? null, ...flag };
    return { ...state, ...flag };
  }

  begin(authority: StatusAuthority) {
    const run = Symbol();
    if (this.current(authority)) this.run = run;
    return {
      update: (patch: Partial<AccountSyncState>) => this.update(authority, run, patch),
      end: (patch: Partial<AccountSyncState>) => this.update(authority, run, patch, true),
    };
  }

  private update(authority: StatusAuthority, run: symbol, patch: Partial<AccountSyncState>, end = false): Promise<void> {
    if (!this.current(authority) || this.run !== run) return Promise.resolve();
    // Run outcomes never prove that a refused credential or a policy hold recovered.
    const { authRequired: _required, authScope: _scope, ...outcome } = patch;
    if ((this.signInRequired || this.policyPaused || this.constraint?.active()) && outcome.lastSyncAt !== undefined) outcome.lastSyncAt = this.state.lastSyncAt;
    if (outcome.progress === null && this.state.progress === undefined) delete outcome.progress;
    this.state = { ...this.state, ...outcome };
    if (end) {
      this.run = undefined;
      if (!this.auth && !this.policyPaused && !this.constraint?.active() && outcome.status === "idle") { this.state.authRequired = false; this.state.authScope = null; }
    }
    return this.publish();
  }

  refuse(authority: StatusAuthority, failure: StatusFailure, scope: "send" | null = null, source: "account" | "incoming" = "account"): Promise<void> {
    if (!this.current(authority)) return Promise.resolve();
    // plan 264: our keychain failing to open a secret never hides the server's refusal of the same credentials (the
    // keychain's is lifted by opening the secret again; the server's only by a sign-in)
    if (scope === null && keychainRefusal(failure) && this.whole && !keychainRefusal(this.whole.failure)) return Promise.resolve();
    if (scope === "send") this.send = { failure, scope };
    else this.whole = { failure, scope, source };
    this.refusal++;
    return this.publish(true);
  }

  forbid(authority: StatusAuthority, revision: number, failure: StatusFailure): Promise<void> {
    if (!this.current(authority) || revision !== this.recovery) return Promise.resolve();
    this.policy = { failure };
    return this.publish(true);
  }

  constrain(authority: StatusAuthority, failure: StatusFailure, active: () => boolean): Promise<void> {
    if (!this.current(authority)) return Promise.resolve();
    this.constraint = { failure, active };
    return this.publish();
  }

  recoverPolicy(): boolean {
    if (this.auth) return false;
    this.recovery++;
    this.policy = undefined;
    this.options.admissionChanged?.();
    return true;
  }

  recoveryProof(authority: StatusAuthority, scope: "account" | "incoming" = "account"): () => Promise<void> {
    const refusal = this.refusal;
    return () => refusal === this.refusal ? this.verified(authority, scope) : Promise.resolve();
  }

  /**
   * Plan 264: a refusal our own keychain made, lifted once the secret opens: only that refusal (captured before the
   * read: a newer one, or another key, stays), never a policy pause or a send refusal beside it.
   */
  localRecoveryProof(authority: StatusAuthority): () => Promise<void> {
    const refusal = this.refusal, failure = this.whole?.failure;
    return () => {
      if (!this.current(authority) || refusal !== this.refusal || !keychainRefusal(failure) || this.whole?.failure !== failure) return Promise.resolve();
      this.whole = undefined;
      this.run = undefined;
      this.state = { ...this.state, status: "idle", lastError: null, lastErrorI18n: null, authRequired: false, authScope: null, connection: null };
      return this.publish(true);
    };
  }

  verified(authority: StatusAuthority, scope: "account" | "incoming" = "account"): Promise<void> {
    if (!this.current(authority)) return Promise.resolve();
    if (scope === "incoming") {
      // A durable whole-account refusal has unknown protocol coverage: IMAP alone cannot prove SMTP.
      if (this.whole?.source !== "incoming") return Promise.resolve();
      this.whole = undefined;
    } else {
      this.whole = undefined;
      this.send = undefined;
      this.policy = undefined;
      this.recovery++;
    }
    this.run = undefined;
    this.state = { ...this.state, status: "idle", lastError: null, lastErrorI18n: null, authRequired: false, authScope: null, connection: null };
    return this.publish(true);
  }

  network(authority: Pick<StatusAuthority, "live">, patch: Pick<AccountSyncState, "status" | "lastError" | "lastErrorI18n" | "connection">): Promise<void> {
    if (!authority.live()) return Promise.resolve();
    this.state = { ...this.state, ...patch };
    return this.publish();
  }

  private publish(admission = false): Promise<void> {
    if (admission) this.options.admissionChanged?.();
    const encoded = JSON.stringify(this.project());
    if (!this.writing && encoded === this.persisted) return Promise.resolve();
    this.revision++;
    if (encoded !== this.visible) { this.visible = encoded; this.options.changed(); }
    if (!this.writing) {
      let resolve!: () => void, reject!: (error: unknown) => void;
      const writing = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
      this.writing = writing;
      // Background facts keep transport classification independent of status persistence failure.
      void writing.catch(() => {});
      void Promise.resolve().then(async () => {
        try {
          for (;;) {
            const revision = this.revision, state = this.project(), encoded = JSON.stringify(state);
            if (encoded !== this.persisted) { await this.options.write(state); this.persisted = encoded; }
            if (revision === this.revision) break;
          }
          this.writing = undefined;
          resolve();
        } catch (error) {
          this.writing = undefined;
          this.options.failed?.();
          reject(error);
        }
      });
    }
    return this.writing;
  }

  flush(): Promise<void> { return this.writing ?? this.publish(); }
}
