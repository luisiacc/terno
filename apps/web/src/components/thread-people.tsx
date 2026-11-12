import type { MessageDetail, ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Chip } from "@terno/ui/components/chip";
import { cn } from "@terno/ui/lib/utils";
import { useMemo, useState } from "react";
import { autoRecipients, identitiesIn } from "~/lib/compose-fields";
import { threadPeople } from "~/lib/thread-overview";
import { fullName, PersonMenu } from "./person-menu";
import { SenderAvatar } from "./sender-avatar";

/** past this many, the rest wait behind a "+N" that shows them (and folds them back) */
const SHOWN = 6;

/**
 * Plan 177: who's on a conversation of two or more messages, under its subject: a chip each (their avatar and first name),
 * without the user. Each chip opens that person's menu (plan 180). `icons` and `personOf` are the reader's avatar rules
 * (plans 22, 158), read at render (a thread turning spam drops the icons at once), applied to the newest message each one
 * wrote; someone only written to is shown as a person.
 */
export function ThreadPeople({ detail, myEmails, icons, personOf, className }: { detail: ThreadDetail; myEmails: readonly string[]; icons: boolean; personOf: (m: MessageDetail) => boolean; className?: string }) {
  const { messages } = detail;
  const mineKey = myEmails.join("\n");
  const { everyone, replyGoesTo } = useMemo(() => {
    if (messages.length < 2) return { everyone: [], replyGoesTo: null };
    const mine = identitiesIn(detail, myEmails);
    // plan 180: "Reply to X only" isn't offered for the one person a plain Reply already goes to alone (Reply-To counted)
    const { to, cc } = autoRecipients("reply", detail, mine);
    return { everyone: threadPeople(messages, mine), replyGoesTo: to.length === 1 && cc.length === 0 ? to[0]!.email.toLowerCase() : null };
  }, [messages, mineKey]);
  const [all, setAll] = useState(false);
  // plan 194: one other person is a one-to-one conversation, whose headers already say who (each message's ⋯ has what
  // their chip's menu offered)
  if (everyone.length < 2) return null;
  const shown = all ? everyone : everyone.slice(0, SHOWN);
  return (
    <ul aria-label={t("reader.people")} data-testid="thread-people" className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {shown.map((p) => (
        <li key={p.email} className="flex max-w-full min-w-0">
          <PersonMenu person={p} detail={detail} offerReplyOnly={p.email.toLowerCase() !== replyGoesTo}>
            <Chip
              dot={<SenderAvatar name={p.name} email={p.email} icon={icons} person={!p.lastSent || personOf(p.lastSent)} className="size-5 text-2xs" />}
              className="max-w-48 ps-0.5 font-normal transition-colors duration-fast group-hover/person:bg-accent group-data-[popup-open]/person:bg-accent"
            >
              <span aria-hidden>{p.short}</span>
              <span className="sr-only">{fullName(p)}</span>
            </Chip>
          </PersonMenu>
        </li>
      ))}
      {/* one toggle, there while open too: focus stays on it when it shows the rest, and it folds them back */}
      {everyone.length > SHOWN && (
        <li className="flex">
          <Button variant="link-secondary" size="xs" data-testid="thread-people-more" aria-expanded={all} aria-label={all ? t("reader.showFewer") : t("reader.showPeople", { count: everyone.length - SHOWN })} onClick={() => setAll(!all)} className="px-1 font-normal tabular">
            {all ? t("reader.showFewer") : t("reader.morePeople", { count: everyone.length - SHOWN })}
          </Button>
        </li>
      )}
    </ul>
  );
}
