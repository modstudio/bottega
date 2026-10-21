import { variant } from '@bottega/hub-ui/text/variant'

export const treeViewStyles = variant({
  slots: {
    documentRow: 'min-w-0 flex-1 rounded-sm px-2 py-1 text-left',
    groupHeading: 'font-mono text-text-muted text-xs tracking-[0.14em] uppercase px-2',
    documentTitle: 'line-clamp-2 text-pretty',
    disabledTitle: 'line-clamp-2 text-pretty',
    treeItem: 'm-0',
    row: 'group relative flex items-start',
    // The handle sits in the gutter left of the title, so it takes no room from the title; on a
    // touch screen, where reordering by drag is not offered, it is not shown at all.
    dragHandle:
      'absolute top-0.5 -left-4 grid h-6 w-4 touch-none cursor-grab place-items-center rounded-sm text-text-muted opacity-0 hover:bg-control-hover hover:text-text-primary focus:opacity-100 focus-visible:outline-2 focus-visible:outline-focus-ring group-focus-within:opacity-100 group-hover:opacity-100 active:cursor-grabbing [@media(any-hover:none)]:hidden',
    gripVertical: 'size-3.5',
    toggle:
      'grid size-7 shrink-0 cursor-pointer place-items-center rounded-sm text-text-muted hover:bg-control-hover hover:text-text-primary',
    chevronDown: 'size-3.5',
    chevronRight: 'size-3.5',
    children: 'my-1 ml-2 border-border-default border-l pl-2',
    tree: 'm-0 list-none p-0 text-md',
    group: 'mt-2.5 first:mt-0',
  },
  variants: {
    state: {
      disabled: { documentRow: 'text-text-secondary' },
      ancestor: { documentRow: 'font-medium text-text-primary' },
      current: { documentRow: 'bg-accent-fill text-accent-on-fill hover:bg-accent-fill-hover' },
      ancestorLink: { documentRow: 'font-medium text-text-primary hover:bg-control-hover' },
      link: { documentRow: 'text-text-secondary hover:bg-control-hover' },
    },
  },
})
