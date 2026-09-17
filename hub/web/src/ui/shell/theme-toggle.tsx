import { Monitor, Moon, Sun } from 'lucide-react'
import { IconButton } from '../button/button'
import { type ThemeChoice, useTheme } from '../dom/use-theme'
import { Menu } from '../menu/menu'

const icons = { system: Monitor, light: Sun, dark: Moon } as const

/** Chooses light, dark or the system theme; the choice is remembered in this browser. */
export function ThemeToggle({ storageKey }: { storageKey: string }) {
  const { choice, setChoice } = useTheme(storageKey)
  const Icon = icons[choice]
  const item = (value: ThemeChoice, label: string) => ({
    label: value === choice ? `${label} (current)` : label,
    icon: icons[value],
    onSelect: () => setChoice(value),
  })
  return (
    <Menu
      align="end"
      trigger={
        <IconButton label="Theme">
          <Icon />
        </IconButton>
      }
      items={[item('system', 'System'), item('light', 'Light'), item('dark', 'Dark')]}
    />
  )
}
