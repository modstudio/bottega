import { variant } from '../text/variant.ts'

export const tabsStyles = variant({
  slots: {
    slot1: 'flex min-w-0 gap-4 overflow-x-auto border-border-default border-b',
    slot2: 'text-sm text-text-muted tabular-nums',
  },
})

export const tabStyles = variant({
  base: '-mb-px flex h-9 shrink-0 items-center gap-1.5 border-b-2 text-text-secondary hover:text-text-primary',
  variants: {
    selected: {
      true: 'border-accent-fill font-medium',
      false: 'border-transparent',
    },
  },
})
