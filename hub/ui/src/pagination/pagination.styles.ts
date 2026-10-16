import { variant } from '../text/variant.ts'

export const paginationStyles = variant({
  slots: {
    root: 'flex items-center justify-between gap-3 text-sm text-text-secondary',
    slot1: 'tabular-nums',
    slot2: 'flex items-center gap-2',
    slot3: 'max-sm:hidden',
    slot4: 'min-w-0',
    slot5: 'min-w-16 text-center tabular-nums max-sm:hidden',
  },
})
