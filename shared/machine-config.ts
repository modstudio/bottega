import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { type ConfigEnvironment, resolveConfigRoot } from './config-directory.ts'

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
} as const satisfies Record<string, MachineConfigEntry>

export type MachineConfigKey = keyof typeof MACHINE_CONFIG
type MachineConfigValue<Key extends MachineConfigKey> =
  (typeof MACHINE_CONFIG)[Key]['type'] extends 'integer' ? number : string

const warnedLegacyVariables = new Set<string>()

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
      if (!prefix && (name === 'autonomy' || name === 'projects')) continue
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

export function machineConfigPath(env: ConfigEnvironment): string {
  return join(resolveConfigRoot(env), 'machine.toml')
}

export function readMachineFile(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`refusing machine config ${path}: cannot read file: ${detail}`)
  }
  try {
    return Bun.TOML.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`refusing machine config ${path}: invalid TOML: ${detail}`)
  }
}

/** Read the autonomy tables while sharing machine.toml path and TOML handling. */
export function readMachineAutonomy(
  project: string,
  env: ConfigEnvironment = process.env,
): { user: unknown; project: unknown } {
  const path = machineConfigPath(env)
  const parsed = readMachineFile(path)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`refusing machine config ${path}: expected a TOML table`)
  const root = parsed as Record<string, unknown>
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
