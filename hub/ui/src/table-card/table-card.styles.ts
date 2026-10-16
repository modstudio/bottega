import { variant } from '../text/variant.ts'

export const tableCardStyles = variant({
  slots: {
    filters: 'shrink-0 items-center gap-2',
    filterTrigger: 'shrink-0',
    card: 'flex min-w-0 flex-1 flex-col border border-border-default bg-surface-page',
    filterCount:
      'grid size-4 place-items-center rounded-full bg-accent-fill text-xs text-accent-on-fill tabular-nums',
    filterPanel: 'flex min-w-60 flex-col gap-2 [&_button[role=combobox]]:w-full',
    desktopToolbar: 'flex min-h-9 min-w-0 flex-nowrap items-center gap-2',
    desktopHeading: 'mr-2 flex shrink-0 items-baseline gap-2 whitespace-nowrap',
    tabs: 'flex shrink-0 items-center',
    search: 'min-w-40 shrink basis-60',
    filtersButton: 'shrink-0',
    meta: 'hidden shrink-0 text-sm text-text-muted @3xl/card:block',
    actions: 'ml-auto flex shrink-0 items-center gap-2',
    phoneHeading: 'flex items-baseline gap-2',
    root: '@container/card flex min-w-0 flex-col gap-3',
    body: 'flex min-h-0 min-w-0',
    rows: '@container/rows relative min-w-0 overflow-auto',
    footer: 'border-border-default border-t px-3 py-2',
  },
  variants: {
    panel: { true: { card: 'border-r-0' } },
    filterBand: {
      small: {
        filters: 'hidden @3xl/card:flex',
        filterTrigger: '@3xl/card:hidden',
      },
      medium: {
        filters: 'hidden @5xl/card:flex',
        filterTrigger: '@5xl/card:hidden',
      },
      large: {
        filters: 'hidden @7xl/card:flex',
        filterTrigger: '@7xl/card:hidden',
      },
    },
  },
})
