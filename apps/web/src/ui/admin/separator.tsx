/* Shadcn Admin e16c87f213a5ba5e45964e9b67c792105ec74d26: src/components/ui/separator.tsx. MIT; see public/licenses/shadcn-admin-MIT.txt. */
import * as React from 'react'
import { Separator as SeparatorPrimitive } from 'radix-ui'
import { cn } from './utils'

function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot='separator'
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px',
        className
      )}
      {...props}
    />
  )
}

export { Separator }
