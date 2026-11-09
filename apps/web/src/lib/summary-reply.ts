import { reply } from "~/lib/keyboard";

/**
 * Plan 162 (after ai162-r03): a summary item's Reply is the conversation's ordinary reply, as R is (a reply ready here is
 * what it opens, as R's). After ai162-r01 it put the item in ⌘J as the instruction; on real models a question item is
 * the other person's question ("Share your thoughts on the option"), so Write drafted a reply with no stance.
 */
export function replyFromItem(): void {
  reply("reply");
}
