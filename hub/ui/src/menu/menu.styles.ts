import { type Align, panelClasses, placementClasses, type Side } from '../popover/placement.ts'
import { variant } from '../text/variant.ts'

export const menuStyles = variant({
  slots: {
    root: '',
    header: 'mb-1 border-border-subtle border-b px-3 pt-1.5 pb-2',
  },
  variants: { danger: { true: 'text-status-text' } },
})

export const menuPanelStyles = (side: Side, align: Align) =>
  variant({ base: [placementClasses(side, align), panelClasses, 'min-w-44 py-1'] })

export const menuItemStyles = variant({
  base: 'flex h-control-md w-full items-center gap-2 px-3 text-left outline-none hover:bg-control-hover focus-visible:bg-control-hover disabled:text-text-disabled [&_svg]:size-4',
  variants: { danger: { true: 'text-status-text' } },
})
