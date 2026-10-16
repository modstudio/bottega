import { variant } from '../text/variant.ts'

export const bottomSheetStyles = variant({
  slots: {
    root: 'fixed inset-x-0 top-auto bottom-0 max-h-none w-full max-w-none border-border-default border-t bg-surface-overlay text-text-primary shadow-overlay backdrop:bg-scrim starting:translate-y-full',
    slot1: 'flex h-full flex-col',
    slot2: 'flex h-5 shrink-0 cursor-row-resize touch-none items-center justify-center',
    slot3: 'h-1 w-10 rounded-full bg-border-strong',
    slot4: 'flex h-11 shrink-0 items-center justify-between border-border-subtle border-b px-4',
    slot5: 'font-semibold text-md',
    slot6:
      'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 [&_button[role=combobox]]:w-full',
  },
  variants: {
    dragging: { false: 'transition-[translate,height] duration-(--duration-base)' },
  },
})
