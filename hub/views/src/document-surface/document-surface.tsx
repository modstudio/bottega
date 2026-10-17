import { Button } from '@bottega/hub-ui/button'
import { Maximize2, Minimize2 } from 'lucide-react'
import { type ReactNode, type Ref, useCallback, useEffect, useState } from 'react'
import { documentSurfaceStyles } from './document-surface.styles.ts'

export const LONG_TITLE = 40

function useScrolledPast(target: HTMLElement | null): boolean {
  const [past, setPast] = useState(false)
  useEffect(() => {
    if (!target) {
      setPast(false)
      return
    }
    const sticky = target.previousElementSibling
    const line = sticky ? Number.parseFloat(getComputedStyle(sticky).top) || 0 : 0
    const header = sticky ? sticky.getBoundingClientRect().height : 0
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) setPast(!entry.isIntersecting && entry.boundingClientRect.top < line + 200)
      },
      { rootMargin: `-${line + header}px 0px 0px 0px` },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [target])
  return past
}

export function DocumentTitle({ title, ref }: { title: string; ref?: Ref<HTMLElement | null> }) {
  return (
    <h1
      ref={ref as Ref<HTMLHeadingElement>}
      className={documentSurfaceStyles().title()}
      data-long={title.length > LONG_TITLE ? '' : undefined}
    >
      {title}
    </h1>
  )
}

export function DocumentSurface({
  crumbs,
  title,
  heading,
  keyLine,
  headerActions,
  wide = false,
  onWideChange,
  banner,
  body,
  footer,
  error,
  pending = false,
}: {
  crumbs: { key: string; label: ReactNode }[]
  title: string
  heading: (ref: Ref<HTMLElement | null>) => ReactNode
  keyLine?: ReactNode
  headerActions?: ReactNode
  wide?: boolean
  onWideChange?: (wide: boolean) => void
  banner?: ReactNode
  body: ReactNode
  footer?: ReactNode
  error?: string | null
  pending?: boolean
}) {
  const [headingElement, setHeadingElement] = useState<HTMLElement | null>(null)
  const headingRef = useCallback((element: HTMLElement | null) => setHeadingElement(element), [])
  const titleGone = useScrolledPast(headingElement)
  return (
    <main className={documentSurfaceStyles().main()} data-doc-wide={wide ? '' : undefined}>
      {error ? (
        <p data-tone="error" className={documentSurfaceStyles().error()}>
          {error}
        </p>
      ) : null}
      {pending ? null : (
        <>
          <div className={documentSurfaceStyles({ titleGone }).top()}>
            <div className={documentSurfaceStyles().crumbs()}>
              {crumbs.map((crumb, index) => (
                <span key={crumb.key} className={documentSurfaceStyles().crumb()}>
                  {index > 0 ? <span>/</span> : null}
                  <span>{crumb.label}</span>
                </span>
              ))}
              {titleGone ? (
                <>
                  <span>/</span>
                  <span className={documentSurfaceStyles().goneTitle()}>{title}</span>
                </>
              ) : null}
            </div>
            <div className={documentSurfaceStyles().actions()}>
              {headerActions}
              {onWideChange ? (
                <span className={documentSurfaceStyles().wideControl()}>
                  <Button size="sm" variant="secondary" onClick={() => onWideChange(!wide)}>
                    {wide ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                    {wide ? 'Reading width' : 'Wide'}
                  </Button>
                </span>
              ) : null}
            </div>
          </div>
          {banner}
          {heading(headingRef)}
          {keyLine}
          {body}
          {footer}
        </>
      )}
    </main>
  )
}
