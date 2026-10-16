import { variant } from '../text/variant.ts'

export const companionStyles = variant({
  slots: {
    root: 'flex flex-col bg-surface-page outline-none',
    resizeHandle:
      'absolute inset-y-0 -left-1 w-2 cursor-col-resize hover:bg-control-hover focus-visible:bg-control-hover',
    header: 'flex min-h-14 shrink-0 items-start gap-3 border-border-default border-b px-4 py-3',
    heading: 'min-w-0 flex-1',
    title: 'truncate font-semibold text-lg',
    subtitle: 'mt-0.5 text-sm text-text-secondary',
    actions: 'flex shrink-0 items-center gap-2',
    body: '@container/panel min-h-0 flex-1 overflow-y-auto p-4',
    footer: 'shrink-0 border-border-default border-t p-4',
    dockedLayout: 'flex min-w-0 items-start gap-4',
    dockedContent: 'min-w-0 flex-1',
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
