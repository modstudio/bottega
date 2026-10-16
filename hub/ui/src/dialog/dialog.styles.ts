import { variant } from '../text/variant.ts'

export const dialogStyles = variant({
  slots: {
    root: 'border border-border-default bg-surface-overlay text-text-primary shadow-overlay backdrop:bg-scrim transition-[opacity,scale] duration-(--duration-base) starting:scale-98 starting:opacity-0',
    slot1: 'flex max-h-[inherit] flex-col',
    slot2: 'flex items-start gap-3 px-5 pt-5 pb-3',
    slot3: 'min-w-0 flex-1',
    slot4: 'font-semibold text-lg',
    slot5: 'mt-1 text-text-secondary',
    slot6: 'min-h-0 overflow-y-auto px-5 pb-4',
    slot7: 'flex justify-end gap-2 border-border-default border-t px-5 py-3',
  },
  variants: {
    size: {
      sm: 'w-[min(24rem,calc(100vw-2rem))]',
      md: 'w-[min(32rem,calc(100vw-2rem))]',
      lg: 'w-[min(40rem,calc(100vw-2rem))]',
      full: 'h-dvh w-screen max-w-none',
    },
    chromeless: {
      true: 'fixed inset-x-0 mx-auto',
      false: 'fixed inset-0 m-auto max-h-[calc(100dvh-2rem)]',
    },
  },
  defaultVariants: { size: 'md', chromeless: false },
})
