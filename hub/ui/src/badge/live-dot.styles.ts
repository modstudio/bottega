import { variant } from '../text/variant.ts'

export const liveDotStyles = variant({
  slots: {
    indicator:
      'relative inline-block size-1.5 shrink-0 rounded-full bg-status-fill motion-safe:animate-pulse',
    label: 'sr-only',
  },
})
