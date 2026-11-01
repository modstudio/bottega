import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { patch as patchToml } from '@decimalturn/toml-patch'
import { z } from 'zod'
import { AUTONOMY_PRESETS, AUTONOMY_STAGES, AUTONOMY_VALUES } from './autonomy.ts'
import { PLATFORM_SLUG } from './brand.ts'
import { type ConfigEnvironment, resolveConfigRoot } from './config-directory.ts'
import {
  DELEGATION_MODES,
  DELEGATION_SETTING_KEYS,
  type DelegationSettingKey,
  type DelegationSettings,
} from './delegation-mode.ts'
import { containsSecretShaped } from './secret-shaped.ts'
import { SETTINGS_PERMISSION_LISTS, type SettingsPermissionList } from './settings-summary.ts'
import {
  isShipToConfigKey,
  readStoredShipTo,
  SHIP_TO_CONFIG_KEY,
  SHIP_TO_VALUES,
  storedShipToLevel,
} from './ship-to.ts'

export type MachineConfigEntry = {
  environment?: string
  legacyEnvironment?: string
  type: 'string' | 'integer'
  default: string | number
  values?: readonly string[]
  validator?: (value: string | number) => string | null
}

const MACHINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function machineIdValidation(value: string | number): string | null {
  return typeof value === 'string' && MACHINE_ID.test(value) ? null : 'value must be a UUID'
}

/**
 * Machine configuration keys and their sources. Precedence is canonical
 * environment, legacy environment, machine.toml, then default.
 */
const DELEGATION_MACHINE_CONFIG = Object.values(DELEGATION_SETTING_KEYS).reduce<
  Record<DelegationSettingKey, MachineConfigEntry>
>(
  (entries, key) => {
    entries[key] = { type: 'string', default: 'external', values: DELEGATION_MODES }
    return entries
  },
  {} as Record<DelegationSettingKey, MachineConfigEntry>,
)

export const MACHINE_CONFIG = {
  'projects.clone_root': {
    environment: 'BOTTEGA_CLONE_ROOT',
    type: 'string',
    default: '$HOME/Projects',
  },
  'hub.transcript_root': {
    environment: 'BOTTEGA_TRANSCRIPT_ROOT',
    type: 'string',
    default: '$HOME/.claude/projects',
  },
  'hub.port': {
    environment: 'BOTTEGA_HUB_PORT',
    type: 'integer',
    default: 7778,
  },
  'machine.id': { type: 'string', default: '', validator: machineIdValidation },
  'machine.short_name': { type: 'string', default: '' },
  'machine.display_name': { type: 'string', default: '' },
  'machine.former_short_names': { type: 'string', default: '' },
  ...DELEGATION_MACHINE_CONFIG,
  'model_host.url': {
    environment: 'BOTTEGA_MODEL_HOST_URL',
    legacyEnvironment: 'BOTTEGA_LOCAL_BASE_URL',
    type: 'string',
    default: '',
  },
  'model_host.model': {
    environment: 'BOTTEGA_MODEL_HOST_MODEL',
    legacyEnvironment: 'BOTTEGA_LOCAL_MODEL',
    type: 'string',
    default: '',
  },
  'model_host.wol_mac': {
    environment: 'BOTTEGA_MODEL_HOST_WOL_MAC',
    legacyEnvironment: 'BOTTEGA_LOCAL_WOL_MAC',
    type: 'string',
    default: '',
  },
  'model_host.ssh_alias': {
    environment: 'LOCAL_MODEL_HOST',
    type: 'string',
    default: '',
  },
  'model_host.tunnel_local_port': { type: 'integer', default: 8010 },
  'model_host.tunnel_remote_port': { type: 'integer', default: 8000 },
  'record.tunnel_app': { type: 'string', default: '' },
  'record.tunnel_local_port': { type: 'integer', default: 15432 },
  'record.tunnel_remote_port': { type: 'integer', default: 5432 },
  'routing.cost_policy': { type: 'string', default: '{}' },
  // The spare-hands lane: best-effort nightly jobs for free-tier agents only.
  // A task key that owns the lane's cost, so an operator can move it to a
  // standing maintenance task without a code change.
  'spare.task_key': {
    environment: 'BOTTEGA_SPARE_TASK_KEY',
    type: 'string',
    default: 'DEV-1676',
  },
  // When the nightly runner may start, and the clock time it stops for the night.
  'spare.start_time': {
    environment: 'BOTTEGA_SPARE_START_TIME',
    type: 'string',
    default: '22:00',
  },
  'spare.stop_time': {
    environment: 'BOTTEGA_SPARE_STOP_TIME',
    type: 'string',
    default: '05:00',
  },
} as const satisfies Record<string, MachineConfigEntry>

