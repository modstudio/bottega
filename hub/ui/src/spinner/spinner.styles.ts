import { variant } from '../text/variant.ts'

export const spinnerStyles = variant({
  slots: {
    root: 'inline-flex',
    slot1: 'size-4 animate-spin text-text-muted motion-reduce:animate-none',
    slot2: 'sr-only',
  },
})
