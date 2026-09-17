import { X } from 'lucide-react'
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useRef,
} from 'react'
import { IconButton } from '../button/button'
import { useMediaQuery } from '../dom/use-media-query'
import { useStoredState } from '../dom/use-stored-state'
import { useDockedPanel } from '../shell/app-shell'
import { classes } from '../text/classes'

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
  const phone = useMediaQuery('(max-width: 767px)')
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
      className={classes(
        'flex flex-col bg-surface-page outline-none',
        phone
          ? 'fixed inset-0 z-(--z-sheet)'
          : 'relative sticky top-[calc(var(--topbar-h)+1rem)] max-h-[calc(100dvh-var(--topbar-h)-2rem)] shrink-0 self-start border border-border-default',
      )}
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
          className="absolute inset-y-0 -left-1 w-2 cursor-col-resize hover:bg-control-hover focus-visible:bg-control-hover"
        />
      )}
      <header className="flex min-h-14 shrink-0 items-start gap-3 border-border-default border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate font-semibold text-lg">
            {title}
          </h2>
          {subtitle ? <div className="mt-0.5 text-sm text-text-secondary">{subtitle}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        <IconButton size="sm" label="Close panel" onClick={onClose}>
          <X />
        </IconButton>
      </header>
      <div className="@container/panel min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      {footer ? (
        <footer className="shrink-0 border-border-default border-t p-4">{footer}</footer>
      ) : null}
    </aside>
  )
}

/** A page without a TableCard docks its companion here, beside its content. */
export function Docked({ panel, children }: { panel?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-4">
      <div className="min-w-0 flex-1">{children}</div>
      {panel}
    </div>
  )
}