export type MachineConfigKey = keyof typeof MACHINE_CONFIG
type MachineConfigValue<Key extends MachineConfigKey> =
  (typeof MACHINE_CONFIG)[Key]['type'] extends 'integer' ? number : string

const warnedMachineConfigMessages = new Set<string>()

function writeWarning(message: string): void {
  process.stderr.write(`${message}\n`)
}

function warnUnknownMachineKey(
  path: string,
  key: string,
  warn: (message: string) => void,
  warned: Set<string>,
): void {
  const warningKey = `unknown:${path}:${key}`
  if (warned.has(warningKey)) return
  warned.add(warningKey)
  warn(
    `machine config ${path}: ignoring unknown key ${key}; a newer ${PLATFORM_SLUG} may have written it`,
  )
}

export function isMachineConfigKey(key: string): key is MachineConfigKey {
  return Object.hasOwn(MACHINE_CONFIG, key)
}

export type ConfigHome = 'machine' | 'user' | 'space'

export function isSubscriptionPriceKey(key: string): boolean {
  return /^subscription\.[^.]+\.monthly_usd$/.test(key)
}

export function configHomes(key: string): readonly ConfigHome[] | null {
  if (isMachineConfigKey(key)) return ['machine']
  if (key.startsWith('autonomy.')) return ['user', 'space', 'machine']
  if (isSubscriptionPriceKey(key)) return ['user']
  return null
}

export type MachinePermissionOverlay = {
  additions: Record<SettingsPermissionList, string[]>
  drop: Record<SettingsPermissionList, string[]>
}

const permissionRuleSchema = z
  .string()
  .refine((rule) => !containsSecretShaped(rule), 'secret-shaped permission rule')
const permissionListsSchema = z
  .object(
    Object.fromEntries(
      SETTINGS_PERMISSION_LISTS.map((list) => [list, z.array(permissionRuleSchema).optional()]),
    ) as Record<SettingsPermissionList, z.ZodOptional<z.ZodArray<typeof permissionRuleSchema>>>,
  )
  .strict()
const permissionsSchema = permissionListsSchema
  .extend({ drop: permissionListsSchema.optional() })
  .strict()

function valueSchema(entry: MachineConfigEntry, environmentValue: boolean) {
  if (entry.type === 'string') return z.string()
  return environmentValue
    ? z
        .string()
        .regex(/^-?\d+$/)
        .transform(Number)
        .pipe(z.number().int())
    : z.number().int()
}

function assertAllowedMachineValue(key: string, entry: MachineConfigEntry, value: unknown): void {
  if (!entry.values || typeof value !== 'string' || entry.values.includes(value)) return
  throw new Error(
    `key ${key} must be one of ${entry.values.join(', ')}; cleared by: ${PLATFORM_SLUG} machine config set --machine ${key} ${entry.default}`,
  )
}

