import { variant } from '../text/variant.ts'

export const spinnerStyles = variant({
  slots: {
    root: 'inline-flex',
    icon: 'size-4 animate-spin text-text-muted motion-reduce:animate-none',
    label: 'sr-only',
  },
})
