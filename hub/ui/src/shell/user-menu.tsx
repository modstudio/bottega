import { Building2, LogOut, Monitor, Moon, Sun } from 'lucide-react'
import { type ThemeChoice, useTheme } from '../dom/use-theme'
import { Menu } from '../menu/menu'
import { userMenuStyles } from './user-menu.styles.ts'

const themeIcons = { system: Monitor, light: Sun, dark: Moon } as const
const themeLabels = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' } as const

export function spaceMenuItems(
  spaces: readonly { id: string; name: string }[],
  activeSpaceId: string | undefined,
  onSelectSpace: (spaceId: string) => void,
) {
  if (spaces.length <= 1) return []
  return spaces.map((space) => ({
    label: space.id === activeSpaceId ? `${space.name} ✓` : space.name,
    icon: Building2,
    disabled: space.id === activeSpaceId,
    onSelect: () => onSelectSpace(space.id),
  }))
}

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
  spaces = [],
  activeSpaceId,
  onSelectSpace,
  themeKey,
  onSignOut,
}: {
  name: string
  detail?: string
  spaces?: readonly { id: string; name: string }[]
  activeSpaceId?: string
  onSelectSpace?: (spaceId: string) => void
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
        <div className={userMenuStyles().slot1()}>
          <div className={userMenuStyles().slot2()}>{name}</div>
          {detail ? <div className={userMenuStyles().slot3()}>{detail}</div> : null}
        </div>
      }
      items={[
        ...(onSelectSpace ? spaceMenuItems(spaces, activeSpaceId, onSelectSpace) : []),
        theme('system'),
        theme('light'),
        theme('dark'),
        ...(onSignOut ? [{ label: 'Sign out', icon: LogOut, onSelect: onSignOut }] : []),
      ]}
      trigger={
        <button type="button" aria-label={`Account: ${name}`} className={userMenuStyles().slot4()}>
          <span aria-hidden className={userMenuStyles().slot5()}>
            {initials(name)}
          </span>
          <span className={userMenuStyles().slot6()}>
            <span className={userMenuStyles().slot7()}>{name}</span>
            {detail ? <span className={userMenuStyles().slot8()}>{detail}</span> : null}
          </span>
        </button>
      }
    />
  )
}
