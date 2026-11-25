import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import {
  HOSTED_TABLES_WITHOUT_LOCAL_ACCESS,
  hostedTableInSql,
  LOCAL_SQLITE_ADAPTER_PATH,
} from '../orchestrator/src/database/hosted-table-guard.ts'
import {
  readRecordInstallBinding,
  storeHasAttachedToHostedRecord,
} from '../orchestrator/src/record/install-binding.ts'
import { hostedRecordOwnsHostedTables } from '../orchestrator/src/record/record-write-authority.ts'
import {
  MAINTENANCE_SCHEDULE_LABELS,
  SYSTEMD_UNITS,
} from '../orchestrator/src/setup/setup-schedule-policy.ts'
import {
  HOSTED_LOCAL_SQL_ALLOWED_FILES,
  HOSTED_LOCAL_SQL_EXCLUSION_REASONS,
  type HostedLocalSqlAllowedFile,
} from './hosted-local-sql-allowlist.ts'
import {
  extractSqlFromSource,
  type HostedSqlCannotJudgeSite,
  type HostedSqlSite,
  type HostedSqlUnresolvedSite,
  productionTypeScriptFiles,
} from './hosted-sql-schema.ts'
import {
  STATE_CLASSES,
  type StateClassDeclaration,
  type TableStateClassDeclaration,
} from './identity-state-classes.ts'

const HOSTED_LOCAL_READ_KINDS = ['read', 'write'] as const
const HOSTED_LOCAL_READ_PATHS = [
  'excluded-by-design',
  'local-only',
  'cannot-tell',
  'hosted-record',
  'declared-cache',
  'hosted-reachable',
] as const

export type HostedLocalReadKind = (typeof HOSTED_LOCAL_READ_KINDS)[number]
type HostedLocalReadPath = (typeof HOSTED_LOCAL_READ_PATHS)[number]
export type HostedLocalReadCandidate = {
  file: string
  line: number
  sql: string
  sourceText?: string
  expression?: string
  dynamicTable?: boolean
  sourceSelector?: string
  sourceUsesPostgres: boolean
  sourceUsesSqlite: boolean
}
export type HostedLocalReadTable = {
  table: string
  cache: boolean
  readCache?: TableStateClassDeclaration['readCache']
  task?: string
}
export type HostedLocalReadAllowedFile = HostedLocalSqlAllowedFile
export type HostedLocalReadHit = {
  file: string
  line: number
  table: string
  kind: HostedLocalReadKind
  path: HostedLocalReadPath
  reason: string
  exclusionReason?: string
  functionName?: string
  module: string
}
export type HostedLocalReadReport = {
  hits: HostedLocalReadHit[]
  totals: {
    hits: number
    byKind: Record<HostedLocalReadKind, number>
    byPath: Record<HostedLocalReadPath, number>
    byTable: Record<string, number>
    byModule: Record<string, number>
  }
  wallTimeMs: number
}

export type HostedLocalReadScan = {
  report: HostedLocalReadReport
  configurationFailures: string[]
  gate: {
    sites: HostedSqlSite[]
    unresolved: HostedSqlUnresolvedSite[]
    cannotJudge: HostedSqlCannotJudgeSite[]
  }
}

const HOSTED_HUB_LOCAL_READ_REFUSAL_TABLES = [
  'task',
  'task_document',
  'task_comment',
  'task_status_event',
  'note',
  'note_acknowledgement',
  'note_counter',
  'operator_waiting_email',
] as const

function hostedRecordLocalReadFailures(
  hits: readonly HostedLocalReadHit[],
  tables: readonly string[],
  remedy: string,
): string[] {
  const refused = new Set<string>(tables)
  return hits.flatMap((hit) =>
    hit.kind === 'read' &&
    (hit.path === 'hosted-reachable' || hit.path === 'cannot-tell') &&
    hit.exclusionReason !== 'planned' &&
    refused.has(hit.table)
      ? [
          `${hit.file}:${hit.line}: hosted install can read ${hit.table} from the local SQLite store; ${remedy}`,
        ]
      : [],
  )
}

export function hostedHubLocalReadFailures(hits: readonly HostedLocalReadHit[]): string[] {
  return hostedRecordLocalReadFailures(
    hits,
    HOSTED_HUB_LOCAL_READ_REFUSAL_TABLES,
    'read the hosted record through the hub client on a hosted install',
  )
}

export function hostedDocLocalReadFailures(hits: readonly HostedLocalReadHit[]): string[] {
  return hostedRecordLocalReadFailures(
    hits,
    ['doc_revision'],
    'read revisions through the hosted doc client on a hosted install',
  )
}

const WRITE_SQL = /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE)\b/i
const MODE_SELECTORS = [
  'boardMode',
  'boardModeForId',
  'boardIdentifierMode',
  'hostedWriteMode',
  'writeMode',
] as const
const MODE_SELECTOR_PATTERN = MODE_SELECTORS.join('|')
const HOSTED_SELECTORS = [
  ...MODE_SELECTORS,
  'requireLocalBoardRead',
  'requireLocalBoardWrite',
  'hostedRecordOwnsHostedTables',
] as const
const OWNERSHIP_SELECTOR = 'hostedRecordOwnsHostedTables'
const LOCAL_ADAPTER = new RegExp(LOCAL_SQLITE_ADAPTER_PATH)
const ATTACHMENT_PREDICATES = [
  readRecordInstallBinding.name,
  storeHasAttachedToHostedRecord.name,
  'record_install_binding',
] as const
const OWNERSHIP_PREDICATE = hostedRecordOwnsHostedTables.name

