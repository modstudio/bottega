import { variant } from '@bottega/hub-ui/text/variant'

export const richToolbarStyles = variant({
  slots: {
    label: 'grid gap-1 text-sm',
    hint: 'text-text-muted',
    root: 'flex h-control-sm min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden',
    block: 'shrink-0 [&>button]:min-w-28',
  },
})
