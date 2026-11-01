import type { AccountSyncState } from "@terno/core";

export interface StatusAuthority {
  generation: number;
  live(): boolean;
}
export interface StatusFailure {
  message: string;
  i18n?: AccountSyncState["lastErrorI18n"];
}

/** One account-stamp authority survives provider replacement and orders every status write. */
export class AccountStatus {
  private state: AccountSyncState;
  private auth: { failure: StatusFailure; scope: "send" | null } | undefined;
  private policy: { failure: StatusFailure; generation: number } | undefined;
  private run: symbol | undefined;
  private constraint: { failure: StatusFailure; active(): boolean } | undefined;
  private revision = 0;
  private persisted: string;
  private visible: string;
  private writing: Promise<void> | undefined;
  private recovery = 0;
  private refusal = 0;

  constructor(private readonly options: {
    initial: AccountSyncState;
    generation(): number;
    write(state: AccountSyncState): Promise<void>;
    changed(): void;
    admissionChanged?(): void;
  }) {
    this.state = { ...options.initial };
    if (this.state.authRequired) this.auth = { scope: this.state.authScope ?? null, failure: { message: this.state.lastError ?? "", i18n: this.state.lastErrorI18n } };
    this.persisted = JSON.stringify(this.project());
    this.visible = this.persisted;
  }

  private current(authority: StatusAuthority): boolean {
    return authority.live() && authority.generation === this.options.generation();
  }

  get signInRequired(): boolean { return this.auth?.scope === null; }
  holds(kind: string): boolean { return !!this.auth && (this.auth.scope === null || kind === "send"); }
  get policyPaused(): boolean { return this.policy?.generation === this.options.generation(); }
  get policyRevision(): number { return this.recovery; }

  project(): AccountSyncState {
    const state = { ...this.state, ...(this.auth ? { authRequired: true, authScope: this.auth.scope } : {}) };
    const failure = this.signInRequired ? this.auth!.failure : this.policyPaused ? this.policy!.failure : this.constraint?.active() ? this.constraint.failure : this.auth?.failure;
    if (failure) return { ...state, ...(this.auth?.scope !== "send" || this.policyPaused || this.constraint?.active() ? { status: "error" as const, connection: null } : {}), lastError: failure.message, lastErrorI18n: failure.i18n ?? null };
    return state;
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
    if ((this.auth || this.policyPaused) && outcome.lastSyncAt !== undefined) outcome.lastSyncAt = this.state.lastSyncAt;
    this.state = { ...this.state, ...outcome };
    if (end) {
      this.run = undefined;
      if (!this.auth && !this.policyPaused && !this.constraint?.active() && outcome.status === "idle") { this.state.authRequired = false; this.state.authScope = null; }
    }
    return this.publish();
  }

  refuse(authority: StatusAuthority, failure: StatusFailure, scope: "send" | null = null): Promise<void> {
    if (!this.current(authority)) return Promise.resolve();
    if (!this.signInRequired || scope === null) { this.auth = { failure, scope }; this.refusal++; }
    return this.publish(true);
  }

  forbid(authority: StatusAuthority, revision: number, failure: StatusFailure): Promise<void> {
    if (!this.current(authority) || revision !== this.recovery) return Promise.resolve();
    this.policy = { generation: authority.generation, failure };
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

  recoveryProof(authority: StatusAuthority): () => Promise<void> {
    const refusal = this.refusal;
    return () => refusal === this.refusal ? this.verified(authority) : Promise.resolve();
  }

  verified(authority: StatusAuthority): Promise<void> {
    if (!this.current(authority)) return Promise.resolve();
    this.auth = undefined;
    this.policy = undefined;
    this.recovery++;
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
      // Start after assigning writing, so a synchronous publisher cannot start a second writer.
      const writing = Promise.resolve().then(async () => {
        for (;;) {
          const revision = this.revision, state = this.project(), encoded = JSON.stringify(state);
          if (encoded !== this.persisted) { await this.options.write(state); this.persisted = encoded; }
          if (revision === this.revision) return;
        }
      });
      this.writing = writing;
      void writing.then(() => { if (this.writing === writing) this.writing = undefined; }, () => { if (this.writing === writing) this.writing = undefined; });
    }
    return this.writing;
  }

  flush(): Promise<void> { return this.writing ?? Promise.resolve(); }
}
