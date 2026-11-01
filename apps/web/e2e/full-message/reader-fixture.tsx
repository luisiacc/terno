import { Reader } from "../../src/components/reader";
import { useApp } from "../../src/state/app";
import { useThreads } from "../../src/state/threads";
import { TooltipProvider } from "@terno/ui/components/tooltip";

export function prepareReaderFixture(html: string) {
  const detail = {
    thread: { id: 1, accountId: 1, subject: "Synthetic complete message", snippet: "First", lastDate: 1700000000000, messageCount: 1, unread: false, starred: false, categoryIds: [], fromName: "Synthetic", fromEmail: "sender@example.invalid", hasAttachments: false, inInbox: true, inTrash: false, inSpam: false },
    messages: [{ id: 1, threadId: 1, accountId: 1, from: { name: "Synthetic", email: "sender@example.invalid" }, to: [], cc: [], bcc: [], replyTo: [], subject: "Synthetic complete message", date: 1700000000000, snippet: "First", bodyHtml: html, bodyText: null, bodyState: "full" as const, attachments: [], hasAttachments: false, isRead: true, isStarred: false, isSent: false, isDraft: false, inInbox: true, isTrash: false, isSpam: false, size: html.length, rfcMessageId: "synthetic@example.invalid", inReplyTo: null, references: [], listId: null }],
  };
  // This fixture seeds renderer cache only; no backend/store/worker is started.
  useThreads.setState({ details: new Map([[1, detail]]) });
  useApp.setState({ selectedId: 1, readerOpen: true });
}

export function ReaderFixture() {
  return <TooltipProvider><Reader /></TooltipProvider>;
}
