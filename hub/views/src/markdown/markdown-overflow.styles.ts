import { variant } from '@bottega/hub-ui/text/variant'

export const markdownOverflowStyles = variant({
  slots: {
    root: 'doc-overflow',
    actions: 'doc-overflow-actions',
    scroll: 'doc-overflow-scroll',
    dialog: 'w-[min(96rem,calc(100vw-3rem))] max-w-none',
    full: 'markdown doc-overflow-full',
  },
})
