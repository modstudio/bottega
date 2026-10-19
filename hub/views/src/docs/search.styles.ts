import { variant } from '@bottega/hub-ui/text/variant'

export const searchStyles = variant({
  slots: {
    result: 'cursor-pointer rounded-sm px-2.5 py-2',
    snippet: 'mt-0.5 text-sm text-text-muted leading-5',
    highlight: 'bg-surface-sunken text-text-primary',
    resultHeading: 'flex items-baseline gap-2',
    resultTitle: 'text-md text-text-primary',
    resultSpace: 'text-text-muted text-xs',
    dialog: 'top-[12vh] max-h-[min(35rem,80vh)]',
    searchHeader: 'flex items-center gap-2.5 border-border-default border-b px-3.5 py-3',
    searchField: 'min-w-0 flex-1',
    results: 'max-h-[min(25rem,56vh)] overflow-auto px-1.5 py-2',
    hint: 'mx-2.5 my-3.5 text-md text-text-muted',
    footer:
      'flex flex-wrap items-center gap-4 border-border-default border-t px-3.5 py-2 text-text-muted text-xs',
    shortcutKey: 'ml-1',
    scopeLabel: 'ml-auto',
  },
  variants: { selected: { true: { result: 'bg-control-hover' } } },
})
