import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { hostedLocalBoardHeadFailures } from './hosted-local-board-head-check.ts'
import {
  classifyHostedLocalReadSites,
  type HostedLocalReadAllowedFile,
  type HostedLocalReadCandidate,
  hostedBoardLocalReadFailures,
  hostedDocLocalReadFailures,
  hostedHubLocalReadFailures,
  hostedLocalReadDeclarationValidation,
  hostedLocalReadKind,
  hostedLocalReadScan,
  hostedLocalReadSourceFacts,
} from './hosted-local-read-report.ts'
import { HOSTED_LOCAL_SQL_ALLOWED_FILES } from './hosted-local-sql-allowlist.ts'
import { extractSqlFromSource } from './hosted-sql-schema.ts'

const tables = [
  { table: 'hosted_row', cache: false },
  { table: 'task', cache: false },
  { table: 'board_message', cache: false },
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
  {
    name: 'a read after an unconditional local board guard',
    source: `function read() {
      requireLocalBoardRead(env, db)
      db.query(\`SELECT * FROM hosted_row\`)
    }`,
    path: 'local-only',
  },
  {
    name: 'a write after an unconditional local board write guard',
    source: `function write() {
      requireLocalBoardWrite('notice post', env, db)
      db.query(\`UPDATE hosted_row SET value=1\`)
    }`,
    path: 'local-only',
  },
  {
    name: 'a read before a local board guard',
    source: `function read() {
      db.query(\`SELECT * FROM hosted_row\`)
      requireLocalBoardRead(env, db)
    }`,
    path: 'cannot-tell',
  },
  {
    name: 'a read after a returning hosted board arm',
    source: `function read() {
      const mode = boardMode('shared', env, db)
      if (mode === 'hosted') return hostedRead()
      db.query(\`SELECT * FROM hosted_row\`)
    }`,
    path: 'local-only',
  },
  {
    name: 'a read after a fall-through hosted board arm',
    source: `function read() {
      if (boardModeForId(id, 'board id', env, db) === 'hosted') {
        if (refreshFailed) throw new Error('refresh failed')
      }
      db.query(\`SELECT * FROM hosted_row\`)
    }`,
    path: 'hosted-reachable',
  },
  {
    name: 'a read after a multi-line braceless fall-through hosted board arm',
    source: `function read() {
      const mode = boardMode('shared', env, db)
      if (mode === 'hosted') {
        const refreshed = refresh()
        if (refreshed.status !== 'success')
          throw new Error('x')
      }
      db.query(\`SELECT * FROM hosted_row\`)
    }`,
    path: 'cannot-tell',
  },
  {
    name: 'a read after a conditional local board guard',
    source: `function read() {
      if (strict) requireLocalBoardRead(env, db)
      db.query(\`SELECT * FROM hosted_row\`)
    }`,
    path: 'cannot-tell',
  },
  {
    name: 'a read after a local board guard inside a callback',
    source: `function read() {
      items.forEach((item) => requireLocalBoardRead(env, db))
      db.query(\`SELECT * FROM hosted_row\`)
    }`,
    path: 'cannot-tell',
  },
  {
    name: 'a helper called from the local arm of a board mode ternary',
    source: `function localRead() {
      db.query(\`SELECT * FROM hosted_row\`)
    }
    function read() {
      const mode = boardMode('shared', env, db)
      return mode === 'local' ? localRead() : hostedRead()
    }`,
    path: 'local-only',
  },
  {
    name: 'a helper called from the hosted arm of a board mode ternary',
    source: `function hostedRead() {
      db.query(\`SELECT * FROM hosted_row\`)
    }
    function read() {
      const mode = boardMode('shared', env, db)
      return mode === 'local' ? localRead() : hostedRead()
    }`,
    path: 'hosted-reachable',
  },
  {
    name: 'a helper called from the local arm of a write mode ternary',
    source: `function localRead() {
      db.query(\`SELECT * FROM hosted_row\`)
    }
    function read() {
      return writeMode(project) === 'hosted' ? hostedRead() : localRead()
    }`,
    path: 'local-only',
  },
  {
    name: 'a helper after an object colon in the hosted arm of a board mode ternary',
    source: `function localRead() { db.query(\`SELECT * FROM hosted_row\`) }
    function read() {
      const mode = boardMode('shared', env, db)
      return mode === 'hosted' ? wrap({ kind: 1 }, localRead()) : other()
    }`,
    path: 'cannot-tell',
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
    hostedBoardLocalReadFailures([{ ...hit, file: 'orchestrator/src/board/board-suggestions.ts' }]),
  ).toEqual([
    expect.stringContaining('board-suggestions.ts:17: hosted install can read board_message'),
  ])
  expect(
    hostedBoardLocalReadFailures([
      { ...hit, path: 'cannot-tell' },
      { ...hit, exclusionReason: 'planned' },
      { ...hit, kind: 'write' },
      { ...hit, table: 'doc_revision' },
      { ...hit, table: 'session_board_hold' },
      { ...hit, table: 'typed_question_answer' },
    ]),
  ).toEqual([])
})

