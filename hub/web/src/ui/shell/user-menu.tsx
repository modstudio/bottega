import { LogOut, Monitor, Moon, Sun } from 'lucide-react'
import { type ThemeChoice, useTheme } from '../dom/use-theme'
import { Menu } from '../menu/menu'

const themeIcons = { system: Monitor, light: Sun, dark: Moon } as const
const themeLabels = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' } as const

function initials(name: string) {
  const words = name.split(/[\s@._-]+/).filter(Boolean)
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.slice(0, 2)).toUpperCase()
}

/**
 * Who is using the dashboard, at the foot of the rail: the account, the theme
 * choice and signing out. `name` is the signed-in person, or the local
 * dashboard when nobody signs in.
 */
export function UserMenu({
  name,
  detail,
  themeKey,
  onSignOut,
}: {
  name: string
  detail?: string
  themeKey: string
  onSignOut?: () => void
}) {
  const { choice, setChoice } = useTheme(themeKey)
  const theme = (value: ThemeChoice) => ({
    label: value === choice ? `${themeLabels[value]} ✓` : themeLabels[value],
    icon: themeIcons[value],
    onSelect: () => setChoice(value),
  })
  return (
    <Menu
      side="right"
      align="end"
      header={
        <div className="min-w-0">
          <div className="truncate font-medium">{name}</div>
          {detail ? <div className="truncate text-sm text-text-muted">{detail}</div> : null}
        </div>
      }
      items={[
        theme('system'),
        theme('light'),
        theme('dark'),
        ...(onSignOut ? [{ label: 'Sign out', icon: LogOut, onSelect: onSignOut }] : []),
      ]}
      trigger={
        <button
          type="button"
          aria-label={`Account: ${name}`}
          className="ml-[0.9375rem] grid size-8 place-items-center border border-border-default bg-surface-sunken font-medium text-text-secondary text-xs hover:border-border-strong"
        >
          {initials(name)}
        </button>
      }
    />
  )
}
