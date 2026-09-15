import { useSyncExternalStore } from 'react'

type Kind = 'success' | 'error'
type Toast = { id: number; kind: Kind; message: string }

let nextId = 1
let toasts: Toast[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function show(kind: Kind, message: string) {
  const id = nextId++
  toasts = [...toasts, { id, kind, message }]
  emit()
  window.setTimeout(() => {
    toasts = toasts.filter((toast) => toast.id !== id)
    emit()
  }, 4000)
}

export const toast = Object.assign(show, {
  success: (message: string) => show('success', message),
  error: (message: string) => show('error', message),
})

export function Toaster() {
  const items = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => toasts,
    () => toasts,
  )
  return (
    <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2 font-mono" aria-live="polite">
      {items.map((item) => (
        <div
          key={item.id}
          className="border border-border bg-background px-3 py-2 text-[13px] opacity-100"
          role="status"
        >
          {item.message}
        </div>
      ))}
    </div>
  )
}
