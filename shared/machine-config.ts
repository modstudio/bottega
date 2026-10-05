import {
  chmodSync,
  mkdirSync,
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
import { type ConfigEnvironment, resolveConfigRoot } from './config-directory.ts'
import { containsSecretShaped } from './secret-shaped.ts'
import { SETTINGS_PERMISSION_LISTS, type SettingsPermissionList } from './settings-summary.ts'
import { storedShipToLevel } from './ship-to.ts'

type MachineConfigEntry = {
  environment?: string
  legacyEnvironment?: string
  type: 'string' | 'integer'
  default: string | number
}

/**
 * Machine configuration keys and their sources. Precedence is canonical
 * environment, legacy environment, machine.toml, then default.
 */
export const MACHINE_CONFIG = {
  'projects.clone_root': {
    environment: 'ORCH_CLONE_ROOT',
    type: 'string',
    default: '$HOME/Projects',
  },
  'hub.transcript_root': {
    environment: 'HUB_TRANSCRIPT_ROOT',
    type: 'string',
    default: '$HOME/.claude/projects',
  },
  'hub.port': { environment: 'HUB_PORT', type: 'integer', default: 7778 },
  'model_host.url': {
    environment: 'ORCH_MODEL_HOST_URL',
    legacyEnvironment: 'ORCH_LOCAL_BASE_URL',
    type: 'string',
    default: '',
  },
  'model_host.model': {
    environment: 'ORCH_MODEL_HOST_MODEL',
    legacyEnvironment: 'ORCH_LOCAL_MODEL',
    type: 'string',
    default: '',
  },
  'model_host.wol_mac': {
    environment: 'ORCH_MODEL_HOST_WOL_MAC',
    legacyEnvironment: 'ORCH_LOCAL_WOL_MAC',
    type: 'string',
    default: '',
  },
  'model_host.ssh_alias': { environment: 'LOCAL_MODEL_HOST', type: 'string', default: '' },
  'model_host.tunnel_local_port': { type: 'integer', default: 8010 },
  'model_host.tunnel_remote_port': { type: 'integer', default: 8000 },
  'record.tunnel_app': { type: 'string', default: '' },
  'record.tunnel_local_port': { type: 'integer', default: 15432 },
  'record.tunnel_remote_port': { type: 'integer', default: 5432 },
} as const satisfies Record<string, MachineConfigEntry>

export type MachineConfigKey = keyof typeof MACHINE_CONFIG
type MachineConfigValue<Key extends MachineConfigKey> =
  (typeof MACHINE_CONFIG)[Key]['type'] extends 'integer' ? number : string

const warnedLegacyVariables = new Set<string>()

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
    throw new Error(`refusing machine config ${path}: unknown key ${key}`)
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

function validateProjectTable(child: unknown, prefix: string, key: string, path: string): boolean {
  if (prefix !== 'projects' || key === 'projects.clone_root') return false
  if (typeof child !== 'object' || child === null || Array.isArray(child))
    throw new Error(`refusing machine config ${path}: key ${key} must be a table`)
  const project = child as Record<string, unknown>
  if (Object.keys(project).some((projectKey) => projectKey !== 'autonomy'))
    throw new Error(`refusing machine config ${path}: unknown key ${key}`)
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
        validateProjectTable(child, prefix, key, path)
      )
        continue
      const childTable = validatedChildTable(table, known, child, key, path)
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
): Table[Key]['type'] extends 'integer' ? number : string {
  validateFile(table, parsed, path)
  const entry = table[key]
  if (!entry) throw new Error(`refusing machine config ${path}: unknown key ${key}`)

  let value: unknown
  let environmentValue = false
  let environmentSource: string | undefined
  if (entry.environment && env[entry.environment] !== undefined) {
    value = env[entry.environment]
    environmentValue = true
    environmentSource = entry.environment
  } else if (entry.legacyEnvironment && env[entry.legacyEnvironment] !== undefined) {
    value = env[entry.legacyEnvironment]
    environmentValue = true
    environmentSource = entry.legacyEnvironment
    if (!warned.has(entry.legacyEnvironment)) {
      warned.add(entry.legacyEnvironment)
      warn(`${entry.legacyEnvironment} is deprecated; use ${entry.environment}`)
    }
  } else {
    value = fileValue(parsed, key) ?? resolvedDefault(entry, env, key)
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
  return result.data as Table[Key]['type'] extends 'integer' ? number : string
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
  if (path.length === 1 && ['preset', 'rulings', 'ship-to', 'release'].includes(path[0]!))
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

function validateAutonomyEntry(key: string, value: string): void {
  const kind = autonomyEntryKind(key)
  const valid =
    (kind === 'preset' && AUTONOMY_PRESETS.includes(value as never)) ||
    (kind === 'rulings' && ['agent', 'user'].includes(value)) ||
    (kind === 'ship-to' && storedShipToLevel(value) !== undefined) ||
    (kind === 'value' && AUTONOMY_VALUES.includes(value as never))
  if (!valid) throw new Error(`accepted machine keys: ${MACHINE_AUTONOMY_KEYS}`)
}

export function setMachineAutonomy(
  key: string,
  value: string,
  env: ConfigEnvironment = process.env,
): void {
  validateAutonomyEntry(key, value)
  const alias = key === 'autonomy.release'
  const path = autonomyPath(alias ? 'autonomy.ship-to' : key)
  const storedValue = alias || key === 'autonomy.ship-to' ? storedShipToLevel(value)! : value
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
  const shipTo = key === 'autonomy.ship-to' || key === 'autonomy.release'
  const path = autonomyPath(shipTo ? 'autonomy.ship-to' : key)
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

export type MachineAutonomyEntry = { key: string; value: string; scope: 'local user' }

export function listMachineAutonomy(env: ConfigEnvironment = process.env): MachineAutonomyEntry[] {
  const root = readMachineFile(machineConfigPath(env))
  const rows: MachineAutonomyEntry[] = []
  const visit = (value: unknown, path: string[]): void => {
    if (typeof value === 'string') {
      const normalized = path.map(
        (part) => ({ stages: 'stage', steps: 'step', workflows: 'workflow' })[part] ?? part,
      )
      rows.push({ key: `autonomy.${normalized.join('.')}`, value, scope: 'local user' })
      return
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return
    for (const [name, child] of Object.entries(value)) visit(child, [...path, name])
  }
  const autonomy = root.autonomy
  if (typeof autonomy === 'object' && autonomy !== null && !Array.isArray(autonomy)) {
    const table = { ...(autonomy as Record<string, unknown>) }
    const stored = Object.hasOwn(table, 'ship-to') ? table['ship-to'] : table.release
    delete table.release
    if (stored !== undefined) {
      const mapped = storedShipToLevel(stored)
      table['ship-to'] = mapped ?? stored
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
    (message) => process.stderr.write(`${message}\n`),
    warnedLegacyVariables,
  )
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
