import { variant } from '@bottega/hub-ui/text/variant'

export const documentEditorStyles = variant({
  slots: {
    title: 'doc-title doc-editor-title',
    body: 'mt-6',
    loading: 'doc-editor-loading',
    banner: 'text-status-text',
    band: 'doc-measure -mx-1 z-[9] mt-3 flex h-control-sm items-center gap-3 bg-surface-page px-1 lg:sticky lg:top-[calc(var(--docs-stick)+var(--docs-reading-top))]',
    toolbar: 'flex min-w-0 flex-1 items-center',
    reasonLabel: 'grid gap-1 text-sm',
    reasonText: 'text-text-muted',
  },
})
