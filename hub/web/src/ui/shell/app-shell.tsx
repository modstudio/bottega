import { ChevronRight, Menu as MenuIcon, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react'
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
import { Popover } from '../popover/popover'
import { classes } from '../text/classes'

type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>

export type NavItem = {
  to: string
  label: string
  icon: Icon
  count?: number
  live?: boolean
}

/** Pages visited less often, behind one rail entry that opens them beside the rail. */
export type NavGroup = { label: string; icon: Icon; items: readonly NavItem[] }

export type NavEntry = NavItem | NavGroup

/** Entries in one section sit together; a hairline separates sections. */
export type NavSection = { id: string; entries: readonly NavEntry[] }

const isGroup = (entry: NavEntry): entry is NavGroup => 'items' in entry

/** Renders one navigation link; the router marks the current one `data-status="active"`. */
export type RenderLink = (
  item: NavItem,
  props: { className: string; onClick?: () => void; children: ReactNode },
) => ReactElement

const MOBILE_QUERY = '(max-width: 767px)'

// The inline padding centres an 18px icon in the collapsed rail, so labels open
// beside icons that never move.
const linkBase =
  'relative flex h-10 items-center gap-3 border border-transparent px-[1.0625rem] text-text-secondary outline-none transition-colors hover:bg-control-hover hover:text-text-primary focus-visible:bg-control-hover data-[status=active]:border-border-default data-[status=active]:bg-surface-sunken data-[status=active]:text-text-primary [&_svg]:size-[18px] [&_svg]:shrink-0 [&_svg]:stroke-[1.5]'

function Marks({ item, labelClass }: { item: NavItem; labelClass: string }) {
  return (
    <>
      {item.live ? (
        <span
          aria-hidden
          data-tone="success"
          className="absolute top-2 left-9 size-1.5 shrink-0 rounded-full bg-status-fill"
        />
      ) : null}
      {item.count ? (
        <span className={classes(labelClass, 'ml-auto text-sm text-text-muted tabular-nums')}>
          {item.count.toLocaleString()}
        </span>
      ) : null}
    </>
  )
}

function ItemContent({ item, labelClass }: { item: NavItem; labelClass: string }) {
  const Icon = item.icon
  return (
    <>
      <Icon aria-hidden />
      <span className={labelClass}>{item.label}</span>
      <Marks item={item} labelClass={labelClass} />
    </>
  )
}

function GroupEntry({
  group,
  renderLink,
  labelClass,
  active,
}: {
  group: NavGroup
  renderLink: RenderLink
  labelClass: string
  active: boolean
}) {
  const Icon = group.icon
  const panel = useRef<HTMLDivElement>(null)
  return (
    <Popover
      ref={panel}
      label={group.label}
      side="right"
      trigger={
        <button
          type="button"
          data-status={active ? 'active' : undefined}
          className={classes(linkBase, 'w-full')}
        >
          <Icon aria-hidden />
          <span className={classes(labelClass, 'flex-1 text-left')}>{group.label}</span>
          <ChevronRight aria-hidden className={classes(labelClass, 'ml-auto !size-3.5')} />
        </button>
      }
    >
      <div className="-m-3 flex min-w-48 flex-col gap-px p-1">
        <div className="px-3 pt-2 pb-1 font-medium text-sm text-text-muted">{group.label}</div>
        {group.items.map((item) => (
          <div key={item.to}>
            {renderLink(item, {
              className: linkBase,
              onClick: () => panel.current?.hidePopover(),
              children: <ItemContent item={item} labelClass="truncate" />,
            })}
          </div>
        ))}
      </div>
    </Popover>
  )
}

function NavList({
  sections,
  renderLink,
  labelled,
  isActive,
  onNavigate,
}: {
  sections: readonly NavSection[]
  renderLink: RenderLink
  /** `hover`: labels exist but show only while the rail is open. `full`: groups unfold in place. */
  labelled: 'hover' | 'always' | 'full'
  isActive: (to: string) => boolean
  onNavigate?: () => void
}) {
  const labelClass =
    labelled === 'hover'
      ? 'truncate opacity-0 transition-opacity duration-(--duration-fast) group-hover/rail:opacity-100 group-focus-within/rail:opacity-100'
      : 'truncate'
  const link = (item: NavItem) => (
    <div key={item.to}>
      {renderLink(item, {
        className: linkBase,
        onClick: onNavigate,
        children: <ItemContent item={item} labelClass={labelClass} />,
      })}
    </div>
  )
  return (
    <nav aria-label="Main" className="flex flex-col py-3">
      {sections.map((section, index) => (
        <div key={section.id} className={classes('flex flex-col gap-1 px-2', index > 0 && 'mt-4')}>
          {section.entries.map((entry) =>
            !isGroup(entry) ? (
              link(entry)
            ) : labelled === 'full' ? (
              <div key={entry.label} className="flex flex-col gap-px">
                <div className="px-3 pt-2 pb-1 font-medium text-sm text-text-muted">
                  {entry.label}
                </div>
                {entry.items.map(link)}
              </div>
            ) : (
              <GroupEntry
                key={entry.label}
                group={entry}
                renderLink={renderLink}
                labelClass={labelClass}
                active={entry.items.some((item) => isActive(item.to))}
              />
            ),
          )}
        </div>
      ))}
    </nav>
  )
}

function MobileMenu({
  open,
  onClose,
  brand,
  sections,
  renderLink,
  isActive,
  footer,
}: {
  open: boolean
  onClose: () => void
  brand: ReactNode
  sections: readonly NavSection[]
  renderLink: RenderLink
  isActive: (to: string) => boolean
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
          <NavList
            sections={sections}
            renderLink={renderLink}
            labelled="full"
            isActive={isActive}
            onNavigate={onClose}
          />
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
  isActive,
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
  nav: readonly NavSection[]
  renderLink: RenderLink
  /** Whether a destination is the current page, for marking its group. */
  isActive: (to: string) => boolean
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
              <NavList
                sections={nav}
                renderLink={renderLink}
                labelled={pinned ? 'always' : 'hover'}
                isActive={isActive}
              />
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
          sections={nav}
          renderLink={renderLink}
          isActive={isActive}
          footer={railFooter}
        />
      ) : null}
    </div>
  )
}
