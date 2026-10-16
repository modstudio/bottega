import { variant } from '../text/variant.ts'

export const userMenuStyles = variant({
  slots: {
    slot1: 'min-w-0',
    slot2: 'truncate font-medium',
    slot3: 'truncate text-sm text-text-muted',
    slot4:
      'mx-2 flex w-[calc(100%-1rem)] items-center gap-3 px-[0.8125rem] py-1 text-left hover:bg-control-hover',
    slot5:
      'grid size-7 shrink-0 place-items-center border border-border-default bg-surface-sunken font-medium text-text-secondary text-xs',
    slot6: 'min-w-0 truncate group-data-collapsed/rail:sr-only',
    slot7: 'block truncate font-medium text-sm',
    slot8: 'block truncate text-text-muted text-xs',
  },
})
