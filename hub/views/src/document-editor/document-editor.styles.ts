import { variant } from '@bottega/hub-ui/text/variant'

export const documentEditorStyles = variant({
  slots: {
    title: 'doc-title doc-editor-title',
    body: 'mt-6',
    loading: 'doc-editor-loading',
    banner: 'text-status-text',
    band: 'doc-measure -mx-1 z-[9] mt-3 flex min-h-control-sm flex-wrap items-center gap-x-3 gap-y-2 bg-surface-page px-1 md:flex-nowrap lg:sticky lg:top-[calc(var(--docs-stick)+var(--docs-reading-top))]',
    toolbar: 'flex min-w-0 basis-full items-center md:basis-0 md:flex-1',
    mode: 'shrink-0',
    reasonLabel: 'grid gap-1 text-sm',
    reasonText: 'text-text-muted',
  },
})
