import { variant } from '../text/variant.ts'

export const appShellStyles = variant({
  slots: {
    liveIndicator: 'absolute top-2 left-9 size-1.5 shrink-0 rounded-full bg-status-fill',
    switcherPanel: '-m-3 flex min-w-48 flex-col gap-px p-1',
    groupHeading: 'px-3 pt-2 pb-1 font-medium text-sm text-text-muted',
    nav: 'flex flex-col py-3',
    group: 'flex flex-col gap-px',
    mobileDialog:
      'fixed inset-y-0 left-0 h-dvh max-h-none w-[min(17rem,82vw)] border-border-default border-r bg-surface-page text-text-primary shadow-overlay transition-[translate] duration-(--duration-base) backdrop:bg-scrim starting:-translate-x-full',
    mobileFrame: 'flex h-full flex-col',
    mobileHeader:
      'flex h-topbar shrink-0 items-center justify-between border-border-default border-b px-4',
    mobileNav: 'min-h-0 flex-1 overflow-y-auto',
    mobileFooter: 'border-border-default border-t p-4',
    collapsedBrandName: 'sr-only',
    mobileBrand: 'flex items-center gap-3 whitespace-nowrap font-serif text-xl lowercase',
    pageTitle: 'flex min-w-0 items-center gap-2.5 truncate font-serif text-xl',
    pageIcon: 'size-5 shrink-0 text-text-secondary',
    shell: 'flex min-h-dvh bg-surface-page text-text-primary',
    railNav: 'min-h-0 flex-1 overflow-y-auto overflow-x-hidden',
    railFooter: 'border-border-default border-t py-3',
    workspace: 'flex min-w-0 flex-1 flex-col',
    topbar:
      'sticky top-0 z-(--z-rail) flex h-topbar shrink-0 items-center gap-3 border-border-default border-b bg-surface-page px-4 md:px-8',
    topbarPortal: 'flex min-w-0 flex-1 items-center',
    topbarActions: 'flex shrink-0 items-center gap-2',
    main: 'min-w-0 flex-1 px-4 pb-8 md:px-8 md:pt-6',
  },
})

export const navLinkStyles = variant({
  base: 'relative flex h-10 items-center gap-3 border border-transparent px-[1.0625rem] text-text-secondary outline-none transition-colors hover:bg-control-hover hover:text-text-primary focus-visible:bg-control-hover data-[status=active]:border-border-default data-[status=active]:bg-surface-sunken data-[status=active]:text-text-primary [&_svg]:size-[18px] [&_svg]:shrink-0 [&_svg]:stroke-[1.5]',
  variants: { full: { true: 'w-full' } },
})

export const navLabelStyles = variant({
  variants: {
    hidden: { true: 'sr-only', false: 'truncate' },
    role: {
      switcherLabel: 'flex-1 text-left',
      switcherIcon: 'ml-auto !size-3.5',
    },
  },
})

export const navMarkStyles = variant({
  base: 'ml-auto text-sm text-text-muted tabular-nums',
  variants: { hidden: { true: 'sr-only', false: 'truncate' } },
})

export const navSectionStyles = variant({
  base: 'flex flex-col gap-1 px-2',
  variants: { separated: { true: 'mt-4' } },
})

export const brandToggleStyles = variant({
  base: 'opacity-0 transition-opacity group-hover/brand:opacity-100 has-focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
  variants: { collapsed: { true: 'absolute inset-0 grid place-items-center', false: 'ml-auto' } },
})

export const brandCellStyles = variant({
  base: 'group/brand relative flex h-topbar shrink-0 items-center gap-3 border-border-default border-b',
  variants: { collapsed: { true: 'justify-center', false: 'px-[1.625rem] pr-3' } },
})

export const brandNameStyles = variant({
  base: 'flex items-center gap-3 whitespace-nowrap font-serif text-xl lowercase transition-opacity',
  variants: {
    hidden: {
      true: 'group-has-focus-visible/brand:opacity-0 group-hover/brand:opacity-0 [@media(hover:none)]:opacity-0',
    },
  },
})

export const railStyles = variant({
  base: 'group/rail sticky top-0 z-(--z-rail) flex h-dvh shrink-0 flex-col overflow-hidden border-border-default border-r bg-surface-page transition-[width] duration-(--duration-base)',
  variants: { collapsed: { true: 'w-rail', false: 'w-rail-open' } },
})
