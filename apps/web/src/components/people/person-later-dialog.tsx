import { laterWindow, taskOf } from "~/lib/dated";
import { laterFromPersonPicker } from "~/lib/people";
import { setApp } from "~/state/app";
import { usePeople } from "~/state/people";
import { LaterDialog } from "../today-later-dialog";

/**
 * Plan 281 (owner, after the QA panel): Later's "Pick a date…" on a person's page or card: What matters' own picker, in the
 * item's window (a reply owed to you, or a promise of yours: anywhere ahead).
 */
export function PersonLaterDialog() {
  const pick = usePeople((s) => s.laterPick);
  const item = pick?.item ?? null;
  const task = item?.kind === "today" ? taskOf(item.item.why, Date.now(), item.item.thread) : null;
  const span = !item ? null : item.kind === "awaiting" ? { before: null, limit: null } : task && laterWindow(task);
  const close = () => {
    usePeople.setState({ laterPick: null });
    setApp({ dialog: null });
  };
  return <LaterDialog span={span ?? null} testId="person-later-dialog" testPrefix="person-later" close={close} onSet={(at) => pick && laterFromPersonPicker(pick, at)} />;
}
