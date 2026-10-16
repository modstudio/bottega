import { variant } from '../text/variant.ts'

export const pageHeaderStyles = variant({
  slots: {
    slot1: 'flex min-w-0 flex-1 items-center gap-4',
    slot2: 'flex min-w-0 items-baseline gap-3',
    slot3: 'shrink-0 font-normal font-serif text-xl',
    slot4: 'hidden truncate text-sm text-text-muted lg:inline',
    slot5: 'ml-auto flex shrink-0 items-center gap-2',
    slot6: 'flex min-w-0 flex-wrap items-end justify-between gap-x-6 gap-y-3 pt-6 pb-5',
    slot7: 'min-w-0',
    slot8: 'font-normal font-serif text-2xl tracking-tight',
    slot9: 'mt-1 truncate text-sm text-text-muted',
    slot10: 'flex flex-wrap items-center gap-2',
    slot11: 'mt-8 mb-3 flex items-baseline justify-between gap-4',
    slot12: 'font-normal font-serif text-md',
    slot13: 'text-right text-sm text-text-muted',
  },
})
