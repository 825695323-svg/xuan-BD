/* Shadcn Admin e16c87f213a5ba5e45964e9b67c792105ec74d26: src/hooks/use-mobile.tsx. MIT; see public/licenses/shadcn-admin-MIT.txt. */
import * as React from 'react'

const MOBILE_BREAKPOINT = 768
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

export function useIsMobile() {
  return React.useSyncExternalStore(
    (callback) => {
      const mql = window.matchMedia(MOBILE_QUERY)
      mql.addEventListener('change', callback)
      return () => mql.removeEventListener('change', callback)
    },
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false
  )
}
