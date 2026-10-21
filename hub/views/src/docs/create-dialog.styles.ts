import { variant } from '@bottega/hub-ui/text/variant'

export const createDialogStyles = variant({
  slots: {
    fields: 'space-y-3',
    scopeField: 'grid gap-1 text-sm',
    scopeLabel: 'text-text-muted',
    subjectField: 'grid gap-1 text-sm',
    subjectLabel: 'text-text-muted',
    slugField: 'block text-sm',
    slugLabel: 'text-text-muted',
    titleField: 'block text-sm',
    titleLabel: 'text-text-muted',
    deliveryField: 'grid gap-1 text-sm',
    deliveryLabel: 'text-text-muted',
    error: 'text-status-text',
  },
})
