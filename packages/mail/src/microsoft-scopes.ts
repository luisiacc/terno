// Plan 259: what Outlook asks Microsoft for and how a grant is read. Portable: the backend checks a sign-in's grant
// on every host, and the sign-in itself (microsoft.ts) is the desktop's.

/** Delegated, none needing an administrator's consent, all available to personal accounts (plan 259). */
export const MICROSOFT_SCOPES = ["openid", "email", "profile", "offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"];

/** The documented tenant id of personal Microsoft accounts (outlook.com, hotmail.com, live.com). */
export const CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

const GRAPH_RESOURCE = "https://graph.microsoft.com/";
/** Microsoft names a granted scope bare (`Mail.Send`) or by its resource (`https://graph.microsoft.com/mail.send`), in any case. */
const scopeName = (scope: string) => {
  const lower = scope.toLowerCase();
  return lower.startsWith(GRAPH_RESOURCE) ? lower.slice(GRAPH_RESOURCE.length) : lower;
};

/** Whether a grant lets Terno read, change and send mail: what an Outlook account can't work without. */
export function microsoftMailGranted(scopes: readonly string[]): boolean {
  const names = new Set(scopes.map(scopeName));
  return names.has("mail.readwrite") && names.has("mail.send");
}
