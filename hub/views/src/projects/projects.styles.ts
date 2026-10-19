import { variant } from '@bottega/hub-ui/text/variant'

export const projectsStyles = variant({
  slots: {
    project: 'flex items-center gap-2 font-semibold',
    loading: 'text-text-muted',
    error: 'text-status-text',
  },
})
