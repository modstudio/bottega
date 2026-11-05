import { variant } from '@bottega/hub-ui/text/variant'

export const autonomyLayersStyles = variant({
  slots: {
    named: 'inline-flex items-center gap-1 whitespace-nowrap text-text-primary',
    select: 'w-auto min-w-24',
    hint: 'block text-text-muted text-xs',
    value: 'font-mono text-sm',
    effect: 'block font-medium font-mono text-sm text-text-primary',
  },
  variants: {
    set: {
      true: { value: 'text-text-primary' },
      false: { value: 'text-text-muted' },
    },
  },
})