function fileValue(parsed: unknown, key: string): unknown {
  let value = parsed
  for (const part of key.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

function validatedChildTable(
  table: Record<string, MachineConfigEntry>,
  known: string[],
  child: unknown,
  key: string,
  path: string,
  warn: (message: string) => void,
  warned: Set<string>,
): Record<string, unknown> | null {
  const entry = table[key]
  if (entry) {
    const result = valueSchema(entry, false).safeParse(child)
    if (!result.success) {
      throw new Error(
        `refusing machine config ${path}: key ${key} must be ${entry.type === 'integer' ? 'an integer' : 'a string'}`,
      )
    }
    return null
  }
  if (!known.some((candidate) => candidate.startsWith(`${key}.`))) {
    warnUnknownMachineKey(path, key, warn, warned)
    return null
  }
  if (typeof child !== 'object' || child === null || Array.isArray(child)) {
    throw new Error(`refusing machine config ${path}: key ${key} must be a table`)
  }
  return child as Record<string, unknown>
}

function validateAutonomyTable(
  name: string,
  child: unknown,
  prefix: string,
  path: string,
): boolean {
  if (prefix || name !== 'autonomy') return false
  if (typeof child !== 'object' || child === null || Array.isArray(child))
    throw new Error(`refusing machine config ${path}: key autonomy must be a table`)
  return true
}

function validatePermissionsTable(
  name: string,
  child: unknown,
  prefix: string,
  path: string,
): boolean {
  if (prefix || name !== 'permissions') return false
  const result = permissionsSchema.safeParse(child)
  if (result.success) return true
  const secretIssue = result.error.issues.find(
    (issue) => issue.message === 'secret-shaped permission rule',
  )
  if (secretIssue) {
    const location = secretIssue.path.reduce<string>(
      (current, part) =>
        typeof part === 'number' ? `${current}[${part}]` : `${current}.${String(part)}`,
      'permissions',
    )
    throw new Error(`refusing machine config ${path}: secret-shaped permission rule at ${location}`)
  }
  if (!result.success)
    throw new Error(
      `refusing machine config ${path}: permissions must contain only optional allow, ask, deny string lists and a drop table with the same lists`,
    )
  return true
}

function validateProjectTable(
  child: unknown,
  prefix: string,
  key: string,
  path: string,
  warn: (message: string) => void,
  warned: Set<string>,
): boolean {
  if (prefix !== 'projects' || key === 'projects.clone_root') return false
  if (typeof child !== 'object' || child === null || Array.isArray(child))
    throw new Error(`refusing machine config ${path}: key ${key} must be a table`)
  const project = child as Record<string, unknown>
  for (const projectKey of Object.keys(project)) {
    if (projectKey !== 'autonomy') warnUnknownMachineKey(path, `${key}.${projectKey}`, warn, warned)
  }
  if (
    project.autonomy !== undefined &&
    (typeof project.autonomy !== 'object' ||
      project.autonomy === null ||
      Array.isArray(project.autonomy))
  )
    throw new Error(`refusing machine config ${path}: key ${key}.autonomy must be a table`)
  return true
}

function validateFile(
  table: Record<string, MachineConfigEntry>,
  parsed: unknown,
  path: string,
  warn: (message: string) => void = writeWarning,
  warned: Set<string> = warnedMachineConfigMessages,
): void {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`refusing machine config ${path}: expected a TOML table`)
  }
  const known = Object.keys(table)
  const visit = (value: Record<string, unknown>, prefix = ''): void => {
    for (const [name, child] of Object.entries(value)) {
      const key = prefix ? `${prefix}.${name}` : name
      if (
        validateAutonomyTable(name, child, prefix, path) ||
        validatePermissionsTable(name, child, prefix, path) ||
        validateProjectTable(child, prefix, key, path, warn, warned)
      )
        continue
      const childTable = validatedChildTable(table, known, child, key, path, warn, warned)
      if (childTable) visit(childTable, key)
    }
  }
  visit(parsed as Record<string, unknown>)
}

function resolvedDefault(entry: MachineConfigEntry, env: ConfigEnvironment, key: string): unknown {
  if (typeof entry.default !== 'string' || !entry.default.startsWith('$HOME/')) return entry.default
  if (!env.HOME) {
    const environment = entry.environment ? ` or set ${entry.environment}` : ''
    throw new Error(`cannot resolve machine config key ${key}: HOME is unset${environment}`)
  }
  return join(env.HOME, entry.default.slice('$HOME/'.length))
}

/** Resolve one value from already-gathered facts, without reading the filesystem. */
export type MachineValueSource =
  | { kind: 'environment'; name: string }
  | { kind: 'machine-file' }
  | { kind: 'default' }

export function resolveMachineValue<
  Table extends Record<string, MachineConfigEntry>,
  Key extends keyof Table & string,
