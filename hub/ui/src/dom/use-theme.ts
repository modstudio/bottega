import { useEffect } from 'react'
import { useMediaQuery } from './use-media-query'
import { useStoredState } from './use-stored-state'

export type ThemeChoice = 'system' | 'light' | 'dark'
const choices: ThemeChoice[] = ['system', 'light', 'dark']

/**
 * The reader's theme: system by default, or a stored override. Applies the
 * `dark` class the head script set before first paint, and follows the system
 * while no override is stored.
 */
export function useTheme(storageKey: string) {
  const [choice, setStoredChoice] = useStoredState<ThemeChoice>(storageKey, 'system', choices)
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  const dark = choice === 'system' ? systemDark : choice === 'dark'
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])
  const setChoice = (next: ThemeChoice) => {
    if (next !== 'system') return setStoredChoice(next)
    setStoredChoice('system')
    try {
      localStorage.removeItem(storageKey)
    } catch {}
  }
  return { choice, dark, setChoice }
}
