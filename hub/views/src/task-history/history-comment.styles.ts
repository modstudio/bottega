import { variant } from '@bottega/hub-ui/text/variant'

export const historyCommentStyles = variant({
  slots: {
    root: '@container/comment group/comment',
    head: 'flex min-h-6 items-center gap-3 text-md text-text-secondary',
    kind: 'min-w-0 flex-1 truncate',
    agent: 'text-text-muted',
    actions:
      'flex shrink-0 items-center gap-4 opacity-0 transition-opacity duration-(--duration-fast) pointer-events-none group-hover/comment:pointer-events-auto group-hover/comment:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 [@media(any-hover:none)]:pointer-events-auto [@media(any-hover:none)]:opacity-100',
    inline: 'flex items-center gap-4 @max-sm/comment:hidden',
    compact: 'hidden @max-sm/comment:flex',
    action:
      'inline-flex cursor-pointer items-center gap-1 text-text-muted text-xs hover:text-text-primary hover:underline',
    more: 'inline-flex size-6 cursor-pointer items-center justify-center text-icon-muted hover:text-text-primary',
    confirm: 'flex shrink-0 items-center gap-2 text-sm text-text-secondary',
    time: 'shrink-0 font-mono text-text-muted text-xs tabular-nums',
    body: 'mt-1 text-md text-text-primary',
    editor: 'mt-2 border border-border-default bg-surface-page px-3 py-2',
    error: 'mt-2 text-sm text-status-text',
    editActions: 'mt-2 flex items-center justify-end gap-2',
  },
})
