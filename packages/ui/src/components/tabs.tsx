"use client"

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

// BoardUI's tabs (plan 120): by default the segmented control's track (ToggleGroup variant="segmented"); `line` is its
// row of tabs over a hairline, the chosen one in the primary with a 2 px underline
const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center text-muted-foreground group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col",
  {
    variants: {
      variant: {
        default: "gap-0.5 rounded-[calc(var(--radius-md)+var(--spacing)*0.5)] bg-field p-0.5 group-data-horizontal/tabs:h-8 dark:bg-background",
        line: "hairline-b gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex items-center justify-center gap-1.5 group-data-horizontal/tabs:flex-1 text-sm font-medium whitespace-nowrap transition-colors outline-none group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[1.15em]",
        // the thumb on the track
        "h-7 rounded-md px-2.5 text-muted-foreground hover:text-foreground data-active:bg-card data-active:text-foreground data-active:shadow-xs dark:data-active:bg-muted dark:data-active:shadow-[inset_0_1px_var(--highlight),0_1px_2px_var(--shadow-color)]",
        // a tab over the line: the chosen one in the primary, underlined
        "group-data-[variant=line]/tabs-list:h-auto group-data-[variant=line]/tabs-list:rounded-sm group-data-[variant=line]/tabs-list:py-2 group-data-[variant=line]/tabs-list:font-normal group-data-[variant=line]/tabs-list:text-foreground group-data-[variant=line]/tabs-list:data-active:bg-transparent group-data-[variant=line]/tabs-list:data-active:font-medium group-data-[variant=line]/tabs-list:data-active:text-primary group-data-[variant=line]/tabs-list:data-active:shadow-none dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:shadow-none",
        "after:absolute after:bg-primary after:opacity-0 group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-0 group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:right-0 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
