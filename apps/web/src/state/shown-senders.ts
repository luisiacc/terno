import { addressKey, type ShownSender } from "@terno/core";
import { create } from "zustand";
import { client } from "~/rpc/connection";

/**
 * Plan 240: the senders always shown in What matters, for every sender's menu. Read the first time a menu asks (never before
 * What matters is used), then kept by the backend's `shownSenders`, which every window hears.
 */
export const useShownSenders = create<{ senders: ShownSender[] | null }>(() => ({ senders: null }));

let reading: Promise<void> | null = null;

/** Once, unless it failed (then the next menu asks again). */
export function readShownSenders(): Promise<void> {
  reading ??= client.call("today.shownSenders", {}).then(
    ({ senders }) => useShownSenders.setState({ senders }),
    () => {
      reading = null;
    },
  );
  return reading;
}

/** At boot, once there's a connection to listen on. */
export function installShownSenders(): void {
  client.on("shownSenders", ({ senders }) => useShownSenders.setState({ senders }));
}

/** Whether this address (any spelling of it) is shown; unknown until read, which the first ask starts. */
export function useIsShown(email: string): boolean {
  const senders = useShownSenders((s) => s.senders);
  if (senders === null) void readShownSenders();
  const key = addressKey(email);
  return senders?.some((s) => s.key === key) ?? false;
}