type SelectorPath = Pick<HostedLocalReadHit, 'path' | 'reason'> | null
type SourceRange = { start: number; end: number }
type MaskState = 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
type MaskStep = { state: MaskState; text: string; advance: number }

function maskCodeCharacter(char: string, next: string): MaskStep {
  if (char === '/' && next === '/') return { state: 'line', text: '  ', advance: 2 }
  if (char === '/' && next === '*') return { state: 'block', text: '  ', advance: 2 }
  if (char === "'") return { state: 'single', text: char, advance: 1 }
  if (char === '"') return { state: 'double', text: char, advance: 1 }
  if (char === '`') return { state: 'template', text: ' ', advance: 1 }
  return { state: 'code', text: char, advance: 1 }
}

function maskEscape(state: Exclude<MaskState, 'code' | 'line' | 'block'>, next: string): MaskStep {
  const visible = state === 'single' || state === 'double'
  return {
    state,
    text: `\\${next === '\n' ? '\n' : visible ? next : ' '}`,
    advance: 2,
  }
}

function closesMaskState(state: Exclude<MaskState, 'code'>, char: string): boolean {
  if (state === 'single') return char === "'"
  if (state === 'double') return char === '"'
  return state === 'template' && char === '`'
}

function maskNonCodeCharacter(
  state: Exclude<MaskState, 'code'>,
  char: string,
  next: string,
): MaskStep {
  if (char === '\n') return { state: state === 'line' ? 'code' : state, text: '\n', advance: 1 }
  const visible = state === 'single' || state === 'double'
  if (char === '\\' && state !== 'line' && state !== 'block') return maskEscape(state, next)
  if (state === 'block' && char === '*' && next === '/')
    return { state: 'code', text: '  ', advance: 2 }
  if (closesMaskState(state, char)) return { state: 'code', text: visible ? char : ' ', advance: 1 }
  return { state, text: visible ? char : ' ', advance: 1 }
}

function maskSource(source: string): string {
  let result = ''
  let state: MaskState = 'code'
  for (let index = 0; index < source.length; ) {
    const char = source[index] ?? ''
    const next = source[index + 1] ?? ''
    const step: MaskStep =
      state === 'code' ? maskCodeCharacter(char, next) : maskNonCodeCharacter(state, char, next)
    result += step.text
    state = step.state
    index += step.advance
  }
  return result
}

function matchingDelimiter(source: string, start: number, open: string, close: string): number {
  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === open) depth += 1
    if (source[index] === close && --depth === 0) return index
  }
  return -1
}

function functionBodyRange(source: string, parenEnd: number): SourceRange | null {
  let start = source.indexOf('{', parenEnd)
  while (start >= 0) {
    const end = matchingDelimiter(source, start, '{', '}')
    if (end < 0) return null
    const next = source.slice(end + 1).match(/\S/)?.[0]
    if (!next || !['>', '[', '|', '&', '{'].includes(next)) return { start, end }
    start = source.indexOf('{', end + 1)
  }
  return null
}

