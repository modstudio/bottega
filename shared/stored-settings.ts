/**
 * The one declaration of the owned settings document. The orchestrator settings
 * module writes it; the hub's hosted settings read parses it.
 */
import { z } from 'zod'

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

export const OWNED_SETTINGS_SCHEMA = z
  .object({
    permissions: z.unknown(),
    hooks: z.unknown(),
    autoMode: OWNED_AUTO_MODE_SCHEMA.optional(),
    env: z.record(z.string().regex(ENV_NAME), z.string()).default({}),
    envKeys: z
      .array(z.string().regex(ENV_NAME))
      .refine((names) => names.every((name, index) => index === 0 || names[index - 1]! < name))
      .default([]),
  })
  .strict()

export const STORED_SETTINGS_REMEDY =
  'cleared by: write a JSON object with permissions, hooks, optional autoMode, env string values, and sorted envKeys names'

function firstIssuePath(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String)
  if (issue.code === 'unrecognized_keys') path.push(issue.keys[0] ?? '(root)')
  return path.join('.') || '(root)'
}

export class StoredSettingsRowError extends Error {
  readonly reason: 'json' | 'shape'
  readonly path?: string

  constructor(reason: 'json')
  constructor(reason: 'shape', path: string)
  constructor(reason: 'json' | 'shape', path?: string) {
    super(
      reason === 'json'
        ? `stored settings row cannot parse JSON\n${STORED_SETTINGS_REMEDY}`
        : `stored settings row has an invalid shape at ${JSON.stringify(path)}\n${STORED_SETTINGS_REMEDY}`,
    )
    this.name = 'StoredSettingsRowError'
    this.reason = reason
    if (reason === 'shape') this.path = path
  }
}

export function parseStoredSettingsRow(body: string): OwnedSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    throw new StoredSettingsRowError('json')
  }
  const result = OWNED_SETTINGS_SCHEMA.safeParse(parsed)
  if (!result.success) {
    throw new StoredSettingsRowError('shape', firstIssuePath(result.error.issues[0]!))
  }
  return result.data
}
