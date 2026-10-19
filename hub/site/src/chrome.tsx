import { useEffect, useRef, useState } from 'react'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { SiteLink as Link, useSiteNavigation } from './navigation.tsx'
import './site.css'

export type SiteIdentity = 'signed-in' | 'signed-out'
const Chevron = () => (
  <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M2 4l3 3 3-3" />
  </svg>
)
const Mark = () => (
  <svg
    className="mark"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.25"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 21V10a8 8 0 0 1 16 0v11" />
    <path d="M9 21v-6a3 3 0 0 1 6 0v6" />
    <path d="M2 21h20" />
  </svg>
)
const Brand = ({ onClick }: { onClick?: () => void }) => (
  <Link className="brand" to="/" aria-label={`${PLATFORM_NAME} home`} onClick={onClick}>
    <Mark />
    <span className="wordmark">{PLATFORM_SLUG}</span>
  </Link>
)
type MenuKey = 'orchestration' | 'workspace'

export function SiteHeader({
  identity,
  appSignInHref,
}: {
  identity: SiteIdentity
  appSignInHref?: string
}) {
  const { currentPath: pathname } = useSiteNavigation()
  const [openKey, setOpenKey] = useState<MenuKey | null>(null)
  const [mobile, setMobile] = useState(false)
  const [accordion, setAccordion] = useState<MenuKey | null>(null)
  const [stuck, setStuck] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const deferClose = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpenKey(null), 140)
  }
  const cancelClose = () => {
    if (timer.current) clearTimeout(timer.current)
  }
  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 8)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenKey(null)
        setMobile(false)
      }
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', onScroll)
      document.removeEventListener('keydown', onKey)
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])
  useEffect(() => {
    if (pathname) {
      setOpenKey(null)
      setMobile(false)
    }
  }, [pathname])
  useEffect(() => {
    document.body.style.overflow = mobile ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [mobile])
  const toggle = (key: MenuKey) => setOpenKey((value) => (value === key ? null : key))
  return (
    <>
      <SiteDesktopNavigation
        identity={identity}
        appSignInHref={appSignInHref}
        openKey={openKey}
        mobile={mobile}
        stuck={stuck}
        toggle={toggle}
        openMenu={setOpenKey}
        openMobile={() => setMobile(true)}
        cancelClose={cancelClose}
        deferClose={deferClose}
      />
      <SiteMobileNavigation
        identity={identity}
        appSignInHref={appSignInHref}
        mobile={mobile}
        accordion={accordion}
        setAccordion={setAccordion}
        close={() => setMobile(false)}
      />
    </>
  )
}

type DesktopNavigationProps = {
  identity: SiteIdentity
  appSignInHref?: string
  openKey: MenuKey | null
  mobile: boolean
  stuck: boolean
  toggle: (key: MenuKey) => void
  openMenu: (key: MenuKey | null) => void
  openMobile: () => void
  cancelClose: () => void
  deferClose: () => void
}

function SiteDesktopNavigation(props: DesktopNavigationProps) {
  return (
    <>
      <div className="strip">
        <div className="wrap">
          <span>One board across every project — whatever tracker each one runs.</span>
          <Link to="/product/board">See the unified board</Link>
        </div>
      </div>
      <header className={`nav${props.stuck ? ' stuck' : ''}`}>
        <div className="wrap nav-inner">
          <Brand />
          <PrimaryNavigation {...props} />
          <NavigationTail {...props} />
        </div>
        <NavigationFlyouts {...props} />
      </header>
      {props.openKey ? (
        <button
          className="nav-dim"
          type="button"
          aria-label="Close navigation"
          onClick={() => props.openMenu(null)}
        />
      ) : null}
    </>
  )
}

function PrimaryNavigation(props: DesktopNavigationProps) {
  const open = (key: MenuKey) => {
    props.cancelClose()
    props.openMenu(key)
  }
  return (
    <nav className="nav-links" aria-label="Primary">
      <button
        className="trig"
        type="button"
        aria-expanded={props.openKey === 'orchestration'}
        aria-controls="menu-orchestration"
        onClick={() => props.toggle('orchestration')}
        onMouseEnter={() => open('orchestration')}
        onMouseLeave={props.deferClose}
        onFocus={() => open('orchestration')}
      >
        Orchestration <Chevron />
      </button>
      <Link to="/product/workflows">Workflows</Link>
      <button
        className="trig"
        type="button"
        aria-expanded={props.openKey === 'workspace'}
        aria-controls="menu-workspace"
        onClick={() => props.toggle('workspace')}
        onMouseEnter={() => open('workspace')}
        onMouseLeave={props.deferClose}
        onFocus={() => open('workspace')}
      >
        Workspace <Chevron />
      </button>
    </nav>
  )
}

