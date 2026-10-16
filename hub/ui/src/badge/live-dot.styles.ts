import { variant } from '../text/variant.ts'

export const liveDotStyles = variant({
  slots: {
    slot1:
      'relative inline-block size-1.5 shrink-0 rounded-full bg-status-fill motion-safe:animate-pulse',
    slot2: 'sr-only',
  },
})
