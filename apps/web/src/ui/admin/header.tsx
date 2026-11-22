/* Shadcn Admin e16c87f213a5ba5e45964e9b67c792105ec74d26: src/components/layout/header.tsx. MIT; see public/licenses/shadcn-admin-MIT.txt. */
import { useEffect, useState } from 'react'
import { cn } from './utils'
import { Separator } from './separator'
import { SidebarTrigger } from './sidebar'

type HeaderProps = React.HTMLAttributes<HTMLElement> & {
  fixed?: boolean
  sidebarTrigger?: { label: string; expanded: boolean }
  ref?: React.Ref<HTMLElement>
}

export function Header({ className, fixed, sidebarTrigger, children, ...props }: HeaderProps) {
  const [offset, setOffset] = useState(0)

  useEffect(() => {
    const onScroll = () => {
      setOffset(document.body.scrollTop || document.documentElement.scrollTop)
    }

    // Add scroll listener to the body
    document.addEventListener('scroll', onScroll, { passive: true })

    // Clean up the event listener on unmount
    return () => document.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header
      className={cn(
        'z-50 h-16',
        fixed && 'header-fixed peer/header sticky top-0 w-[inherit]',
        offset > 10 && fixed ? 'shadow' : 'shadow-none',
        className
      )}
      {...props}
    >
      <div
        className={cn(
          'relative flex h-full items-center gap-3 p-4 sm:gap-4',
          offset > 10 &&
            fixed &&
            'after:absolute after:inset-0 after:-z-10 after:bg-background/20 after:backdrop-blur-lg'
        )}
      >
        {sidebarTrigger && <>
          <SidebarTrigger type='button' variant='outline' aria-label={sidebarTrigger.label} aria-expanded={sidebarTrigger.expanded} />
          <Separator orientation='vertical' className='h-6' />
        </>}
        {children}
      </div>
    </header>
  )
}