>(
  table: Table,
  env: ConfigEnvironment,
  parsed: unknown,
  key: Key,
  path: string,
  warn: (message: string) => void,
  warned: Set<string>,
): {
  value: Table[Key]['type'] extends 'integer' ? number : string
  source: MachineValueSource
} {
  validateFile(table, parsed, path, warn, warned)
  const entry = table[key]
  if (!entry) throw new Error(`refusing machine config ${path}: unknown key ${key}`)

  let value: unknown
  let environmentValue = false
  let environmentSource: string | undefined
  let source: MachineValueSource
  if (entry.environment && env[entry.environment] !== undefined) {
    value = env[entry.environment]
    environmentValue = true
    environmentSource = entry.environment
    source = { kind: 'environment', name: entry.environment }
  } else if (entry.legacyEnvironment && env[entry.legacyEnvironment] !== undefined) {
    value = env[entry.legacyEnvironment]
    environmentValue = true
    environmentSource = entry.legacyEnvironment
    source = { kind: 'environment', name: entry.legacyEnvironment }
    if (!warned.has(entry.legacyEnvironment)) {
      warned.add(entry.legacyEnvironment)
      warn(`${entry.legacyEnvironment} is deprecated; use ${entry.environment}`)
    }
  } else {
    const stored = fileValue(parsed, key)
    value = stored ?? resolvedDefault(entry, env, key)
    source = stored === undefined ? { kind: 'default' } : { kind: 'machine-file' }
  }

  const result = valueSchema(entry, environmentValue).safeParse(value)
  if (!result.success) {
    const expected = entry.type === 'integer' ? 'an integer' : 'a string'
    if (environmentSource) {
      throw new Error(
        `refusing machine config key ${key}: ${environmentSource} must be ${expected}; set ${environmentSource} to ${expected} or unset it`,
      )
    }
    throw new Error(`refusing machine config ${path}: key ${key} must be ${expected}`)
  }
  assertAllowedMachineValue(key, entry, result.data)
  return {
    value: result.data as Table[Key]['type'] extends 'integer' ? number : string,
    source,
  }
}

function machineConfigPath(env: ConfigEnvironment = process.env): string {
  return join(resolveConfigRoot(env), 'machine.toml')
}

function readMachineText(path: string): string {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`refusing machine config ${path}: cannot read file: ${detail}`)
  }
  try {
    Bun.TOML.parse(text)
    return text
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`refusing machine config ${path}: invalid TOML: ${detail}`)
  }
}

function readMachineFile(path: string): Record<string, unknown> {
  const text = readMachineText(path)
  const parsed = text ? Bun.TOML.parse(text) : {}
  validateFile(MACHINE_CONFIG, parsed, path)
  return parsed as Record<string, unknown>
}

function emptyPermissionLists(): Record<SettingsPermissionList, string[]> {
  const lists = {} as Record<SettingsPermissionList, string[]>
  for (const list of SETTINGS_PERMISSION_LISTS) lists[list] = []
  return lists
}

export function readMachinePermissions(
  env: ConfigEnvironment = process.env,
): MachinePermissionOverlay {
  const parsed = readMachineFile(machineConfigPath(env))
  const permissions = (parsed.permissions ?? {}) as Record<string, unknown>
  const drop = (permissions.drop ?? {}) as Record<string, unknown>
  const additions = emptyPermissionLists()
  const dropped = emptyPermissionLists()
  for (const list of SETTINGS_PERMISSION_LISTS) {
    additions[list] = [...((permissions[list] as string[] | undefined) ?? [])]
    dropped[list] = [...((drop[list] as string[] | undefined) ?? [])]
  }
  return { additions, drop: dropped }
}

export type MachinePermissionOperation = 'add' | 'remove' | 'drop' | 'undrop'

