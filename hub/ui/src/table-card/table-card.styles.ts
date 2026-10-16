import { variant } from '../text/variant.ts'

export const tableCardStyles = variant({
  slots: {
    filters: 'shrink-0 items-center gap-2',
    filterTrigger: 'shrink-0',
    card: 'flex min-w-0 flex-1 flex-col border border-border-default bg-surface-page',
    slot1:
      'grid size-4 place-items-center rounded-full bg-accent-fill text-xs text-accent-on-fill tabular-nums',
    slot2: 'flex min-w-60 flex-col gap-2 [&_button[role=combobox]]:w-full',
    slot3: 'flex min-h-9 min-w-0 flex-nowrap items-center gap-2',
    slot4: 'mr-2 flex shrink-0 items-baseline gap-2 whitespace-nowrap',
    slot5: 'flex shrink-0 items-center',
    slot6: 'min-w-40 shrink basis-60',
    slot7: 'shrink-0',
    slot8: 'hidden shrink-0 text-sm text-text-muted @3xl/card:block',
    slot9: 'ml-auto flex shrink-0 items-center gap-2',
    slot10: 'flex items-baseline gap-2',
    slot11: '@container/card flex min-w-0 flex-col gap-3',
    slot12: 'flex min-h-0 min-w-0',
    slot13: '@container/rows relative min-w-0 overflow-auto',
    slot14: 'border-border-default border-t px-3 py-2',
  },
  variants: { panel: { true: 'border-r-0' } },
})
