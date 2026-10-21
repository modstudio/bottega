import { variant } from '@bottega/hub-ui/text/variant'

export const passwordResetStyles = variant({
  slots: {
    form: 'max-w-sm space-y-4',
    label: 'block space-y-1',
    link: 'text-link hover:underline',
    error: 'text-status-text',
  },
})
