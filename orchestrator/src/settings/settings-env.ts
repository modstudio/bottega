// concern: settings-env
/** Reads and writes the user-only settings secrets file without exposing values. */

import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ENV_NAME, SETTINGS_PARSE_REFUSAL } from './settings.ts'

let temporarySequence = 0

export function userSettingsEnvPath(claudeHome: string): string {
  return join(claudeHome, 'settings.env')
}

export function settingsEnvironmentFromJson(path: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readRegular(path)) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(SETTINGS_PARSE_REFUSAL)
    throw error
  }
  if (!plainObject(parsed))
    throw new Error(`refusing settings env import: expected an object in ${path}`)
  const environment = parsed.env
  if (environment === undefined) return {}
  if (!plainObject(environment)) {
    throw new Error(`refusing settings env import: env must be an object in ${path}`)
  }
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(environment)) {
    if (!ENV_NAME.test(name))
      throw new Error(`refusing settings env import: invalid env name ${name}`)
    if (typeof value !== 'string') {
      throw new Error(`refusing settings env import: ${name} must have a string value`)
    }
    result[name] = value
  }
  return result
}

export function readSettingsEnv(path: string): Map<string, string> {
  if (!existsSync(path)) return new Map()
  refuseUnsafeMode(path)
  return parseDotenv(readRegular(path), path)
}

export function selectedSettingsEnvironment(path: string, names: string[]): Record<string, string> {
  const values = readSettingsEnv(path)
  const selected: Record<string, string> = {}
  for (const name of names) {
    const value = values.get(name)
    if (value === undefined) {
      throw new Error(
        `refusing settings render: ${name} is missing from ${path}\n` +
          `cleared by: add ${name} to ${path} with mode 0600`,
      )
    }
    selected[name] = value
  }
  return selected
}

export function mergeSettingsEnv(
  path: string,
  imported: Record<string, string>,
  dryRun: boolean,
): { names: string[]; added: number; present: number } {
  const current = readSettingsEnv(path)
  let added = 0
  let present = 0
  for (const [name, value] of Object.entries(imported)) {
    const prior = current.get(name)
    if (prior !== undefined && prior !== value) {
      throw new Error(
        `refusing settings env import: ${name} already has a different value in ${path}\n` +
          `cleared by: reconcile ${name} without printing either value`,
      )
    }
    if (prior === value) present++
    else {
      current.set(name, value)
      added++
    }
  }
  if (!dryRun && (added > 0 || !existsSync(path))) writeSettingsEnv(path, current)
  return { names: Object.keys(imported).sort(), added, present }
}

export function writeSettingsEnv(
  path: string,
  values: Map<string, string>,
  temporaryWritten: () => void = () => {},
): void {
  const directory = dirname(path)
  const temporary = join(
    directory,
    `.${basename(path)}.tmp-${process.pid}-${Date.now()}-${temporarySequence++}`,
  )
  let fd: number | null = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  )
  try {
    const text = [...values]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join('\n')
    writeFileSync(fd, text ? `${text}\n` : '')
    fsyncSync(fd)
    fchmodSync(fd, 0o600)
    closeSync(fd)
    fd = null
    temporaryWritten()
    if (existsSync(path)) refuseUnsafeDestination(path)
    renameSync(temporary, path)
    const directoryFd = openSync(directory, constants.O_RDONLY)
    try {
      fsyncSync(directoryFd)
    } finally {
      closeSync(directoryFd)
    }
  } finally {
    if (fd !== null) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

function refuseUnsafeDestination(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`refusing settings secrets file ${path}: expected a regular file`)
  }
  if (stat.nlink !== 1) {
    throw new Error(`refusing settings secrets file ${path}: hard links are not allowed`)
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`refusing settings secrets file ${path}: file is not owned by the current user`)
  }
}

function refuseUnsafeMode(path: string): void {
  const mode = lstatSync(path).mode & 0o777
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `refusing settings secrets file ${path}: mode ${mode.toString(8).padStart(4, '0')} permits group or other access\n` +
        `cleared by: chmod 600 ${path}`,
    )
  }
}

function readRegular(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!fstatSync(fd).isFile())
      throw new Error(`refusing settings path ${path}: expected a regular file`)
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function parseDotenv(text: string, path: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) throw new Error(`refusing settings secrets file ${path}: invalid line ${index + 1}`)
    const name = match[1]!
    if (values.has(name)) {
      throw new Error(`refusing settings secrets file ${path}: duplicate key ${name}`)
    }
    values.set(name, parseDotenvValue(match[2]!, path, index + 1))
  }
  return values
}

function parseDotenvValue(raw: string, path: string, line: number): string {
  if (raw.startsWith('"')) {
    const token = quotedToken(raw, '"', path, line)
    try {
      const value = JSON.parse(token) as unknown
      if (typeof value === 'string') return value
    } catch {}
    throw new Error(`refusing settings secrets file ${path}: invalid quoted value at line ${line}`)
  }
  if (raw.startsWith("'")) {
    const token = quotedToken(raw, "'", path, line)
    return token.slice(1, -1)
  }
  return raw.replace(/(?:^|\s+)#.*$/, '').trimEnd()
}

function quotedToken(raw: string, quote: '"' | "'", path: string, line: number): string {
  let escaped = false
  for (let index = 1; index < raw.length; index++) {
    const character = raw[index]!
    if (quote === '"' && character === '\\' && !escaped) {
      escaped = true
      continue
    }
    if (character === quote && !escaped) {
      const suffix = raw.slice(index + 1)
      if (suffix === '' || /^\s+#.*$/.test(suffix)) return raw.slice(0, index + 1)
      break
    }
    escaped = false
  }
  throw new Error(`refusing settings secrets file ${path}: invalid quoted value at line ${line}`)
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
