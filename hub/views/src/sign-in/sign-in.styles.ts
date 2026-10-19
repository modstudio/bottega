import { variant } from '@bottega/hub-ui/text/variant'

export const signInStyles = variant({
  slots: {
    notice: 'mb-4',
    form: 'max-w-sm space-y-4',
    label: 'block space-y-1',
    error: 'text-status-text',
    link: 'text-link hover:underline',
  },
})
