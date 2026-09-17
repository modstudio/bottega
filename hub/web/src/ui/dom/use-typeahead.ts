import { useRef } from 'react'

const RESET_MS = 600

/** Accumulates printable keys into a query that resets after a pause. Returns null for other keys. */
export function useTypeahead() {
  const typed = useRef({ text: '', at: 0 })
  return (event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) => {
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return null
    const now = Date.now()
    const text = now - typed.current.at > RESET_MS ? event.key : typed.current.text + event.key
    typed.current = { text, at: now }
    return text
  }
}
