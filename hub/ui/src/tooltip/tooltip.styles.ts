import { variant } from '../text/variant.ts'

export const tooltipStyles = variant({
  base: 'pointer-events-none [inset:auto] [position-try-fallbacks:flip-block] my-1 max-w-64 bg-accent-fill px-2 py-1 text-accent-on-fill text-xs',
  variants: {
    side: {
      top: '[position-area:block-start]',
      bottom: '[position-area:block-end]',
    },
  },
  defaultVariants: { side: 'top' },
})
