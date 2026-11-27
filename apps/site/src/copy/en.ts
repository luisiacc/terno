import type { Lang } from "../site";

/** The site's copy (plan 97), English (the source language). `es.ts` must match this shape: the type check says so. */
export const en = {
  lang: "en" as Lang,
  meta: {
    title: "Terno: instant, private email for Mac and Linux",
    description:
      "Terno is a fast, keyboard-first email client for Mac and Linux. Every account in one inbox. Instant search. Fully local, no account needed. Terno Pro adds AI that drafts your replies and powers “What matters”: one view of only what needs you.",
  },
  skip: "Skip to content",
  nav: { features: "Features", pro: "Pro", privacy: "Privacy", source: "Source", download: "Download", language: "Español", languageHref: "/es/", languageMenu: "Language", sourceOnGithub: "Source code on GitHub", home: "Terno home" },
  hero: {
    title: "The last email client you’ll try.",
    /** its last sentence is the AI, which works today on the user's own key or a local model (Pro's plan isn't sold yet) */
    subtitle: "Unified inbox. Instant search. Archive one email, and every one like it goes too. Fully local, no sign-up. Turn on AI, and Terno keeps track of what needs you: who’s waiting on your answer, what you promised, and who hasn’t replied.",
    /** the link above the title, down to “What matters” in Pro (the owner, 2026-11-23: it belongs in the first lines) */
    news: { tag: "New", text: "“What matters”: only the email that needs you" },
    note: "Free · macOS on Apple silicon and Linux",
  },
  download: {
    mac: "Download for Mac",
    macSub: "Apple silicon",
    linux: "Download for Linux",
    linuxSub: ".deb · .rpm",
    other: "Windows",
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
      title: "No account. No cloud. Just your computer.",
      body: "Your mail syncs between your computer and your mail servers, never through ours. Your mail, the addresses you write to and the search index live on your computer.",
      points: ["Private from the first launch", "Remote images only when you ask", "Zero tracking"],
      /** the picture of where it all lives (Midnight): your computer, your mail servers, and no server of ours between them */
      map: { computer: "Your computer", kept: { mail: "Mail", contacts: "Addresses", index: "Search index" }, link: "Synced directly", servers: "Your mail servers", providers: "Gmail · Outlook · IMAP", ours: "No Terno server" },
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
      title: "Six designs. Twenty-two palettes.",
      body: "Warm Lumen, editorial Atelier, Apple-Mail-like macOS, rounded Luma, quiet Graphite or tactile Relief, in any color theme from Solarized to Dracula. Or bring your own.",
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
      body: "Connect Claude Code, Codex, Cursor or another app on your computer that runs local MCP servers, and it can search and read all your accounts through Terno. It’s on from the start, read only, and you decide whether agents may also organize, also send, or not connect at all.",
      points: ["Claude Code, Codex, Cursor, other local MCP apps", "Read only until you allow more", "Read only, organize or send: your call"],
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
    /** the AI works today, on the user's own key or a model on their Mac; the plan isn't sold yet (Codex review: not "Use it today", which read as Pro on your own key) */
    status: "AI available today · Plan coming soon",
    title: "Nothing slips.",
    body: "Pro keeps track for you: who’s waiting on your answer, what you promised, and who hasn’t replied. Your reply is drafted in your voice, and no email goes out until you send it.",
    price: "Planned: US$15 a month.",
    reply: {
      title: "Replies that sound like you.",
      body: "When someone is waiting on you, a reply is ready under their message, in your voice. Fill the gaps, then send.",
      points: ["Learned from the mail you’ve sent", "Marks what only you can decide", "Turn rough notes into an email with ⌘J"],
    },
    ask: {
      title: "Ask your mail.",
      body: "The door code, the renewal date, who said yes. Ask in plain words, and the answer comes with links to the emails it came from. Your mail is already here, so there’s nothing to paste into a chatbot.",
      points: ["Ask a follow-up", "Or ask it to archive old mail, and check the preview first"],
    },
    followups: {
      title: "No answer? It comes back.",
      body: "Ask someone a question, archive it, and hear nothing for a few days: Terno brings it back to you, with a follow-up one click away.",
      points: [],
    },
    /** People (plan 281), shown wide between the pairs (plan 288) */
    people: {
      title: "What’s open with each person.",
      body: "People puts first the ones with something open: what they asked of you, what you promised them, conversations waiting on your answer, replies you’re waiting for in Follow-ups. Then the others you’ve written to. Choose someone to see what’s open between you and your recent conversations.",
      points: ["Longest waiting first, with how long", "Mark items Done or move them to Later, with Undo", "Search by name or address as you type"],
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
    privacy: "AI is off until you turn it on. With Pro, each feature sends only the mail details it needs to Claude or OpenAI, through Terno’s relay, which stores none of it. Terno’s AI never sends an email for you.",
    ownKey: "Pro is AI with no keys to set up. These features also work without Pro, on your own Claude or OpenAI key or a model on your computer. Your provider may charge for use.",
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
    { value: "22", label: "color themes, in six designs" },
  ],
  closing: {
    title: "Take back your inbox.",
    body: "Free. No account. No sign-up. Just your mail.",
  },
  waitlist: {
    title: "Windows is coming.",
    body: "Leave your email and we’ll write once, when Terno is ready for your computer. Nothing else.",
    email: "Email",
    placeholder: "you@example.com",
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
    terms: "Terms",
    source: "Source",
    license: "License",
    copyright: "© 2026 Luisiacc LLC",
  },
  /** the app's designs by name, as its Settings call them */
  designs: { lumen: "Lumen", atelier: "Atelier", macos: "macOS", luma: "Luma", graphite: "Graphite", relief: "Relief" },
  alt: {
    inbox: "Terno’s unified inbox: conversations from four accounts in one list, a conversation open beside it",
    "inbox-macos": "Terno in the macOS design, compact and Apple-Mail-like",
    "inbox-atelier": "Terno in the Atelier design, with serif titles on paper",
    "inbox-luma": "Terno in the Luma design, between Lumen and macOS: Inter, rounded shapes, a blue accent",
    "inbox-graphite": "Terno in the Graphite design, quiet and neutral: greys, hairlines and pill buttons",
    "inbox-relief": "Terno in the Relief design, tactile greys: raised pills, recessed tracks and soft shadows",
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
    "filed-detail": "A newsletter just filed in Reading, and under it Terno’s offer to file the 84 more from it, and its future mail",
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
    "ai-people": "One person’s page in People: what’s open between you, each with its kind and how long it’s been, then your recent conversations; beside it, the list of people with something open, longest waiting first",
    "ai-followups": "A question that got no answer, back in Follow-ups with a button to write a follow-up",
    "ai-digest": "Today’s newsletters on one page, one line each, with a button to archive them all",
    "ai-summary": "A short summary above a conversation, with a to-do and a Reply button",
  },
  pages: {
    /** where a download lands when GitHub can't be reached or has no such file (plan 254) */
    download: {
      title: "Get Terno on GitHub",
      body: "We couldn’t reach the newest version just now. Every version of Terno, for Mac and Linux, is on GitHub.",
      releases: "Terno’s releases on GitHub",
    },
    /** the Linux packages (plan 254): the commands are the same in every language, so they're in the page */
    linux: {
      title: "Terno for Linux",
      description: "Download Terno, the fast, private, keyboard-first email client, for Linux: a .deb for Debian and Ubuntu and an .rpm for Fedora and RHEL, for x86-64 and arm64.",
      lead: "Packages for Debian and Ubuntu (.deb) and for Fedora and RHEL (.rpm), for Intel and AMD processors (x86-64) and ARM (arm64).",
      deb: "Debian, Ubuntu and Mint",
      rpm: "Fedora and RHEL",
      x64: "x86-64",
      arm64: "arm64",
      x64Hint: "Intel and AMD processors",
      arm64Hint: "ARM processors",
      download: "Download",
      copy: "Copy the command",
      copied: "Copied",
      install: "Open the file to install it with your software center, or from a terminal in the folder it downloaded to:",
      older: "If that folder holds an older download too, type the new file’s full name instead of the `*`.",
      which: "Not sure which processor? `uname -m` prints `x86_64` for x86-64 and `aarch64` for arm64.",
      updates: "Terno can’t update itself on Linux yet. When a new version is out, download it here and install it the same way.",
      releases: "Every version on GitHub",
      /** shown when a package's download couldn't be reached (the Worker lands on #unavailable) */
      unavailable: "We couldn’t reach that download just now. Try again in a moment, or get it from [every version on GitHub](https://github.com/luisiacc/terno/releases).",
    },
    waitlist: { title: "Join the waitlist" },
    notFound: { title: "This page doesn’t exist", body: "The link may be old or mistyped.", home: "Go to the home page" },
    /** the terms of service (Creem's review, 2026-11-23): use of the app, the site and Pro, and acceptable use of AI */
    terms: {
      title: "Terms of Service",
      intro: "These terms cover using Terno, the email app, its AI features, Terno Pro and this website. They are short, and they say plainly what you can expect from us and what we expect from you.",
      updated: "Last updated: November 27, 2026",
      contents: "On this page",
      sections: [
        {
          id: "agreement",
          title: "Who we are",
          body: [
            "Terno is made by Luisiacc LLC (“we”, “us”). By downloading or using the Terno app, subscribing to Terno Pro or using terno.app, you agree to these terms and to our [Privacy policy](/privacy/). If you use Terno for an organization, you agree for it too. If you don’t agree, don’t use Terno.",
          ],
        },
        {
          id: "license",
          title: "Using the app",
          body: [
            "The Terno app is source-available under the [Business Source License 1.1](https://github.com/luisiacc/terno/blob/main/LICENSE). That license says who may use it for free and what needs a paid subscription. In short: it is free for individuals and for Small Organizations (fewer than 100 employees and contractors combined, and less than US$5 million in revenue in the last fiscal year, counting affiliated companies), and anyone may evaluate it for 30 days. A larger organization needs a Pro subscription for each person who connects one of its email accounts to Terno. [LICENSING.md](https://github.com/luisiacc/terno/blob/main/LICENSING.md) explains it, and the license’s own words decide. These terms add to that license and never take away a right it gives you.",
            "“Terno” and its logo are trademarks of Luisiacc LLC; see [TRADEMARKS.md](https://github.com/luisiacc/terno/blob/main/TRADEMARKS.md) for how a fork may use them.",
          ],
        },
        {
          id: "your-mail",
          title: "Your mail and your accounts",
          body: [
            "Terno is an app on your computer that connects to mail accounts you already have. Your mail stays yours, and you are responsible for what you send and for following the terms of your mail providers (such as Google, Apple or Microsoft). Terno keeps its copy of your mail on your computer, not on our servers, so we can’t recover anything for you. Mail that reached your provider stays on its servers, but some things can exist only on your computer, such as unsent drafts, mail waiting to be sent, your settings and your rules. Keep that computer secure and backed up.",
          ],
        },
        {
          id: "ai",
          title: "AI features",
          body: [
            "Terno’s AI features (summaries, drafted replies, “What matters”, follow-ups, Ask your mail and others) are optional and off until you turn them on. They run on a provider you choose, on a model on your computer, or, with Pro, on AI that Terno provides through Anthropic or OpenAI. When you use your own provider, its terms and usage policies apply as well as these.",
            "AI can be wrong. Read what it writes before you rely on it or send it. Terno’s AI never sends an email on its own: a drafted reply stays a draft until you send it. Rules you set up (such as forwarding) and AI tools you allow to send through Terno’s connector act for you. You are responsible for the mail sent from your accounts, however it was written.",
            "Terno is an independent product. It is not affiliated with or endorsed by Anthropic, OpenAI, Google, Apple or Microsoft; their names here only say which services Terno works with.",
          ],
        },
        {
          id: "acceptable-use",
          title: "Acceptable use",
          body: [
            "These rules cover everything you do with Terno, and they apply to what you ask its AI to write even if you never send it. You may not use Terno, its AI features, Terno Pro or its connector for AI tools to:",
          ],
          points: [
            "Generate, request or send **illegal content**, or anything meant to help someone break the law.",
            "Generate, request or send **abusive content**: harassment, threats, bullying, defamation, or content that promotes violence, terrorism, self-harm or hatred of people for who they are.",
            "Generate, request or send **sexual, sexually explicit or otherwise NSFW content** of any kind. Content that sexualizes minors is never allowed, and we report it where the law requires.",
            "Harass, stalk or intimidate anyone.",
            "Send spam, phishing, scams or bulk unsolicited mail, or impersonate a person or an organization to deceive someone.",
            "Create or spread malware, or try to get into accounts, systems or mail that aren’t yours.",
            "Collect, track or expose other people’s personal information without their permission or a legal right to.",
            "Infringe anyone’s copyright, trademark, privacy or other rights.",
            "Generate misleading content meant to deceive, such as fake reviews, fake documents or disinformation.",
            "Abuse Terno Pro: share or resell your access, get around its limits, or overload or attack the service Terno uses to provide AI.",
            "Break the usage policies of the AI provider your request goes to ([Anthropic](https://www.anthropic.com/legal/aup), [OpenAI](https://openai.com/policies/usage-policies/)).",
          ],
          after: [
            "If you break these rules, we may suspend or end your Pro subscription, without a refund unless the law requires one, and an AI provider may refuse your requests. If you see Terno being used this way, tell us at [support@terno.app](mailto:support@terno.app).",
          ],
        },
        {
          id: "pro",
          title: "Terno Pro",
          body: [
            "Terno Pro is a subscription that adds AI provided by Terno, with nothing to set up. Every other feature of Terno stays free, and the AI features also work without Pro on your own provider’s key or a model on your computer.",
            "Pro isn’t on sale yet. This section and Refunds apply once it is. Before then, our [Privacy policy](/privacy/) will also say what Pro’s AI sends through Terno’s service and what that service keeps.",
          ],
          points: [
            "**Price.** Pro is US$15 a month. The price, and any tax added for where you live, is shown at checkout before you pay.",
            "**Payment.** Payments are handled by Creem (Armitage Labs OÜ), our reseller and merchant of record, which is the seller on your receipt and handles taxes, invoices and payment details. We never see your card.",
            "**Renewal.** Pro is billed monthly in advance. Each billing period starts on the day of the month you subscribed, and Pro renews at the end of each one until you cancel.",
            "**Cancelling.** Cancel at any time from the app or from the link in your receipt. You won’t be charged again, and Pro keeps working until the end of the billing period you paid for.",
            "**AI use.** Pro’s AI has no monthly allowance to keep track of: use it as much as you like. To guard against faults and abuse, it pauses if an account’s use in a billing period goes far beyond what even heavy everyday use needs. The app says so when it happens, Pro’s AI resumes when your next billing period starts, and you can switch to your own provider meanwhile. You are never charged extra automatically.",
            "**Price changes.** If the price changes, we’ll email you at least 30 days before it applies to your subscription, so you can cancel first.",
            "**Business use.** A Pro subscription includes using Terno for work, at an organization of any size.",
          ],
        },
        {
          id: "refunds",
          title: "Refunds",
          body: [
            "If Pro isn’t right for you, email [support@terno.app](mailto:support@terno.app) within 14 days of a payment and we’ll refund that payment in full, unless we ended your Pro for breaking the Acceptable use rules. Creem issues the refund, to the way you paid. After 14 days, payments aren’t refunded, but you can cancel at any time so you aren’t charged again. A refund ends Pro, and never deletes anything on your computer. None of this limits a right to a refund that the law where you live gives you.",
          ],
        },
        {
          id: "site",
          title: "This website",
          body: [
            "You may use terno.app to learn about Terno, download it and join the waitlist. Don’t try to disrupt the site, get around its limits or submit someone else’s email to the waitlist.",
          ],
        },
        {
          id: "warranty",
          title: "No warranty",
          body: [
            "Terno is provided “as is” and “as available”, without warranties of any kind, express or implied, including that it will be error-free or uninterrupted, or fit for a particular purpose, to the extent the law allows. AI features can be wrong, and the services they depend on can be unavailable.",
          ],
        },
        {
          id: "liability",
          title: "Limits on our liability",
          body: [
            "To the extent the law allows, Luisiacc LLC isn’t liable for indirect, incidental, special, consequential or punitive damages, or for lost data, profits or revenue, arising from your use of Terno. Our total liability for any claim about Terno is limited to the greater of what you paid for Terno Pro (including through Creem) in the 12 months before the claim, or US$50. Some places don’t allow these limits, so they may not all apply to you.",
          ],
        },
        {
          id: "ending",
          title: "Ending",
          body: [
            "You can stop using Terno at any time by deleting the app, and cancel Pro as described above. We may suspend or end your access to Pro if you break these terms. Sections that by their nature should last (such as No warranty and Limits on our liability) still apply afterwards.",
          ],
        },
        {
          id: "changes",
          title: "Changes",
          body: [
            "If these terms change, we’ll update this page and its date. If a change matters to a Pro subscription, we’ll email you before it takes effect; keeping Pro after that means you accept the new terms.",
          ],
        },
        {
          id: "contact",
          title: "Contact",
          body: [
            "For help, billing questions or refunds, email Luisiacc LLC at [support@terno.app](mailto:support@terno.app). For privacy questions, [privacy@terno.app](mailto:privacy@terno.app).",
          ],
        },
      ],
    },
    privacy: {
      title: "Privacy",
      intro: "Terno keeps your mail on your computer. There is no Terno account, and no Terno server that stores your mail. This page says exactly what the app and this website do with your data.",
      updated: "Last updated: November 24, 2026",
      contents: "On this page",
      sections: [
        {
          id: "who",
          title: "Who we are",
          body: [
            "Terno is made by Luisiacc LLC (“we”). This policy covers the Terno app on every system it runs on (Mac, Windows and Linux) and this website, terno.app. Terno’s source is public on [GitHub](https://github.com/luisiacc/terno), so you can check everything below.",
          ],
        },
        {
          id: "on-your-computer",
          title: "Your mail stays on your computer",
          body: [
            "Terno downloads your mail from your mail providers and keeps it, with the addresses you write to and hear from and the search index, in a database in your user folder on your computer. Your passwords, sign-in tokens and AI keys are encrypted with a key your system keeps for you: in the Keychain on a Mac, with Windows’ own data protection for your user account on Windows, and in your keyring (such as GNOME Keyring or KWallet) on Linux. On a Linux system with no keyring running, that key is one built into the app instead, which protects them less.",
            "None of this is sent to us. We have no server that receives your mail or anything you do in the app. There are no analytics and no tracking.",
          ],
        },
        {
          id: "connections",
          title: "Who the app talks to",
          body: ["Besides your mail providers, Terno reaches the internet only for these:"],
          points: [
            "**Your mail providers** (Gmail, iCloud, Outlook or any IMAP/SMTP server), to fetch, send and organize your mail.",
            "**Website icons.** To show a company’s logo next to its mail, Terno asks that company’s own website for its icon. The site sees your IP address and nothing else. On by default; turn it off in Settings → Appearance.",
            "**Remote images in messages** load only when you choose to, for one message or always. The sender’s server then sees your IP address, as with any mail app.",
            "**Updates.** Where Terno can update itself, it checks GitHub for a new version after it opens and every few hours. Nothing about you or your mail is sent. In Settings → About you choose whether new versions download on their own.",
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
            "**See your name, email address and profile picture**, to identify the account in Terno. Terno uses your name and address, not the picture.",
            "**Read, send, label and delete your Gmail mail** (the `gmail.modify` permission), so you can read, search, send, archive, label and delete your mail in Terno.",
          ],
          after: [
            "Terno uses this data only to provide the features you see in the app. It is stored on your computer and is never sent to us. We don’t sell it, use it for advertising, use it to build profiles of you, or use it to develop, improve or train AI models, and no person at Luisiacc LLC reads it.",
            "Terno passes Google user data to someone else only in two cases, both your choice: to the AI provider you set up, for the AI features described [below](#ai) (some run on their own once a provider is set up, and you can turn each one off, or turn AI off for one account), and to AI tools on your computer that you connect to Terno.",
            "Terno’s use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.",
            "Removing the account in Settings → Accounts deletes its mail and sign-in tokens from your computer and withdraws Terno’s access at Google, for Terno everywhere you use that account. If Google doesn’t confirm it, Terno tells you, and you can remove Terno yourself at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).",
          ],
        },
        {
          id: "ai",
          title: "AI providers",
          body: [
            "AI is off until you choose a provider in Settings → AI: Anthropic, OpenAI, an OpenAI-compatible service (such as OpenRouter, Groq, Together or Azure OpenAI) or a model running on your computer (Ollama, LM Studio). Your key is stored on your computer and is sent only to that provider, with each request, so it knows the request is yours. Requests go straight from your computer to the provider, under its privacy terms; nothing passes through us. With a model on your computer, nothing leaves it. If you choose Anthropic or OpenAI and save a key for both, Terno divides the work between them, so your mail can reach both.",
            "Once a provider is set up, some features run on their own as mail arrives, marked **automatic** below. You can turn each one off in Settings → AI, and turn AI off for one account with “Use AI with this account” in Settings → Accounts. That account’s mail is then never sent, though its name and address can still appear when you write a filter or a typed action. Automatic features never read mail in Spam or Trash, and they stop at the monthly limit you set in Settings → AI. Attachments and images are never sent, only file names where noted.",
            "What you may and may not use AI for is in the [Terms: Acceptable use](/terms/#acceptable-use).",
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
          title: "AI tools on your computer",
          body: [
            "On a Mac and on Linux, Terno includes a connector (MCP) that AI tools on your computer, such as Claude, can use to reach your mail; it isn’t on Windows yet. It is on from the start, read only, and Settings → Agents is where you choose what those tools may do: only read, also organize (archive, categorize, filters and drafts), or also send, or turn it off. While it is off, nothing listens for them. It can’t be reached from the network: only programs running as you on your computer, holding a key kept in your Terno folder, can use it, the same programs that could open your mail files directly. What those tools do with your mail is up to them and their provider.",
          ],
        },
        {
          id: "errors",
          title: "Error reports",
          body: [
            "When something goes wrong, Terno asks before sending a report, and you can see exactly what it holds first. In Settings you can choose Never instead, or Always, which sends each report without asking, along with any from the past week you haven’t decided on. A report holds the error and where in Terno’s code it happened; the steps just before it, as codes (such as which view or dialog was open); the versions of the app and of what runs it; the operating system, its version, the processor type and memory; your language; how many accounts you have of each kind; how long Terno had been running and how often the error repeated; a random ID for that run of Terno; and a random ID for your installation, which you can reset. Some of these are left out when Terno doesn’t know them. It never holds your mail, addresses, names or subjects. Reports go to Sentry, the service we use to track errors.",
            "Terno keeps its own logs on your computer, limited in size. They don’t contain your mail or addresses.",
          ],
        },
        {
          id: "delete",
          title: "Removing your data",
          body: [
            "Removing an account in Settings → Accounts deletes its mail, sign-in tokens and pictures from Terno’s mailbox. To remove everything at once, quit Terno and delete its folder: `~/Library/Application Support/Terno` on a Mac, `%APPDATA%\\Terno` on Windows, `~/.config/Terno` on Linux (or `$XDG_CONFIG_HOME/Terno` if you set it). On a Mac, also delete the Keychain item “Terno Safe Storage”; on Linux, Terno’s entry in your keyring.",
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
