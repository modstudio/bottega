import { variant } from '../text/variant.ts'

export const fieldGroupStyles = variant({
  slots: {
    root: 'grid min-w-0 gap-2',
    legend: 'font-medium text-sm text-text-secondary',
    content: 'grid gap-2',
  },
})
