import { variant } from '@bottega/hub-ui/text/variant'

export const taskPageStyles = variant({
  slots: {
    root: 'h-dvh overflow-y-auto bg-surface-sunken [--docs-stick:0px]',
    grid: 'mx-auto grid min-h-dvh w-full max-w-[calc(var(--docs-measure)+var(--docs-rail)+7.5rem)] grid-cols-1 lg:grid-cols-[minmax(0,1fr)_var(--docs-rail)]',
    description: 'doc-measure mt-6',
    empty: 'doc-measure mt-6 text-md text-text-muted',
    history: 'doc-measure mt-8',
    phoneTabs: '-mx-6 md:-mx-15 sticky top-0 z-10 mb-5 bg-surface-page px-6 md:px-15',
    phonePanel: 'doc-measure',
    back: 'mb-4 flex cursor-pointer items-center gap-1.5 text-sm text-text-muted hover:text-text-primary',
  },
})
