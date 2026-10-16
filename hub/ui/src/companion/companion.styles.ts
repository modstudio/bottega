import { variant } from '../text/variant.ts'

export const companionStyles = variant({
  slots: {
    root: 'flex flex-col bg-surface-page outline-none',
    slot1:
      'absolute inset-y-0 -left-1 w-2 cursor-col-resize hover:bg-control-hover focus-visible:bg-control-hover',
    slot2: 'flex min-h-14 shrink-0 items-start gap-3 border-border-default border-b px-4 py-3',
    slot3: 'min-w-0 flex-1',
    slot4: 'truncate font-semibold text-lg',
    slot5: 'mt-0.5 text-sm text-text-secondary',
    slot6: 'flex shrink-0 items-center gap-2',
    slot7: '@container/panel min-h-0 flex-1 overflow-y-auto p-4',
    slot8: 'shrink-0 border-border-default border-t p-4',
    slot9: 'flex min-w-0 items-start gap-4',
    slot10: 'min-w-0 flex-1',
  },
  variants: {
    phone: {
      true: { root: 'fixed inset-0 z-(--z-sheet)' },
      false: {
        root: 'relative sticky top-[calc(var(--topbar-h)+1rem)] max-h-[calc(100dvh-var(--topbar-h)-2rem)] shrink-0 self-start border border-border-default',
      },
    },
  },
})
