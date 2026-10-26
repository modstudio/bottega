// concern: settings
/** Pure owned Claude settings shape. Must not know filesystems, stores, commands, or transports. */
import { z } from 'zod'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import {
  SETTINGS_PERMISSION_LISTS,
  type SettingsPermissionList,
} from '../../../shared/settings-summary.ts'

export { containsSecretShaped } from '../../../shared/secret-shaped.ts'

export const SETTINGS_SLUG = 'settings'
export const SETTINGS_SCOPE = 'settings'
export const PERMISSION_LISTS = SETTINGS_PERMISSION_LISTS
export type PermissionList = SettingsPermissionList
export const AUTO_MODE_LISTS = ['allow', 'soft_deny', 'hard_deny', 'environment'] as const
export type AutoModeList = (typeof AUTO_MODE_LISTS)[number]
export type OwnedAutoMode = Partial<Record<AutoModeList, string[]>>

const ownedAutoModeSchema = z
  .object(
    Object.fromEntries(AUTO_MODE_LISTS.map((name) => [name, z.array(z.string()).optional()])) as {
      [Name in AutoModeList]: z.ZodOptional<z.ZodArray<z.ZodString>>
    },
  )
  .strict()

export type OwnedSettings = {
  permissions: unknown
  hooks: unknown
  autoMode?: OwnedAutoMode
  env?: Record<string, string>
  envKeys?: string[]
}

export type SettingsEnvOperation = 'set' | 'unset'

export type SettingsEnvEdit = {
  settings: OwnedSettings
  changed: boolean
  message: string
}

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const ownedSettingsSchema = z
  .object({
    permissions: z.unknown(),
    hooks: z.unknown(),
    autoMode: ownedAutoModeSchema.optional(),
    env: z.record(z.string().regex(ENV_NAME), z.string()).default({}),
    envKeys: z
      .array(z.string().regex(ENV_NAME))
      .refine((names) => names.every((name, index) => index === 0 || names[index - 1]! < name)),
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
  const autoMode = Object.hasOwn(value, 'autoMode') ? parseAutoMode(value.autoMode) : undefined
  return {
    permissions: Object.hasOwn(value, 'permissions') ? value.permissions : {},
    hooks: Object.hasOwn(value, 'hooks') ? value.hooks : {},
    ...(autoMode === undefined ? {} : { autoMode }),
    envKeys: [],
  }
}

export function serializeOwnedSettings(owned: OwnedSettings): string {
  return `${JSON.stringify(
    {
      permissions: owned.permissions,
      hooks: owned.hooks,
      ...(owned.autoMode === undefined ? {} : { autoMode: owned.autoMode }),
      env: owned.env ?? {},
      envKeys: owned.envKeys ?? [],
    },
    null,
    2,
  )}\n`
}

export function validateOwnedSettingsBody(body: string): OwnedSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    throw new Error(
      'refusing settings body: cannot parse JSON\ncleared by: write a JSON object with only permissions, hooks, autoMode, env, and envKeys',
    )
  }
  const result = ownedSettingsSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      'refusing settings body: unknown or missing top-level keys\n' +
        'cleared by: write a JSON object with permissions, hooks, optional autoMode, env string values, and sorted envKeys names',
    )
  }
  assertValidEnvironment(result.data, 'settings body')
  return result.data
}

export function parseStoredOwnedSettings(body: string): OwnedSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    throw new Error('refusing stored settings row: cannot parse JSON')
  }
  if (isPlainObject(parsed) && !Object.hasOwn(parsed, 'env')) parsed.env = {}
  if (isPlainObject(parsed) && !Object.hasOwn(parsed, 'envKeys')) parsed.envKeys = []
  const result = ownedSettingsSchema.safeParse(parsed)
  if (!result.success) throw new Error('refusing stored settings row: invalid owned settings shape')
  assertValidEnvironment(result.data, 'stored settings row')
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

export function autoModeLists(autoMode?: OwnedAutoMode): Record<AutoModeList, string[]> {
  return Object.fromEntries(
    AUTO_MODE_LISTS.map((name) => [name, autoMode?.[name] ?? []]),
  ) as Record<AutoModeList, string[]>
}

