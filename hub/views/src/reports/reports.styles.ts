import { variant } from '@bottega/hub-ui/text/variant'

export const reportsStyles = variant({
  slots: {
    error: 'text-status-text',
    loading: 'text-text-muted',
    tableFrame: 'overflow-x-auto border border-border-default',
    detail: 'text-xs text-text-muted',
    wideDetail: 'max-w-xs text-xs text-text-muted',
  },
})
