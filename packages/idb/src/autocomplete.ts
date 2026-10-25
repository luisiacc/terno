import { addressesOf, SENT_SIZE_MAX, SENT_TEXT_MAX, type ContactMessage, type SentText } from "@terno/store";
import type { R } from "./mail";

/** A message row (SQL-shaped, in memory) as autocomplete's headers (plan 18). */
export function contactOf(m: R): ContactMessage {
  return {
    id: m.id as number,
    accountId: m.account_id as number,
    date: m.date as number,
    sent: m.is_sent === 1,
    spam: m.is_spam === 1,
    draft: m.is_draft === 1,
    from: { name: (m.from_name as string) ?? "", email: (m.from_email as string) ?? "" },
    to: addressesOf(m.to_json as string),
    cc: addressesOf(m.cc_json as string),
    bcc: addressesOf(m.bcc_json as string),
    hasBody: m.body_state !== "none",
  };
}

/** Sent mail eligible for the phrase model: written by the user, not spam or a draft. */
export const isLearnable = (m: R): boolean => m.is_sent === 1 && m.is_spam !== 1 && m.is_draft !== 1 && m.body_state !== "none" && ((m.size as number) ?? 0) <= SENT_SIZE_MAX;

export function sentOf(m: R, body: string): SentText {
  return { id: m.id as number, accountId: m.account_id as number, date: m.date as number, fromName: (m.from_name as string) ?? "", to: addressesOf(m.to_json as string), text: body.length > SENT_TEXT_MAX ? body.slice(0, SENT_TEXT_MAX) : body };
}
