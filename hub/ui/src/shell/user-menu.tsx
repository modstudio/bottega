import { Building2, LogOut, Monitor, Moon, Sun } from 'lucide-react'
import { type ThemeChoice, useTheme } from '../dom/use-theme'
import { Menu } from '../menu/menu'

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
        <div className="min-w-0">
          <div className="truncate font-medium">{name}</div>
          {detail ? <div className="truncate text-sm text-text-muted">{detail}</div> : null}
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
        <button
          type="button"
          aria-label={`Account: ${name}`}
          className="mx-2 flex w-[calc(100%-1rem)] items-center gap-3 px-[0.8125rem] py-1 text-left hover:bg-control-hover"
        >
          <span
            aria-hidden
            className="grid size-7 shrink-0 place-items-center border border-border-default bg-surface-sunken font-medium text-text-secondary text-xs"
          >
            {initials(name)}
          </span>
          <span className="min-w-0 truncate group-data-collapsed/rail:sr-only">
            <span className="block truncate font-medium text-sm">{name}</span>
            {detail ? (
              <span className="block truncate text-text-muted text-xs">{detail}</span>
            ) : null}
          </span>
        </button>
      }
    />
  )
}
