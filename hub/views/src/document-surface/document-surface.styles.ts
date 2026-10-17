import { variant } from '@bottega/hub-ui/text/variant'

export const documentSurfaceStyles = variant({
  slots: {
    main: 'min-w-0 border-border-default bg-surface-page px-6 pt-5 pb-8 md:px-15 md:pt-6 md:pb-9 lg:border-x [.site-docs-chrome_&]:border-b',
    top: '-mx-6 md:-mx-15 z-10 flex lg:sticky lg:top-(--docs-stick) items-center justify-between gap-4 border-b bg-surface-page px-6 py-2.5 md:px-15',
    crumbs:
      'font-mono text-text-muted text-xs tracking-[0.14em] uppercase flex min-w-0 items-baseline gap-2 overflow-hidden whitespace-nowrap',
    actions: 'flex shrink-0 items-center gap-2',
    crumb: 'contents',
    goneTitle: 'min-w-0 truncate text-text-primary',
    wideControl: 'hidden lg:inline-flex',
    error: 'text-status-text',
    title: 'doc-title',
    empty: 'text-md text-text-muted',
  },
  variants: {
    titleGone: { true: { top: 'border-border-default' }, false: { top: 'border-transparent' } },
    long: { true: { title: '' } },
  },
})
