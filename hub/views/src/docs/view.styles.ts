import { variant } from '@bottega/hub-ui/text/variant'

export const viewStyles = variant({
  slots: {
    root: 'flex flex-col',
    grid: 'mx-auto grid min-h-0 w-full flex-1 grid-cols-1 lg:min-h-[calc(100dvh-var(--docs-stick))]',
    projectControls: 'ml-auto flex flex-wrap items-center gap-3',
    projectPicker: 'flex items-center gap-2',
    projectLabel: 'font-mono text-text-muted text-xs tracking-[0.14em] uppercase',
    activeProject: 'bg-accent-fill px-1.5 font-mono text-accent-on-fill text-xs',
    chrome: 'docs-chrome-rule relative z-20 bg-inherit lg:sticky lg:top-(--docs-top)',
    chromeBody:
      'mx-auto flex w-full min-h-(--docs-chrome-h) max-w-(--docs-width) flex-wrap items-center justify-between gap-3 px-5 py-2',
    chromeTitle: 'font-serif text-lg',
    rail: 'flex',
    searchButton:
      'mb-4 flex h-control-md w-full shrink-0 items-center justify-between border border-border-default bg-surface-page px-2.5 text-left text-md text-text-muted transition-colors duration-(--duration-fast) hover:border-border-strong',
    // The scroll box reaches into the rail's padding so the reorder handles, which sit in the
    // gutter left of each title, are not clipped; the titles keep their place.
    railBody: 'min-h-0 flex-1 -ml-4 overflow-y-auto pl-4',
    loading: 'text-md text-text-muted',
    empty: 'mt-4 text-md text-text-muted',
    content: 'px-4 md:px-8',
  },
  variants: {
    framed: {
      true: {
        root: 'site-docs-chrome min-h-dvh bg-surface-sunken [--docs-top:var(--site-nav-h)] [--docs-stick:calc(var(--docs-top)+var(--docs-chrome-h))]',
      },
      false: {
        root: 'min-h-[calc(100dvh-var(--topbar-h))] bg-surface-page [--docs-top:var(--topbar-h)] [--docs-stick:var(--docs-top)] md:-mt-6 -mx-4 -mb-8 md:-mx-8',
      },
    },
    wide: {
      true: { grid: 'lg:grid-cols-[var(--docs-rail)_minmax(0,1fr)]' },
      false: {
        grid: 'max-w-(--docs-width) lg:grid-cols-[var(--docs-rail)_minmax(0,1fr)_var(--docs-rail)]',
      },
    },
    inDrawer: {
      true: { rail: 'h-full flex-col p-4' },
      false: {
        rail: 'max-h-[min(24rem,70dvh)] flex-col border-border-default border-b p-5 lg:sticky lg:top-(--docs-stick) lg:max-h-[calc(100dvh-var(--docs-stick))] lg:self-start lg:border-b-0',
      },
    },
  },
})
