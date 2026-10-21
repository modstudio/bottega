import { useSyncExternalStore } from 'react'

/** Below this width the app uses its phone chrome: drawer, toolbar band, full-screen panels. */
export const PHONE_QUERY = '(max-width: 767px)'

/** Whether a media query matches, kept current as the window changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}
