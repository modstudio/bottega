// concern: settings
/** Pure owned Claude settings shape. Must not know filesystems, stores, commands, or transports. */
import { z } from 'zod'

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

const SECRET_ASSIGNMENT = /\b(?:token|key|secret|password)\s*=\s*\S+/i
const SECRET_BEARER = /\bBearer\s+\S+/i
const SECRET_AUTHORIZATION = /\bAuthorization\s*[:=]\s*\S+/i
const SECRET_TOKEN_PREFIX =
  /(?<![A-Za-z0-9])(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|sk-|xox[bposa]-|AKIA)/
const SECRET_HEX_RUN = /[0-9a-fA-F]{32,}/
const SECRET_URL_USERINFO = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/
const SECRET_PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const SECRET_JWT = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
const SECRET_BASE64_RUN = /[A-Za-z0-9+_-]{27,}={0,2}/g
const SECRET_BASE64_BYTES = 20

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

export function containsSecretShaped(text: string): boolean {
  return (
    SECRET_AUTHORIZATION.test(text) ||
    SECRET_BEARER.test(text) ||
    SECRET_ASSIGNMENT.test(text) ||
    SECRET_TOKEN_PREFIX.test(text) ||
    SECRET_HEX_RUN.test(text) ||
    SECRET_URL_USERINFO.test(text) ||
    SECRET_PEM_PRIVATE_KEY.test(text) ||
    containsJwt(text) ||
    containsBase64Secret(text)
  )
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

function containsJwt(text: string): boolean {
  for (const match of text.matchAll(SECRET_JWT)) {
    if (jwtHeaderIsObject(match[0])) return true
  }
  return false
}

function jwtHeaderIsObject(token: string): boolean {
  const dot = token.indexOf('.')
  if (dot < 1) return false
  try {
    const json = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8')
    return isPlainObject(JSON.parse(json) as unknown)
  } catch {
    return false
  }
}

function containsBase64Secret(text: string): boolean {
  for (const match of text.matchAll(SECRET_BASE64_RUN)) {
    if (base64RunIsSecret(match[0])) return true
  }
  return false
}

function base64RunIsSecret(run: string): boolean {
  const bytes = decodedBase64Bytes(run)
  if (bytes === null || bytes < SECRET_BASE64_BYTES) return false
  if (/[+=]/.test(run)) return true
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run)
}

function decodedBase64Bytes(text: string): number | null {
  const normalized = text.replaceAll('-', '+').replaceAll('_', '/')
  const padded = `${normalized}${'='.repeat((4 - (normalized.length % 4)) % 4)}`
  if (padded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) return null
  const buf = Buffer.from(padded, 'base64')
  if (buf.toString('base64').replace(/=+$/, '') !== padded.replace(/=+$/, '')) return null
  return buf.length
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
