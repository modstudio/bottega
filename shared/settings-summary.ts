/** Pure redacted presentation of stored managed settings. */
import { createHash } from 'node:crypto'
import { containsSecretShaped } from './secret-shaped.ts'

const SETTINGS_PERMISSION_LISTS = ['allow', 'ask', 'deny'] as const
export type SettingsPermissionList = (typeof SETTINGS_PERMISSION_LISTS)[number]

export type StoredSettings = {
  permissions: unknown
  hooks: unknown
  envKeys?: string[]
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const fingerprint = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 12)
const fingerprintText = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 12)

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value))

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!object(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function permissionLists(permissions: unknown): Record<SettingsPermissionList, string[]> {
  const lists = { allow: [], ask: [], deny: [] } as Record<SettingsPermissionList, string[]>
  if (!object(permissions)) return lists
  for (const name of SETTINGS_PERMISSION_LISTS) {
    const value = permissions[name]
    if (Array.isArray(value)) {
      lists[name] = value.filter((entry): entry is string => typeof entry === 'string')
    }
  }
  return lists
}

function hasSecretCommand(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSecretCommand)
  if (!object(value)) return false
  return Object.entries(value).some(([key, child]) =>
    key === 'command' && typeof child === 'string'
      ? containsSecretShaped(child)
      : hasSecretCommand(child),
  )
}

export function summarizeSettings(settings: StoredSettings) {
  const lists = permissionLists(settings.permissions)
  return {
    permissions: Object.fromEntries(
      SETTINGS_PERMISSION_LISTS.map((name) => [
        name,
        lists[name].map((rule, index) =>
          containsSecretShaped(rule)
            ? `permissions.${name}[${index}] ${fingerprintText(rule)} secret-shaped`
            : rule,
        ),
      ]),
    ) as Record<SettingsPermissionList, string[]>,
    hooks: hookSummaries(settings.hooks),
    envKeys: [...(settings.envKeys ?? [])],
  }
}

function hookSummaries(hooks: unknown) {
  if (!object(hooks)) return []
  return Object.entries(hooks).flatMap(([event, value]) => {
    if (!Array.isArray(value)) return []
    return value.map((item, index) => {
      const secretCommand = hasSecretCommand(item)
      const matcher = object(item) && typeof item.matcher === 'string' ? item.matcher : '-'
      return {
        event: secretCommand ? `hooks.${event}[${index}]` : event,
        matcher: secretCommand
          ? 'secret-shaped'
          : containsSecretShaped(matcher)
            ? '[withheld: secret-shaped]'
            : matcher,
        fingerprint: fingerprint(item),
      }
    })
  })
}
