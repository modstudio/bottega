// concern: settings-files
/** Reads Claude settings files. Must not know stores, commands, runs, routing, or transports. */
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { type PermissionList, permissionLists, SETTINGS_PARSE_REFUSAL } from './settings.ts'
import { parseSettingsFile } from './settings-render.ts'

export function claudeHomeFromEnvironment(env: NodeJS.ProcessEnv): string {
  const home = env.HOME
  if (!home) throw new Error('HOME is required to locate the Claude home')
  return join(home, '.claude')
}

export function userSettingsPath(claudeHome: string): string {
  return join(claudeHome, 'settings.json')
}

export function userLocalSettingsPath(claudeHome: string): string {
  return join(claudeHome, 'settings.local.json')
}

export function managedSettingsPaths(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'darwin') {
    return ['/Library/Application Support/ClaudeCode/managed-settings.json']
  }
  if (platform === 'win32') {
    const programFiles = environment.ProgramFiles
    return programFiles ? [join(programFiles, 'ClaudeCode', 'managed-settings.json')] : []
  }
  return ['/etc/claude-code/managed-settings.json']
}

export type LenientSettingsJsonRead =
  | { state: 'absent' }
  | { state: 'readable'; settings: unknown }
  | { state: 'unreadable'; detail: string }

export const SETTINGS_JSON_INVALID_DETAIL = 'settings file is not valid JSON'

export function readSettingsJsonLenient(path: string): LenientSettingsJsonRead {
  if (!existsSync(path)) return { state: 'absent' }
  let text: string
  try {
    text = readRegularFile(path)
  } catch (error) {
    return {
      state: 'unreadable',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  try {
    return { state: 'readable', settings: JSON.parse(text) }
  } catch {
    return { state: 'unreadable', detail: SETTINGS_JSON_INVALID_DETAIL }
  }
}

export function projectSettingsPath(root: string): string {
  return join(root, '.claude', 'settings.json')
}

export function projectLocalSettingsPath(root: string): string {
  return join(root, '.claude', 'settings.local.json')
}

export function readSettingsFile(path: string): ReturnType<typeof parseSettingsFile> {
  return parseSettingsFile(readRegularFile(path))
}

export function tryReadSettingsFile(path: string): ReturnType<typeof parseSettingsFile> | null {
  if (!existsSync(path)) return null
  return readSettingsFile(path)
}

export function readLocalPermissionLists(path: string): Record<PermissionList, string[]> {
  const parsed = tryReadSettingsFile(path)
  return parsed ? permissionLists(parsed.owned.permissions) : { allow: [], ask: [], deny: [] }
}

function readRegularFile(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`refusing settings: no file at ${path}\ncleared by: create the settings file`)
  }
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    throw new Error(
      `refusing settings path ${path}: symbolic link targets ${readlinkSync(path)}; replace the link with a regular file`,
    )
  }
  if (!stat.isFile()) {
    throw new Error(`refusing settings path ${path}: expected a regular file`)
  }
  const text = readFileSync(path, 'utf8')
  if (text.trim() === '') throw new Error(SETTINGS_PARSE_REFUSAL)
  return text
}
