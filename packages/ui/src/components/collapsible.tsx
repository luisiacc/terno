"use client"

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible"
import { cn } from "cn"
import { ChevronDown } from "@terno/ui/icons"

/**
 * BoardUI's accordion look for one disclosure (plan 125) on Base UI's Collapsible: the trigger is a real button with
 * `aria-expanded`, its chevron at the end turning to point up; the panel's height eases open and shut within --motion
 * (none when motion is reduced or off). A closed panel isn't rendered (no work until it opens) unless `keepMounted`.
 */
function Collapsible(props: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

/** the trigger row and its chevron, shared with Accordion */
const disclosureTrigger =
  "group/disclosure flex w-full cursor-pointer items-center gap-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
const disclosureChevron =
  "ms-auto size-4 shrink-0 text-muted-foreground transition-[rotate,color] group-hover/disclosure:text-foreground group-data-panel-open/disclosure:rotate-180 group-data-panel-open/disclosure:text-foreground"

/** The trigger row: what it opens (children), then the chevron (`chevron={false}` leaves it out). */
function CollapsibleTrigger({ className, children, chevron = true, ...props }: CollapsiblePrimitive.Trigger.Props & { chevron?: boolean }) {
  return (
    <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" className={cn(disclosureTrigger, className)} {...props}>
      {children}
      {chevron && <ChevronDown aria-hidden data-slot="collapsible-chevron" className={disclosureChevron} />}
    </CollapsiblePrimitive.Trigger>
  )
}

/**
 * The panel, its height animated from Base UI's --collapsible-panel-height. It clips while it moves, so it reaches
 * 4 px past its sides (padded back in) to leave room for the focus rings of controls at its edges.
 */
function CollapsiblePanel({ className, ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-panel"
      className={cn(
        "-mx-1 h-(--collapsible-panel-height) overflow-hidden px-1 transition-[height] duration-base ease-motion data-ending-style:h-0 data-starting-style:h-0 [&[hidden]:not([hidden=until-found])]:hidden",
        className
      )}
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsiblePanel, disclosureTrigger, disclosureChevron }
