import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  classifyHostedLocalReadSites,
  type HostedLocalReadAllowedFile,
  type HostedLocalReadCandidate,
  hostedBoardLocalReadFailures,
  hostedLocalReadDeclarationValidation,
  hostedLocalReadKind,
  hostedLocalReadScan,
  hostedLocalReadSourceFacts,
} from './hosted-local-read-report.ts'
import { extractSqlFromSource } from './hosted-sql-schema.ts'

const tables = [
  { table: 'hosted_row', cache: false },
  { table: 'hosted_cache', cache: true },
  {
    table: 'declared_cache',
    cache: false,
    readCache: { refresh: 'orchestrator/src/refresh.ts:refresh', schedule: 'hourly' },
  },
  { table: 'planned_row', cache: false, task: 'DEV-2234' },
]

function candidates(file: string, sourceText: string): HostedLocalReadCandidate[] {
  const extracted = extractSqlFromSource({
    file,
    sourceText,
    renderedUnresolvedRisk: () => true,
  })
  return [
    ...extracted.sites.map((site) => ({
      ...site,
      sourceText,
      sourceUsesPostgres: false,
      sourceUsesSqlite: false,
    })),
    ...extracted.unresolved.map((site) => ({
      ...site,
      sourceText,
      sourceUsesPostgres: false,
      sourceUsesSqlite: false,
    })),
    ...extracted.cannotJudge.map((site) => ({
      ...site,
      sourceText,
      dynamicTable: true,
      sourceUsesPostgres: false,
      sourceUsesSqlite: false,
    })),
  ]
}

test.each([
  {
    name: 'a read in the local arm',
    source: `function read() {
      if (writeMode(project) === 'local-authoritative') {
        db.query(\`SELECT * FROM hosted_row\`)
      }
    }`,
    path: 'local-only',
  },
  {
    name: 'a read after a returning hosted arm',
    source: `function read() {
      if (hostedWriteMode(url) === 'hosted-configured') return hostedRead()
      db.query(\`SELECT * FROM hosted_row\`)
    }`,
    path: 'local-only',
  },
  {
    name: 'a read before the branch',
    source: `function read() {
      db.query(\`SELECT * FROM hosted_row\`)
      if (hostedWriteMode(url) === 'hosted-configured') return hostedRead()
    }`,
    path: 'hosted-reachable',
  },
  {
    name: 'a read inside the hosted arm',
    source: `function read() {
      if (writeMode(project) === 'hosted-configured') {
        db.query(\`SELECT * FROM hosted_row\`)
      }
    }`,
    path: 'hosted-reachable',
  },
  {
    name: 'a helper reached only from local arms',
    source: `function localRead() {
      db.query(\`SELECT * FROM hosted_row\`)
    }
    function read() {
      if (writeMode(project) === 'local-authoritative') {
        localRead()
      }
    }`,
    path: 'local-only',
  },
] as const)('classifies selector control flow for $name', ({ source, path }) => {
  const hit = classifyHostedLocalReadSites({
    candidates: candidates('hub/src/fixture.ts', source).map((candidate) => ({
      ...candidate,
      sourceSelector: hostedLocalReadSourceFacts(source).sourceSelector,
    })),
    tables,
    allowedFiles: [],
  })[0]
  expect(hit?.path).toBe(path)
})

test.each([
  ['SELECT * FROM hosted_row', 'read'],
  ['INSERT INTO hosted_row SELECT * FROM other_row', 'write'],
  ['WITH chosen AS (SELECT 1) UPDATE hosted_row SET value = 1', 'write'],
] as const)('classifies %s as %s', (sql, kind) => {
  expect(hostedLocalReadKind(sql)).toBe(kind)
})

