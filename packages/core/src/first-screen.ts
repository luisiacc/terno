/**
 * Plan 207: the screen the app opens on, and with it the one number the sidebar and the Dock show. Unset (never asked)
 * is the Inbox; What matters leads only while it's shown (AI can run, its row isn't hidden), and the choice waits for it.
 */
export type FirstScreen = "inbox" | "whatMatters";

export const leadScreen = (firstScreen: FirstScreen | null | undefined, whatMattersShown: boolean): FirstScreen =>
  firstScreen === "whatMatters" && whatMattersShown ? "whatMatters" : "inbox";
