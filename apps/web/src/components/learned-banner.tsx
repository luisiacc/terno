import type { LearnedProposal } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";

const VERB = { archive: "archivas", trash: "borras", spam: "marcas como spam" } as const;
const ACTION = { archive: "Archivar automáticamente", trash: "Borrar automáticamente", spam: "Mandar a spam" } as const;

/** Surfaces one learned-filter proposal at the top of the inbox. */
export function LearnedBanner() {
  const view = useApp((s) => s.view);
  const query = useApp((s) => s.query);
  const counts = useApp((s) => s.counts);
  const [proposal, setProposal] = useState<LearnedProposal | null>(null);

  useEffect(() => {
    if (view !== "inbox" || query) return;
    let alive = true;
    void client.call("learning.proposals", {}).then((ps) => alive && setProposal(ps[0] ?? null)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [view, query, counts]);

  if (!proposal || view !== "inbox" || query) return null;
  const who = proposal.scope === "list" ? `la lista ${proposal.value}` : proposal.scope === "domain" ? `todo ${proposal.value}` : proposal.value;
  return (
    <div data-testid="learned-banner" className="mx-3 mt-1 mb-1 flex items-start gap-2.5 rounded-[10px] bg-tint p-2.5 text-xs">
      <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-foreground">
          Siempre {VERB[proposal.action]} los correos de <span className="font-medium">{who}</span> ({proposal.support} veces).
        </p>
        <div className="mt-1.5 flex gap-1.5">
          {/* a suggestion, not the screen's main action: a quiet raised button */}
          <Button
            size="xs"
            variant="outline"
            data-testid="learned-accept"
            onClick={async () => {
              await client.call("learning.accept", { key: proposal.key });
              toast.success(`Filtro creado: ${ACTION[proposal.action]}`);
              setProposal(null);
            }}
          >
            {ACTION[proposal.action]}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={async () => {
              await client.call("learning.dismiss", { key: proposal.key });
              setProposal(null);
            }}
          >
            Ahora no
          </Button>
        </div>
      </div>
      <button type="button" aria-label="Cerrar" className="text-muted-foreground hover:text-foreground" onClick={() => setProposal(null)}>
        <X className="size-3.5" />
      </button>
    </div>
  );
}
