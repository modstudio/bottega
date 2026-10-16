import { variant } from '../text/variant.ts'

export const calloutStyles = variant({
  slots: {
    root: 'border border-status-border bg-status-surface px-4 py-3',
    title: 'font-medium text-sm text-status-text',
    body: 'text-sm text-text-secondary',
  },
})