function functionRanges(source: string): Array<SourceRange & { name: string }> {
  const ranges: Array<SourceRange & { name: string }> = []
  for (const match of source.matchAll(/\bfunction\s+(\w+)(?:<[^\n]*>)?\s*\(/g)) {
    const parenStart = (match.index ?? 0) + match[0].lastIndexOf('(')
    const parenEnd = matchingDelimiter(source, parenStart, '(', ')')
    if (parenEnd < 0) continue
    const range = functionBodyRange(source, parenEnd)
    if (range) ranges.push({ name: match[1] ?? '(anonymous)', ...range })
  }
  for (const match of source.matchAll(
    /\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>\s*\{/g,
  )) {
    const start = (match.index ?? 0) + match[0].lastIndexOf('{')
    const end = matchingDelimiter(source, start, '{', '}')
    if (end >= 0) ranges.push({ name: match[1] ?? '(anonymous)', start, end })
  }
  return ranges
}

function siteOffset(source: string, line: number): number {
  let offset = 0
  for (let current = 1; current < line; current += 1) {
    const next = source.indexOf('\n', offset)
    if (next < 0) return source.length
    offset = next + 1
  }
  return offset
}

function selectorVariables(functionText: string): Map<string, 'mode' | 'hosted'> {
  const result = new Map<string, 'mode' | 'hosted'>()
  const assignment = new RegExp(
    `\\bconst\\s+(\\w+)\\s*=\\s*(?:${MODE_SELECTOR_PATTERN})\\s*\\([^;\\n]+`,
    'g',
  )
  for (const match of functionText.matchAll(assignment))
    result.set(match[1] ?? '', /hosted-configured/.test(match[0]) ? 'hosted' : 'mode')
  for (const [modeName, kind] of result) {
    if (kind !== 'mode') continue
    const derived = new RegExp(
      `\\bconst\\s+(\\w+)\\s*=\\s*${modeName}\\s*={2,3}\\s*['"]hosted-configured['"]`,
      'g',
    )
    for (const match of functionText.matchAll(derived)) result.set(match[1] ?? '', 'hosted')
  }
  return result
}

function conditionMode(
  condition: string,
  variables: ReadonlyMap<string, 'mode' | 'hosted'>,
): 'local' | 'hosted' | null {
  const direct = new RegExp(`\\b(?:${MODE_SELECTOR_PATTERN})\\s*\\(`).test(condition)
  const mode = [...variables].find(
    ([name, kind]) => kind === 'mode' && new RegExp(`\\b${name}\\b`).test(condition),
  )
  const hosted = [...variables].find(
    ([name, kind]) => kind === 'hosted' && new RegExp(`\\b${name}\\b`).test(condition),
  )
  if (!direct && !mode && !hosted) return null
  if (hosted) return new RegExp(`!\\s*${hosted[0]}\\b`).test(condition) ? 'local' : 'hosted'
  const notEqual = /!==?/.test(condition)
  for (const [literal, equalMode] of [
    ['local-authoritative', 'local'],
    ['hosted-configured', 'hosted'],
    ['local', 'local'],
    ['hosted', 'hosted'],
  ] as const)
    if (new RegExp(`['"]${literal}['"]`).test(condition))
      return notEqual ? (equalMode === 'local' ? 'hosted' : 'local') : equalMode
  return null
}

type DelimiterDepths = { brace: number; paren: number; bracket: number }

function advanceDepths(depths: DelimiterDepths, char: string): void {
  if (char === '{') depths.brace += 1
  else if (char === '}') depths.brace -= 1
  else if (char === '(') depths.paren += 1
  else if (char === ')') depths.paren -= 1
  else if (char === '[') depths.bracket += 1
  else if (char === ']') depths.bracket -= 1
}

function isTopLevel(depths: DelimiterDepths): boolean {
  return depths.brace === 0 && depths.paren === 0 && depths.bracket === 0
}

function hasNegativeDepth(depths: DelimiterDepths): boolean {
  return depths.brace < 0 || depths.paren < 0 || depths.bracket < 0
}

function statementPrefixFacts(
  text: string,
  token: number,
): { depths: DelimiterDepths; start: number } {
  const depths = { brace: 0, paren: 0, bracket: 0 }
  let start = 0
  for (let index = 0; index < token; index += 1) {
    const char = text[index] ?? ''
    advanceDepths(depths, char)
    if ((char === '}' || char === ';' || char === '\n') && isTopLevel(depths)) start = index + 1
  }
  return { depths, start }
}

function bracelessControlHeaderBefore(text: string, statementStart: number): boolean {
  const prefix = text.slice(0, statementStart).trimEnd()
  if (/\b(?:else|do)$/.test(prefix)) return true
  if (!prefix.endsWith(')')) return false
  let depth = 0
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    if (prefix[index] === ')') depth += 1
    if (prefix[index] !== '(' || --depth !== 0) continue
    return /\b(?:if|for|while)\s*$/.test(prefix.slice(0, index))
  }
  return true
}

function exitConsumesRemainder(remainder: string): boolean {
  const depths = { brace: 0, paren: 0, bracket: 0 }
  for (let index = 0; index < remainder.length; index += 1) {
    const char = remainder[index] ?? ''
    advanceDepths(depths, char)
    if (char === ';' && isTopLevel(depths)) return remainder.slice(index + 1).trim().length === 0
    if (char === '\n' && isTopLevel(depths) && remainder.slice(index + 1).trim()) return false
  }
  return true
}

function endsInUnconditionalExit(statementText: string): boolean | null {
  let uncertain = false
  for (const match of statementText.matchAll(/\b(?:return|throw)\b/g)) {
    const token = match.index ?? 0
    const prefix = statementPrefixFacts(statementText, token)
    const finalTopLevelStatement =
      isTopLevel(prefix.depths) &&
      !statementText.slice(prefix.start, token).trim() &&
      exitConsumesRemainder(statementText.slice(token))
    if (!finalTopLevelStatement) continue
    if (bracelessControlHeaderBefore(statementText, prefix.start)) uncertain = true
    else return true
  }
  return uncertain ? null : false
}

function matchingTernaryColon(source: string, question: number): number {
  const depths = { brace: 0, paren: 0, bracket: 0 }
  let nestedTernaries = 0
  for (let index = question + 1; index < source.length; index += 1) {
    const char = source[index] ?? ''
    advanceDepths(depths, char)
    if (hasNegativeDepth(depths)) return -1
    if (!isTopLevel(depths)) continue
    if (char === '?') nestedTernaries += 1
    if (char === ':' && nestedTernaries > 0) nestedTernaries -= 1
    else if (char === ':') return index
    if ((char === ';' || char === '\n') && nestedTernaries === 0) return -1
  }
  return -1
}

function ternaryExpressionEnd(source: string, colon: number): number {
  const depths = { brace: 0, paren: 0, bracket: 0 }
  let nestedTernaries = 0
  for (let index = colon + 1; index < source.length; index += 1) {
    const char = source[index] ?? ''
    if (isTopLevel(depths) && (char === ')' || char === ']' || char === '}')) return index
    advanceDepths(depths, char)
    if (!isTopLevel(depths)) continue
    if (char === '?') nestedTernaries += 1
    if (char === ':' && nestedTernaries > 0) nestedTernaries -= 1
    if ((char === ';' || char === '\n' || char === ',') && nestedTernaries === 0) return index
  }
  return source.length
}

function isTopLevelInRange(source: string, start: number, site: number): boolean {
  const depths = { brace: 0, paren: 0, bracket: 0 }
  for (let index = start; index < site; index += 1) {
    advanceDepths(depths, source[index] ?? '')
    if (hasNegativeDepth(depths)) return false
  }
  return isTopLevel(depths)
}

function selectorTernaryPath(
  body: string,
  site: number,
  variables: ReadonlyMap<string, 'mode' | 'hosted'>,
): 'local' | 'hosted' | null {
  const ternary = new RegExp(
    `((?:(?:${MODE_SELECTOR_PATTERN})\\s*\\([^?\\n]+\\)|\\w+)\\s*(?:={2,3}|!={1,2})\\s*['"](?:local|hosted)['"])\\s*\\?`,
    'g',
  )
  for (const match of body.matchAll(ternary)) {
    const question = (match.index ?? 0) + match[0].lastIndexOf('?')
    const colon = matchingTernaryColon(body, question)
    if (colon < 0) continue
    const end = ternaryExpressionEnd(body, colon)
    const mode = conditionMode(match[1] ?? '', variables)
    if (!mode) continue
    if (question < site && site < colon && isTopLevelInRange(body, question + 1, site)) return mode
    if (colon < site && site < end && isTopLevelInRange(body, colon + 1, site))
      return mode === 'local' ? 'hosted' : 'local'
  }
  return null
}

function statementRange(body: string, parenEnd: number): SourceRange & { braced: boolean } {
  let start = parenEnd + 1
  while (/\s/.test(body[start] ?? '')) start += 1
  const braced = body[start] === '{'
  if (braced) return { start, end: matchingDelimiter(body, start, '{', '}'), braced }
  const newline = body.indexOf('\n', start)
  return { start, end: newline < 0 ? body.length : newline, braced }
}

function selectorIfPath(input: {
  body: string
  ifStart: number
  parenEnd: number
  mode: 'local' | 'hosted'
  site: number
}): 'local' | 'hosted' | null {
  const statement = statementRange(input.body, input.parenEnd)
  if (input.site >= statement.start && input.site <= statement.end) return input.mode
  if (input.ifStart >= input.site) return 'hosted'
  const statementText = input.body.slice(
    statement.start + (statement.braced ? 1 : 0),
    statement.end,
  )
  const exits = endsInUnconditionalExit(statementText)
  if (exits === null) return null
  return exits && input.mode === 'hosted' ? 'local' : 'hosted'
}

function hasUnconditionalLocalBoardGuard(body: string, site: number): boolean {
  for (const match of body.slice(0, site).matchAll(/\brequireLocalBoard(?:Read|Write)\s*\(/g)) {
    const token = match.index ?? 0
    const prefix = statementPrefixFacts(body, token)
    if (
      isTopLevel(prefix.depths) &&
      !body.slice(prefix.start, token).trim() &&
      !bracelessControlHeaderBefore(body, prefix.start)
    )
      return true
  }
  return false
}

function functionSitePath(
  source: string,
  range: SourceRange,
  offset: number,
): 'local' | 'hosted' | null {
  const body = source.slice(range.start + 1, range.end)
  const site = offset - range.start - 1
  const variables = selectorVariables(body)
  if (hasUnconditionalLocalBoardGuard(body, site)) return 'local'
  const ternary = selectorTernaryPath(body, site, variables)
  if (ternary) return ternary
  for (const match of body.matchAll(/\bif\s*\(/g)) {
    const ifStart = match.index ?? 0
    const parenStart = ifStart + match[0].lastIndexOf('(')
    const parenEnd = matchingDelimiter(body, parenStart, '(', ')')
    if (parenEnd < 0) continue
    const mode = conditionMode(body.slice(parenStart + 1, parenEnd), variables)
    if (!mode) continue
    return selectorIfPath({ body, ifStart, parenEnd, mode, site })
  }
  return null
}

function selectorPath(candidate: HostedLocalReadCandidate): SelectorPath {
  if (!candidate.sourceSelector || !candidate.sourceText) return null
  const masked = maskSource(candidate.sourceText)
  const offset = siteOffset(masked, candidate.line)
  const ranges = functionRanges(masked)
  const enclosing = ranges
    .filter((range) => range.start < offset && offset < range.end)
    .sort((left, right) => right.start - left.start)[0]
  if (!enclosing) return null
  const direct = functionSitePath(masked, enclosing, offset)
  if (direct)
    return {
      path: direct === 'local' ? 'local-only' : 'hosted-reachable',
      reason: `${candidate.sourceSelector} control flow in enclosing function ${enclosing.name} is ${direct}`,
    }
  const callerPathsFor = (
    subject: SourceRange & { name: string },
    seen: ReadonlySet<string>,
  ): Array<'local' | 'hosted' | null> => {
    if (seen.has(subject.name)) return [null]
    const nextSeen = new Set([...seen, subject.name])
    const callers = [...masked.matchAll(new RegExp(`\\b${subject.name}\\s*\\(`, 'g'))]
      .map((match) => match.index ?? -1)
      .filter((call) => call >= 0 && !(subject.start - 120 < call && call < subject.start))
    return callers.flatMap((call) => {
      const caller = ranges
        .filter((range) => range.start < call && call < range.end)
        .sort((left, right) => right.start - left.start)[0]
      if (!caller) return [null]
      const path = functionSitePath(masked, caller, call)
      return path ? [path] : callerPathsFor(caller, nextSeen)
    })
  }
  const callerPaths = callerPathsFor(enclosing, new Set())
  if (!callerPaths.length) return null
  if (callerPaths.every((path) => path === 'local'))
    return {
      path: 'local-only',
      reason: `${enclosing.name} is called only from local arms in this file`,
    }
  if (callerPaths.some((path) => path === 'hosted'))
    return {
      path: 'hosted-reachable',
      reason: `${enclosing.name} has a hosted-reachable caller in this file`,
    }
  return null
}

function enclosingFunctionName(candidate: HostedLocalReadCandidate): string | undefined {
  if (!candidate.sourceText) return undefined
  const source = maskSource(candidate.sourceText)
  const offset = siteOffset(source, candidate.line)
  return functionRanges(source)
    .filter((range) => range.start < offset && offset < range.end)
    .sort((left, right) => right.start - left.start)[0]?.name
}

export function hostedLocalSqlExemptionReasonFailures(
  allowedFiles: readonly HostedLocalReadAllowedFile[],
): string[] {
  return allowedFiles.flatMap((allowed) => {
    const attachment = ATTACHMENT_PREDICATES.find((name) => (allowed.detail ?? '').includes(name))
    return attachment
      ? [
          `${allowed.pattern}: hosted-only SQL exemption cites attachment predicate ${attachment}; select local SQL with ${OWNERSHIP_PREDICATE} instead`,
        ]
      : []
  })
}

export function hostedLocalSqlSelectorFailures(
  root: string,
  allowedFiles: readonly HostedLocalReadAllowedFile[],
): string[] {
  const files = productionTypeScriptFiles(resolve(root, 'orchestrator'))
  const calls = (source: string, name: string): boolean =>
    new RegExp(`\\b${name}\\s*\\(`).test(source)
  return allowedFiles.flatMap((allowed) => {
    if (!(allowed.detail ?? allowed.reason ?? '').includes(OWNERSHIP_PREDICATE)) return []
    return files.flatMap((file) => {
      const path = relative(root, file)
      if (!allowed.pattern.test(path)) return []
      const source = readFileSync(file, 'utf8')
      const attachment = ATTACHMENT_PREDICATES.find((name) =>
        name === 'record_install_binding' ? source.includes(name) : calls(source, name),
      )
      if (attachment)
        return [
          `${path}: hosted-only SQL selector cites attachment predicate ${attachment}; select local SQL with ${OWNERSHIP_PREDICATE} instead`,
        ]
      if (!calls(source, OWNERSHIP_PREDICATE))
        return [
          `${path}: hosted-only SQL exemption names ${OWNERSHIP_PREDICATE} but the file does not call it; select local SQL with ${OWNERSHIP_PREDICATE} instead`,
        ]
      return []
    })
  })
}

export function hostedLocalReadSourceFacts(
  sourceText: string,
): Pick<HostedLocalReadCandidate, 'sourceSelector' | 'sourceUsesPostgres' | 'sourceUsesSqlite'> {
  return {
    sourceSelector: HOSTED_SELECTORS.find((selector) =>
      new RegExp(`\\b${selector}\\s*\\(`).test(sourceText),
    ),
    sourceUsesPostgres:
      /\bfrom\s+['"]postgres['"]/.test(sourceText) ||
      /\b(?:Sql|TransactionSql)\b/.test(sourceText) ||
      /\b(?:tx|sql)\s*`/.test(sourceText),
    sourceUsesSqlite:
      /\bfrom\s+['"]bun:sqlite['"]/.test(sourceText) ||
      /\bDatabase\b/.test(sourceText) ||
      /\b(?:db|writableDb)\s*\(/.test(sourceText),
  }
}

export function hostedLocalReadKind(sql: string): HostedLocalReadKind {
  return /^\s*SELECT\b/i.test(sql) ? 'read' : WRITE_SQL.test(sql) ? 'write' : 'read'
}

function hostedLocalReadModule(file: string): string {
  const match = /^(orchestrator|hub)\/src\/([^/]+)/.exec(file)
  if (!match) return file
  return `${match[1]}:${match[2]}`
}

function reachablePath(
  candidate: HostedLocalReadCandidate,
  table: HostedLocalReadTable | null,
): Pick<HostedLocalReadHit, 'path' | 'reason'> {
  if (candidate.dynamicTable)
    return {
      path: 'cannot-tell',
      reason: `dynamic table expression ${candidate.expression ?? '(unknown)'}`,
    }
  if (table?.task)
    return {
      path: 'hosted-reachable',
      reason: `hosted home is planned by ${table.task}; local read remains report-only`,
    }
  const selected = selectorPath(candidate)
  if (selected) return selected
  if (candidate.sourceSelector)
    return {
      path: 'cannot-tell',
      reason: `${candidate.sourceSelector} is called somewhere in the file; the extractor cannot prove it encloses this site`,
    }
  return { path: 'hosted-reachable', reason: 'no local-only or excluded hosted path was found' }
}

function classifiedPath(
  candidate: HostedLocalReadCandidate,
  table: HostedLocalReadTable | null,
  allowedFiles: readonly HostedLocalReadAllowedFile[],
): Pick<HostedLocalReadHit, 'path' | 'reason' | 'exclusionReason'> {
  if (table?.cache)
    return { path: 'excluded-by-design', reason: 'hosted cache table is local by design' }
  if (table?.readCache && hostedLocalReadKind(candidate.sql) === 'read')
    return {
      path: 'declared-cache',
      reason: `declared read cache refreshed by ${table.readCache.refresh} on ${table.readCache.schedule}`,
    }
  if (LOCAL_ADAPTER.test(candidate.file))
    return { path: 'local-only', reason: 'file matches LOCAL_SQLITE_ADAPTER_PATH' }
  const functionName = enclosingFunctionName(candidate)
  const allowed = allowedFiles.find(
    ({ pattern, functionName: allowedFunction }) =>
      pattern.test(candidate.file) &&
      (allowedFunction === undefined || allowedFunction === functionName),
  )
  const allowedDetail = allowed?.detail ?? allowed?.reason ?? ''
  if (allowed?.reason === 'planned')
    return {
      path: 'hosted-reachable',
      reason: `planned: ${allowedDetail}`,
      exclusionReason: 'planned',
    }
  if (allowed?.reason === 'local-only')
    return {
      path: 'local-only',
      reason: `reasoned local-only allowlist: ${allowedDetail}`,
      exclusionReason: 'local-only',
    }
  if (allowedDetail.includes(OWNERSHIP_SELECTOR))
    return {
      path: 'local-only',
      reason: `reasoned allowlist selects local SQL with ${OWNERSHIP_SELECTOR}: ${allowedDetail}`,
    }
  if (allowed)
    return {
      path: 'excluded-by-design',
      reason: `existing reasoned allowlist (${allowed.reason}): ${allowed.detail ?? allowed.reason}`,
    }
  if (/(?:^|[/.-])migrations?(?:[/.-]|$)/.test(candidate.file))
    return { path: 'excluded-by-design', reason: 'migration SQL is excluded by design' }
  if (/(?:^|[-/])outbox(?:[-/.]|$)/.test(candidate.file))
    return { path: 'excluded-by-design', reason: 'outbox SQL is excluded by design' }
  if (/(?:^|\/)record-(?:sync|push|pull|import|cache)(?:[-/.]|$)/.test(candidate.file))
    return {
      path: 'excluded-by-design',
      reason: 'record synchronization SQL is excluded by design',
    }
  if (candidate.sourceUsesPostgres && candidate.sourceUsesSqlite)
    return {
      path: 'cannot-tell',
      reason: 'file uses both a SQLite handle and Postgres',
    }
  if (candidate.sourceUsesPostgres)
    return {
      path: 'hosted-record',
      reason: 'SQL runs on the hosted record, not the local store',
    }
  return reachablePath(candidate, table)
}

/** Pure report policy over SQL sites and inventory declarations gathered by the caller. */
export function classifyHostedLocalReadSites(input: {
  candidates: readonly HostedLocalReadCandidate[]
  tables: readonly HostedLocalReadTable[]
  allowedFiles: readonly HostedLocalReadAllowedFile[]
}): HostedLocalReadHit[] {
  const tablesByName = new Map(input.tables.map((table) => [table.table, table]))
  return input.candidates.flatMap((candidate) => {
    const functionName = enclosingFunctionName(candidate)
    const namedTables = candidate.dynamicTable
      ? [null]
      : input.tables.filter(({ table }) => hostedTableInSql(candidate.sql, [table]) !== null)
    return namedTables.map((table) => ({
      file: candidate.file,
      line: candidate.line,
      ...(functionName ? { functionName } : {}),
      table: table?.table ?? `dynamic:${candidate.expression ?? '(unknown)'}`,
      kind: hostedLocalReadKind(candidate.sql),
      ...classifiedPath(
        candidate,
        table ? (tablesByName.get(table.table) ?? table) : null,
        input.allowedFiles,
      ),
      module: hostedLocalReadModule(candidate.file),
    }))
  })
}

function counts<T extends string>(values: readonly T[], keys: readonly T[]): Record<T, number> {
  const result = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>
  for (const value of values) result[value] += 1
  return result
}

function groupedCounts(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {}
  for (const value of values) result[value] = (result[value] ?? 0) + 1
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  )
}

export type HostedLocalReadScheduleFact = {
  label: string
  launchdInterval: string | null
  systemdInterval: string | null
}

export function hostedLocalReadDeclarationValidation(input: {
  stateClasses: readonly StateClassDeclaration[]
  exportedRefreshes: readonly string[]
  schedules: readonly HostedLocalReadScheduleFact[]
}): { failures: string[]; valid: Set<string> } {
  const failures: string[] = []
  const valid = new Set<string>()
  const exported = new Set(input.exportedRefreshes)
  const schedules = new Map(input.schedules.map((schedule) => [schedule.label, schedule]))
  for (const declaration of input.stateClasses) {
    if (!('table' in declaration) || !declaration.readCache) continue
    const name = `${declaration.store}.${declaration.table} readCache ${declaration.readCache.refresh} @ ${declaration.readCache.schedule}`
    const schedule = schedules.get(declaration.readCache.schedule)
    if (!exported.has(declaration.readCache.refresh))
      failures.push(
        `${name}: refresh symbol is not exported at that path; export the named symbol or fix readCache.refresh`,
      )
    if (!schedule)
      failures.push(
        `${name}: schedule label is not in MAINTENANCE_SCHEDULE_LABELS; use a declared maintenance schedule`,
      )
    else if (!schedule.launchdInterval || !schedule.systemdInterval)
      failures.push(
        `${name}: schedule interval is missing from its launchd or systemd definition; define StartInterval and OnUnitActiveSec`,
      )
    else if (schedule.launchdInterval !== schedule.systemdInterval)
      failures.push(
        `${name}: launchd StartInterval ${schedule.launchdInterval} disagrees with systemd OnUnitActiveSec ${schedule.systemdInterval}; make the schedule definitions agree`,
      )
    if (!failures.some((failure) => failure.startsWith(`${name}:`)))
      valid.add(`${declaration.store}:${declaration.table}`)
  }
  return { failures, valid }
}

export function hostedLocalSqlAllowedFileFailures(
  allowedFiles: readonly HostedLocalReadAllowedFile[],
): string[] {
  const reasons = new Set<string>(HOSTED_LOCAL_SQL_EXCLUSION_REASONS)
  return allowedFiles.flatMap((allowed) =>
    allowed.reason && reasons.has(allowed.reason)
      ? []
      : [
          `${allowed.pattern}: hosted-only SQL exemption has ${allowed.reason ? `unknown reason ${allowed.reason}` : 'no reason'}; use one of ${HOSTED_LOCAL_SQL_EXCLUSION_REASONS.join(', ')}`,
        ],
  )
}

const interval = (source: string, pattern: RegExp): string | null =>
  pattern.exec(source)?.[1] ?? null

function hostedLocalReadConfiguration(root: string) {
  if (!existsSync(resolve(root, 'scripts/identity-state-classes.ts')))
    return { failures: [], valid: new Set<string>() }
  const refreshes = STATE_CLASSES.flatMap((item) =>
    'table' in item && item.readCache ? [item.readCache.refresh] : [],
  )
  const exportedRefreshes = [...new Set(refreshes)].filter((refresh) => {
    const separator = refresh.lastIndexOf(':')
    const file = refresh.slice(0, separator)
    const symbol = refresh.slice(separator + 1)
    const source = readFileSync(resolve(root, file), 'utf8')
    return new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const)\\s+${symbol}\\b`).test(source)
  })
  const schedules = MAINTENANCE_SCHEDULE_LABELS.map((label) => {
    const timer = SYSTEMD_UNITS[label].find((unit) => unit.endsWith('.timer'))
    const launchd = readFileSync(resolve(root, `ops/launchd/${label}.plist.template`), 'utf8')
    const systemd = timer ? readFileSync(resolve(root, `ops/systemd/${timer}`), 'utf8') : ''
    return {
      label,
      launchdInterval: interval(launchd, /<key>StartInterval<\/key>\s*<integer>([^<]+)<\/integer>/),
      systemdInterval: interval(systemd, /^OnUnitActiveSec=(\S+)$/m),
    }
  })
  const declarations = hostedLocalReadDeclarationValidation({
    stateClasses: STATE_CLASSES,
    exportedRefreshes,
    schedules,
  })
  return {
    ...declarations,
    failures: [
      ...declarations.failures,
      ...hostedLocalSqlAllowedFileFailures(HOSTED_LOCAL_SQL_ALLOWED_FILES),
    ],
  }
}

export function scanHostedLocalReadSource(input: {
  file: string
  sourceText: string
  concern: 'orchestrator' | 'hub'
  validReadCaches?: ReadonlySet<string>
  gate?: HostedLocalReadScan['gate']
}): HostedLocalReadHit[] {
  const { file, sourceText, concern, gate } = input
  const validReadCaches = input.validReadCaches ?? new Set<string>()
  const tables = STATE_CLASSES.flatMap((item) =>
    'table' in item && item.store === concern && item.class === 'hosted'
      ? [
          {
            table: item.table,
            cache: item.cache === true,
            ...(item.task ? { task: item.task } : {}),
            ...(validReadCaches.has(`${concern}:${item.table}`) && item.readCache
              ? { readCache: item.readCache }
              : {}),
          },
        ]
      : [],
  )
  const tableNames = tables.map(({ table }) => table)
  const { sourceSelector, sourceUsesPostgres, sourceUsesSqlite } =
    hostedLocalReadSourceFacts(sourceText)
  const gateUnresolved: HostedSqlUnresolvedSite[] = []
  const extracted = extractSqlFromSource({
    sourceText,
    file,
    renderedUnresolvedRisk: (sql) =>
      hostedTableInSql(sql, tableNames) !== null || /^\s*(?:CREATE|DROP|ALTER)\b/i.test(sql),
    ...(concern === 'orchestrator' && gate
      ? {
          gateRenderedUnresolvedRisk: (sql: string) =>
            hostedTableInSql(sql, HOSTED_TABLES_WITHOUT_LOCAL_ACCESS) !== null ||
            /^\s*(?:CREATE|DROP|ALTER)\b/i.test(sql),
          gateUnresolvedSink: gateUnresolved,
        }
      : {}),
  })
  if (concern === 'orchestrator' && gate) {
    gate.sites.push(...extracted.sites)
    gate.unresolved.push(...gateUnresolved)
    gate.cannotJudge.push(...extracted.cannotJudge)
  }
  const candidates: HostedLocalReadCandidate[] = [
    ...extracted.sites.map((site) => ({
      ...site,
      sourceText,
      sourceSelector,
      sourceUsesPostgres,
      sourceUsesSqlite,
    })),
    ...extracted.unresolved.map((site) => ({
      ...site,
      sourceText,
      sourceSelector,
      sourceUsesPostgres,
      sourceUsesSqlite,
    })),
    ...extracted.cannotJudge.map((site) => ({
      ...site,
      sourceText,
      dynamicTable: true,
      sourceSelector,
      sourceUsesPostgres,
      sourceUsesSqlite,
    })),
  ]
  return classifyHostedLocalReadSites({
    candidates,
    tables,
    allowedFiles: HOSTED_LOCAL_SQL_ALLOWED_FILES,
  })
}

function scanHostedLocalReadConcern(input: {
  root: string
  concern: 'orchestrator' | 'hub'
  validReadCaches: ReadonlySet<string>
  gate: HostedLocalReadScan['gate']
}): HostedLocalReadHit[] {
  const { root, concern, validReadCaches, gate } = input
  if (!existsSync(resolve(root, concern))) return []
  const testDirectory = `${resolve(root, concern, 'test')}/`
  const files = productionTypeScriptFiles(resolve(root, concern)).filter(
    (file) =>
      !file.startsWith(testDirectory) &&
      (concern !== 'hub' || !file.startsWith(resolve(root, 'hub/web/'))),
  )
  return files.flatMap((file) => {
    const sourceText = readFileSync(file, 'utf8')
    const path = relative(root, file)
    return scanHostedLocalReadSource({
      sourceText,
      file: path,
      concern,
      validReadCaches,
      gate,
    })
  })
}

export function hostedLocalReadScan(root: string): HostedLocalReadScan {
  const started = performance.now()
  const configuration = hostedLocalReadConfiguration(root)
  const gate: HostedLocalReadScan['gate'] = { sites: [], unresolved: [], cannotJudge: [] }
  const hits = (['orchestrator', 'hub'] as const).flatMap((concern) =>
    scanHostedLocalReadConcern({ root, concern, validReadCaches: configuration.valid, gate }),
  )
  hits.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.table.localeCompare(right.table),
  )
  gate.unresolved = [
    ...new Map(
      gate.unresolved.map((site) => [`${site.file}:${site.line}:${site.fingerprint}`, site]),
    ).values(),
  ]
  return {
    configurationFailures: configuration.failures,
    gate,
    report: {
      hits,
      totals: {
        hits: hits.length,
        byKind: counts(
          hits.map(({ kind }) => kind),
          HOSTED_LOCAL_READ_KINDS,
        ),
        byPath: counts(
          hits.map(({ path }) => path),
          HOSTED_LOCAL_READ_PATHS,
        ),
        byTable: groupedCounts(hits.map(({ table }) => table)),
        byModule: groupedCounts(hits.map(({ module }) => module)),
      },
      wallTimeMs: Math.round((performance.now() - started) * 100) / 100,
    },
  }
}

export function hostedLocalReadReport(root: string): HostedLocalReadReport {
  return hostedLocalReadScan(root).report
}

export function formatHostedLocalReadReport(report: HostedLocalReadReport): string {
  const lines = report.hits.map(
    (hit) =>
      `${hit.file}:${hit.line}: table=${hit.table} kind=${hit.kind} path=${hit.path} reason=${hit.reason}`,
  )
  const totals = (label: string, values: Record<string, number>) =>
    `${label}: ${Object.entries(values)
      .map(([key, count]) => `${key}=${count}`)
      .join(', ')}`
  return [
    ...lines,
    `hits: ${report.totals.hits}`,
    totals('kind totals', report.totals.byKind),
    totals('path totals', report.totals.byPath),
    totals('table totals', report.totals.byTable),
    totals('module totals', report.totals.byModule),
    `wall time: ${report.wallTimeMs} ms`,
  ].join('\n')
}
