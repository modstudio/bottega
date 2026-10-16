import { variant } from '../text/variant.ts'

export const calloutStyles = variant({
  slots: {
    slot1: 'border border-status-border bg-status-surface px-4 py-3',
    slot2: 'font-medium text-sm text-status-text',
    slot3: 'text-sm text-text-secondary',
  },
})
