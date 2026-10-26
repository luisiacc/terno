import type { ImapLocation, ImapLocationStore, ProviderStore } from "@terno/store";
import { getSetting, T, type Ctx, type R } from "./mail";

type Command = <V>(fn: () => V) => Promise<V>;

/** One account's provider-side reads and IMAP identity (the SQL adapter's SqlProviderStore, on the in-memory tables). */
export class IdbProviderStore implements ProviderStore {
  readonly locations: ImapLocationStore;

  constructor(
    private readonly c: Ctx,
    private readonly accountId: number,
    command: Command,
    private readonly read: Command,
  ) {
    this.locations = new IdbImapLocations(c, accountId, command, read);
  }

  messageByProviderId(providerMsgId: string) {
    return this.read(() => {
      const r = T(this.c, "messages").by("provider", this.accountId, providerMsgId)[0];
      return r ? { id: r.id as number, subject: r.subject as string, fromEmail: r.from_email as string } : null;
    });
  }

  syncedMessages() {
    return this.read(() =>
      T(this.c, "messages")
        .by("fk_account_id", this.accountId)
        .filter((m) => m.provider_msg_id !== null && !String(m.provider_msg_id).startsWith("local:"))
        .map((m) => ({ id: m.id as number, providerMsgId: m.provider_msg_id as string, date: m.date as number })),
    );
  }

  pendingAttachmentBodies(limit: number) {
    return this.read(() => T(this.c, "messages").by("attachment_pending", this.accountId, 1)
      .filter((m) => m.provider_msg_id != null && !String(m.provider_msg_id).startsWith("local:"))
      .slice(0, Math.max(0, Math.min(50, limit))).map((m) => ({ id: m.id as number, providerMsgId: m.provider_msg_id as string })));
  }

  pendingBodies(limit: number) {
    return this.read(() => {
      const locations = T(this.c, "message_locations");
      return T(this.c, "messages")
        .by("fk_account_id", this.accountId)
        .filter((m) => m.body_state !== "full" || !m.attachments_captured)
        .sort((x, y) => y.date - x.date || y.id - x.id)
        .flatMap((m) => {
          const l = locations.by("fk_message_id", m.id).sort((x, y) => (x.mailbox < y.mailbox ? -1 : 1))[0];
          return l ? [{ id: m.id as number, mailbox: l.mailbox as string, uid: l.uid as number, uidvalidity: l.uidvalidity as number }] : [];
        })
        .slice(0, limit);
    });
  }

  countPendingBodies() {
    return this.read(() => T(this.c, "messages").by("fk_account_id", this.accountId).filter((m) => m.body_state !== "full" || !m.attachments_captured).length);
  }

  providerIds(messageIds: readonly number[]) {
    return this.read(() => {
      const out = new Map<number, string | null>();
      const messages = T(this.c, "messages");
      for (const id of messageIds) {
        const m = messages.get(id);
        if (m) out.set(id, m.provider_msg_id as string | null);
      }
      return out;
    });
  }

  setting<V>(key: string): Promise<V | null> {
    return this.read(() => getSetting<V | null>(this.c, key, null));
  }
}

class IdbImapLocations implements ImapLocationStore {
  constructor(
    private readonly c: Ctx,
    private readonly accountId: number,
    private readonly command: Command,
    private readonly read: Command,
  ) {}

  private get t() {
    return T(this.c, "message_locations");
  }

  upsert(messageId: number, mailbox: string, uidvalidity: number, uid: number, flags: string[]) {
    return this.command(() => void this.t.put({ message_id: messageId, account_id: this.accountId, mailbox, uidvalidity, uid, flags: JSON.stringify(flags) }));
  }

  remove(messageId: number, mailbox: string) {
    return this.command(() => void this.t.delete(messageId, mailbox));
  }

  setFlags(messageId: number, mailbox: string, flags: string) {
    return this.command(() => {
      const r = this.t.get(messageId, mailbox);
      if (r) this.t.update(r, { flags });
    });
  }

  of(messageIds: readonly number[]): Promise<ImapLocation[]> {
    return this.read(() => messageIds.flatMap((id) => this.t.by("fk_message_id", id).map((r) => ({ message_id: r.message_id, mailbox: r.mailbox, uid: r.uid, uidvalidity: r.uidvalidity, flags: r.flags }) as ImapLocation)));
  }

  at(mailbox: string, uidvalidity: number, uid: number) {
    return this.read(() => (this.t.by("uid", this.accountId, mailbox, uidvalidity, uid)[0]?.message_id as number | undefined) ?? null);
  }

  get(messageId: number, mailbox: string) {
    return this.read(() => {
      const r = this.t.get(messageId, mailbox);
      return r ? { uid: r.uid as number, uidvalidity: r.uidvalidity as number, flags: r.flags as string } : null;
    });
  }

  count(messageId: number) {
    return this.read(() => this.t.count("fk_message_id", messageId));
  }

  inMailbox(mailbox: string, uidvalidity: number) {
    return this.read(() =>
      this.t
        .by("mailbox", this.accountId, mailbox)
        .filter((r) => r.uidvalidity === uidvalidity)
        .map((r) => ({ message_id: r.message_id as number, uid: r.uid as number, flags: r.flags as string })),
    );
  }

  resetMailbox(mailbox: string) {
    return this.command(() => {
      const rows: R[] = this.t.by("mailbox", this.accountId, mailbox);
      for (const r of rows) this.t.deleteRow(r);
      return rows.map((r) => r.message_id as number);
    });
  }

  resetCandidate(c: { candidates: readonly number[]; subject: string; fromEmail: string; date: number; size: number; mailbox: string }) {
    return this.read(() => {
      const messages = T(this.c, "messages");
      const hit = [...c.candidates]
        .sort((x, y) => x - y)
        .map((id) => messages.get(id))
        .find((m) => m && m.account_id === this.accountId && m.rfc_message_id === null && m.subject === c.subject && m.from_email === c.fromEmail && m.date === c.date && m.size === c.size && !this.t.has(m.id, c.mailbox));
      return hit ? { id: hit.id as number } : null;
    });
  }
}
