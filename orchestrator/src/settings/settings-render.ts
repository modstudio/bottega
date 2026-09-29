// concern: settings-render
/** Pure settings-file parse, render, and drift. Must not know filesystems, stores, commands, or transports. */
import { createHash } from 'node:crypto'
import {
  containsSecretShaped,
  extractOwnedSettings,
  isPlainObject,
  type OwnedSettings,
  PERMISSION_LISTS,
  type PermissionList,
  permissionLists,
  SETTINGS_PARSE_REFUSAL,
  secretShapedPaths,
} from './settings.ts'

const OWNED_KEYS = ['permissions', 'hooks'] as const
const HOOK_FINGERPRINT_LENGTH = 12

type SettingsMember = {
  ownedKey: (typeof OWNED_KEYS)[number] | null
  nameStart: number
  valueStart: number
  valueEnd: number
}

export type ParsedSettingsFile = {
  text: string
  owned: OwnedSettings
  envKeys: string[]
  open: number
  close: number
  members: SettingsMember[]
}

export type SettingsDrift = {
  rules: Record<PermissionList, { added: string[]; removed: string[] }>
  hooks: { added: HookDrift[]; removed: HookDrift[] }
  env: { added: string[]; removed: string[] }
}

export type HookDrift = {
  event: string
  matcher: string
  fingerprint: string
  path: string
}

export function parseSettingsFile(text: string): ParsedSettingsFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error(SETTINGS_PARSE_REFUSAL)
  }
  if (!isPlainObject(parsed)) throw new Error(SETTINGS_PARSE_REFUSAL)
  const span = locateObject(text)
  return {
    text,
    owned: extractOwnedSettings(parsed),
    envKeys: isPlainObject(parsed.env) ? Object.keys(parsed.env).sort() : [],
    open: span.open,
    close: span.close,
    members: span.members,
  }
}

export function renderOwnedSettingsFile(
  text: string,
  owned: OwnedSettings,
  environment?: Record<string, string>,
): string {
  const parsed = parseSettingsFile(text)
  let next = text
  for (const member of [...parsed.members].reverse()) {
    if (member.ownedKey === null) continue
    const formatted = indentJson(owned[member.ownedKey], indentOf(text, member.nameStart))
    next = `${next.slice(0, member.valueStart)}${formatted}${next.slice(member.valueEnd)}`
  }
  const present = new Set(
    parsed.members.flatMap((member) => (member.ownedKey === null ? [] : [member.ownedKey])),
  )
  const missing = OWNED_KEYS.filter((name) => !present.has(name))
  if (missing.length > 0) {
    const updated = locateObject(next)
    next = insertOwnedKeys(
      next,
      { ...parsed, ...updated, members: updated.members },
      owned,
      missing,
    )
  }
  return environment === undefined ? next : renderEnvironment(next, environment)
}

export function displaySettingsValue(path: string, value: string): string {
  if (!containsSecretShaped(value)) return value
  return `${path} ${fingerprintValue(value)} secret-shaped`
}

export function displayHookDrift(hook: HookDrift, owned: OwnedSettings): string {
  const secret = secretShapedPaths(owned).some(
    (path) => path === hook.path || path.startsWith(`${hook.path}.`),
  )
  if (secret) return `${hook.path} ${hook.fingerprint} secret-shaped`
  return `${hook.event} ${hook.matcher} ${hook.fingerprint}`
}

function fingerprintValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, HOOK_FINGERPRINT_LENGTH)
}

export function diffOwnedSettings(file: OwnedSettings, store: OwnedSettings): SettingsDrift {
  const fileLists = permissionLists(file.permissions)
  const storeLists = permissionLists(store.permissions)
  const rules = Object.fromEntries(
    PERMISSION_LISTS.map((name) => [
      name,
      {
        added: subtract(fileLists[name], storeLists[name]),
        removed: subtract(storeLists[name], fileLists[name]),
      },
    ]),
  ) as SettingsDrift['rules']
  const fileHooks = hookDriftEntries(file.hooks)
  const storeHooks = hookDriftEntries(store.hooks)
  return {
    rules,
    hooks: {
      added: subtractHooks(fileHooks, storeHooks),
      removed: subtractHooks(storeHooks, fileHooks),
    },
    env: {
      added: subtract(file.envKeys ?? [], store.envKeys ?? []),
      removed: subtract(store.envKeys ?? [], file.envKeys ?? []),
    },
  }
}

function renderEnvironment(text: string, environment: Record<string, string>): string {
  const parsed = JSON.parse(text) as Record<string, unknown>
  const names = Object.keys(parsed)
  const envIndex = names.indexOf('env')
  const span = locateObject(text)
  if (envIndex >= 0) {
    const member = span.members[envIndex]!
    const formatted = indentJson(environment, indentOf(text, member.nameStart))
    return `${text.slice(0, member.valueStart)}${formatted}${text.slice(member.valueEnd)}`
  }
  const indent = span.members.length ? indentOf(text, span.members[0]!.nameStart) : 2
  const pad = ' '.repeat(indent)
  const inserted = `${pad}"env": ${indentJson(environment, indent)}`
  if (span.members.length === 0) {
    return `${text.slice(0, span.open + 1)}\n${inserted}\n${text.slice(span.close)}`
  }
  const last = span.members.at(-1)!
  const between = text.slice(last.valueEnd, span.close)
  const comma = between.includes(',') ? '' : ','
  return `${text.slice(0, last.valueEnd)}${comma}\n${inserted}${text.slice(span.close)}`
}

