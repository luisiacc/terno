"use client"

import { cn } from "cn"
import { t } from "@terno/i18n"
import { Button } from "@terno/ui/components/button"
import { ArrowLeft, ArrowRight } from "@terno/ui/icons"

/**
 * BoardUI's pagination (plan 125), its simple form: "Previous" and "Next" as secondary buttons with the range shown
 * between them ("1–25 of 80"). `page` counts from 0. Nothing when everything fits on one page. At either end the
 * button is unavailable but keeps focus, so a keyboard user paging through stays where they were.
 */
function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  className,
  "aria-label": label,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  className?: string
  "aria-label"?: string
}) {
  if (total <= pageSize) return null
  const from = page * pageSize + 1
  const to = Math.min(total, (page + 1) * pageSize)
  return (
    <nav data-slot="pagination" aria-label={label ?? t("ui.pagination.label")} className={cn("flex w-full items-center justify-between gap-2", className)}>
      <Button variant="outline" size="sm" focusableWhenDisabled disabled={page === 0} onClick={() => onPageChange(page - 1)} data-slot="pagination-previous">
        <ArrowLeft data-icon="inline-start" />
        {t("ui.pagination.previous")}
      </Button>
      <span aria-live="polite" className="text-sm text-muted-foreground tabular-nums">
        {t("ui.pagination.range", { from, to, total })}
      </span>
      <Button variant="outline" size="sm" focusableWhenDisabled disabled={to >= total} onClick={() => onPageChange(page + 1)} data-slot="pagination-next">
        {t("ui.pagination.next")}
        <ArrowRight data-icon="inline-end" />
      </Button>
    </nav>
  )
}

export { Pagination }