function NavigationTail(props: DesktopNavigationProps) {
  return (
    <div className="nav-tail">
      <Link to="/docs" className="nav-guide">
        Guides
      </Link>
      <span className="nav-sep" aria-hidden="true" />
      <a href={`https://github.com/modstudio/${PLATFORM_SLUG}`}>GitHub</a>
      <AppEntryLink identity={props.identity} appSignInHref={props.appSignInHref} />
      <Link className="btn sm site-install" to="/docs">
        Install
      </Link>
      <button
        className="burger"
        type="button"
        aria-expanded={props.mobile}
        aria-controls="site-mobile-menu"
        aria-label="Open menu"
        onClick={() => {
          props.openMenu(null)
          props.openMobile()
        }}
      >
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M2 6h16M2 13h16" />
        </svg>
      </button>
    </div>
  )
}

function NavigationFlyouts(props: DesktopNavigationProps) {
  if (!props.openKey) return null
  const flyoutProps = {
    onEnter: props.cancelClose,
    onLeave: props.deferClose,
    onClose: () => props.openMenu(null),
  }
  return props.openKey === 'orchestration' ? (
    <OrchestrationFlyout {...flyoutProps} />
  ) : (
    <WorkspaceFlyout {...flyoutProps} />
  )
}

type FlyoutEvents = { onEnter: () => void; onLeave: () => void; onClose: () => void }

function OrchestrationFlyout(props: FlyoutEvents) {
  return (
    <Flyout id="menu-orchestration" {...props}>
      <div className="fly-col">
        <FlyLink
          to="/product/orchestration"
          title="How a run works"
          copy="Spec, build, rule, judge"
        />
        <FlyLink
          to="/product/workers"
          title="Workers & cost"
          copy="Frontier on top, cheap underneath"
        />
      </div>
      <div className="fly-col">
        <FlyLink to="/product/review" title="Review" copy="Multi-lens, on a budget that ends" />
      </div>
      <Link className="fly-card" to="/docs">
        <span className="art">
          <span className="big">curl {PLATFORM_SLUG}.sh</span>
        </span>
        <span className="foot">
          <b>Install</b>
          <span>One command. Bring your own models.</span>
        </span>
      </Link>
    </Flyout>
  )
}

function WorkspaceFlyout(props: FlyoutEvents) {
  return (
    <Flyout id="menu-workspace" {...props}>
      <div className="fly-col">
        <FlyLink to="/product/board" title="Board" copy="Every project, whatever runs it" />
        <FlyLink
          to="/product/doc-store"
          title="Doc store"
          copy="One store for the team and the models"
        />
      </div>
      <div className="fly-col">
        <FlyLink to="/product/context" title="Context" copy="Handoffs and resume briefs" />
      </div>
      <Link className="fly-card" to="/product/board">
        <span className="art">
          <span className="big">3 projects</span>
        </span>
        <span className="foot">
          <b>One board</b>
          <span>Tasks, docs and cost, without migrating anything.</span>
        </span>
      </Link>
    </Flyout>
  )
}

type MobileNavigationProps = {
  identity: SiteIdentity
  appSignInHref?: string
  mobile: boolean
  accordion: MenuKey | null
  setAccordion: (key: MenuKey | null) => void
  close: () => void
}

function SiteMobileNavigation(props: MobileNavigationProps) {
  const toggle = (key: MenuKey) => props.setAccordion(props.accordion === key ? null : key)
  return (
    <div
      className="mobile-menu"
      id="site-mobile-menu"
      role="dialog"
      aria-label="Product navigation"
      aria-modal="true"
      hidden={!props.mobile}
    >
      <div className="wrap mm-wrap">
        <div className="mm-bar">
          <Brand onClick={props.close} />
          <button
            className="burger mm-close"
            type="button"
            aria-label="Close menu"
            onClick={props.close}
          >
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M4 4l12 12M16 4L4 16" />
            </svg>
          </button>
        </div>
        <MobileGroup
          label="Orchestration"
          open={props.accordion === 'orchestration'}
          onToggle={() => toggle('orchestration')}
        >
          <Link to="/product/orchestration">How a run works</Link>
          <Link to="/product/workers">Workers &amp; cost</Link>
          <Link to="/product/review">Review</Link>
        </MobileGroup>
        <MobileGroup
          label="Workspace"
          open={props.accordion === 'workspace'}
          onToggle={() => toggle('workspace')}
        >
          <Link to="/product/board">Board</Link>
          <Link to="/product/doc-store">Doc store</Link>
          <Link to="/product/context">Context</Link>
        </MobileGroup>
        <Link className="mm-link" to="/product/workflows">
          Workflows
        </Link>
        <Link className="mm-link" to="/docs">
          Guides
        </Link>
        <a className="mm-link" href={`https://github.com/modstudio/${PLATFORM_SLUG}`}>
          GitHub
        </a>
        <AppEntryLink
          identity={props.identity}
          appSignInHref={props.appSignInHref}
          className="mm-link"
        />
        <Link className="mm-link" to="/docs">
          Install {PLATFORM_NAME}
        </Link>
      </div>
    </div>
  )
}

