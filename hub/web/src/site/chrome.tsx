import { Link } from '@tanstack/react-router'
import { Menu, X } from 'lucide-react'
import { useState } from 'react'
import { AppMark } from '@/components/app-mark'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'
import './site.css'

export type SiteIdentity = 'signed-in' | 'signed-out'

type ProductPath =
  | '/product/orchestration'
  | '/product/workers'
  | '/product/review'
  | '/product/board'
  | '/product/doc-store'
  | '/product/context'

const productGroups: readonly {
  label: string
  links: readonly (readonly [ProductPath, string])[]
}[] = [
  {
    label: 'Orchestration',
    links: [
      ['/product/orchestration', 'How a run works'],
      ['/product/workers', 'Workers & cost'],
      ['/product/review', 'Review'],
    ],
  },
  {
    label: 'Workspace',
    links: [
      ['/product/board', 'Board'],
      ['/product/doc-store', 'Doc store'],
      ['/product/context', 'Context'],
    ],
  },
]

export function SiteHeader({ identity }: { identity: SiteIdentity }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="site-strip">
        <span>One board across every project — whatever tracker each one runs.</span>
        <Link to="/product/board">See the unified board</Link>
      </div>
      <header className="site-header">
        <div className="site-wrap site-nav">
          <Link to="/" className="site-brand" aria-label={`${PLATFORM_NAME} home`}>
            <AppMark className="size-5" />
            <span>{PLATFORM_NAME.toLowerCase()}</span>
          </Link>
          <nav className="site-desktop-nav" aria-label="Primary">
            {productGroups.map((group) => (
              <details key={group.label} className="site-menu">
                <summary>{group.label}</summary>
                <div className="site-menu-panel">
                  {group.links.map(([to, label]) => (
                    <Link key={to} to={to}>
                      {label}
                    </Link>
                  ))}
                </div>
              </details>
            ))}
            <Link to="/product/workflows">Workflows</Link>
          </nav>
          <div className="site-nav-tail">
            <Link to="/docs">Docs</Link>
            <a href="https://github.com/modstudio/bottega" aria-label="Bottega on GitHub">
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M12 .7a11.3 11.3 0 0 0-3.6 22c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.2c0 .4.2.7.8.6A11.3 11.3 0 0 0 12 .7Z" />
              </svg>
              <span className="site-github-label">GitHub</span>
            </a>
            <Link to={identity === 'signed-in' ? '/flight' : '/sign-in'}>
              {identity === 'signed-in' ? 'Open app' : 'Sign in'}
            </Link>
            <Link className="site-button site-button-small" to="/docs">
              Install
            </Link>
            <button
              className="site-burger"
              type="button"
              aria-label="Open menu"
              onClick={() => setOpen(true)}
            >
              <Menu />
            </button>
          </div>
        </div>
      </header>
      {open ? (
        <div className="site-mobile-menu">
          <div className="site-mobile-bar">
            <span className="site-brand">
              <AppMark className="size-5" />
              {PLATFORM_NAME.toLowerCase()}
            </span>
            <button type="button" aria-label="Close menu" onClick={() => setOpen(false)}>
              <X />
            </button>
          </div>
          {productGroups
            .flatMap((group) => group.links)
            .map(([to, label]) => (
              <Link key={to} to={to} onClick={() => setOpen(false)}>
                {label}
              </Link>
            ))}
          <Link to="/product/workflows" onClick={() => setOpen(false)}>
            Workflows
          </Link>
          <Link to="/docs" onClick={() => setOpen(false)}>
            Docs & install
          </Link>
        </div>
      ) : null}
    </>
  )
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-wrap site-footer-grid">
        {productGroups.map((group) => (
          <div key={group.label}>
            <h2>{group.label}</h2>
            {group.links.map(([to, label]) => (
              <Link key={to} to={to}>
                {label}
              </Link>
            ))}
          </div>
        ))}
        <div>
          <h2>Product</h2>
          <Link to="/product/workflows">Workflows</Link>
          <Link to="/docs">Docs</Link>
          <a href="https://github.com/modstudio/bottega">GitHub</a>
        </div>
        <div className="site-footer-sign">
          Delegate the execution.
          <br />
          Never the judgement.
        </div>
      </div>
      <div className="site-wrap site-footer-bar">
        <span>Workshop status: Operational</span>
        <span>© 2026 Bottega. Built by the workshop it runs.</span>
      </div>
      <p className="site-watermark" aria-hidden="true">
        bottega
      </p>
    </footer>
  )
}

export function SiteFrame({
  identity,
  children,
}: {
  identity: SiteIdentity
  children: React.ReactNode
}) {
  return (
    <>
      <SiteHeader identity={identity} />
      {children}
      <SiteFooter />
    </>
  )
}
