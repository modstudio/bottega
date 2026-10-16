import { variant } from '../text/variant.ts'

export const badgeStyles = variant({
  slots: {
    root: 'inline-flex h-5 max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 font-medium text-xs',
    slot1: 'size-1.5 shrink-0 rounded-full bg-current',
    slot2: '-ml-0.5 size-3 shrink-0',
    slot3: 'truncate',
  },
  variants: {
    emphasis: {
      subtle: 'border-status-border bg-status-surface text-status-text',
      solid: 'border-transparent bg-status-fill text-status-on-fill',
    },
    identifier: { true: 'font-mono' },
  },
  defaultVariants: { emphasis: 'subtle' },
})
