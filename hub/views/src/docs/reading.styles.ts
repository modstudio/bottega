import { variant } from '@bottega/hub-ui/text/variant'

export const readingStyles = variant({
  slots: {
    replacement: 'inline-flex items-center gap-1.5',
    pagination:
      'doc-measure -mb-8 md:-mb-9 mt-14 flex items-center justify-between gap-4 border-border-default border-t py-5 text-md text-text-muted',
    previous: 'text-left hover:text-text-primary',
    next: 'text-right hover:text-text-primary',
    summary: 'doc-measure mt-3.5 text-lg text-text-muted',
    body: 'mt-6',
    empty: 'text-md text-text-muted',
  },
})
