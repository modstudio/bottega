import { variant } from '@bottega/hub-ui/text/variant'

export const taskRailStyles = variant({
  slots: {
    rail: 'bg-surface-page',
    back: 'flex w-full cursor-pointer items-center gap-1.5 text-sm text-text-muted hover:text-text-primary',
    facts: 'grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-sm',
    fact: 'contents',
    factLabel: 'text-text-muted',
    factValue: 'min-w-0 text-text-primary',
    contents: 'space-y-6',
    doc: 'flex min-w-0 items-center gap-1.5',
    docIcon: 'shrink-0',
    docTitle: 'truncate',
    nothing: 'text-sm text-text-muted',
  },
})
