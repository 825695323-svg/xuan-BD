/* Shadcn Admin e16c87f213a5ba5e45964e9b67c792105ec74d26: src/components/ui/skeleton.tsx. MIT; see public/licenses/shadcn-admin-MIT.txt. */
import { cn } from './utils'

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='skeleton'
      className={cn('animate-pulse rounded-md bg-accent', className)}
      {...props}
    />
  )
}

export { Skeleton }