function AppEntryLink({
  identity,
  appSignInHref,
  className,
}: {
  identity: SiteIdentity
  appSignInHref?: string
  className?: string
}) {
  const label = identity === 'signed-in' ? 'Open app' : 'Sign in'
  if (appSignInHref) {
    return (
      <a className={className} href={appSignInHref}>
        {label}
      </a>
    )
  }
  return (
    <Link className={className} to={identity === 'signed-in' ? '/flight' : '/sign-in'}>
      {label}
    </Link>
  )
}
function Flyout({
  id,
  children,
  onEnter,
  onLeave,
}: {
  id: string
  children: React.ReactNode
  onEnter: () => void
  onLeave: () => void
  onClose: () => void
}) {
  return (
    <div className="flyout" id={id} onMouseEnter={onEnter} onMouseLeave={onLeave} role="menu">
      <div className="flyout-in">{children}</div>
    </div>
  )
}
function FlyLink({ to, title, copy }: { to: string; title: string; copy: string }) {
  return (
    <Link to={to}>
      <b>{title}</b>
      <span>{copy}</span>
    </Link>
  )
}
function MobileGroup({
  label,
  open,
  onToggle,
  children,
}: {
  label: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="mm-sec">
      <button className="mm-head" type="button" aria-expanded={open} onClick={onToggle}>
        {label}
        <Chevron />
      </button>
      {open ? <div className="mm-panel">{children}</div> : null}
    </div>
  )
}

const footerGroups = [
  [
    'Orchestration',
    [
      ['/product/orchestration', 'How a run works'],
      ['/product/workers', 'Workers & cost'],
      ['/product/review', 'Review'],
      ['/product/workflows', 'Workflows'],
    ],
  ],
  [
    'Workspace',
    [
      ['/product/board', 'Board'],
      ['/product/doc-store', 'Doc store'],
      ['/product/context', 'Context'],
    ],
  ],
] as const
function SiteFooter() {
  return (
    <footer>
      <div className="wrap">
        <div className="foot">
          {footerGroups.map(([heading, links]) => (
            <div key={heading}>
              <h5>{heading}</h5>
              <ul>
                {links.map(([to, label]) => (
                  <li key={to}>
                    <Link to={to}>{label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div>
            <h5>Guides</h5>
            <ul>
              <li>
                <Link to="/docs">Install</Link>
              </li>
              <li>
                <Link to="/docs">Your first run</Link>
              </li>
              <li>
                <Link to="/docs">Worker contract</Link>
              </li>
              <li>
                <Link to="/docs">Scoring &amp; routing</Link>
              </li>
              <li>
                <Link to="/docs">Retrieval</Link>
              </li>
              <li>
                <Link to="/docs">MCP</Link>
              </li>
            </ul>
          </div>
          <div>
            <h5>Reference</h5>
            <ul>
              <li>
                <Link to="/docs">All guides</Link>
              </li>
              <li>
                <Link to="/docs">CLI reference</Link>
              </li>
              <li>
                <Link to="/docs">Workflows</Link>
              </li>
              <li>
                <Link to="/docs">Doc store</Link>
              </li>
              <li>
                <Link to="/docs">Context</Link>
              </li>
              <li>
                <a href={`https://github.com/modstudio/${PLATFORM_SLUG}`}>GitHub</a>
              </li>
            </ul>
          </div>
          <div>
            <p className="sign">
              Delegate the execution.
              <br />
              Never the judg{String.fromCharCode(101, 109, 101, 110, 116)}.
            </p>
            <div className="badges">
              <span className="badge">Runs on your machine</span>
              <span className="badge">Bring your own models</span>
              <span className="badge">
                Frontier for judg{String.fromCharCode(101, 109, 101, 110, 116)}, cheap for volume
              </span>
            </div>
          </div>
        </div>
        <div className="foot-bar">
          <span className="status">
            <i aria-hidden="true" /> Workshop status: Operational
          </span>
          <span>© 2026 {PLATFORM_NAME}. Built by the workshop it runs.</span>
        </div>
      </div>
      <p className="watermark" aria-hidden="true">
        {PLATFORM_SLUG}
      </p>
    </footer>
  )
}
export function SiteFrame({
  identity,
  appSignInHref,
  children,
}: {
  identity: SiteIdentity
  appSignInHref?: string
  children: React.ReactNode
}) {
  return (
    <div className="site-frame">
      <SiteHeader identity={identity} appSignInHref={appSignInHref} />
      {children}
      <SiteFooter />
    </div>
  )
}
