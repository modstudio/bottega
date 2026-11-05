import { variant } from '@bottega/hub-ui/text/variant'

export const permissionMatrixStyles = variant({
  slots: {
    column: 'w-44',
    reason: 'min-w-0 flex-1',
    add: 'flex min-w-0 items-center gap-2',
    groupLine: 'flex w-full items-center gap-1.5',
    groupButton: 'flex items-baseline gap-2 text-left',
    groupChevron: '-rotate-90 size-3.5 shrink-0 self-center text-text-muted transition-transform',
    groupLabel: 'font-serif text-md text-text-primary',
    groupSummary: 'ml-auto shrink-0 font-mono text-text-secondary text-xs',
    label: 'block text-text-primary',
    rule: 'block break-all font-mono text-text-muted text-xs',
    cell: 'rounded-sm border-l-2 border-transparent pl-1.5',
    footer: 'flex flex-col gap-2',
    saveBar: 'flex flex-wrap items-center gap-2',
    saveCount: 'font-mono text-sm text-text-secondary',
    refusal: 'text-sm text-text-muted',
  },
  variants: {
    value: {
      none: {},
      inherit: {},
      allow: { cell: 'border-status-fill' },
      ask: { cell: 'border-status-fill' },
      deny: { cell: 'border-status-fill' },
      drop: { cell: 'border-status-fill' },
    },
    open: {
      true: { groupChevron: 'rotate-0' },
      false: {},
    },
    changed: {
      true: { cell: 'bg-status-surface' },
      false: {},
    },
  },
})