function hookDriftEntries(hooks: unknown): HookDrift[] {
  if (!isPlainObject(hooks)) return []
  const entries: HookDrift[] = []
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue
    for (const [index, item] of value.entries()) {
      entries.push({
        event,
        matcher: hookMatcher(item),
        fingerprint: hookFingerprint(item),
        path: `hooks.${event}[${index}]`,
      })
    }
  }
  return entries
}

function hookMatcher(item: unknown): string {
  return isPlainObject(item) && typeof item.matcher === 'string' ? item.matcher : '-'
}

function hookFingerprint(item: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(item))
    .digest('hex')
    .slice(0, HOOK_FINGERPRINT_LENGTH)
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function subtract(left: string[], right: string[]): string[] {
  const remaining = new Map<string, number>()
  for (const value of right) remaining.set(value, (remaining.get(value) ?? 0) + 1)
  const added: string[] = []
  for (const value of left) {
    const count = remaining.get(value) ?? 0
    if (count === 0) added.push(value)
    else remaining.set(value, count - 1)
  }
  return added
}

function subtractHooks(left: HookDrift[], right: HookDrift[]): HookDrift[] {
  const remaining = new Map<string, number>()
  const key = (entry: HookDrift) => `${entry.event}\0${entry.fingerprint}`
  for (const value of right) remaining.set(key(value), (remaining.get(key(value)) ?? 0) + 1)
  const added: HookDrift[] = []
  for (const value of left) {
    const fingerprint = key(value)
    const count = remaining.get(fingerprint) ?? 0
    if (count === 0) added.push(value)
    else remaining.set(fingerprint, count - 1)
  }
  return added
}

function indentJson(value: unknown, indent: number): string {
  const json = JSON.stringify(value, null, 2)
  if (!json.includes('\n')) return json
  const pad = ' '.repeat(indent)
  return json.replaceAll('\n', `\n${pad}`)
}

function indentOf(text: string, index: number): number {
  let start = index
  while (start > 0 && text[start - 1] !== '\n') start--
  let indent = 0
  while (start + indent < index && text[start + indent] === ' ') indent++
  return indent
}

function insertOwnedKeys(
  text: string,
  parsed: ParsedSettingsFile,
  owned: OwnedSettings,
  missing: readonly (typeof OWNED_KEYS)[number][],
): string {
  const indent = parsed.members.length ? indentOf(text, parsed.members[0]!.nameStart) : 2
  const pad = ' '.repeat(indent)
  const inserted = missing
    .map((name) => `${pad}"${name}": ${indentJson(owned[name], indent)}`)
    .join(',\n')
  if (parsed.members.length === 0) {
    return `${text.slice(0, parsed.open + 1)}\n${inserted}\n${text.slice(parsed.close)}`
  }
  const last = parsed.members.at(-1)!
  const between = text.slice(last.valueEnd, parsed.close)
  const comma = between.includes(',') ? '' : ','
  return `${text.slice(0, last.valueEnd)}${comma}\n${inserted}${text.slice(parsed.close)}`
}

function locateObject(text: string): {
  open: number
  close: number
  members: SettingsMember[]
} {
  const open = skipWs(text, 0)
  if (text[open] !== '{') throw new Error(SETTINGS_PARSE_REFUSAL)
  const members: SettingsMember[] = []
  let i = skipWs(text, open + 1)
  if (text[i] === '}') return { open, close: i, members }
  while (i < text.length) {
    if (text[i] !== '"') throw new Error(SETTINGS_PARSE_REFUSAL)
    const name = readString(text, i)
    const colon = skipWs(text, name.end)
    if (text[colon] !== ':') throw new Error(SETTINGS_PARSE_REFUSAL)
    const valueStart = skipWs(text, colon + 1)
    const valueEnd = skipValue(text, valueStart)
    members.push({
      ownedKey: name.value === 'permissions' || name.value === 'hooks' ? name.value : null,
      nameStart: i,
      valueStart,
      valueEnd,
    })
    i = skipWs(text, valueEnd)
    if (text[i] === ',') {
      i = skipWs(text, i + 1)
      continue
    }
    if (text[i] === '}') return { open, close: i, members }
    throw new Error(SETTINGS_PARSE_REFUSAL)
  }
  throw new Error(SETTINGS_PARSE_REFUSAL)
}

function skipWs(text: string, index: number): number {
  let i = index
  while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++
  return i
}

function readString(text: string, start: number): { value: string; end: number } {
  let i = start + 1
  while (i < text.length) {
    if (text[i] === '"')
      return { value: JSON.parse(text.slice(start, i + 1)) as string, end: i + 1 }
    if (text[i] === '\\') i += 2
    else i++
  }
  throw new Error(SETTINGS_PARSE_REFUSAL)
}

function skipValue(text: string, start: number): number {
  const c = text[start]
  if (c === '"') return readString(text, start).end
  if (c === '{' || c === '[') return skipDelimited(text, start, c, c === '{' ? '}' : ']')
  if (c === 't' && text.startsWith('true', start)) return start + 4
  if (c === 'f' && text.startsWith('false', start)) return start + 5
  if (c === 'n' && text.startsWith('null', start)) return start + 4
  if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) {
    let i = start + 1
    while (i < text.length && /[0-9.eE+-]/.test(text[i]!)) i++
    return i
  }
  throw new Error(SETTINGS_PARSE_REFUSAL)
}

function skipDelimited(text: string, start: number, open: string, close: string): number {
  let depth = 0
  let i = start
  while (i < text.length) {
    const c = text[i]!
    if (c === '"') {
      i = readString(text, i).end
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  throw new Error(SETTINGS_PARSE_REFUSAL)
}
