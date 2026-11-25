import * as React from "react"
import { cn } from "cn"

import { GoogleMark, MicrosoftMark } from "@terno/ui/brand/provider-marks"
import { Button } from "@terno/ui/components/button"

/**
 * BoardUI's Social Button (plan 276), its outlined `white` appearance: the one that shows each provider's real mark and the
 * one BoardUI recommends for a stack. On our outline button (BoardUI's white "matches the system's secondary button"), at
 * its medium size (our `lg`, 36 px), filling its column. The brand names the mark; the words are the caller's (the
 * catalog's), so they translate. `loading` puts the spinner in the mark's place, the words staying.
 */
const MARKS = { google: GoogleMark, microsoft: MicrosoftMark } as const

export type SocialBrand = keyof typeof MARKS

function SocialButton({
  brand,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "variant" | "size"> & { brand: SocialBrand }) {
  const Mark = MARKS[brand]
  return (
    <Button variant="outline" size="lg" data-brand={brand} className={cn("w-full", className)} {...props}>
      {/* 16 px, a touch under a label's line icon (1.15em), as BoardUI's: a full-colour mark reads heavier */}
      <Mark className="size-4" />
      {children}
    </Button>
  )
}

export { SocialButton }
