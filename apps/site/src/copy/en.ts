/** The site's copy (plan 97), English (the source language). `es.ts` must match this shape: the type check says so. */
export const en = {
  lang: "en",
  meta: {
    title: "Terno: instant, private email for Mac",
    description:
      "Terno is a fast, keyboard-first email client for Mac. Every account in one inbox. Instant search. Fully local, no account needed.",
  },
  skip: "Skip to content",
  nav: { features: "Features", privacy: "Privacy", source: "Source", download: "Download", language: "Español", languageHref: "/es/", home: "Terno home" },
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
  features: {
    unified: {
      title: "Every account. One inbox.",
      body: "Gmail, Outlook and any IMAP/SMTP account: one list. Every row shows which account it’s for, so you never reply from the wrong one.",
      points: ["Gmail, Outlook, any IMAP/SMTP", "Unlimited accounts", "Categories across all of them"],
    },
    local: {
      title: "No account. No cloud. Just your Mac.",
      body: "Terno talks to your mail servers and nothing else. Your mail, contacts and search index live on your Mac.",
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
      title: "Three designs. Eighteen palettes.",
      body: "Warm Lumen, editorial Atelier or Apple-Mail-like macOS, in any color theme from Solarized to Dracula. Or bring your own.",
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
    { value: "0", label: "Terno servers between you and your mail" },
    { value: "18", label: "color themes, in three designs" },
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
  alt: {
    inbox: "Terno’s unified inbox: conversations from four accounts in one list, a conversation open beside it",
    "inbox-macos": "Terno in the macOS design, compact and Apple-Mail-like",
    "inbox-atelier": "Terno in the Atelier design, with serif titles on paper",
    code: "A verification code shown on its message in the list, with a copy button",
    search: "Search results for “hopper ride”: more than 100 results, instantly",
    palette: "The command palette open, with archive commands matching what was typed",
    snippets: "The snippets list open over a reply, each with a preview",
    "archive-similar": "After archiving a promotion, Terno offers to archive all 14 more from the same sender",
    "file-similar": "After filing a newsletter in Reading, Terno offers to file all 87 more from it, and its future mail",
    shortcuts: "The keyboard shortcuts sheet",
    "palette-dracula": "Terno with the Apple color theme in light mode and Dracula in dark mode",
    "palette-nord": "Terno with its own color theme in light mode and Nord in dark mode",
    "palette-solarized": "Terno with Solarized in light mode and Tokyo Night in dark mode",
    "palette-catppuccin": "Terno with the Catppuccin color theme, Latte in light mode and Mocha in dark mode",
    "palette-gruvbox": "Terno with the Gruvbox color theme",
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
      intro: "Terno the app keeps your mail on your Mac. This page is about this website.",
      sections: [
        {
          title: "What this site stores",
          body: "Only what you give the waitlist: your email address, the platform you chose and the time you joined. Nothing else is stored. There are no cookies, no analytics and no third-party scripts or fonts.",
        },
        {
          title: "What passes through without being kept",
          body: "Your IP address is used for a moment to stop abuse (a few sign-ups a minute at most) and is not stored. The server doesn’t log what you submit.",
        },
        {
          title: "How long we keep it",
          body: "Until we write to tell you Terno is ready for your platform, then it is deleted. To be removed sooner, write to the address on our GitHub profile.",
        },
        {
          title: "The app",
          body: "Terno connects to your own mail servers and, if you set one up, the AI provider you choose. It has no Terno account and sends us nothing unless you choose to send an error report. The source is public, so you can check.",
        },
      ],
    },
  },
  shot: { appearance: "Picture appearance", light: "Light", dark: "Dark", enlarge: "Enlarge picture", close: "Close" },
  preview: { label: "Design preview", of: "of" },
};

export type SiteCopy = typeof en;
