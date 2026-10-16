import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTopbarSlot } from '../dom/topbar-slot'
import { pageHeaderStyles } from './page-header.styles.ts'

type PageHeaderProps = {
  title: ReactNode
  subtitle?: ReactNode
  /** The full context behind a shortened subtitle, on hover. */
  subtitleTitle?: string
  actions?: ReactNode
}

/**
 * The page's name, a line of standing context, and the page's own controls.
 * On a desk they sit in the app's top bar, so the page opens on its content; on
 * a phone, where the bar holds the menu, they open the page.
 */
export function PageHeader({ title, subtitle, subtitleTitle, actions }: PageHeaderProps) {
  const slot = useTopbarSlot()
  if (slot) {
    return createPortal(
      <div className={pageHeaderStyles().slot1()}>
        <div className={pageHeaderStyles().slot2()}>
          <h1 className={pageHeaderStyles().slot3()}>{title}</h1>
          {subtitle ? (
            <span className={pageHeaderStyles().slot4()} title={subtitleTitle}>
              {subtitle}
            </span>
          ) : null}
        </div>
        {actions ? <div className={pageHeaderStyles().slot5()}>{actions}</div> : null}
      </div>,
      slot,
    )
  }
  return (
    <header className={pageHeaderStyles().slot6()}>
      <div className={pageHeaderStyles().slot7()}>
        <h1 className={pageHeaderStyles().slot8()}>{title}</h1>
        {subtitle ? (
          <div className={pageHeaderStyles().slot9()} title={subtitleTitle}>
            {subtitle}
          </div>
        ) : null}
      </div>
      {actions ? <div className={pageHeaderStyles().slot10()}>{actions}</div> : null}
    </header>
  )
}

/** A heading that opens a section of a page, with optional right-aligned detail. */
export function SectionTitle({ children, detail }: { children: ReactNode; detail?: ReactNode }) {
  return (
    <div className={pageHeaderStyles().slot11()}>
      <h2 className={pageHeaderStyles().slot12()}>{children}</h2>
      {detail ? <span className={pageHeaderStyles().slot13()}>{detail}</span> : null}
    </div>
  )
}
