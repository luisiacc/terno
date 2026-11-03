"use client"

import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion"
import { cn } from "cn"
import { ChevronDown } from "@terno/ui/icons"
import { disclosureChevron, disclosureTrigger } from "@terno/ui/components/collapsible"

/**
 * BoardUI's accordion (plan 125) on Base UI's: stacked sections that open in place, one at a time or several
 * (`multiple`). Each header is a heading holding a real button (`aria-expanded`), its chevron at the end turning to
 * point up; a panel's height eases from Base UI's --accordion-panel-height within --motion. A closed panel isn't
 * rendered unless `keepMounted`. Collapsible draws one disclosure the same way.
 */
function Accordion({ className, ...props }: AccordionPrimitive.Root.Props) {
  return <AccordionPrimitive.Root data-slot="accordion" className={cn("flex flex-col", className)} {...props} />
}

function AccordionItem(props: AccordionPrimitive.Item.Props) {
  return <AccordionPrimitive.Item data-slot="accordion-item" {...props} />
}

const HEADINGS = { 2: <h2 />, 3: <h3 />, 4: <h4 />, 5: <h5 />, 6: <h6 /> }

/** The header row: a heading (`level`, 3 by default) around the trigger, its content then the chevron. */
function AccordionTrigger({ className, children, level = 3, ...props }: AccordionPrimitive.Trigger.Props & { level?: keyof typeof HEADINGS }) {
  return (
    <AccordionPrimitive.Header data-slot="accordion-header" render={HEADINGS[level]} className="flex">
      <AccordionPrimitive.Trigger data-slot="accordion-trigger" className={cn(disclosureTrigger, className)} {...props}>
        {children}
        <ChevronDown aria-hidden data-slot="accordion-chevron" className={disclosureChevron} />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

/** The panel: as CollapsiblePanel, on --accordion-panel-height. */
function AccordionPanel({ className, ...props }: AccordionPrimitive.Panel.Props) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-panel"
      className={cn(
        "-mx-1 h-(--accordion-panel-height) overflow-hidden px-1 transition-[height] duration-base ease-motion data-ending-style:h-0 data-starting-style:h-0 [&[hidden]:not([hidden=until-found])]:hidden",
        className
      )}
      {...props}
    />
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionPanel }
