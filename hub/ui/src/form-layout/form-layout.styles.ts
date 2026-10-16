import { variant } from '../text/variant.ts'

export const formLayoutStyles = variant({
  slots: {
    copyable: 'flex min-w-0 items-center gap-2',
    slot1: 'flex flex-col gap-4 border-border-subtle border-t pt-5 first:border-t-0 first:pt-0',
    slot2: 'font-semibold text-md',
    slot3: 'mt-1 text-sm text-text-secondary',
    slot4: 'flex flex-col gap-1.5',
    slot5: 'font-medium text-sm text-text-secondary',
    slot6: 'text-sm text-text-muted',
    slot7: '@container/row border-border-subtle border-b py-2.5 last:border-b-0',
    slot8: 'grid gap-1 @md/row:grid-cols-[9rem_minmax(0,1fr)] @md/row:gap-4',
    slot9: 'text-sm text-text-muted',
    slot10: 'min-w-0 break-words',
    slot11: 'min-w-0 flex-1 break-all font-mono',
  },
  variants: { compact: { true: 'text-sm text-text-muted' } },
})
