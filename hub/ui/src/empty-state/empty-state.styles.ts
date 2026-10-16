import { variant } from '../text/variant.ts'

export const emptyStateStyles = variant({
  slots: {
    slot1: 'flex flex-col items-center gap-1 px-6 py-10 text-center',
    slot2: 'font-medium',
    slot3: 'max-w-md text-sm text-text-muted',
    slot4: 'mt-3',
  },
})
