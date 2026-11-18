import { X } from 'lucide-react'
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { Badge, type Tone } from '../badge/badge'
import { IconButton } from '../button/button'
import { toastStyles } from './toast.styles.ts'

type Kind = Extract<Tone, 'success' | 'warning' | 'error' | 'info'>
type ToastItem = { id: number; kind: Kind; message: string }

const DISMISS_MS = 5000
let nextId = 1
let items: ToastItem[] = []
const listeners = new Set<() => void>()
const timers = new Map<number, number>()
const persistent: Record<Kind, boolean> = {
  success: false,
  warning: true,
  error: false,
  info: false,
}

const emit = () => {
  for (const listener of listeners) listener()
}

function dismiss(id: number) {
  window.clearTimeout(timers.get(id))
  timers.delete(id)
  items = items.filter((item) => item.id !== id)
  emit()
}

function schedule(id: number) {
  window.clearTimeout(timers.get(id))
  timers.set(
    id,
    window.setTimeout(() => dismiss(id), DISMISS_MS),
  )
}

function show(kind: Kind, message: string) {
  const id = nextId++
  items = [...items, { id, kind, message }]
  if (!persistent[kind]) schedule(id)
  emit()
}

/** Announces the outcome of an action. */
export const toast = {
  success: (message: string) => show('success', message),
  warning: (message: string) => show('warning', message),
  error: (message: string) => show('error', message),
  info: (message: string) => show('info', message),
}

const kindLabel: Record<Kind, string> = {
  success: 'Done',
  warning: 'Warning',
  error: 'Failed',
  info: 'Note',
}

/**
 * The toast region, mounted once. Announcements go through a live region that
 * exists before any message arrives, outside the popover, which is hidden while
 * empty. The visible stack sits in the top layer, re-raised on every message so
 * a toast shows above an open dialog.
 */
export function Toaster() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => items,
  )
  const region = useRef<HTMLElement>(null)

  useLayoutEffect(() => {
    const node = region.current
    if (!node) return
    if (node.matches(':popover-open')) node.hidePopover()
    if (current.length) node.showPopover()
  }, [current])

  const latest = current.at(-1)
  return (
    <>
      <div aria-live="polite" className={toastStyles().liveRegion()}>
        {latest ? `${kindLabel[latest.kind]}: ${latest.message}` : ''}
      </div>
      <section
        ref={region}
        popover="manual"
        aria-label="Notifications"
        className={toastStyles().viewport()}
      >
        <ol className={toastStyles().list()}>
          {current.map((item) => (
            <li
              key={item.id}
              data-tone={item.kind}
              onPointerEnter={
                persistent[item.kind] ? undefined : () => window.clearTimeout(timers.get(item.id))
              }
              onPointerLeave={persistent[item.kind] ? undefined : () => schedule(item.id)}
              className={toastStyles().item()}
            >
              <Badge tone={item.kind}>{kindLabel[item.kind]}</Badge>
              <p className={toastStyles().message()}>{item.message}</p>
              <IconButton size="sm" label="Dismiss" onClick={() => dismiss(item.id)}>
                <X />
              </IconButton>
            </li>
          ))}
        </ol>
      </section>
    </>
  )
}
