# 124: The privacy policy, and Google's OAuth verification

## Request (verbatim)

> For shipping the desktop app, with the Google sign up. Do we, do I have to ship the, the Google keys with the bundle or how would I do that then? So people can connect the rural accounts? Like, is it safe to do that? Or what is normally done for just about? To not like. Leak the secret keys.

(Answer: a Desktop OAuth client's secret isn't confidential, and plans 99 and 123 already bake it in at build time. What stops the public from connecting is that the consent screen is in Testing. The offer was to draft the verification material.)

> yes and also add the privacy policy information on the apps site, add there anythikg necessary

## What exists

- `terno.app/privacy/` and `/es/privacy/` (plan 97) covered only the website's waitlist, plus one paragraph about the app.
- The home page said "Terno talks to your mail servers and nothing else". That isn't true: website icons (on by default), update checks, Google contact photos, and AI and error reports when chosen all reach other hosts.
- Google sign-in (`packages/mail/src/gmail-api.ts:31`) asks for `openid email profile gmail.modify`, plus `contacts.readonly` and `contacts.other.readonly` for sender photos (`packages/mail/src/google-photos.ts`). Adding a new account asks for all six (`packages/backend/src/handlers.ts:921`).
- The consent screen of the `terno-512816` project is in Testing: at most 100 listed test users, and refresh tokens that expire after 7 days.
- No contact email exists anywhere. LICENSE, TRADEMARKS and README all point to github.com/luisiacc.

## Design

### The privacy page

- One policy for the app and the site. Every statement was checked against the code, and the inventory is below.
- Sections, each with a stable anchor shared by both languages: who we are, your mail stays on your Mac, who the app talks to, **Google user data** (`#google`), AI providers (`#ai`), AI tools on your Mac (MCP), error reports (`#errors`), removing your data, this website, children, changes, contact.
- `#google` is what Google's reviewers look for:
  - each permission and what it's for;
  - that the data stays on the Mac and isn't sold, used for ads, used for profiling or used to train AI;
  - the only transfers, which happen when the user asks (the chosen AI provider, local MCP tools);
  - Google's required Limited Use sentence, word for word, linked to the User Data Policy;
  - how to stop access: remove the account, then revoke at myaccount.google.com/permissions.
- A "Last updated" date and a contents list.
- The copy (`en`, `es`) keeps its marks inline (`**strong**`, `` `code` ``, `[label](href)`), rendered by `parts/rich.tsx`, so a translation moves them with the words. A section is `{ id, title, body[], points?[], after?[] }`.
- The home page's "local" feature now reads "Your mail goes between your Mac and your mail servers, never through ours".

### Inventory the policy rests on

| Flow | When | What goes out |
|---|---|---|
| Mail providers (Gmail REST, IMAP/SMTP) | always | what mail needs |
| Website icons (`icons/fetcher.ts`) | on by default | a request to the sender domain's own site |
| Google contact photos (People API) | the per-account switch | Google OAuth token |
| Remote images | per message, or Always | the sender's server sees the IP |
| Updates (electron-updater, GitHub) | auto by default; checks every 4 h | plain GETs, no identifiers |
| AI (`packages/ai`) | off until a provider is chosen | filter writing: the typed request, the date, account addresses and names, category names. Sorting help (`aiCategorize`, off): sender, subject, the first 600 characters, category names |
| Error reports (Sentry, plan 78) | Ask by default | an allowlisted report, with no mail, addresses or names |
| Unsubscribe | on click | a POST to the sender's URL, or a mail sent through the user's account |
| MCP (`packages/mcp`) | local socket, token file | whatever a connected local tool reads; sending needs `allowAgentSend` (off) |

## Google verification: the material

### Consent screen (Google Auth Platform → Branding)

- App name **Terno**; logo `brand/terno-icon.svg` exported at 120 × 120 px.
- Home page `https://terno.app/`, privacy policy `https://terno.app/privacy/`, authorized domain `terno.app`.
- **Support email and developer contact:** `privacy@terno.app`. Cloudflare Email Routing forwards it, with `support@`, `luis@` and `l@terno.app`, to the maintainer's inbox; the policy's Contact section links to it.
- Terms of service: optional, so left out. LICENSE covers the software.
- Prove you own `terno.app` in Google Search Console with a DNS TXT record in Cloudflare, using the Google account that owns the Cloud project.

### Scope justifications (Data Access)

