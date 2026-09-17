import { Menu as MenuIcon, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react'
import {
  type ComponentType,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import { IconButton } from '../button/button'
import { useMediaQuery } from '../dom/use-media-query'
import { useStoredState } from '../dom/use-stored-state'
import { classes } from '../text/classes'

export type NavItem = {
  to: string
  label: string
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  /** Items with the same group sit together; a hairline separates groups. */
  group: string
  count?: number
  live?: boolean
}

/** Renders one navigation link; the router marks the current one `data-status="active"`. */
export type RenderLink = (
  item: NavItem,
  props: { className: string; onClick?: () => void; children: ReactNode },
) => ReactElement

const MOBILE_QUERY = '(max-width: 767px)'

const linkBase =
  'relative flex h-10 items-center gap-3 px-3 text-text-secondary outline-none transition-colors hover:bg-control-hover hover:text-text-primary focus-visible:bg-control-hover data-[status=active]:bg-control-selected data-[status=active]:text-text-primary [&_svg]:size-[18px] [&_svg]:shrink-0'

function groups(items: readonly NavItem[]) {
  const out: NavItem[][] = []
  for (const item of items) {
    const last = out.at(-1)
    if (last && last[0]!.group === item.group) last.push(item)
    else out.push([item])
  }
  return out
}

function Marks({ item, labelled }: { item: NavItem; labelled: boolean }) {
  return (
    <>
      {item.live ? (
        <span
          aria-hidden
          data-tone="success"
          className={classes(
            'size-1.5 shrink-0 rounded-full bg-status-fill',
            labelled ? '' : 'absolute top-2 right-2',
          )}
        />
      ) : null}
      {labelled && item.count ? (
        <span className="ml-auto text-sm text-text-muted tabular-nums">
          {item.count.toLocaleString()}
        </span>
      ) : null}
    </>
  )
}

function NavList({
  items,
  renderLink,
  labelled,
  onNavigate,
}: {
  items: readonly NavItem[]
  renderLink: RenderLink
  labelled: boolean | 'hover'
  onNavigate?: () => void
}) {
  // With `hover`, labels exist for every width but only show while the rail is open.
  const labelClass =
    labelled === 'hover'
      ? 'truncate opacity-0 transition-opacity duration-(--duration-fast) group-hover/rail:opacity-100 group-focus-within/rail:opacity-100'
      : 'truncate'
  return (
    <nav aria-label="Main" className="flex flex-col py-2">
      {groups(items).map((group, index) => (
        <div
          key={group[0]!.group}
          className={classes(
            'flex flex-col gap-px px-2 py-1',
            index > 0 && 'border-border-subtle border-t',
          )}
        >
          {group.map((item) => {
            const Icon = item.icon
            return (
              <div key={item.to}>
                {renderLink(item, {
                  className: linkBase,
                  onClick: onNavigate,
                  children: (
                    <>
                      <Icon aria-hidden />
                      {labelled ? <span className={labelClass}>{item.label}</span> : null}
                      <Marks item={item} labelled={Boolean(labelled)} />
                      {labelled ? null : <span className="sr-only">{item.label}</span>}
                    </>
                  ),
                })}
              </div>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

function MobileMenu({
  open,
  onClose,
  brand,
  items,
  renderLink,
  footer,
}: {
  open: boolean
  onClose: () => void
  brand: ReactNode
  items: readonly NavItem[]
  renderLink: RenderLink
  footer?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const node = ref.current
    if (open && node && !node.open) node.showModal()
    if (!open && node?.open) node.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      aria-label="Menu"
      onClose={onClose}
      className="fixed inset-0 h-dvh max-h-none w-screen bg-surface-page text-text-primary"
    >
      <div className="flex h-full flex-col">
        <div className="flex h-topbar shrink-0 items-center justify-between border-border-default border-b px-4">
          {brand}
          <IconButton label="Close menu" onClick={onClose}>
            <X />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <NavList items={items} renderLink={renderLink} labelled onNavigate={onClose} />
        </div>
        {footer ? <div className="border-border-default border-t p-4">{footer}</div> : null}
      </div>
    </dialog>
  )
}

/**
 * The application frame. On a desk: an icon rail whose labels open on hover or
 * focus, or stay open when pinned, and collapse whenever a companion panel
 * needs the width. On a phone: a top bar whose menu button opens the full
 * navigation, closing again once a destination is chosen.
 */
export function AppShell({
  name,
  mark,
  nav,
  renderLink,
  topbar,
  railFooter,
  collapsed = false,
  storageKey,
  children,
}: {
  /** The product name, shown beside the mark wherever labels show. */
  name: string
  /** The product mark, shown alone in the collapsed rail. */
  mark: ReactNode
  nav: readonly NavItem[]
  renderLink: RenderLink
  /** Controls on the right of the top bar. */
  topbar?: ReactNode
  /** Controls at the foot of the rail and the mobile menu. */
  railFooter?: ReactNode
  /** Force the rail to icons, as while a companion panel is docked. */
  collapsed?: boolean
  /** Where the pinned preference is remembered. */
  storageKey: string
  children: ReactNode
}) {
  const mobile = useMediaQuery(MOBILE_QUERY)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pin, setPin] = useStoredState(storageKey, 'icons', ['icons', 'pinned'] as const)
  const pinned = pin === 'pinned' && !collapsed
  const brand = (
    <span className="flex items-center gap-3 whitespace-nowrap font-semibold">
      {mark}
      {name}
    </span>
  )

  return (
    <div className="flex min-h-dvh bg-surface-page text-text-primary">
      {mobile ? null : (
        <div
          className={classes(
            'sticky top-0 z-(--z-rail) h-dvh shrink-0 transition-[width] duration-(--duration-base)',
            pinned ? 'w-rail-open' : 'w-rail',
          )}
        >
          <aside
            aria-label="Navigation"
            className={classes(
              'group/rail absolute inset-y-0 left-0 flex flex-col overflow-hidden border-border-default border-r bg-surface-page transition-[width,box-shadow] duration-(--duration-base)',
              pinned
                ? 'w-rail-open'
                : 'w-rail hover:w-rail-open hover:shadow-overlay focus-within:w-rail-open focus-within:shadow-overlay',
            )}
          >
            <div className="flex h-topbar shrink-0 items-center border-border-default border-b px-[1.625rem]">
              <span className="flex items-center gap-3 whitespace-nowrap font-semibold">
                {mark}
                <span
                  className={
                    pinned
                      ? undefined
                      : 'opacity-0 transition-opacity group-focus-within/rail:opacity-100 group-hover/rail:opacity-100'
                  }
                >
                  {name}
                </span>
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
              <NavList items={nav} renderLink={renderLink} labelled={pinned ? true : 'hover'} />
            </div>
            <div className="flex flex-col gap-2 border-border-default border-t p-2">
              {railFooter}
              {collapsed ? null : (
                <IconButton
                  label={pinned ? 'Collapse navigation' : 'Keep navigation open'}
                  onClick={() => setPin(pinned ? 'icons' : 'pinned')}
                >
                  {pinned ? <PanelLeftClose /> : <PanelLeftOpen />}
                </IconButton>
              )}
            </div>
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-(--z-sticky) flex h-topbar shrink-0 items-center gap-3 border-border-default border-b bg-surface-page px-4 md:px-8">
          {mobile ? (
            <>
              <IconButton label="Open menu" onClick={() => setMenuOpen(true)}>
                <MenuIcon />
              </IconButton>
              {mark}
            </>
          ) : null}
          <div className="ml-auto flex items-center gap-2">{topbar}</div>
        </header>
        <main className="min-w-0 flex-1 px-4 pb-8 md:px-8">{children}</main>
      </div>
      {mobile ? (
        <MobileMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          brand={brand}
          items={nav}
          renderLink={renderLink}
          footer={railFooter}
        />
      ) : null}
    </div>
  )
}
