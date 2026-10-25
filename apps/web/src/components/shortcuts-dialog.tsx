import { shortcutsFor } from "@terno/core";
import { t } from "@terno/i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@terno/ui/components/dialog";
import { Shortcut } from "@terno/ui/components/shortcut";
import { isMac } from "~/lib/select";
import { FORMATTING, SECTIONS } from "~/lib/shortcut-sections";
import { setApp, useApp } from "~/state/app";

export function ShortcutsDialog() {
  const open = useApp((s) => s.dialog === "shortcuts");
  return (
    <Dialog open={open} onOpenChange={(o) => !o && setApp({ dialog: null })}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl" data-testid="shortcuts-dialog">
        <DialogHeader>
          <DialogTitle>{t("shortcuts.title")}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-x-10 gap-y-5">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h3 className="mb-1.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">{t(section.title)}</h3>
              <div className="space-y-1.5">
                {section.rows.map(([command, label]) => (
                  <div key={command} className="flex items-center justify-between gap-3 text-sm" data-testid={`shortcut-${command}`}>
                    <span className="text-muted-foreground">{t(label)}</span>
                    <span className="flex flex-wrap items-center justify-end gap-1">
                      {shortcutsFor(command, undefined, isMac).map((keys, i) => (
                        <span key={keys} className="inline-flex items-center gap-1">
                          {i > 0 && <span className="text-2xs text-muted-foreground">{t("shortcuts.or")}</span>}
                          <Shortcut keys={keys} />
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
          <section>
            <h3 className="mb-1.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">{t("shortcuts.section.formatting")}</h3>
            <div className="space-y-1.5">
              {FORMATTING.map(([keys, label]) => (
                <div key={keys} className="flex items-center justify-between gap-3 text-sm" data-testid={`shortcut-format-${label}`}>
                  <span className="text-muted-foreground">{t(label)}</span>
                  <Shortcut keys={keys} />
                </div>
              ))}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