- **`openid`, `email`, `profile`** (non-sensitive): identify which Google account was connected (its address and name in the account list), and with "Photos from Google" on, show the user's own picture on the mail they send.
- **`https://www.googleapis.com/auth/gmail.modify`** (restricted):
  > Terno is a desktop email client for macOS. Users read, search, send, archive, label, move to trash and mark as read their Gmail messages in Terno. It needs to read messages and history to show and search the mailbox (synced to a local database on the user's Mac), send to send replies and new mail, and modify labels to archive, file in categories, mark read and trash. gmail.readonly can't send or change labels, and gmail.send plus gmail.labels can't read mail. gmail.modify is the narrowest scope that covers a full mail client, and Terno doesn't request https://mail.google.com/ because it never deletes permanently. Gmail data is stored only on the user's device, and Terno has no server that receives it. The one exception is optional and set up by the user: if they choose a cloud AI provider and turn on an AI feature, Terno sends that provider, directly from the device, only what the feature needs. For "help sorting into categories" that is the sender's name and address, the subject and the first 600 characters of a message Terno couldn't sort on its own. AI is off by default, and the privacy policy lists what each feature sends.
- **`https://www.googleapis.com/auth/contacts.readonly`, `.../contacts.other.readonly`** (sensitive):
  > Used only to show the profile photos of the people in the user's message list. Terno reads each contact's email addresses and photo through the People API (`people/me/connections?personFields=emailAddresses,photos`, `otherContacts?readMask=emailAddresses,photos`), so it can match a photo to the sender of a message. Only the address-to-photo list and the images are kept, cached on the user's Mac; no other contact data is read. Terno asks for it only when the user turns on "Photos from Google" in Settings → Appearance (plan 125), and the user can turn it off there.

### Demo video (unlisted YouTube, English, about 3 minutes)

1. Open Terno and choose Add account → Google. Show the browser consent screen with the app name "Terno". Show the address bar long enough for the `client_id` to be readable, and show each permission.
2. **gmail.modify:** the inbox loading; opening and searching a message; replying (show it arriving); archiving, filing in a category, marking read, moving to trash; then the same changes in Gmail on the web.
3. **contacts:** turn on Settings → Appearance → Photos from Google, show Google's consent for contacts, then the sender photos in the list.
4. **openid/email/profile:** the account in Settings → Accounts with its address and name, then your own picture on a message you sent (Photos from Google on).
5. Remove the account, then show Terno is gone from myaccount.google.com/permissions (plan 125 withdraws the grant).

### The security assessment (CASA)

Restricted scopes normally need a yearly third-party assessment. Google's criteria cover restricted data stored on, or passed through, servers: the developer's own servers **and third parties'**. When asked, state the facts:

- Terno is a client-side desktop app with no backend that receives Gmail data (the source is public at github.com/luisiacc/terno).
- The only third parties that can receive it are the cloud AI provider the user chooses, for the AI features they turn on (off by default), and local MCP tools the user connects.

Google may count the AI transfer and require the assessment anyway, so plan time and money for it. One way to avoid it is to keep Gmail-derived content away from cloud AI providers, allowing only local models for Gmail accounts. That would cost a feature, so it's a product decision.

### App changes that would make review smoother (1 and 2 done in plan 125)

1. **Ask for the contacts scopes only when the user turns on photos.** Right now a new account asks for all six (`handlers.ts:921`). Reviewers prefer asking for each permission at the moment it's needed, and the reconnect and switch path already does that (plan 74).
2. **Revoke at Google on Remove account** (`POST https://oauth2.googleapis.com/revoke`), so removing an account also withdraws the grant. Today the policy tells the user to do it by hand.
3. Turning photos off could drop the contacts grant, which today it keeps.

## Tests

`apps/site/src/render.test.ts`:
- the Limited Use sentence and its link, the permissions link and `gmail.modify`, in both languages;
- every in-page link lands on a section, and `es` uses `en`'s anchors;
- no mark is left as literal text;
- every home design links to its language's privacy page.

Screenshots at desktop and phone widths, in English and Spanish (the site's secondary pages are always dark).

## Perf

Static HTML; no script added.

## Out of scope

- The app changes listed above.
- Terms of service.

## What the Codex review changed

Codex reviewed `052b2053` and raised 7 points, all fixed:

1. **Account removal and upgrade backups.** A pre-upgrade backup still holds a removed account until it expires, and it expires at the first open 14 days or more after the upgrade, not on a timer. The policy now says so.
2. **MCP.** The connector always runs, gated by a token file that any program running as the user can read; nothing authorizes it per app. The policy now describes that boundary instead of "only apps you set it up in".
3. **AI in the verification material.** The gmail.modify justification and the CASA section claimed Gmail data never leaves the device. Both now disclose the optional transfer to the user's chosen AI provider, and that Google's assessment criteria include third-party servers.
4. **Error reports** also carry coded breadcrumbs (views, dialogs), the locale and the kind of Mac; the policy lists them.
5. **Update checks can't be turned off**, only automatic downloads. The connections list no longer says every item is user-controlled.
6. **Contacts.** Terno reads `emailAddresses,photos` to match photos to senders. The scope justification and the policy say so.
7. **Own picture.** It is shown on the user's own messages, not in Settings → Accounts. The justification and the demo script were corrected.

Points 2 and 5 are honest descriptions of the current app. Opt-in MCP and a way to turn update checks off would be app changes.