test('classifies only the reasoned board suggestion function as local-only', () => {
  const source = `function suggestBoardPost() {
    db.query(\`SELECT * FROM board_message\`)
  }
  function newHostedBoardReader() {
    db.query(\`SELECT * FROM board_message\`)
  }`
  const hits = classifyHostedLocalReadSites({
    candidates: candidates('orchestrator/src/board/board-suggestions.ts', source),
    tables,
    allowedFiles: HOSTED_LOCAL_SQL_ALLOWED_FILES,
  })
  expect(hits.map(({ functionName, path }) => ({ functionName, path }))).toEqual([
    { functionName: 'suggestBoardPost', path: 'local-only' },
    { functionName: 'newHostedBoardReader', path: 'hosted-reachable' },
  ])
  expect(hostedBoardLocalReadFailures(hits)).toEqual([
    expect.stringContaining('hosted install can read board_message'),
  ])
})

test('refuses hosted-reachable and cannot-tell reads of B2 hub tables', () => {
  const hit = {
    file: 'hub/src/new-reader.ts',
    line: 23,
    table: 'task',
    kind: 'read' as const,
    path: 'hosted-reachable' as const,
    reason: 'fixture',
    module: 'hub:new-reader.ts',
  }
  expect(hostedHubLocalReadFailures([hit, { ...hit, path: 'cannot-tell' }])).toEqual([
    expect.stringContaining('new-reader.ts:23: hosted install can read task'),
    expect.stringContaining('read the hosted record through the hub client on a hosted install'),
  ])
  expect(
    hostedHubLocalReadFailures([
      { ...hit, path: 'local-only' },
      { ...hit, kind: 'write' },
      { ...hit, table: 'typed_question_answer' },
    ]),
  ).toEqual([])
})

test('reports planned reads as hosted-reachable without refusing them', () => {
  const source = `function plannedRead() {
    db.query(\`SELECT * FROM task\`)
  }`
  const [planned] = classifyHostedLocalReadSites({
    candidates: candidates('hub/src/planned.ts', source),
    tables,
    allowedFiles: [
      {
        pattern: /^hub\/src\/planned\.ts$/,
        functionName: 'plannedRead',
        reason: 'planned',
        detail: `planned by project/${PLATFORM_SLUG}/plan-dev-2608-b3-local-task-reads`,
        expectedSites: 1,
        reportOnly: true,
      },
    ],
  })
  expect(planned).toMatchObject({
    path: 'hosted-reachable',
    exclusionReason: 'planned',
    functionName: 'plannedRead',
  })
  expect(planned?.reason).toContain(`project/${PLATFORM_SLUG}/plan-dev-2608-b3-local-task-reads`)
  expect(hostedHubLocalReadFailures([planned!])).toEqual([])
  expect(hostedHubLocalReadFailures([{ ...planned!, exclusionReason: undefined }])).toEqual([
    expect.stringContaining('hosted install can read task'),
  ])
})

test('refuses unplanned hosted doc revision reads and permits planned ones', () => {
  const hit = {
    file: 'orchestrator/src/doc/new-reader.ts',
    line: 31,
    table: 'doc_revision',
    kind: 'read' as const,
    path: 'hosted-reachable' as const,
    reason: 'fixture',
    module: 'orchestrator:doc',
  }
  expect(hostedDocLocalReadFailures([hit, { ...hit, path: 'cannot-tell' }])).toEqual([
    expect.stringContaining('new-reader.ts:31: hosted install can read doc_revision'),
    expect.stringContaining('read revisions through the hosted doc client'),
  ])
  expect(
    hostedDocLocalReadFailures([
      { ...hit, exclusionReason: 'planned' },
      { ...hit, path: 'local-only' },
      { ...hit, kind: 'write' },
    ]),
  ).toEqual([])
})

test.each([
  'boardMode',
  'boardModeForId',
  'boardIdentifierMode',
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

test('write-time board head judgment refuses an unheaded site and accepts a headed site', () => {
  const file = 'orchestrator/src/board/candidate.ts'
  expect(
    hostedLocalBoardHeadFailures({
      file,
      sourceText: `function write(database) {
        database.query(\`UPDATE board_message SET title='changed'\`)
      }`,
    }),
  ).toEqual([
    expect.stringContaining(`${file}:2: local board_message write has no proven local-board head`),
  ])
  expect(
    hostedLocalBoardHeadFailures({
      file,
      sourceText: `function write(database) {
        requireLocalBoardWrite('notice post', process.env, database)
        database.query(\`UPDATE board_message SET title='changed'\`)
      }`,
    }),
  ).toEqual([])
})