function atomicPatch(
  mutate: (root: Record<string, unknown>) => void,
  env: ConfigEnvironment,
): void {
  const path = machineConfigPath(env)
  const text = readMachineText(path)
  const parsed = text ? (Bun.TOML.parse(text) as Record<string, unknown>) : {}
  validateFile(MACHINE_CONFIG, parsed, path)
  mutate(parsed)
  validateFile(MACHINE_CONFIG, parsed, path)
  const rendered = patchToml(text, parsed)
  const directory = resolveConfigRoot(env)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.machine.toml.${process.pid}.${crypto.randomUUID()}.tmp`)
  let mode = 0o600
  try {
    mode = statSync(path).mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    writeFileSync(temporary, rendered, { encoding: 'utf8', mode, flag: 'wx' })
    chmodSync(temporary, mode)
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {}
    throw error
  }
}

export function editMachinePermission(
  operation: MachinePermissionOperation,
  list: SettingsPermissionList,
  rule: string,
  env: ConfigEnvironment = process.env,
): { changed: boolean; overlay: MachinePermissionOverlay } {
  let changed = false
  atomicPatch((root) => {
    const result = editMachinePermissionTable(
      (root.permissions as Record<string, unknown> | undefined) ?? {},
      operation,
      list,
      rule,
    )
    changed = result.changed
    if (Object.keys(result.permissions).length) root.permissions = result.permissions
    else delete root.permissions
  }, env)
  return { changed, overlay: readMachinePermissions(env) }
}

export function editMachinePermissionTable(
  current: Record<string, unknown>,
  operation: MachinePermissionOperation,
  list: SettingsPermissionList,
  rule: string,
): { permissions: Record<string, unknown>; changed: boolean } {
  const permissions = { ...current }
  const useDrop = operation === 'drop' || operation === 'undrop'
  const currentDrop = (current.drop as Record<string, unknown> | undefined) ?? {}
  const target = useDrop ? { ...currentDrop } : permissions
  const values = [...((target[list] as string[] | undefined) ?? [])]
  const remove = operation === 'remove' || operation === 'undrop'
  const next = remove ? values.filter((value) => value !== rule) : [...values, rule]
  const deduplicated = [...new Set(next)]
  const changed =
    deduplicated.length !== values.length ||
    deduplicated.some((value, index) => value !== values[index])
  if (deduplicated.length) target[list] = deduplicated
  else delete target[list]
  if (useDrop) {
    if (Object.keys(target).length) permissions.drop = target
    else delete permissions.drop
  }
  return { permissions, changed }
}

const MACHINE_AUTONOMY_KEYS =
  'autonomy.preset, autonomy.rulings, autonomy.ship-to, autonomy.stage.<stage>, autonomy.step.<slug>, autonomy.workflow.<slug>.(preset|rulings|stage.<stage>|step.<slug>)'

function autonomyPath(key: string): string[] {
  const parts = key.split('.')
  if (parts.shift() !== 'autonomy')
    throw new Error(`accepted machine keys: ${MACHINE_AUTONOMY_KEYS}`)
  const mapped: string[] = []
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!
    if (part === 'stage') mapped.push('stages')
    else if (part === 'step') mapped.push('steps')
    else if (part === 'workflow') mapped.push('workflows')
    else mapped.push(part)
  }
  return mapped
}

function autonomyEntryKind(key: string): 'preset' | 'rulings' | 'ship-to' | 'value' {
  const path = autonomyPath(key)
  if (
    path.length === 1 &&
    (['preset', 'rulings'].includes(path[0]!) || isShipToConfigKey(`autonomy.${path[0]}`))
  )
    return path[0] === 'release' ? 'ship-to' : (path[0] as 'preset' | 'rulings' | 'ship-to')
  if (
    path.length === 2 &&
    ((path[0] === 'stages' && AUTONOMY_STAGES.includes(path[1] as never)) ||
      (path[0] === 'steps' && Boolean(path[1])))
  )
    return 'value'
  if (path.length === 3 && path[0] === 'workflows' && path[1]) {
    if (path[2] === 'preset' || path[2] === 'rulings') return path[2]
  }
  if (
    path.length === 4 &&
    path[0] === 'workflows' &&
    path[1] &&
    ((path[2] === 'stages' && AUTONOMY_STAGES.includes(path[3] as never)) ||
      (path[2] === 'steps' && Boolean(path[3])))
  )
    return 'value'
  throw new Error(`accepted machine keys: ${MACHINE_AUTONOMY_KEYS}`)
}

export function validateAutonomyEntry(key: string, value: string): void {
  const kind = autonomyEntryKind(key)
  if (kind === 'ship-to') {
    if (storedShipToLevel(value) === undefined)
      throw new Error(
        `refusing autonomy config key ${key}: value must be one of ${SHIP_TO_VALUES.join(', ')}`,
      )
    return
  }
  const accepted =
    kind === 'preset' ? AUTONOMY_PRESETS : kind === 'rulings' ? ['agent', 'user'] : AUTONOMY_VALUES
  if (!accepted.includes(value as never))
    throw new Error(
      `refusing autonomy config key ${key}: value must be one of ${accepted.join(', ')}`,
    )
}

export function setMachineAutonomy(
  key: string,
  value: string,
  env: ConfigEnvironment = process.env,
): void {
  validateAutonomyEntry(key, value)
  const shipTo = isShipToConfigKey(key)
  const path = autonomyPath(shipTo ? SHIP_TO_CONFIG_KEY : key)
  const storedValue = shipTo ? storedShipToLevel(value)! : value
  atomicPatch((root) => {
    if (root.autonomy === undefined) root.autonomy = {}
    let table = root.autonomy as Record<string, unknown>
    for (const part of path.slice(0, -1)) {
      if (table[part] === undefined) table[part] = {}
      table = table[part] as Record<string, unknown>
    }
    table[path.at(-1)!] = storedValue
    if (path.length === 1 && path[0] === 'ship-to') delete table.release
  }, env)
}

export function deleteMachineAutonomy(key: string, env: ConfigEnvironment = process.env): void {
  autonomyEntryKind(key)
  const shipTo = isShipToConfigKey(key)
  const path = autonomyPath(shipTo ? SHIP_TO_CONFIG_KEY : key)
  atomicPatch((root) => {
    const stack: Record<string, unknown>[] = []
    let table = root.autonomy as Record<string, unknown> | undefined
    if (!table) return
    stack.push(root, table)
    for (const part of path.slice(0, -1)) {
      const child = table[part]
      if (typeof child !== 'object' || child === null || Array.isArray(child)) return
      table = child as Record<string, unknown>
      stack.push(table)
    }
    delete table[path.at(-1)!]
    if (shipTo) delete table.release
    for (let index = stack.length - 1; index > 0; index--) {
      const child = stack[index]!
      if (Object.keys(child).length) break
      const parent = stack[index - 1]!
      const childKey = index === 1 ? 'autonomy' : path[index - 2]!
      delete parent[childKey]
    }
  }, env)
}

export type MachineConfigFileEntry = {
  key: string
  value: string
  scope: 'machine'
}

export function listMachineAutonomy(
  env: ConfigEnvironment = process.env,
): MachineConfigFileEntry[] {
  const root = readMachineFile(machineConfigPath(env))
  const rows: MachineConfigFileEntry[] = []
  const visit = (value: unknown, path: string[]): void => {
    if (typeof value === 'string') {
      const normalized = path.map(
        (part) => ({ stages: 'stage', steps: 'step', workflows: 'workflow' })[part] ?? part,
      )
      rows.push({ key: `autonomy.${normalized.join('.')}`, value, scope: 'machine' })
      return
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return
    for (const [name, child] of Object.entries(value)) visit(child, [...path, name])
  }
  const autonomy = root.autonomy
  if (typeof autonomy === 'object' && autonomy !== null && !Array.isArray(autonomy)) {
    const table = { ...(autonomy as Record<string, unknown>) }
    const stored = readStoredShipTo(
      table['ship-to'],
      table.release,
      Object.hasOwn(table, 'ship-to'),
      Object.hasOwn(table, 'release'),
    )
    delete table.release
    if (stored.level !== undefined || stored.invalid !== undefined) {
      table['ship-to'] = stored.level ?? stored.invalid
    }
    visit(table, [])
  }
  return rows.sort((left, right) => left.key.localeCompare(right.key))
}

/** Read the autonomy tables while sharing machine.toml path and TOML handling. */
export function readMachineAutonomy(
  project: string,
  env: ConfigEnvironment = process.env,
): { user: unknown; project: unknown } {
  const path = machineConfigPath(env)
  const parsed = readMachineFile(path)
  const root = parsed
  const projects = root.projects
  const projectTable =
    typeof projects === 'object' && projects !== null && !Array.isArray(projects)
      ? (projects as Record<string, unknown>)[project]
      : undefined
  return {
    user: root.autonomy,
    project:
      typeof projectTable === 'object' && projectTable !== null && !Array.isArray(projectTable)
        ? (projectTable as Record<string, unknown>).autonomy
        : undefined,
  }
}

/** Read machine.toml at use time and resolve one machine-valued setting. */
export function readMachineValue<Key extends MachineConfigKey>(
  key: Key,
  env: ConfigEnvironment = process.env,
): MachineConfigValue<Key> {
  const path = machineConfigPath(env)
  return resolveMachineValue(
    MACHINE_CONFIG,
    env,
    readMachineFile(path),
    key,
    path,
    writeWarning,
    warnedMachineConfigMessages,
  ).value
}

export function readMachineValueWithSource<Key extends MachineConfigKey>(
  key: Key,
  env: ConfigEnvironment = process.env,
): { value: MachineConfigValue<Key>; source: MachineValueSource } {
  const path = machineConfigPath(env)
  const parsed = readMachineFile(path)
  return resolveMachineValue(
    MACHINE_CONFIG,
    env,
    parsed,
    key,
    path,
    writeWarning,
    warnedMachineConfigMessages,
  )
}

export function readMachineFileValue(
  key: MachineConfigKey,
  env: ConfigEnvironment = process.env,
): string | number | undefined {
  const path = machineConfigPath(env)
  const parsed = readMachineFile(path)
  const value = fileValue(parsed, key)
  if (value === undefined) return undefined
  const entry = MACHINE_CONFIG[key]
  const result = valueSchema(entry, false).safeParse(value)
  if (!result.success) {
    const expected = entry.type === 'integer' ? 'an integer' : 'a string'
    throw new Error(`refusing machine config ${path}: key ${key} must be ${expected}`)
  }
  assertAllowedMachineValue(key, entry, result.data)
  return result.data
}

export function setMachineValue(
  key: MachineConfigKey,
  value: string,
  env: ConfigEnvironment = process.env,
): string | number {
  const entry: MachineConfigEntry = MACHINE_CONFIG[key]
  const parsedValue = entry.type === 'integer' && /^-?\d+$/.test(value) ? Number(value) : value
  const result = valueSchema(entry, false).safeParse(parsedValue)
  if (!result.success) {
    const expected = entry.type === 'integer' ? 'an integer' : 'a string'
    throw new Error(`refusing machine config key ${key}: value must be ${expected}`)
  }
  assertAllowedMachineValue(key, entry, result.data)
  const validation = entry.validator?.(result.data)
  if (validation)
    throw new Error(
      `refusing machine config key ${key}: ${validation}; write a valid value with \`${PLATFORM_SLUG} machine config set --machine ${key} <uuid>\``,
    )
  atomicPatch((root) => {
    const parts = key.split('.')
    let table = root
    for (const part of parts.slice(0, -1)) {
      if (table[part] === undefined) table[part] = {}
      table = table[part] as Record<string, unknown>
    }
    table[parts.at(-1)!] = result.data
  }, env)
  return result.data
}

