import { variant } from '@bottega/hub-ui/text/variant'

export const taskRailStyles = variant({
  slots: {
    rail: 'hidden bg-surface-page lg:block',
    back: 'flex w-full cursor-pointer items-center gap-1.5 text-sm text-text-muted hover:text-text-primary',
    facts: 'grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-sm',
    fact: 'contents',
    factLabel: 'text-text-muted',
    factValue: 'min-w-0 text-text-primary',
    extra: 'mt-6 border-border-default border-t pt-5',
    contents: 'space-y-6',
    doc: 'flex min-w-0 items-center gap-1.5',
    docIcon: 'shrink-0',
    docTitle: 'truncate',
    nothing: 'text-sm text-text-muted',
    narrow: 'doc-measure mt-6 space-y-6 border-border-default border-y py-5 lg:hidden',
  },
})