test('the production scan excludes concern test directories', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'hosted-local-read-report-'))
  try {
    const production = resolve(root, 'orchestrator/src/read.ts')
    const fixture = resolve(root, 'orchestrator/test/read.ts')
    mkdirSync(resolve(production, '..'), { recursive: true })
    mkdirSync(resolve(fixture, '..'), { recursive: true })
    writeFileSync(production, "db.query('SELECT * FROM board_message')")
    writeFileSync(fixture, "db.query('SELECT * FROM board_message')")
    expect(hostedLocalReadScan(root).report.hits.map(({ file }) => file)).toEqual([
      'orchestrator/src/read.ts',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('refuses only hosted-reachable reads of B1 board tables', () => {
  const hit = {
    file: 'orchestrator/src/board/new-reader.ts',
    line: 17,
    table: 'board_message',
    kind: 'read' as const,
    path: 'hosted-reachable' as const,
    reason: 'fixture',
    module: 'orchestrator:board',
  }
  expect(hostedBoardLocalReadFailures([hit])).toEqual([
    expect.stringContaining('new-reader.ts:17: hosted install can read board_message'),
  ])
  expect(
    hostedBoardLocalReadFailures([
      { ...hit, path: 'cannot-tell' },
      { ...hit, kind: 'write' },
      { ...hit, table: 'doc_revision' },
      { ...hit, table: 'session_board_hold' },
      { ...hit, table: 'typed_question_answer' },
      { ...hit, file: 'orchestrator/src/board/board-suggestions.ts' },
    ]),
  ).toEqual([])
})

test.each([
  'boardMode',
  'boardModeForId',
  'hostedWriteMode',
  'writeMode',
  'requireLocalBoardRead',
  'hostedRecordOwnsHostedTables',
] as const)('recognizes the %s selector', (selector) => {
  expect(hostedLocalReadSourceFacts(`${selector}(database)`).sourceSelector).toBe(selector)
})

test.each([
  ['SELECT * FROM declared_cache', 'declared-cache'],
  ['UPDATE declared_cache SET value=1', 'hosted-reachable'],
] as const)('a declared cache classifies %s as %s', (sql, path) => {
  expect(
    classifyHostedLocalReadSites({
      candidates: candidates('orchestrator/src/read.ts', `db.query(\`${sql}\`)`),
      tables,
      allowedFiles: [],
    })[0]?.path,
  ).toBe(path)
})

const readCacheDeclaration = {
  store: 'orchestrator',
  table: 'declared_cache',
  class: 'hosted',
  reason: 'fixture',
  counterpart: 'declared_cache',
  readCache: { refresh: 'orchestrator/src/refresh.ts:refresh', schedule: 'hourly' },
} as const

test.each([
  {
    name: 'unexported refresh symbol',
    exportedRefreshes: [],
    schedules: [{ label: 'hourly', launchdInterval: '60', systemdInterval: '60' }],
    failure: 'refresh symbol is not exported',
  },
  {
    name: 'unknown schedule label',
    exportedRefreshes: ['orchestrator/src/refresh.ts:refresh'],
    schedules: [],
    failure: 'schedule label is not in MAINTENANCE_SCHEDULE_LABELS',
  },
  {
    name: 'disagreeing intervals',
    exportedRefreshes: ['orchestrator/src/refresh.ts:refresh'],
    schedules: [{ label: 'hourly', launchdInterval: '60', systemdInterval: '90' }],
    failure: 'launchd StartInterval 60 disagrees with systemd OnUnitActiveSec 90',
  },
] as const)('refuses a read-cache declaration with $name', (fixture) => {
  const result = hostedLocalReadDeclarationValidation({
    stateClasses: [readCacheDeclaration],
    exportedRefreshes: fixture.exportedRefreshes,
    schedules: fixture.schedules,
  })
  expect(result.failures).toContainEqual(expect.stringContaining(fixture.failure))
  expect(result.valid).toEqual(new Set())
})

test('recognizes Postgres and SQLite file signals', () => {
  expect(
    hostedLocalReadSourceFacts("import postgres from 'postgres'\ntx`SELECT 1`").sourceUsesPostgres,
  ).toBe(true)
  expect(
    hostedLocalReadSourceFacts("import { Database } from 'bun:sqlite'\nwritableDb()")
      .sourceUsesSqlite,
  ).toBe(true)
})

test.each([
  {
    name: 'cache table',
    file: 'orchestrator/src/board/cache.ts',
    source: 'db.query(`SELECT * FROM hosted_cache`)',
    path: 'excluded-by-design',
  },
  {
    name: 'reasoned exclusion',
    file: 'orchestrator/src/record/record-sync.ts',
    source: 'db.query(`SELECT * FROM hosted_row`)',
    path: 'excluded-by-design',
    allow: [{ pattern: /record-sync\.ts$/, reason: 'record synchronization adapter' }],
  },
  {
    name: 'local adapter',
    file: 'orchestrator/src/question-store/question-store-sqlite.ts',
    source: 'db.query(`SELECT * FROM hosted_row`)',
    path: 'local-only',
  },
  {
    name: 'ownership-selected allowlist entry',
    file: 'orchestrator/src/report/selected.ts',
    source: 'db.query(`SELECT * FROM hosted_row`)',
    path: 'local-only',
    allow: [
      {
        pattern: /selected\.ts$/,
        reason: 'local SQL runs when hostedRecordOwnsHostedTables(database) is false',
      },
    ],
  },
  {
    name: 'dynamic table',
    file: 'orchestrator/src/report/dynamic.ts',
    source: 'db.query(`SELECT * FROM $' + '{table}`)',
    path: 'cannot-tell',
  },
  {
    name: 'selector elsewhere in file',
    file: 'orchestrator/src/report/selector.ts',
    source: 'db.query(`SELECT * FROM hosted_row`)',
    path: 'cannot-tell',
    selector: 'boardModeForId',
    reason: 'boardModeForId is called somewhere in the file',
  },
  {
    name: 'planned hosted home despite selector',
    file: 'orchestrator/src/report/planned.ts',
    source: 'db.query(`SELECT * FROM planned_row`)',
    path: 'hosted-reachable',
    selector: 'boardMode',
    reason: 'hosted home is planned by DEV-2234',
  },
  {
    name: 'Postgres SQL',
    file: 'orchestrator/src/report/hosted-record.ts',
    source: 'query(`SELECT * FROM hosted_row`)',
    path: 'hosted-record',
    postgres: true,
    reason: 'SQL runs on the hosted record, not the local store',
  },
  {
    name: 'mixed SQLite and Postgres SQL',
    file: 'orchestrator/src/report/mixed.ts',
    source: 'query(`SELECT * FROM hosted_row`)',
    path: 'cannot-tell',
    postgres: true,
    sqlite: true,
    reason: 'file uses both a SQLite handle and Postgres',
  },
  {
    name: 'ordinary production path',
    file: 'orchestrator/src/report/read.ts',
    source: 'db.query(`SELECT * FROM hosted_row`)',
    path: 'hosted-reachable',
  },
] as const)('classifies $name as $path', (fixture) => {
  const input = candidates(fixture.file, fixture.source).map((candidate) => ({
    ...candidate,
    sourceSelector: 'selector' in fixture ? fixture.selector : undefined,
    sourceUsesPostgres: 'postgres' in fixture && fixture.postgres === true,
    sourceUsesSqlite: 'sqlite' in fixture && fixture.sqlite === true,
  }))
  const allowedFiles: readonly HostedLocalReadAllowedFile[] =
    'allow' in fixture && fixture.allow ? fixture.allow : []
  const hits = classifyHostedLocalReadSites({
    candidates: input,
    tables,
    allowedFiles,
  })
  expect(hits).toHaveLength(1)
  expect(hits[0]?.path).toBe(fixture.path)
  if ('reason' in fixture) expect(hits[0]?.reason).toContain(fixture.reason)
})
