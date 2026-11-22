/**
 * The one declaration of the owned settings document. The orchestrator settings
 * module writes it; the hub's hosted settings read parses it.
 */
import { z } from 'zod'
import { PLATFORM_NAME } from './brand.ts'
import { refusal, renderRefusal } from './refusal.ts'

export const AUTO_MODE_LISTS = ['allow', 'soft_deny', 'hard_deny', 'environment'] as const
export type AutoModeList = (typeof AUTO_MODE_LISTS)[number]
export type OwnedAutoMode = Partial<Record<AutoModeList, string[]>>

const OWNED_SETTINGS_OPTIONS_SCHEMA = z
  .object({
    subagentHooks: z.enum(['on']).optional(),
  })
  .strict()
type OwnedSettingsOptions = z.infer<typeof OWNED_SETTINGS_OPTIONS_SCHEMA>

const OWNED_SETTINGS_SUBAGENT_HOOK_VALUES =
  OWNED_SETTINGS_OPTIONS_SCHEMA.shape.subagentHooks.unwrap().options
export const OWNED_SETTINGS_OPTIONS_ACCEPTED = `accepted options.subagentHooks=${OWNED_SETTINGS_SUBAGENT_HOOK_VALUES.map((value) => JSON.stringify(value)).join('|')}`

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
  options?: OwnedSettingsOptions
  env?: Record<string, string>
  envKeys?: string[]
}

export function subagentBlockingState(options: OwnedSettings['options']): {
  blocking: 'on' | 'off'
  source: 'user' | 'default'
} {
  return options?.subagentHooks === 'on'
    ? { blocking: 'on', source: 'user' }
    : { blocking: 'off', source: 'default' }
}

const ENV_KEYS_SCHEMA = z
  .array(z.string().regex(ENV_NAME))
  .refine((names) => names.every((name, index) => index === 0 || names[index - 1]! < name))

export const OWNED_SETTINGS_SCHEMA = z
  .object({
    permissions: z.unknown(),
    hooks: z.unknown(),
    autoMode: OWNED_AUTO_MODE_SCHEMA.optional(),
    options: OWNED_SETTINGS_OPTIONS_SCHEMA.optional(),
    env: z.record(z.string().regex(ENV_NAME), z.string()).default({}),
    envKeys: ENV_KEYS_SCHEMA,
  })
  .strict()

function storedSchema(schema: unknown): z.ZodType {
  if (schema instanceof z.ZodOptional) return storedSchema(schema.unwrap()).optional()
  if (schema instanceof z.ZodObject) return storedObjectSchema(schema)
  return schema as z.ZodType
}

function storedObjectSchema(schema: z.ZodObject): z.ZodObject {
  return z
    .object(
      Object.fromEntries(
        Object.entries(schema.shape).map(([key, child]) => [key, storedSchema(child)]),
      ),
    )
    .strip()
}

const STORED_SETTINGS_ROW_SCHEMA = storedObjectSchema(OWNED_SETTINGS_SCHEMA).extend({
  envKeys: ENV_KEYS_SCHEMA.default([]),
}) as unknown as z.ZodType<OwnedSettings>

const OWNED_SETTINGS_KEYS_TEXT = Object.keys(OWNED_SETTINGS_SCHEMA.shape).join(', ')

export const STORED_SETTINGS_REMEDY = `cleared by: write a JSON object with only these keys: ${OWNED_SETTINGS_KEYS_TEXT}`
export function storedSettingsUpgradeRemedy(verb: 'reading' | 'editing'): string {
  return `upgrade ${PLATFORM_NAME} before ${verb} this settings row`
}
export const STORED_SETTINGS_OPTIONS_REMEDY = `${OWNED_SETTINGS_OPTIONS_ACCEPTED}; ${storedSettingsUpgradeRemedy('reading')}`

function firstIssuePath(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String)
  if (issue.code === 'unrecognized_keys') path.push(issue.keys[0] ?? '(root)')
  return path.join('.') || '(root)'
}

function storedSettingsShapeMessage(path: string, issue: z.core.$ZodIssue): string {
  const condition = `stored settings row has an invalid shape at ${JSON.stringify(path)}`
  const remedy =
    path.startsWith('options.') && issue.code === 'invalid_value'
      ? STORED_SETTINGS_OPTIONS_REMEDY
      : null
  return remedy === null
    ? `${condition}\n${STORED_SETTINGS_REMEDY}`
    : renderRefusal(refusal(condition, { kind: 'edit', text: remedy }))
}

export class StoredSettingsRowError extends Error {
  readonly reason: 'json' | 'shape'
  readonly path?: string

  constructor(reason: 'json')
  constructor(reason: 'shape', path: string, issue: z.core.$ZodIssue)
  constructor(reason: 'json' | 'shape', path?: string, issue?: z.core.$ZodIssue) {
    super(
      reason === 'json'
        ? `stored settings row cannot parse JSON\n${STORED_SETTINGS_REMEDY}`
        : storedSettingsShapeMessage(path!, issue!),
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
  const result = STORED_SETTINGS_ROW_SCHEMA.safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]!
    throw new StoredSettingsRowError('shape', firstIssuePath(issue), issue)
  }
  return result.data
}
