/** The site's copy (plan 97), English (the source language). `es.ts` must match this shape: the type check says so. */
export const en = {
  lang: "en",
  meta: {
    title: "Terno: instant, private email for Mac",
    description:
      "Terno is a fast, keyboard-first email client for Mac. Every account in one inbox. Instant search. Fully local, no account needed. Terno Pro adds AI that drafts your replies and powers “What matters”: one view of only what needs you.",
  },
  skip: "Skip to content",
  nav: { features: "Features", pro: "Pro", privacy: "Privacy", source: "Source", download: "Download", language: "Español", languageHref: "/es/", languageMenu: "Language", sourceOnGithub: "Source code on GitHub", home: "Terno home" },
  hero: {
    title: "The last email client you’ll try.",
    subtitle: "Every account in one inbox. Instant search. Archive one email, and every similar one is archived too. Fully local, no account needed.",
    note: "Free · macOS on Apple silicon",
  },
  download: {
    mac: "Download for Mac",
    macSub: "Apple silicon",
    other: "Windows & Linux",
    otherSub: "Join the waitlist",
  },
  /**
   * “What matters” (plan 224): the feed of what needs you (plan 210), Terno Pro's lead (it runs on AI). Quoted
   * mid-sentence, bare as a name (the owner's rule).
   */
  whatMatters: {
    eyebrow: "What matters",
    title: "Hundreds of emails. A handful need you.",
    body: "“What matters” is a view that reads your email as it arrives and lists only what needs you: the bill due Friday, the client waiting on your answer, the call you said you’d make. One plain sentence each, with when. Your Inbox keeps everything else.",
    benefits: {
      tasks: {
        title: "One plain line each.",
        body: "“Review Joaquín’s draft.” “You said you’d call Emma.” “Javier wrote to you about the payments API.” Each line says what it is and when. Open it, and the email is right there.",
      },
      urgent: {
        title: "The urgent stays on top.",
        body: "What you missed comes first, then what’s due today and who’s waiting on your answer, then the week ahead. The most pressing thing is always the first line.",
      },
      promises: {
        title: "Your promises, kept.",
        body: "Write “I’ll send it Tuesday” in a reply, and it’s on the list for Tuesday, so what you said you’d do doesn’t slip your mind.",
      },
      quiet: {
        title: "The rest stays quiet.",
        body: "Newsletters and routine automated mail fold into one row at the end, and a bill that’s already paid or pays itself gets no line at all.",
      },
    },
    done: "Press D when something’s done, and it moves down to Earlier. When nothing’s left, it tells you: “You’re free until 3:00 PM.”",
    foot: "Make it the screen Terno opens on, or leave an account out of it.",
  },
  features: {
    unified: {
      title: "Every account. One inbox.",
      body: "Gmail, Outlook and any IMAP/SMTP account: one list. Every row shows which account it’s for, so you never reply from the wrong one.",
      points: ["Gmail, Outlook, any IMAP/SMTP", "Unlimited accounts", "Categories across all of them"],
    },
    local: {
      title: "No account. No cloud. Just your Mac.",
      body: "Your mail syncs between your Mac and your mail servers, never through ours. Your mail, contacts and search index live on your Mac.",
      points: ["Private from the first launch", "Remote images only when you ask", "Zero tracking"],
    },
    search: {
      title: "Instant search.",
      body: "Every message, every account, every folder, archive included. Results as you type.",
      points: ["By person, subject or attachment", "Decades of mail, no wait", "Works offline"],
    },
    speed: {
      title: "Nothing waits.",
      body: "Every action lands the moment you press the key. The server catches up in the background.",
      points: ["Opens in under a second", "Light on memory and battery", "Silent when idle"],
    },
    triage: {
      title: "File one. Clear them all.",
      body: "Archive one promotion and Terno offers to clear every one like it, plus whatever comes next. One key. One undo.",
      points: ["By sender, domain or list", "A filter for the future, same step", "One undo for all of it"],
    },
    codes: {
      title: "Sign-in codes, one click.",
      body: "The code shows right on the message. Click, paste, done.",
      points: [],
    },
    themes: {
      title: "Five designs. Twenty-two palettes.",
      body: "Warm Lumen, editorial Atelier, Apple-Mail-like macOS, rounded Luma or quiet Graphite, in any color theme from Solarized to Dracula. Or bring your own.",
      points: ["Light and dark in every one", "All checked for contrast", "Motion you can turn down or off"],
    },
    snippets: {
      title: "Write it once.",
      body: "Save the replies you send every week. ⌘; drops one in, name already filled.",
      points: [],
    },
    palette: {
      title: "⌘K does everything.",
      body: "Every action, folder, setting and snippet, a few letters away. What you use most comes first.",
      points: [],
    },
    agents: {
      title: "Your AI agents, every inbox.",
      body: "Connect Claude Code, Codex, Cursor or another app on your Mac that runs local MCP servers, and it can search and read all your accounts through Terno. It’s off until you turn it on, and you decide whether agents may only read, also organize, or also send.",
      points: ["Claude Code, Codex, Cursor, other local MCP apps", "Off until you turn it on", "Read only, organize or send: your call"],
      /** the example session beside it: the setup line, a question, Terno's tool at work, the answer */
      demo: {
        you: "You",
        agent: "Agent",
        ask: "Which invoices haven’t I paid yet? Check every account.",
        query: "invoice",
        found: "4 conversations in 3 accounts",
        answer: "Three are still open: Acme Studio, due Friday; Northwind, in your work account; and the studio rent, in your personal one.",
      },
    },
    keyboard: {
      title: "Never touch the mouse.",
      body: "Move, archive, file, reply and undo from the keyboard. Press ? for every shortcut.",
      points: [],
    },
    open: {
      title: "Don’t take our word for it.",
      body: "Every line of Terno is public. See exactly what’s stored and what crosses the network. Three years after each release, it’s fully open source.",
      points: [],
      cta: "Read the source on GitHub",
    },
  },
  /** Terno Pro (plan 97): the AI features, coming soon. Its own key so `features` keeps one shape. */
  pro: {
    eyebrow: "Terno Pro",
    status: "Coming soon",
    title: "Less time on email.",
    body: "Pro shows you what matters, drafts your replies and sums up long threads. You stay in charge: no email goes out until you send it.",
    price: "Planned: US$12 a month or $108 a year, with a 14-day free trial.",
    reply: {
      title: "Replies, already drafted.",
      body: "When someone is waiting on you, a reply is ready under their message, in your voice. Fill the gaps, then send.",
      points: ["Learned from the mail you’ve sent", "Marks what only you can decide", "Turn rough notes into an email with ⌘J"],
    },
    ask: {
      title: "Ask your mail.",
      body: "Stop digging for that one email. Ask in plain words and get an answer, with links to the messages it came from.",
      points: ["Ask a follow-up", "Or ask it to archive old mail, and check the preview first"],
    },
    followups: {
      title: "No answer? It comes back.",
      body: "Ask someone a question and hear nothing for a few days, and Terno brings it back to you, with a follow-up one click away.",
      points: [],
    },
    digest: {
      title: "Every newsletter, one page.",
      body: "Today’s newsletters folded into one page, a line each. Read what matters, then archive them all at once.",
      points: [],
    },
    summaries: {
      title: "The gist, before you read.",
      body: "New mail, except spam, gets a short summary, plus a to-do when it asks something of you. Any older conversation, one click.",
      points: [],
    },
    privacy: "AI is off until you turn it on. With Pro, each feature sends only the mail details it needs to Claude or OpenAI, through Terno’s relay, which stores none of it. Terno never sends an email for you.",
    ownKey: "Pro is AI with no keys to set up. These features also work without Pro, on your own Claude or OpenAI key or a model on your Mac. Your provider may charge for use.",
  },
  keys: [
    { keys: ["J", "K"], label: "Next, previous" },
    { keys: ["E"], label: "Archive" },
    { keys: ["L"], label: "File in a category" },
    { keys: ["R"], label: "Reply" },
    { keys: ["/"], label: "Search" },
    { keys: ["⌘", "K"], label: "Command palette" },
    { keys: ["Z"], label: "Undo" },
    { keys: ["?"], label: "Every shortcut" },
  ],
  stats: [
    { value: "Instant", label: "search across every account" },
    { value: "0", label: "Terno servers storing your mail" },
    { value: "22", label: "color themes, in five designs" },
  ],
  closing: {
    title: "Take back your inbox.",
    body: "Free. No account. No sign-up. Just your mail.",
  },
  waitlist: {
    title: "Windows and Linux are coming.",
    body: "Leave your email and we’ll write once, when Terno is ready for your computer. Nothing else.",
    email: "Email",
    placeholder: "you@example.com",
    platform: "Platform",
    platforms: { windows: "Windows", linux: "Linux", mac: "Mac (Apple silicon)", "mac-intel": "Mac (Intel)" },
    submit: "Join the waitlist",
    sending: "Joining…",
    thanks: "You’re on the list. We’ll write when it’s ready.",
    invalid: "That email doesn’t look right. Check it and try again.",
    busy: "Too many tries at once. Wait a minute and try again.",
    full: "The list is full for now. Check back soon.",
    error: "Something went wrong on our side. Try again in a moment.",
    note: "We keep your email and platform only to tell you about the release, then delete them.",
  },
  footer: {
    tagline: "The last email client you’ll try.",
    privacy: "Privacy",
    source: "Source",
    license: "License",
    copyright: "© 2026 Terno",
  },
  /** the app's designs by name, as its Settings call them */
  designs: { lumen: "Lumen", atelier: "Atelier", macos: "macOS", luma: "Luma", graphite: "Graphite" },
  alt: {
    inbox: "Terno’s unified inbox: conversations from four accounts in one list, a conversation open beside it",
    "inbox-macos": "Terno in the macOS design, compact and Apple-Mail-like",
    "inbox-atelier": "Terno in the Atelier design, with serif titles on paper",
    "inbox-luma": "Terno in the Luma design, between Lumen and macOS: Inter, rounded shapes, a blue accent",
    "inbox-graphite": "Terno in the Graphite design, quiet and neutral: greys, hairlines and pill buttons",
    code: "A verification code shown on its message in the list, with a copy button",
    search: "Search results for “hopper ride”: more than 100 results, instantly",
    palette: "The command palette open, with archive commands matching what was typed",
    snippets: "The snippets list open over a reply, each with a preview",
    "archive-similar": "After archiving a promotion, Terno offers to archive all 14 more from the same sender",
    "file-similar": "After filing a newsletter in Reading, Terno offers to file all 84 more from it, and its future mail",
    shortcuts: "The keyboard shortcuts sheet",
    "unified-detail": "Four accounts in Terno’s sidebar and their conversations in one list, each row naming its account",
    "code-detail": "A verification code on its message in the list, with a copy button",
    "search-detail": "Search for “hopper ride”: more than 100 results, instantly, with the matching words highlighted",
    "triage-detail": "After filing a newsletter in Reading, Terno offers to file the 84 more from it, and its future mail",
    "archive-detail": "After archiving a promotion, Terno offers to archive the 14 more from the same sender",
    "palette-detail": "The command palette, with the archive commands that match what was typed",
    "snippets-detail": "The snippets list, each with a preview",
    "shortcuts-detail": "The keyboard shortcuts sheet",
    "palette-dracula": "Terno with the Apple color theme in light mode and Dracula in dark mode",
    "palette-nord": "Terno with its own color theme in light mode and Nord in dark mode",
    "palette-solarized": "Terno with Solarized in light mode and Tokyo Night in dark mode",
    "palette-catppuccin": "Terno with the Catppuccin color theme, Latte in light mode and Mocha in dark mode",
    "palette-gruvbox": "Terno with the Gruvbox color theme",
    "ai-reply": "A conversation open in Terno, with a reply already drafted under the last message and one gap marked to fill in",
    "ai-ask": "Ask your mail answering “What did Isabella say about the payment?”, with numbered links to the emails it came from",
    "ai-what-matters": "The “What matters” view: what you missed, what’s due today and who’s waiting on your answer, one plain sentence each, with when it’s due",
    "ai-followups": "A question that got no answer, back in Follow-ups with a button to write a follow-up",
    "ai-digest": "Today’s newsletters on one page, one line each, with a button to archive them all",
    "ai-summary": "A short summary above a conversation, with a to-do and a Reply button",
  },
  pages: {
    download: {
      title: "The first build is on its way",
      body: "Terno for Mac isn’t published yet. Leave your email and we’ll write the day it is.",
    },
    waitlist: { title: "Join the waitlist" },
    notFound: { title: "This page doesn’t exist", body: "The link may be old or mistyped.", home: "Go to the home page" },
    privacy: {
      title: "Privacy",
      intro: "Terno keeps your mail on your Mac. There is no Terno account, and no Terno server that stores your mail. This page says exactly what the app and this website do with your data.",
      updated: "Last updated: November 20, 2026",
      contents: "On this page",
      sections: [
        {
          id: "who",
          title: "Who we are",
          body: [
            "Terno is made by Luisiacc LLC (“we”). This policy covers the Terno app for Mac and this website, terno.app. Terno’s source is public on [GitHub](https://github.com/luisiacc/terno), so you can check everything below.",
          ],
        },
        {
          id: "on-your-mac",
          title: "Your mail stays on your Mac",
          body: [
            "Terno downloads your mail from your mail providers and keeps it, with your contacts and the search index, in a database in your Mac’s user folder. Your passwords, sign-in tokens and AI keys are encrypted with a key kept in your macOS Keychain.",
            "None of this is sent to us. We have no server that receives your mail, your contacts or anything you do in the app. There are no analytics and no tracking.",
          ],
        },
        {
          id: "connections",
          title: "Who the app talks to",
          body: ["Besides your mail providers, Terno reaches the internet only for these:"],
          points: [
            "**Your mail providers** (Gmail, iCloud, Outlook or any IMAP/SMTP server), to fetch, send and organize your mail.",
            "**Website icons.** To show a company’s logo next to its mail, Terno asks that company’s own website for its icon. The site sees your IP address and nothing else. On by default; turn it off in Settings → Appearance.",
            "**Photos from Google.** With a Google account, Terno can show your Google contacts’ photos. You can turn it off in Settings → Appearance.",
            "**Remote images in messages** load only when you choose to, for one message or always. The sender’s server then sees your IP address, as with any mail app.",
            "**Updates.** Terno checks GitHub for a new version after it opens and every few hours. Nothing about you or your mail is sent. In Settings → General you choose whether new versions download on their own.",
            "**AI**, only if you set up a provider. See [AI providers](#ai).",
            "**Error reports**, only if you agree. See [Error reports](#errors).",
            "**Unsubscribing.** When you click Unsubscribe, Terno contacts the address the sender gave for it.",
          ],
        },
        {
          id: "google",
          title: "Google user data",
          body: [
            "When you connect a Google account, Google asks you to allow Terno to:",
          ],
          points: [
            "**See your name, email address and profile picture**, to identify the account in Terno and, with Photos from Google on, to show your picture on the mail you send.",
            "**Read, send, label and delete your Gmail mail** (the `gmail.modify` permission), so you can read, search, send, archive, label and delete your mail in Terno.",
            "**See your contacts’ email addresses and photos** (read-only access to your contacts and other contacts), only to put the right photo next to the people who write to you. Terno asks for this only when you turn on Photos from Google in Settings → Appearance.",
          ],
          after: [
            "Terno uses this data only to provide the features you see in the app. It is stored on your Mac and is never sent to us. We don’t sell it, use it for advertising, use it to build profiles of you, or use it to develop, improve or train AI models, and no person at Luisiacc LLC reads it.",
            "Terno passes Google user data to someone else only in two cases, both your choice: to the AI provider you set up, for the AI features described [below](#ai) (some run on their own once a provider is set up, and you can turn each one off, or turn AI off for one account), and to AI tools on your Mac that you connect to Terno.",
            "Terno’s use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.",
            "Removing the account in Settings → Accounts deletes its mail and sign-in tokens from your Mac and withdraws Terno’s access at Google, for Terno everywhere you use that account. If Google doesn’t confirm it, Terno tells you, and you can remove Terno yourself at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).",
          ],
        },
        {
          id: "ai",
          title: "AI providers",
          body: [
            "AI is off until you choose a provider in Settings → AI: Anthropic, OpenAI, an OpenAI-compatible service (such as OpenRouter, Groq, Together or Azure OpenAI) or a model running on your Mac (Ollama, LM Studio). Your key stays on your Mac, and requests go straight from your Mac to that provider, under its privacy terms. Nothing passes through us. With a model on your Mac, nothing leaves it. If you save both an Anthropic and an OpenAI key, Terno divides the work between them, so your mail can reach both.",
            "Once a provider is set up, some features run on their own as mail arrives, marked **automatic** below. You can turn each one off in Settings → AI, and turn AI off for one account with “Use AI with this account” in Settings → Accounts. That account’s mail is then never sent, though its name and address can still appear when you write a filter or a typed action. Automatic features never read mail in Spam or Trash, and they stop at the monthly limit you set in Settings → AI. Attachments and images are never sent, only file names where noted.",
            "What each feature sends:",
          ],
          points: [
            "**Summaries** (automatic for new mail in your Inbox, or when you ask for one): the subject, your name and address, each message’s sender, recipients’ names and date, the newest message’s text, and shorter extracts of the earlier messages in the conversation.",
            "**“What matters”** (automatic for new mail you receive, plus a one-time look at each account’s last 14 days, up to 300 messages): the message’s text without quoted replies, its subject and time, the names of its sender and recipients, and the items already open in that conversation.",
            "**Follow-ups** (automatic for each message you send, plus a one-time look at each account’s last 30 days of sent mail, up to 300 messages): your text without quotes or signature, its subject and time, your recipients’ names, attachment file names, the message you were answering, and the promises and requests already open in that conversation.",
            "**Ask your mail** (when you ask): your question and your last few questions, today’s date and time zone, your accounts’ names and addresses and your category names; then passages from up to 30 matching messages, each with its sender, date and subject.",
            "**Typed actions** (when you type a command such as “archive the newsletters from last week”): what you typed, today’s date and time zone, your accounts’ names and addresses, and your category and folder names; then, to check what it matches, the sender names, domains and subjects of the matching mail, never its text.",
            "**Writing with AI** (when you ask for a draft): your instruction, the draft so far, its recipients and subject, your signature, writing instructions and style notes, attachment file names, and the conversation you’re answering. With “Learn from my sent mail” on, also a few of your earlier messages to the same person.",
            "**Reply ready** (off by default): when you open a conversation waiting for your reply, its latest message and your last message there, to decide whether a reply is needed; then what Writing with AI sends.",
            "**Notes on your tone** (when you ask Terno to study your writing, then refreshed from time to time): samples of your sent mail without quotes or signatures, with recipients replaced by anonymous labels.",
            "**Newsletter digest** (off by default, once a day): the sender’s name, the subject and the opening text of up to 40 unread newsletters from the last 3 days.",
            "**Help sorting into categories** (off by default, automatic once on): for a new message Terno can’t sort on its own, the sender’s name and address, the subject, the first 600 characters of the text, your category names and a few examples of each category (sender name, domain and subject). If you add a TypeSafe AI (JEV) key in Settings → Categories, this goes to TypeSafe AI instead.",
            "**Writing a filter from your words:** what you typed, today’s date, your accounts’ addresses and names, and your category names.",
          ],
        },
        {
          id: "agents",
          title: "AI tools on your Mac",
          body: [
            "Terno includes a connector (MCP) that AI tools on your Mac, such as Claude, can use to reach your mail. It is off until you turn it on in Settings → Agents, where you also choose what those tools may do: only read, also organize (archive, categorize, filters and drafts), or also send. While it is off, nothing listens for them. It can’t be reached from the network: only programs running as you on your Mac, holding a key kept in your Terno folder, can use it, the same programs that could open your mail files directly. What those tools do with your mail is up to them and their provider.",
          ],
        },
        {
          id: "errors",
          title: "Error reports",
          body: [
            "When something goes wrong, Terno asks before sending a report (you can choose Always or Never instead), and you can see exactly what it holds first: the error and where in Terno’s code it happened; the steps just before it, as codes (such as which view or dialog was open); the app and macOS versions, your language and the kind of Mac (processor and memory); how many accounts you have; and a random ID you can reset. It never holds your mail, addresses, names or subjects. Reports go to Sentry, the service we use to track errors.",
            "Terno keeps its own logs on your Mac, limited in size. They don’t contain your mail or addresses.",
          ],
        },
        {
          id: "delete",
          title: "Removing your data",
          body: [
            "Removing an account in Settings → Accounts deletes its mail, sign-in tokens and pictures from Terno’s mailbox. Before an update changes how your mailbox is stored, Terno keeps a copy of it in case something goes wrong; a copy made before you removed the account still holds it until the copy is deleted, the first time Terno opens 14 days or more after the update. To remove everything at once, quit Terno and delete the folder `~/Library/Application Support/Terno` and the Keychain item “Terno Safe Storage”.",
          ],
        },
        {
          id: "site",
          title: "This website",
          body: [
            "This site is served by Cloudflare. It has no cookies, no analytics and no third-party scripts or fonts.",
            "It stores only what you give the waitlist: your email address, the platform you chose and the time you joined. That is deleted once we write to tell you Terno is ready for your platform, or sooner if you ask. Your IP address is used for a moment to stop abuse and is not stored, and the server doesn’t log what you submit.",
          ],
        },
        {
          id: "children",
          title: "Children",
          body: ["Terno isn’t directed to children under 13, and we don’t knowingly collect their data."],
        },
        {
          id: "changes",
          title: "Changes",
          body: ["If this policy changes, we’ll update this page and its date. Important changes will also be in the app’s release notes."],
        },
        {
          id: "contact",
          title: "Contact",
          body: ["For questions about privacy, or to have your waitlist entry removed, email Luisiacc LLC at [privacy@terno.app](mailto:privacy@terno.app)."],
        },
      ],
    },
  },
  shot: { appearance: "Picture appearance", light: "Light", dark: "Dark", enlarge: "Enlarge picture", close: "Close" },
  preview: { label: "Design preview", of: "of" },
};

export type SiteCopy = typeof en;
