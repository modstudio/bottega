import { variant } from '../text/variant.ts'

export const toastStyles = variant({
  slots: {
    liveRegion: 'sr-only',
    viewport:
      '[inset:auto] right-4 bottom-4 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 bg-transparent',
    list: 'm-0 flex list-none flex-col gap-2 p-0',
    item: 'flex items-start gap-3 border border-status-border bg-surface-overlay p-3 shadow-overlay transition-[opacity,translate] duration-(--duration-base) starting:translate-y-2 starting:opacity-0',
    message: 'm-0 min-w-0 flex-1 pt-px',
  },
})