export function ownedSettingsEqual(left: OwnedSettings, right: OwnedSettings): boolean {
  return (
    deepEqual(left.permissions, right.permissions) &&
    deepEqual(left.hooks, right.hooks) &&
    ((left.autoMode === undefined && right.autoMode === undefined) ||
      (left.autoMode !== undefined &&
        right.autoMode !== undefined &&
        deepEqual(left.autoMode, right.autoMode))) &&
    deepEqual(left.env ?? {}, right.env ?? {}) &&
    deepEqual(left.envKeys ?? [], right.envKeys ?? [])
  )
}

export function ownedEnvironmentNames(owned: OwnedSettings): string[] {
  return [...new Set([...Object.keys(owned.env ?? {}), ...(owned.envKeys ?? [])])].sort()
}

export function editSettingsEnv(
  owned: OwnedSettings,
  input: { operation: SettingsEnvOperation; name: string; value?: string },
): SettingsEnvEdit {
  if (!ENV_NAME.test(input.name)) {
    throw new Error(`refusing settings env ${input.operation}: invalid name ${input.name}`)
  }
  if (input.operation === 'set' && input.value === undefined) {
    throw new Error('refusing settings env set: value is required')
  }
  const current = owned.env ?? {}
  if (input.operation === 'unset' && !Object.hasOwn(current, input.name)) {
    return {
      settings: owned,
      changed: false,
      message: (owned.envKeys ?? []).includes(input.name)
        ? `${input.name} is a secrets-file name, not a plain value`
        : `${input.name} is absent`,
    }
  }
  if (input.operation === 'set' && current[input.name] === input.value) {
    return { settings: owned, changed: false, message: `${input.name} is already current` }
  }
  const entries =
    input.operation === 'set'
      ? Object.entries({ ...current, [input.name]: input.value! })
      : Object.entries(current).filter(([name]) => name !== input.name)
  return {
    settings: {
      ...owned,
      env: Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))),
    },
    changed: true,
    message: `${input.operation === 'set' ? 'set' : 'unset'} ${input.name}`,
  }
}

function assertValidEnvironment(owned: OwnedSettings, subject: string): void {
  const plainNames = Object.keys(owned.env ?? {})
  const duplicate = plainNames.find((name) => (owned.envKeys ?? []).includes(name))
  if (duplicate) {
    throw new Error(
      `refusing ${subject}: ${duplicate} appears in both env and envKeys\n` +
        `cleared by: run \`${PLATFORM_SLUG} machine settings env unset ${duplicate}\` to keep the secrets-file name, or remove ${duplicate} from envKeys`,
    )
  }
  const secret = plainNames.find((name) => containsSecretShaped(owned.env![name]!))
  if (secret) {
    throw new Error(
      `refusing ${subject}: ${secret} has a secret-shaped value\n` +
        'cleared by: put secrets in envKeys and the secrets file',
    )
  }
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
  return [
    ...permissionSecretPaths(owned.permissions),
    ...autoModeSecretPaths(owned.autoMode ?? {}),
    ...hookSecretPaths(owned.hooks),
  ]
}

function parseAutoMode(value: unknown): OwnedAutoMode {
  const result = ownedAutoModeSchema.safeParse(value)
  if (!result.success) {
    throw new Error(
      'refusing settings file: invalid autoMode\ncleared by: use only allow, soft_deny, hard_deny, and environment arrays of strings',
    )
  }
  return result.data
}

function autoModeSecretPaths(autoMode: OwnedAutoMode): string[] {
  const paths: string[] = []
  for (const name of AUTO_MODE_LISTS) {
    for (const [index, entry] of (autoMode[name] ?? []).entries()) {
      if (containsSecretShaped(entry)) paths.push(`autoMode.${name}[${index}]`)
    }
  }
  return paths
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
  walkHookText(hooks, 'hooks', paths)
  return paths
}

function walkHookText(value: unknown, path: string, paths: string[]): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walkHookText(item, `${path}[${index}]`, paths)
    }
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    const next = `${path}.${key}`
    if ((key === 'command' || key === 'matcher') && typeof child === 'string') {
      if (containsSecretShaped(child)) paths.push(next)
      continue
    }
    walkHookText(child, next, paths)
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
