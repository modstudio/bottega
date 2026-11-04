/** Pure redacted presentation of stored managed settings. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { containsSecretShaped, redactSecretShaped } from './secret-shaped.ts'

export const SETTINGS_PERMISSION_LISTS = ['allow', 'ask', 'deny'] as const
export type SettingsPermissionList = (typeof SETTINGS_PERMISSION_LISTS)[number]

export const AUTO_MODE_LISTS = ['allow', 'soft_deny', 'hard_deny', 'environment'] as const
export type AutoModeList = (typeof AUTO_MODE_LISTS)[number]
export type OwnedAutoMode = Partial<Record<AutoModeList, string[]>>

export const OWNED_AUTO_MODE_SCHEMA = z
  .object(
    Object.fromEntries(AUTO_MODE_LISTS.map((name) => [name, z.array(z.string()).optional()])) as {
      [Name in AutoModeList]: z.ZodOptional<z.ZodArray<z.ZodString>>
    },
  )
  .strict()

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export type OwnedSettings = {
  permissions: unknown
  hooks: unknown
  autoMode?: OwnedAutoMode
  env?: Record<string, string>
  envKeys?: string[]
}

export type StoredSettings = OwnedSettings

export const OWNED_SETTINGS_SCHEMA = z
  .object({
    permissions: z.unknown(),
    hooks: z.unknown(),
    autoMode: OWNED_AUTO_MODE_SCHEMA.optional(),
    env: z.record(z.string().regex(ENV_NAME), z.string()).default({}),
    envKeys: z
      .array(z.string().regex(ENV_NAME))
      .refine((names) => names.every((name, index) => index === 0 || names[index - 1]! < name)),
  })
  .strict()

export const STORED_SETTINGS_REMEDY =
  'cleared by: write a JSON object with permissions, hooks, optional autoMode, env string values, and sorted envKeys names'

function firstIssuePath(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String)
  if (issue.code === 'unrecognized_keys') path.push(issue.keys[0] ?? '(root)')
  return path.join('.') || '(root)'
}

export function parseStoredSettingsRow(body: string): OwnedSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    throw new Error(`stored settings row cannot parse JSON\n${STORED_SETTINGS_REMEDY}`)
  }
  if (object(parsed) && !Object.hasOwn(parsed, 'env')) parsed.env = {}
  if (object(parsed) && !Object.hasOwn(parsed, 'envKeys')) parsed.envKeys = []
  const result = OWNED_SETTINGS_SCHEMA.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `stored settings row has an invalid shape at ${JSON.stringify(firstIssuePath(result.error.issues[0]!))}\n${STORED_SETTINGS_REMEDY}`,
    )
  }
  return result.data
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const fingerprint = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 12)

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
        lists[name].map((rule) => redactSecretShaped(rule).text),
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
        matcher: secretCommand ? 'secret-shaped' : redactSecretShaped(matcher).text,
        fingerprint: fingerprint(item),
      }
    })
  })
}
