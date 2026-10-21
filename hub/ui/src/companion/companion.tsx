import { X } from 'lucide-react'
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useRef,
} from 'react'
import { IconButton } from '../button/button'
import { PHONE_QUERY, useMediaQuery } from '../dom/use-media-query'
import { useStoredState } from '../dom/use-stored-state'
import { useDockedPanel } from '../shell/app-shell'
import { companionStyles } from './companion.styles.ts'

const WIDTHS = ['360', '420', '480', '560', '640'] as const
type Width = (typeof WIDTHS)[number]

/**
 * A record opened beside the list it came from. The list stays readable and
 * usable, so there is no scrim; the rail collapses to make room, and the panel
 * can be widened by dragging its edge (remembered per browser). On a phone it
 * covers the page instead. Escape inside the panel closes it.
 */
export function Companion({
  title,
  subtitle,
  actions,
  footer,
  onClose,
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  useDockedPanel()
  const phone = useMediaQuery(PHONE_QUERY)
  const [width, setWidth] = useStoredState<Width>('ui:companion-width', '420', WIDTHS)
  const panel = useRef<HTMLElement>(null)
  const titleId = useId()
  const opener = useRef<Element | null>(null)

  useEffect(() => {
    opener.current = document.activeElement
    panel.current?.focus({ preventScroll: true })
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus({ preventScroll: true })
    }
  }, [])

  const startResize = (event: ReactPointerEvent) => {
    const startX = event.clientX
    const startWidth = Number(width)
    const move = (moveEvent: PointerEvent) => {
      const wanted = startWidth + (startX - moveEvent.clientX)
      const nearest = WIDTHS.reduce((best, option) =>
        Math.abs(Number(option) - wanted) < Math.abs(Number(best) - wanted) ? option : best,
      )
      setWidth(nearest)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) onClose()
      }}
      style={phone ? undefined : { width: `${width}px` }}
      className={companionStyles({ phone }).root()}
    >
      {phone ? null : (
        <button
          type="button"
          aria-label={`Resize panel, ${width} pixels wide`}
          title="Drag, or use the arrow keys, to resize"
          onPointerDown={startResize}
          onKeyDown={(event) => {
            const index = WIDTHS.indexOf(width)
            const next =
              event.key === 'ArrowLeft'
                ? WIDTHS[index + 1]
                : event.key === 'ArrowRight'
                  ? WIDTHS[index - 1]
                  : undefined
            if (!next) return
            event.preventDefault()
            setWidth(next)
          }}
          className={companionStyles().resizeHandle()}
        />
      )}
      <header className={companionStyles().header()}>
        <div className={companionStyles().heading()}>
          <h2 id={titleId} className={companionStyles().title()}>
            {title}
          </h2>
          {subtitle ? <div className={companionStyles().subtitle()}>{subtitle}</div> : null}
        </div>
        {actions ? <div className={companionStyles().actions()}>{actions}</div> : null}
        <IconButton size="sm" label="Close panel" onClick={onClose}>
          <X />
        </IconButton>
      </header>
      <div className={companionStyles().body()}>{children}</div>
      {footer ? <footer className={companionStyles().footer()}>{footer}</footer> : null}
    </aside>
  )
}

/** A page without a TableCard docks its companion here, beside its content. */
export function Docked({ panel, children }: { panel?: ReactNode; children: ReactNode }) {
  return (
    <div className={companionStyles().dockedLayout()}>
      <div className={companionStyles().dockedContent()}>{children}</div>
      {panel}
    </div>
  )
}
