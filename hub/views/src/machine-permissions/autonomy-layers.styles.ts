import { variant } from '@bottega/hub-ui/text/variant'

export const autonomyLayersStyles = variant({
  slots: {
    layer: 'block min-w-36 text-text-primary',
    select: 'w-auto min-w-24',
    hint: 'block text-text-muted text-xs',
    cell: 'rounded-sm border-l-2 border-transparent pl-1.5',
    value: 'font-mono text-sm',
    effect: 'block font-medium font-mono text-sm text-text-primary',
  },
  variants: {
    wins: {
      true: { cell: 'border-status-fill bg-status-surface' },
      false: {},
    },
    set: {
      true: { value: 'text-text-primary' },
      false: { value: 'text-text-muted' },
    },
  },
})
