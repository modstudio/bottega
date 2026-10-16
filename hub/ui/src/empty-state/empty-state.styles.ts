import { variant } from '../text/variant.ts'

export const emptyStateStyles = variant({
  slots: {
    root: 'flex flex-col items-center gap-1 px-6 py-10 text-center',
    title: 'font-medium',
    hint: 'max-w-md text-sm text-text-muted',
    action: 'mt-3',
  },
})
