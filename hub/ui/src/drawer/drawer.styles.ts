import { variant } from '../text/variant.ts'

export const drawerStyles = variant({
  slots: {
    root: 'fixed inset-y-0 right-auto left-0 m-0 h-dvh max-h-none w-[min(86vw,20rem)] max-w-none border-border-default border-r bg-surface-page text-text-primary shadow-overlay transition-[translate] duration-(--duration-base) backdrop:bg-scrim starting:-translate-x-full',
    frame: 'flex h-full flex-col',
    header:
      'flex h-(--topbar-h) shrink-0 items-center justify-between gap-3 border-border-default border-b px-4',
    title: 'font-semibold text-md',
    body: 'min-h-0 flex-1 overflow-y-auto',
  },
})