export function deleteMachineValue(
  key: MachineConfigKey,
  env: ConfigEnvironment = process.env,
): void {
  atomicPatch((root) => {
    const parts = key.split('.')
    const tables = [root]
    let table = root
    for (const part of parts.slice(0, -1)) {
      const child = table[part]
      if (typeof child !== 'object' || child === null || Array.isArray(child)) return
      table = child as Record<string, unknown>
      tables.push(table)
    }
    delete table[parts.at(-1)!]
    for (let index = tables.length - 1; index > 0; index--) {
      if (Object.keys(tables[index]!).length) break
      delete tables[index - 1]![parts[index - 1]!]
    }
  }, env)
}

export function readDelegationSettings(env: ConfigEnvironment = process.env): DelegationSettings {
  return Object.fromEntries(
    Object.values(DELEGATION_SETTING_KEYS).map((key) => [key, readMachineValue(key, env)]),
  ) as DelegationSettings
}

export function listMachineEntries(env: ConfigEnvironment = process.env): MachineConfigFileEntry[] {
  const catalogue = Object.keys(MACHINE_CONFIG).flatMap((key) => {
    const value = readMachineFileValue(key as MachineConfigKey, env)
    return value === undefined ? [] : [{ key, value: String(value), scope: 'machine' as const }]
  })
  return [...catalogue, ...listMachineAutonomy(env)].sort((left, right) =>
    left.key.localeCompare(right.key),
  )
}

