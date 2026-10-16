import { variant } from '../text/variant.ts'

export const sheetStyles = variant({
  slots: {
    root: 'fixed inset-y-0 right-0 left-auto h-dvh max-h-none max-w-full border-border-default border-l bg-surface-page text-text-primary shadow-overlay transition-[translate,opacity] duration-(--duration-base) starting:translate-x-6 starting:opacity-0',
    slot1: 'flex h-full flex-col',
    slot2:
      'flex min-h-(--topbar-h) shrink-0 items-center gap-3 border-border-default border-b px-5 py-2',
    slot3: 'min-w-0 flex-1',
    slot4: 'truncate font-semibold text-xl',
    slot5: 'text-sm text-text-secondary',
    slot6: 'flex shrink-0 items-center gap-2',
    slot7: 'shrink-0 border-border-subtle border-b px-5 py-2',
    slot8: 'shrink-0 px-5 pt-3 text-sm text-text-secondary',
    slot9: 'min-h-0 flex-1 overflow-y-auto px-5 py-4',
    slot10: 'mt-8 border border-status-border p-4',
    slot11: 'flex shrink-0 justify-end gap-2 border-border-default border-t px-5 py-3',
  },
  variants: {
    size: {
      default: { root: 'w-(--sheet-w)' },
      wide: { root: 'w-(--sheet-w-wide)' },
      document: { root: 'w-(--sheet-w-document)' },
    },
  },
  defaultVariants: { size: 'default' },
})
