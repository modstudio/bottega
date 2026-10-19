import { variant } from '@bottega/hub-ui/text/variant'

export const revisionViewerStyles = variant({
  slots: {
    selector: 'mt-6',
    selectorHeader: 'mt-2 flex flex-wrap items-center justify-between gap-2',
    loading: 'mt-6 text-md text-text-muted',
    error: 'mt-6',
    empty: 'mt-6 text-md text-text-muted',
    diff: 'mt-6 overflow-x-auto border border-border-default font-mono text-sm',
    hunk: 'border-border-default border-t first:border-t-0',
    line: 'grid grid-cols-[3.5rem_1.5rem_minmax(max-content,1fr)] bg-status-surface',
    lineNumber:
      'border-border-default border-r px-2 py-0.5 text-right text-text-muted tabular-nums',
    marker: 'px-1.5 py-0.5 text-status-text',
    addedLabel: 'sr-only',
    removedLabel: 'sr-only',
    lineText: 'whitespace-pre px-1.5 py-0.5 text-text-primary',
  },
})
