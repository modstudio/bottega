import { variant } from '../text/variant.ts'

export const userMenuStyles = variant({
  slots: {
    header: 'min-w-0',
    name: 'truncate font-medium',
    detail: 'truncate text-sm text-text-muted',
    trigger:
      'mx-2 flex w-[calc(100%-1rem)] items-center gap-3 px-[0.8125rem] py-1 text-left hover:bg-control-hover',
    avatar:
      'grid size-7 shrink-0 place-items-center border border-border-default bg-surface-sunken font-medium text-text-secondary text-xs',
    triggerText: 'min-w-0 truncate group-data-collapsed/rail:sr-only',
    triggerName: 'block truncate font-medium text-sm',
    triggerDetail: 'block truncate text-text-muted text-xs',
  },
})