const MACHINE_ID_LOCK_WAIT_MS = 10_000
const MACHINE_ID_LOCK_POLL_MS = 10

type MachineIdentityLockWait = {
  now: () => number
  wait: (milliseconds: number) => void
  timeoutMs: number
  pollMs: number
}

const machineIdentityLockWait: MachineIdentityLockWait = {
  now: Date.now,
  wait: Bun.sleepSync,
  timeoutMs: MACHINE_ID_LOCK_WAIT_MS,
  pollMs: MACHINE_ID_LOCK_POLL_MS,
}

/** Read the durable machine identity without creating configuration. */
export function storedMachineId(env: ConfigEnvironment = process.env): string | null {
  const id = readMachineValue('machine.id', env)
  if (!id) return null
  if (!MACHINE_ID.test(id))
    throw new Error(
      `refusing machine config: machine.id must be a UUID; write a valid value with \`${PLATFORM_SLUG} machine config set --machine machine.id <uuid>\``,
    )
  return id
}

export type StoredMachineNames = {
  shortName: string
  displayName: string | null
  readonly formerShortNames: readonly string[]
}

export function parseFormerShortNames(value: string): string[] {
  return [...new Set(value.split(',').filter(Boolean))]
}

function formerShortNamesAfterRename(
  former: readonly string[],
  previous: string,
  current: string,
): string[] {
  return [...new Set([...former, ...(previous && previous !== current ? [previous] : [])])].filter(
    (name) => name !== current,
  )
}

