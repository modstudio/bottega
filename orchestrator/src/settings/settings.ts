// concern: settings
/** Pure owned Claude settings shape. Must not know filesystems, stores, commands, or transports. */
import { z } from 'zod'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'

export { containsSecretShaped } from '../../../shared/secret-shaped.ts'

export const SETTINGS_SLUG = 'settings'
export const SETTINGS_SCOPE = 'settings'
export const PERMISSION_LISTS = ['allow', 'ask', 'deny'] as const
export type PermissionList = (typeof PERMISSION_LISTS)[number]

export type OwnedSettings = {
  permissions: unknown
  hooks: unknown
}

const ownedSettingsSchema = z
  .object({
    permissions: z.unknown(),
    hooks: z.unknown(),
  })
  .strict()

export const SETTINGS_PARSE_REFUSAL =
  'refusing settings file: cannot parse JSON\ncleared by: fix the JSON syntax in the settings file'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function extractOwnedSettings(value: unknown): OwnedSettings {
  if (!isPlainObject(value)) {
    throw new Error(SETTINGS_PARSE_REFUSAL)
  }
  return {
    permissions: Object.hasOwn(value, 'permissions') ? value.permissions : {},
    hooks: Object.hasOwn(value, 'hooks') ? value.hooks : {},
  }
}

export function serializeOwnedSettings(owned: OwnedSettings): string {
  return `${JSON.stringify({ permissions: owned.permissions, hooks: owned.hooks }, null, 2)}\n`
}

export function validateOwnedSettingsBody(body: string): OwnedSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    throw new Error(
      'refusing settings body: cannot parse JSON\ncleared by: write a JSON object with only permissions and hooks',
    )
  }
  const result = ownedSettingsSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      'refusing settings body: unknown or missing top-level keys\n' +
        'cleared by: write a JSON object with exactly permissions and hooks',
    )
  }
  return result.data
}

export function refuseSettingsBody(scope: string, body: string): string | null {
  if (scope !== SETTINGS_SCOPE) return null
  let owned: OwnedSettings
  try {
    owned = validateOwnedSettingsBody(body)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return secretShapedSettingsRefusal(owned)
}

export function permissionLists(permissions: unknown): Record<PermissionList, string[]> {
  const lists: Record<PermissionList, string[]> = { allow: [], ask: [], deny: [] }
  if (!isPlainObject(permissions)) return lists
  for (const name of PERMISSION_LISTS) {
    const value = permissions[name]
    if (!Array.isArray(value)) continue
    lists[name] = value.filter((entry): entry is string => typeof entry === 'string')
  }
  return lists
}

export function allPermissionRules(permissions: unknown): string[] {
  const lists = permissionLists(permissions)
  return PERMISSION_LISTS.flatMap((name) => lists[name])
}

export function ownedSettingsEqual(left: OwnedSettings, right: OwnedSettings): boolean {
  return deepEqual(left.permissions, right.permissions) && deepEqual(left.hooks, right.hooks)
}

function secretShapedSettingsRefusal(owned: OwnedSettings): string | null {
  const paths = secretShapedPaths(owned)
  if (paths.length === 0) return null
  return (
    `refusing settings body: secret-shaped material at ${paths.join(', ')}\n` +
    'cleared by: move the credential into an env variable supplied from the secrets file'
  )
}

export function secretShapedPaths(owned: OwnedSettings): string[] {
  return [...permissionSecretPaths(owned.permissions), ...hookSecretPaths(owned.hooks)]
}

function permissionSecretPaths(permissions: unknown): string[] {
  if (!isPlainObject(permissions)) return []
  const paths: string[] = []
  for (const name of PERMISSION_LISTS) {
    const value = permissions[name]
    if (!Array.isArray(value)) continue
    for (const [index, entry] of value.entries()) {
      if (typeof entry === 'string' && containsSecretShaped(entry)) {
        paths.push(`permissions.${name}[${index}]`)
      }
    }
  }
  return paths
}

function hookSecretPaths(hooks: unknown): string[] {
  const paths: string[] = []
  walkHookCommands(hooks, 'hooks', paths)
  return paths
}

function walkHookCommands(value: unknown, path: string, paths: string[]): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walkHookCommands(item, `${path}[${index}]`, paths)
    }
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    const next = `${path}.${key}`
    if (key === 'command' && typeof child === 'string') {
      if (containsSecretShaped(child)) paths.push(next)
      continue
    }
    walkHookCommands(child, next, paths)
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
    )
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
  )
}
