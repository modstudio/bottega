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
  extractSqlFromSource,
  type HostedSqlCannotJudgeSite,
  type HostedSqlSite,
  type HostedSqlUnresolvedSite,
  productionTypeScriptFiles,
} from './hosted-sql-schema.ts'
import {
  HOSTED_LOCAL_SQL_ALLOWED_FILES,
  HOSTED_LOCAL_SQL_EXCLUSION_REASONS,
  type HostedLocalSqlAllowedFile,
} from './hosted-local-sql-allowlist.ts'
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

const HOSTED_BOARD_LOCAL_READ_REFUSAL_TABLES = [
  'board_message',
  'board_claim',
  'board_receipt',
  'board_message_tag',
  'board_withdrawal_delivery',
] as const

export function hostedBoardLocalReadFailures(hits: readonly HostedLocalReadHit[]): string[] {
  const refused = new Set<string>(HOSTED_BOARD_LOCAL_READ_REFUSAL_TABLES)
  return hits.flatMap((hit) =>
    hit.kind === 'read' &&
    hit.path === 'hosted-reachable' &&
    refused.has(hit.table) &&
    hit.file !== 'orchestrator/src/board/board-suggestions.ts'
      ? [
          `${hit.file}:${hit.line}: hosted install can read ${hit.table} from the local SQLite store; branch through boardMode/boardModeForId and the hosted board reader`,
        ]
      : [],
  )
}

const WRITE_SQL = /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE)\b/i
const HOSTED_SELECTORS = [
  'boardMode',
  'boardModeForId',
  'hostedWriteMode',
  'writeMode',
  'requireLocalBoardRead',
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

function classifiedPath(
  candidate: HostedLocalReadCandidate,
  table: HostedLocalReadTable | null,
  allowedFiles: readonly HostedLocalReadAllowedFile[],
): Pick<HostedLocalReadHit, 'path' | 'reason'> {
  if (table?.cache)
    return { path: 'excluded-by-design', reason: 'hosted cache table is local by design' }
  if (table?.readCache && hostedLocalReadKind(candidate.sql) === 'read')
    return {
      path: 'declared-cache',
      reason: `declared read cache refreshed by ${table.readCache.refresh} on ${table.readCache.schedule}`,
    }
  if (LOCAL_ADAPTER.test(candidate.file))
    return { path: 'local-only', reason: 'file matches LOCAL_SQLITE_ADAPTER_PATH' }
  const allowed = allowedFiles.find(({ pattern }) => pattern.test(candidate.file))
  const allowedDetail = allowed?.detail ?? allowed?.reason ?? ''
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
  if (candidate.sourceSelector)
    return {
      path: 'cannot-tell',
      reason: `${candidate.sourceSelector} is called somewhere in the file; the extractor cannot prove it encloses this site`,
    }
  return { path: 'hosted-reachable', reason: 'no local-only or excluded hosted path was found' }
}

/** Pure report policy over SQL sites and inventory declarations gathered by the caller. */
export function classifyHostedLocalReadSites(input: {
  candidates: readonly HostedLocalReadCandidate[]
  tables: readonly HostedLocalReadTable[]
  allowedFiles: readonly HostedLocalReadAllowedFile[]
}): HostedLocalReadHit[] {
  const tablesByName = new Map(input.tables.map((table) => [table.table, table]))
  return input.candidates.flatMap((candidate) => {
    const namedTables = candidate.dynamicTable
      ? [null]
      : input.tables.filter(({ table }) => hostedTableInSql(candidate.sql, [table]) !== null)
    return namedTables.map((table) => ({
      file: candidate.file,
      line: candidate.line,
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

function scanHostedLocalReadConcern(input: {
  root: string
  concern: 'orchestrator' | 'hub'
  validReadCaches: ReadonlySet<string>
  gate: HostedLocalReadScan['gate']
}): HostedLocalReadHit[] {
  const { root, concern, validReadCaches, gate } = input
  if (!existsSync(resolve(root, concern))) return []
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
  const testDirectory = `${resolve(root, concern, 'test')}/`
  const files = productionTypeScriptFiles(resolve(root, concern)).filter(
    (file) =>
      !file.startsWith(testDirectory) &&
      (concern !== 'hub' || !file.startsWith(resolve(root, 'hub/web/'))),
  )
  const candidates = files.flatMap((file): HostedLocalReadCandidate[] => {
    const sourceText = readFileSync(file, 'utf8')
    const path = relative(root, file)
    const { sourceSelector, sourceUsesPostgres, sourceUsesSqlite } =
      hostedLocalReadSourceFacts(sourceText)
    const gateUnresolved: HostedSqlUnresolvedSite[] = []
    const extracted = extractSqlFromSource({
      sourceText,
      file: path,
      renderedUnresolvedRisk: (sql) =>
        hostedTableInSql(sql, tableNames) !== null || /^\s*(?:CREATE|DROP|ALTER)\b/i.test(sql),
      ...(concern === 'orchestrator'
        ? {
            gateRenderedUnresolvedRisk: (sql: string) =>
              hostedTableInSql(sql, HOSTED_TABLES_WITHOUT_LOCAL_ACCESS) !== null ||
              /^\s*(?:CREATE|DROP|ALTER)\b/i.test(sql),
            gateUnresolvedSink: gateUnresolved,
          }
        : {}),
    })
    if (concern === 'orchestrator') {
      gate.sites.push(...extracted.sites)
      gate.unresolved.push(...gateUnresolved)
      gate.cannotJudge.push(...extracted.cannotJudge)
    }
    return [
      ...extracted.sites.map((site) => ({
        ...site,
        sourceSelector,
        sourceUsesPostgres,
        sourceUsesSqlite,
      })),
      ...extracted.unresolved.map((site) => ({
        ...site,
        sourceSelector,
        sourceUsesPostgres,
        sourceUsesSqlite,
      })),
      ...extracted.cannotJudge.map((site) => ({
        ...site,
        dynamicTable: true,
        sourceSelector,
        sourceUsesPostgres,
        sourceUsesSqlite,
      })),
    ]
  })
  return classifyHostedLocalReadSites({
    candidates,
    tables,
    allowedFiles: HOSTED_LOCAL_SQL_ALLOWED_FILES,
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