export function storedMachineNames(
  env: ConfigEnvironment = process.env,
): StoredMachineNames | null {
  const shortName = readMachineValue('machine.short_name', env)
  const displayName = readMachineValue('machine.display_name', env)
  const formerShortNames = parseFormerShortNames(
    readMachineValue('machine.former_short_names', env),
  )
  return shortName ? { shortName, displayName: displayName || null, formerShortNames } : null
}

export function writeMachineNames(
  names: { shortName: string; displayName: string },
  env: ConfigEnvironment = process.env,
): void {
  atomicPatch((root) => {
    const machine = (root.machine as Record<string, unknown> | undefined) ?? {}
    const previous = typeof machine.short_name === 'string' ? machine.short_name : ''
    const former = parseFormerShortNames(
      typeof machine.former_short_names === 'string' ? machine.former_short_names : '',
    )
    root.machine = {
      ...machine,
      short_name: names.shortName,
      display_name: names.displayName,
      former_short_names: formerShortNamesAfterRename(former, previous, names.shortName).join(','),
    }
  }, env)
}

/** Carry over an existing identity or mint and persist this machine's identity once. */
export function machineId(
  existing: string | null = null,
  env: ConfigEnvironment = process.env,
  lockWait: MachineIdentityLockWait = machineIdentityLockWait,
): string {
  const directory = resolveConfigRoot(env)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const lock = join(directory, '.machine-id.lock')
  const deadline = lockWait.now() + lockWait.timeoutMs
  let descriptor: number
  for (;;) {
    try {
      descriptor = openSync(lock, 'wx', 0o600)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (lockWait.now() >= deadline)
        throw new Error(
          `timed out waiting for machine identity lock ${lock}; ` +
            'remove this lock file when no process is starting',
        )
      lockWait.wait(lockWait.pollMs)
    }
  }
  try {
    const stored = storedMachineId(env)
    if (stored) return stored
    const id = existing ?? Bun.randomUUIDv7()
    if (!MACHINE_ID.test(id)) throw new Error(`refusing legacy machine identity: expected a UUID`)
    atomicPatch((root) => {
      root.machine = { ...((root.machine as Record<string, unknown> | undefined) ?? {}), id }
    }, env)
    return id
  } finally {
    closeSync(descriptor)
    unlinkSync(lock)
  }
}

if (import.meta.main) {
  const [command, key] = process.argv.slice(2)
  if (command !== 'get' || !key) {
    throw new Error('working form: bun shared/machine-config.ts get <key>')
  }
  try {
    console.log(readMachineValue(key as MachineConfigKey))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
