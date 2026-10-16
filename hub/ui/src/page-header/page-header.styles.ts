import { variant } from '../text/variant.ts'

export const pageHeaderStyles = variant({
  slots: {
    portalRoot: 'flex min-w-0 flex-1 items-center gap-4',
    portalHeading: 'flex min-w-0 items-baseline gap-3',
    portalTitle: 'shrink-0 font-normal font-serif text-xl',
    portalSubtitle: 'hidden truncate text-sm text-text-muted lg:inline',
    portalActions: 'ml-auto flex shrink-0 items-center gap-2',
    pageHeader: 'flex min-w-0 flex-wrap items-end justify-between gap-x-6 gap-y-3 pt-6 pb-5',
    pageHeading: 'min-w-0',
    pageTitle: 'font-normal font-serif text-2xl tracking-tight',
    pageSubtitle: 'mt-1 truncate text-sm text-text-muted',
    pageActions: 'flex flex-wrap items-center gap-2',
    sectionHeader: 'mt-8 mb-3 flex items-baseline justify-between gap-4',
    sectionHeading: 'font-normal font-serif text-md',
    sectionDetail: 'text-right text-sm text-text-muted',
  },
})
