import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTopbarSlot } from '../dom/topbar-slot'
import { PHONE_QUERY, useMediaQuery } from '../dom/use-media-query'
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
 * On a desk they sit in the app's top bar, so the page opens on its content. On
 * a phone the top bar already names the page beside the menu, so the name is
 * kept for assistive technology only and the controls open the page.
 */
export function PageHeader({ title, subtitle, subtitleTitle, actions }: PageHeaderProps) {
  const slot = useTopbarSlot()
  const phone = useMediaQuery(PHONE_QUERY)
  if (slot) {
    return createPortal(
      <div className={pageHeaderStyles().portalRoot()}>
        <div className={pageHeaderStyles().portalHeading()}>
          <h1 className={pageHeaderStyles().portalTitle()}>{title}</h1>
          {subtitle ? (
            <span className={pageHeaderStyles().portalSubtitle()} title={subtitleTitle}>
              {subtitle}
            </span>
          ) : null}
        </div>
        {actions ? <div className={pageHeaderStyles().portalActions()}>{actions}</div> : null}
      </div>,
      slot,
    )
  }
  if (phone) {
    return (
      <header className={pageHeaderStyles({ bare: !actions }).phoneHeader()}>
        <h1 className={pageHeaderStyles().phoneTitle()}>{title}</h1>
        {actions}
      </header>
    )
  }
  return (
    <header className={pageHeaderStyles().pageHeader()}>
      <div className={pageHeaderStyles().pageHeading()}>
        <h1 className={pageHeaderStyles().pageTitle()}>{title}</h1>
        {subtitle ? (
          <div className={pageHeaderStyles().pageSubtitle()} title={subtitleTitle}>
            {subtitle}
          </div>
        ) : null}
      </div>
      {actions ? <div className={pageHeaderStyles().pageActions()}>{actions}</div> : null}
    </header>
  )
}

/** A heading that opens a section of a page, with optional right-aligned detail. */
export function SectionTitle({ children, detail }: { children: ReactNode; detail?: ReactNode }) {
  return (
    <div className={pageHeaderStyles().sectionHeader()}>
      <h2 className={pageHeaderStyles().sectionHeading()}>{children}</h2>
      {detail ? <span className={pageHeaderStyles().sectionDetail()}>{detail}</span> : null}
    </div>
  )
}
