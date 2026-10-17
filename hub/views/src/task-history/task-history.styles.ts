import { variant } from '@bottega/hub-ui/text/variant'

export const taskHistoryStyles = variant({
  slots: {
    root: 'mt-14 border-border-default border-t pt-6',
    header: 'flex flex-wrap items-center justify-between gap-3',
    heading: 'font-serif text-xl text-text-primary',
    composer: 'mt-5',
    prompt:
      'flex h-control-md w-full cursor-text items-center border border-border-default bg-surface-page px-3 text-left text-md text-text-muted transition-colors duration-(--duration-fast) hover:border-border-strong',
    editor: 'border border-border-default bg-surface-page px-3 py-2',
    composerActions: 'mt-2 flex items-center justify-end gap-2',
    refusal: 'text-md text-text-muted',
    error: 'mt-2 text-sm text-status-text',
    feed: 'mt-6 flex flex-col',
    dayGroup: 'mt-7 first:mt-0',
    day: 'flex items-center gap-2 font-mono text-text-muted text-xs tracking-[0.14em] uppercase after:h-px after:flex-1 after:bg-border-default',
    entry: 'mt-3 grid grid-cols-[1.25rem_1fr] gap-x-3',
    glyph: 'flex h-6 items-center justify-center text-icon-muted',
    line: 'flex min-h-6 items-baseline gap-2 text-md text-text-secondary',
    lineText: 'min-w-0 flex-1',
    strong: 'font-medium text-text-primary',
    arrow: 'text-text-muted',
    time: 'shrink-0 font-mono text-text-muted text-xs tabular-nums',
    toggle: 'shrink-0 cursor-pointer font-mono text-text-muted text-xs hover:text-text-primary',
    changes: 'mt-1 ml-1 flex flex-col gap-1 border-border-default border-l pl-3',
    commentBody: 'mt-1 text-md text-text-primary',
    empty: 'mt-6 text-md text-text-muted',
    live: 'inline-block size-1.5 bg-status-fill',
  },
  variants: {
    running: { true: { live: 'animate-pulse' } },
  },
})
