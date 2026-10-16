import { ChevronRight, Menu as MenuIcon, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react'
import {
  type ComponentType,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { IconButton } from '../button/button'
import { TopbarSlotProvider } from '../dom/topbar-slot'
import { PHONE_QUERY, useMediaQuery } from '../dom/use-media-query'
import { useStoredState } from '../dom/use-stored-state'
import { Popover } from '../popover/popover'
import {
  appShellStyles,
  brandCellStyles,
  brandNameStyles,
  brandToggleStyles,
  navLabelStyles,
  navLinkStyles,
  navMarkStyles,
  navSectionStyles,
  railStyles,
} from './app-shell.styles.ts'

type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>

export type NavItem = {
  to: string
  label: string
  icon: Icon
  count?: number
  live?: boolean
}

/** Pages visited less often, behind one rail entry that opens them beside the rail. */
type NavGroup = { label: string; icon: Icon; items: readonly NavItem[] }

type NavEntry = NavItem | NavGroup

/** Entries in one section sit together; a hairline separates sections. */
export type NavSection = { id: string; entries: readonly NavEntry[] }

const isGroup = (entry: NavEntry): entry is NavGroup => 'items' in entry

/** Renders one navigation link; the router marks the current one `data-status="active"`. */
export type RenderLink = (
  item: NavItem,
  props: { className: string; onClick?: () => void; children: ReactNode },
) => ReactElement

const DockedPanels = createContext<(delta: 1 | -1) => void>(() => undefined)

/**
 * Collapses the rail to icons while the calling panel is mounted, to give a
 * docked companion the width. The reader's own open or collapsed choice is
 * restored when the last panel closes.
 */
export function useDockedPanel() {
  const change = useContext(DockedPanels)
  useEffect(() => {
    change(1)
    return () => change(-1)
  }, [change])
}

// The inline padding centers an 18px icon in the collapsed rail, so labels open
// beside icons that never move.
function Marks({ item, hidden }: { item: NavItem; hidden: boolean }) {
  return (
    <>
      {item.live ? (
        <span aria-hidden data-tone="success" className={appShellStyles().liveIndicator()} />
      ) : null}
      {item.count ? (
        <span className={navMarkStyles({ hidden })}>{item.count.toLocaleString()}</span>
      ) : null}
    </>
  )
}

function ItemContent({ item, hidden }: { item: NavItem; hidden: boolean }) {
  const Icon = item.icon
  return (
    <>
      <Icon aria-hidden />
      <span className={navLabelStyles({ hidden })}>{item.label}</span>
      <Marks item={item} hidden={hidden} />
    </>
  )
}

function GroupEntry({
  group,
  renderLink,
  hidden,
  active,
}: {
  group: NavGroup
  renderLink: RenderLink
  hidden: boolean
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
          className={navLinkStyles({ full: true })}
        >
          <Icon aria-hidden />
          <span className={navLabelStyles({ hidden, role: 'switcherLabel' })}>{group.label}</span>
          <ChevronRight aria-hidden className={navLabelStyles({ hidden, role: 'switcherIcon' })} />
        </button>
      }
    >
      <div className={appShellStyles().switcherPanel()}>
        <div className={appShellStyles().groupHeading()}>{group.label}</div>
        {group.items.map((item) => (
          <div key={item.to}>
            {renderLink(item, {
              className: navLinkStyles(),
              onClick: () => panel.current?.hidePopover(),
              children: <ItemContent item={item} hidden={false} />,
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
  labeled,
  isActive,
  onNavigate,
}: {
  sections: readonly NavSection[]
  renderLink: RenderLink
  /** `icons`: labels only for assistive technology. `full`: groups unfold in place. */
  labeled: 'icons' | 'always' | 'full'
  isActive: (to: string) => boolean
  onNavigate?: () => void
}) {
  const hidden = labeled === 'icons'
  const link = (item: NavItem) => (
    <div key={item.to}>
      {renderLink(item, {
        className: navLinkStyles(),
        onClick: onNavigate,
        children: <ItemContent item={item} hidden={hidden} />,
      })}
    </div>
  )
  return (
    <nav aria-label="Main" className={appShellStyles().nav()}>
      {sections.map((section, index) => (
        <div key={section.id} className={navSectionStyles({ separated: index > 0 })}>
          {section.entries.map((entry) =>
            !isGroup(entry) ? (
              link(entry)
            ) : labeled === 'full' ? (
              <div key={entry.label} className={appShellStyles().group()}>
                <div className={appShellStyles().groupHeading()}>{entry.label}</div>
                {entry.items.map(link)}
              </div>
            ) : (
              <GroupEntry
                key={entry.label}
                group={entry}
                renderLink={renderLink}
                hidden={hidden}
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
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      className={appShellStyles().mobileDialog()}
    >
      <div className={appShellStyles().mobileFrame()}>
        <div className={appShellStyles().mobileHeader()}>
          {brand}
          <IconButton label="Close menu" onClick={onClose}>
            <X />
          </IconButton>
        </div>
        <div className={appShellStyles().mobileNav()}>
          <NavList
            sections={sections}
            renderLink={renderLink}
            labeled="full"
            isActive={isActive}
            onNavigate={onClose}
          />
        </div>
        {footer ? <div className={appShellStyles().mobileFooter()}>{footer}</div> : null}
      </div>
    </dialog>
  )
}

/**
 * The collapse toggle lives in the brand cell and stays quiet until reached
 * for. Collapsed, the cell holds one mark: the logo, which the toggle replaces
 * on hover or focus. A touch screen has no hover to discover that swap, so
 * there the toggle simply shows.
 */
function BrandCell({
  mark,
  name,
  collapsed,
  canToggle,
  onToggle,
}: {
  mark: ReactNode
  name: string
  collapsed: boolean
  canToggle: boolean
  onToggle: () => void
}) {
  const toggle = canToggle ? (
    <span className={brandToggleStyles({ collapsed })}>
      <IconButton
        size="sm"
        label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
      </IconButton>
    </span>
  ) : null
  return (
    <div className={brandCellStyles({ collapsed })}>
      <span className={brandNameStyles({ hidden: collapsed && canToggle })}>
        {mark}
        {collapsed ? <span className={appShellStyles().collapsedBrandName()}>{name}</span> : name}
      </span>
      {toggle}
    </div>
  )
}

/**
 * The application frame. On a desk: a rail that is open with labels or
 * collapsed to icons, toggled from its brand cell and remembered per browser,
 * and collapsed whenever a companion panel needs the width. On a phone: a top
 * bar whose menu button opens the navigation as a drawer, closing once a
 * destination is chosen.
 */
export function AppShell({
  name,
  mark,
  nav,
  renderLink,
  isActive,
  topbar,
  railFooter,
  collapsed: forced = false,
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
  /** The account, at the foot of the rail and the drawer. */
  railFooter?: ReactNode
  /** Force the rail to icons, as while a companion panel is docked. */
  collapsed?: boolean
  /** Where the open or collapsed preference is remembered. */
  storageKey: string
  children: ReactNode
}) {
  const mobile = useMediaQuery(PHONE_QUERY)
  const [menuOpen, setMenuOpen] = useState(false)
  const [rail, setRail] = useStoredState(storageKey, 'open', ['open', 'collapsed'] as const)
  const [docked, setDocked] = useState(0)
  const [topbarSlot, setTopbarSlot] = useState<HTMLDivElement | null>(null)
  const [changeDocked] = useState(() => (delta: 1 | -1) => setDocked((count) => count + delta))
  const pinnedByPanel = forced || docked > 0
  const collapsed = pinnedByPanel || rail === 'collapsed'
  const brand = (
    <span className={appShellStyles().mobileBrand()}>
      {mark}
      {name}
    </span>
  )

  return (
    <DockedPanels.Provider value={changeDocked}>
      <div className={appShellStyles().shell()}>
        {mobile ? null : (
          <aside
            aria-label="Navigation"
            data-collapsed={collapsed || undefined}
            className={railStyles({ collapsed })}
          >
            <BrandCell
              mark={mark}
              name={name}
              collapsed={collapsed}
              canToggle={!pinnedByPanel}
              onToggle={() => setRail(collapsed ? 'open' : 'collapsed')}
            />
            <div className={appShellStyles().railNav()}>
              <NavList
                sections={nav}
                renderLink={renderLink}
                labeled={collapsed ? 'icons' : 'always'}
                isActive={isActive}
              />
            </div>
            {railFooter ? <div className={appShellStyles().railFooter()}>{railFooter}</div> : null}
          </aside>
        )}
        <div className={appShellStyles().workspace()}>
          <header className={appShellStyles().topbar()}>
            {mobile ? (
              <>
                <IconButton label="Open menu" onClick={() => setMenuOpen(true)}>
                  <MenuIcon />
                </IconButton>
                {mark}
              </>
            ) : null}
            <div ref={setTopbarSlot} className={appShellStyles().topbarPortal()} />
            {topbar ? <div className={appShellStyles().topbarActions()}>{topbar}</div> : null}
          </header>
          <main className={appShellStyles().main()}>
            <TopbarSlotProvider value={mobile ? null : topbarSlot}>{children}</TopbarSlotProvider>
          </main>
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
    </DockedPanels.Provider>
  )
}
