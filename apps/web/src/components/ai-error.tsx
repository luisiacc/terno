import type { AiErrorKind, AiProviderId } from "@terno/core";
import type { AiSettings } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { CircleAlert } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { localProvider, providerLabel, providerName } from "~/lib/ai";

/**
 * Plan 161, pass 2: one AI error on every surface (the summary, ⌘J, Ask), in plain English: what happened in the ink, one
 * line of what to do in the secondary, and the surface's own buttons. Never an address: a provider's message that names a
 * host, a URL or a port ("Couldn't find Ollama at 127.0.0.1:60512") is said by its kind instead.
 */

export interface AiErrorInput {
  message: string;
  kind?: AiErrorKind | "other" | undefined;
  /** the message's catalog key, when the backend sent one: a few are said as they are (no credit isn't a bad key) */
  key?: string | undefined;
}

/** Messages that are the app's own words, with no address, whatever their kind: shown as they are. */
const OWN_KEYS = new Set(["errors.ai.noCredit", "errors.ai.dailyLimit", "errors.ai.monthlyLimit", "errors.ai.draftTooLarge"]);

export interface AiErrorCopy {
  title: string;
  help: string | null;
  /** the fix is in Settings → AI: the surface offers it */
  settings: boolean;
}

/**
 * A URL, an IP address, localhost, a host with a port (not a time: "3:00"), a local network name, or a domain on a common
 * top-level domain (a redirect's host).
 */
const ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b|\blocalhost\b|\[[0-9a-f:]+\]|\b[\w-]+(?:\.[\w-]+)+:\d{2,5}\b|\b[a-z][\w-]*:\d{2,5}\b|\b[\w-]+\.(?:local|lan|internal|home)\b|\b(?:[\w-]+\.)+(?:com|net|org|io|ai|dev|app|cloud|co|us|eu|uk|de|es|mx)\b|\bOLLAMA_ORIGINS\b/i;

export const hasAddress = (text: string): boolean => ADDRESS.test(text);

/** The kinds whose words are the provider's, often with its address: always said by kind. */
const BY_KIND: Partial<Record<AiErrorKind | "other", string>> = {
  unavailable: "ai.error.unavailable",
  timeout: "ai.error.timeout",
  auth: "ai.error.auth",
  rate_limited: "ai.error.rateLimited",
  blocked: "ai.error.blocked",
  invalid_output: "ai.error.invalidOutput",
  refused: "ai.error.refused",
  unsupported: "ai.error.unsupported",
};

/**
 * Which provider failed: the task's own (⌘J's writing target, the summary's), not always the one in Settings' first row.
 * `ai` names it as Settings does.
 */
export interface AiErrorTarget {
  provider: AiProviderId;
  local: boolean;
  ai?: Pick<AiSettings, "provider" | "preset" | "local"> | null | undefined;
}

/** The target for a task that runs on `provider`, under these settings. */
export function errorTarget(provider: AiProviderId, ai: Pick<AiSettings, "provider" | "preset" | "local"> | null | undefined): AiErrorTarget {
  return { provider, local: ai && provider === ai.provider ? ai.local : localProvider(provider), ai };
}

type Ai = AiErrorTarget | null | undefined;

function helpOf(kind: AiErrorKind | "other" | undefined, ai: Ai, provider: string): string | null {
  switch (kind) {
    case "auth":
      return t("ai.help.auth");
    case "rate_limited":
      return t("ai.error.help.rateLimited");
    case "unavailable":
      return ai?.local ? t("ai.error.help.unavailableLocal", { provider }) : t("ai.error.help.unavailable");
    case "timeout":
      return ai?.local ? t("ai.help.timeoutLocal") : t("ai.help.timeout");
    case "blocked":
      return t("ai.help.blocked");
    case "invalid_output":
      return t("ai.error.help.invalidOutput");
    case "refused":
      return t("ai.error.help.refused");
    default:
      return null;
  }
}

/** What an AI error says, from its kind and its message; the message only when it's the app's own words, with no address. */
export function aiErrorCopy(error: AiErrorInput, ai: Ai): AiErrorCopy {
  const provider = !ai || ai.provider === "none" ? t("ai.error.provider") : ai.ai && ai.provider === ai.ai.provider ? providerName(ai.ai) : providerLabel(ai.provider, ai.ai ?? undefined);
  const kind = error.kind;
  const message = error.message.trim();
  const byKind = kind ? BY_KIND[kind] : undefined;
  // the app's own sentence (a refusal, "This conversation keeps changing…", no credit left) reads better than a generic
  // one; never for the kinds whose words are the provider's, often with its address
  const ownKey = error.key !== undefined && OWN_KEYS.has(error.key);
  const own = message !== "" && !hasAddress(message) && (ownKey || (kind !== "unavailable" && kind !== "timeout" && kind !== "auth" && kind !== "rate_limited" && kind !== "blocked"));
  if (own && ownKey) return { title: message.replace(/[.。]$/, ""), help: null, settings: true };
  // plan 162: the provider answered, with an error: said as that, never as "Couldn't reach", and its status kept
  if (error.key === "errors.ai.providerError") return { title: message && !hasAddress(message) ? message.replace(/[.。]$/, "") : t("ai.error.providerError", { provider }), help: t("ai.error.help.providerError"), settings: true };
  const title = own ? message.replace(/[.。]$/, "") : byKind ? t(byKind as "ai.error.unavailable", { provider }) : t("ai.error.other");
  const help = helpOf(kind, ai, provider) ?? (own ? null : t("ai.error.help.other"));
  return { title, help, settings: kind === "auth" || kind === "unavailable" || kind === "invalid_output" || kind === "unsupported" || kind === "not_configured" };
}

/**
 * The block: the glyph in the destructive ink on the title's line, the title, its help, and the surface's buttons (Try
 * again the secondary, AI settings a ghost) at the end of the line, or under it when they don't fit.
 */
export function AiErrorNotice({ copy, actions, textTestId, className, ...rest }: { copy: AiErrorCopy; actions?: React.ReactNode; textTestId?: string } & Omit<React.ComponentProps<"div">, "children">) {
  return (
    <div className={cn("flex min-w-0 flex-1 items-start gap-1.5 text-sm", className)} {...rest}>
      <span className="flex h-[1lh] shrink-0 items-center">
        <CircleAlert aria-hidden className="size-[1.15em] text-destructive" />
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
        <p role="alert" data-testid={textTestId} className="min-w-0 flex-auto wrap-anywhere">
          <span className="font-medium text-foreground">{copy.title}</span>
          {copy.help && <span className="block text-muted-foreground">{copy.help}</span>}
        </p>
        {actions && <span className="ms-auto flex shrink-0 flex-wrap items-center gap-1.5 text-foreground">{actions}</span>}
      </div>
    </div>
  );
}
