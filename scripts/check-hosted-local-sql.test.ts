import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  HOSTED_LOCAL_SQL_ALLOWED_FILES,
  HOSTED_TABLES_WITHOUT_LOCAL_ACCESS,
  hostedTableInSql,
} from '../orchestrator/src/database/hosted-table-guard.ts'
import { sqliteAdapterAllowedImporters } from './architecture-boundaries.ts'
import { checkHostedLocalSql, hostedLocalSqlViolations } from './check-hosted-local-sql.ts'
import { hostedLocalSqlSelectorFailures } from './hosted-local-read-report.ts'
import {
  extractSqlFromSource,
  type HostedSqlSite,
  type HostedSqlUnresolvedSite,
} from './hosted-sql-schema.ts'
import type { StateClassDeclaration } from './identity-state-classes.ts'

const temporaryRoots: string[] = []
const hostedLocalRenderedSqlRisk = (sql: string): boolean =>
  hostedTableInSql(sql, HOSTED_TABLES_WITHOUT_LOCAL_ACCESS) !== null ||
  /^\s*(?:CREATE|DROP|ALTER)\b/i.test(sql)

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryProductionFile(file: string, sourceText: string): string {
  const root = mkdtempSync(resolve(tmpdir(), 'hosted-local-sql-'))
  temporaryRoots.push(root)
  const path = resolve(root, file)
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, sourceText)
  return root
}

const site = (file: string): HostedSqlSite => ({
  file,
  line: 12,
  sql: 'SELECT record_id FROM question WHERE number=?',
  fingerprint: 'fixture',
})
const hostedQuestion = {
  store: 'orchestrator',
  table: 'question',
  class: 'hosted',
  counterpart: 'question',
  reason: 'fixture',
} satisfies StateClassDeclaration
const unresolved = (file: string): HostedSqlUnresolvedSite => ({
  ...site(file),
  sql: 'tableSql',
  expression: 'tableSql',
})

test('hosted-only SQL in an undeclared production file fails', () => {
  expect(
    hostedLocalSqlViolations({
      sites: [site('orchestrator/src/run/unsafe.ts')],
      tables: ['question'],
      allowedFiles: [],
      stateClasses: [hostedQuestion],
    }),
  ).toEqual([
    expect.stringContaining(
      'orchestrator/src/run/unsafe.ts:12: SQL names hosted-only table question',
    ),
  ])
})

test('hosted-only SQL in a declared local file passes', () => {
  expect(
    hostedLocalSqlViolations({
      sites: [site('orchestrator/src/question-store/question-store-sqlite.ts')],
      tables: ['question'],
      allowedFiles: [{ pattern: /question-store-sqlite\.ts$/, reason: 'local-only' }],
      stateClasses: [hostedQuestion],
    }),
  ).toEqual([])
})

test.each([
  'readRecordInstallBinding(database).bound is false',
  'record_install_binding has no row',
  'storeHasAttachedToHostedRecord(database) is false',
])('a hosted-only SQL exemption cannot cite attachment state: %s', (reason) => {
  expect(
    hostedLocalSqlViolations({
      sites: [site('orchestrator/src/run/unsafe.ts')],
      tables: ['question'],
      allowedFiles: [{ pattern: /unsafe\.ts$/, reason: 'local-only', detail: reason }],
      stateClasses: [hostedQuestion],
    }),
  ).toEqual([expect.stringContaining('select local SQL with hostedRecordOwnsHostedTables instead')])
})

test.each([
  {
    name: 'an attachment predicate',
    source: 'storeHasAttachedToHostedRecord(database)',
    expectedFailure: 'select local SQL with hostedRecordOwnsHostedTables instead',
  },
  {
    name: 'no ownership predicate',
    source: 'selectLocalWorkflowStore(database)',
    expectedFailure: 'the file does not call it',
  },
  {
    name: 'the ownership predicate',
    source: 'hostedRecordOwnsHostedTables(database)',
    expectedFailure: null,
  },
])(
  'an answer-A exemption with $name is checked against its source',
  ({ source, expectedFailure }) => {
    const file = 'orchestrator/src/run/selector.ts'
    const root = temporaryProductionFile(file, source)
    const failures = hostedLocalSqlSelectorFailures(root, [
      {
        pattern: /^orchestrator\/src\/run\/selector\.ts$/,
        reason: 'local-only',
        detail: 'Local SQL runs when hostedRecordOwnsHostedTables(database) is false',
      },
    ])
    expect(failures).toEqual(
      expectedFailure === null ? [] : [expect.stringContaining(expectedFailure)],
    )
  },
)

test('a guarded table not declared hosted fails', () => {
  expect(
    hostedLocalSqlViolations({
      sites: [],
      tables: ['question'],
      allowedFiles: [],
      stateClasses: [],
    }),
  ).toEqual([
    'question: guarded hosted-only table is not declared hosted in the identity-state inventory; declare it hosted before guarding local access',
  ])
})

test('unresolved SQL in an undeclared production file fails', () => {
  expect(
    hostedLocalSqlViolations({
      sites: [],
      unresolved: [unresolved('orchestrator/src/run/unsafe.ts')],
      tables: ['question'],
      allowedFiles: [],
      stateClasses: [hostedQuestion],
    }),
  ).toEqual([expect.stringContaining('orchestrator/src/run/unsafe.ts:12: unresolved SQL')])
})

test.each([
  'db.query(`SELECT 1 FROM workflow_cursor WHERE ${col}=? LIMIT 1`)',
  'db.exec(`DROP TABLE ${name}`)',
])('a hosted-risk rendered template with an unresolved span fails: %s', (sourceText) => {
  const extracted = extractSqlFromSource({
    sourceText,
    file: 'orchestrator/src/run/unsafe.ts',
    renderedUnresolvedRisk: hostedLocalRenderedSqlRisk,
  })
  expect(extracted.sites).toEqual([])
  expect(extracted.unresolved).toHaveLength(1)
  expect(
    hostedLocalSqlViolations({
      ...extracted,
      tables: ['workflow_cursor'],
      allowedFiles: [],
      stateClasses: [
        {
          store: 'orchestrator',
          table: 'workflow_cursor',
          class: 'hosted',
          counterpart: 'workflow_cursor',
          reason: 'fixture',
        },
      ],
    }),
  ).toEqual([expect.stringContaining('orchestrator/src/run/unsafe.ts:1: unresolved SQL')])
})

test('a substituted template not naming a hosted table stays clean', () => {
  expect(
    extractSqlFromSource({
      sourceText: 'db.query(`SELECT ${columns} FROM machine_local_table`)',
      file: 'orchestrator/src/run/safe.ts',
      renderedUnresolvedRisk: hostedLocalRenderedSqlRisk,
    }),
  ).toEqual({ sites: [], unresolved: [], cannotJudge: [] })
})

test('the project check reports a hosted-risk rendered template with an unresolved span', () => {
  const file = 'orchestrator/src/run/unsafe.ts'
  const root = temporaryProductionFile(
    file,
    'db.query(`SELECT 1 FROM workflow_cursor WHERE ${col}=? LIMIT 1`)',
  )
  expect(checkHostedLocalSql(root).failures).toContainEqual(expect.stringContaining(file))
})

test('the project check does not report a rendered template naming a non-hosted table', () => {
  const file = 'orchestrator/src/run/safe.ts'
  const root = temporaryProductionFile(
    file,
    'db.query(`SELECT ${columns} FROM machine_local_table`)',
  )
  expect(checkHostedLocalSql(root).failures.some((failure) => failure.includes(file))).toBe(false)
})

test('an interpolated table is refused as cannot-judge', () => {
  const extracted = extractSqlFromSource({
    sourceText: 'db.query(`SELECT 1 FROM ${table} WHERE id=?`)',
    file: 'orchestrator/src/run/unsafe.ts',
    renderedUnresolvedRisk: hostedLocalRenderedSqlRisk,
  })
  expect(extracted.cannotJudge).toHaveLength(1)
  expect(
    hostedLocalSqlViolations({
      ...extracted,
      tables: ['question'],
      allowedFiles: [],
      stateClasses: [hostedQuestion],
      cannotJudgeBaseline: [],
    }),
  ).toEqual([expect.stringContaining('cannot judge interpolated SQL table')])
})

test('moving a baselined interpolated table site to another line stays clean', () => {
  const file = 'orchestrator/src/run/unsafe.ts'
  const sourceText = 'db.query(`SELECT 1 FROM ${table} WHERE id=?`)'
  const original = extractSqlFromSource({
    sourceText,
    file,
    renderedUnresolvedRisk: hostedLocalRenderedSqlRisk,
  })
  const moved = extractSqlFromSource({
    sourceText: `\n\n${sourceText}`,
    file,
    renderedUnresolvedRisk: hostedLocalRenderedSqlRisk,
  })
  expect(original.cannotJudge).toHaveLength(1)
  expect(moved.cannotJudge).toHaveLength(1)
  expect(moved.cannotJudge[0]?.line).not.toBe(original.cannotJudge[0]?.line)
  const cannotJudgeBaseline = [
    { file, fingerprint: original.cannotJudge[0]!.fingerprint, count: 1 },
  ]
  for (const extracted of [original, moved])
    expect(
      hostedLocalSqlViolations({
        ...extracted,
        tables: ['question'],
        allowedFiles: [],
        stateClasses: [hostedQuestion],
        cannotJudgeBaseline,
      }),
    ).toEqual([])
})

test('a second copy of a baselined interpolated table statement fails', () => {
  const file = 'orchestrator/src/run/unsafe.ts'
  const statement = 'db.query(`SELECT 1 FROM ${table} WHERE id=?`)'
  const extracted = extractSqlFromSource({
    sourceText: `${statement}\n${statement}`,
    file,
    renderedUnresolvedRisk: hostedLocalRenderedSqlRisk,
  })
  expect(extracted.cannotJudge).toHaveLength(2)
  expect(
    hostedLocalSqlViolations({
      ...extracted,
      tables: ['question'],
      allowedFiles: [],
      stateClasses: [hostedQuestion],
      cannotJudgeBaseline: [{ file, fingerprint: extracted.cannotJudge[0]!.fingerprint, count: 1 }],
    }),
  ).toEqual([expect.stringContaining(`${file}:2: cannot judge interpolated SQL table`)])
})

test('removing a baselined interpolated table statement fails as stale', () => {
  const file = 'orchestrator/src/run/unsafe.ts'
  expect(
    hostedLocalSqlViolations({
      sites: [],
      tables: ['question'],
      allowedFiles: [],
      stateClasses: [hostedQuestion],
      cannotJudgeBaseline: [{ file, fingerprint: 'removed-fixture', count: 1 }],
    }),
  ).toEqual([
    expect.stringContaining(
      `${file}: stale cannot-judge SQL baseline entry for fingerprint removed-fixture; expected 1 occurrences but found 0`,
    ),
  ])
})

test('an exact-path exemption refuses more sites than its budget', () => {
  expect(
    hostedLocalSqlViolations({
      sites: [site('orchestrator/src/database/db.ts'), site('orchestrator/src/database/db.ts')],
      tables: ['question'],
      allowedFiles: [
        { pattern: /^orchestrator\/src\/database\/db\.ts$/, reason: 'fixture', expectedSites: 1 },
      ],
      stateClasses: [hostedQuestion],
    }),
  ).toEqual([expect.stringContaining('expected 1 sites but found 2')])
})

test('an exact-path exemption refuses a stale count above actual', () => {
  expect(
    hostedLocalSqlViolations({
      sites: [site('orchestrator/src/database/db.ts')],
      tables: ['question'],
      allowedFiles: [
        { pattern: /^orchestrator\/src\/database\/db\.ts$/, reason: 'fixture', expectedSites: 2 },
      ],
      stateClasses: [hostedQuestion],
    }),
  ).toEqual([expect.stringContaining('expected 2 sites but found 1')])
})

test('an allowed file with no hosted-only or unresolved SQL is rejected as unused', () => {
  expect(
    hostedLocalSqlViolations({
      sites: [],
      tables: ['question'],
      allowedFiles: [{ pattern: /unused\.ts$/, reason: 'fixture' }],
      stateClasses: [hostedQuestion],
    }),
  ).toEqual([expect.stringContaining('unused hosted-only SQL exemption /unused\\.ts$/')])
})

test.each(['hosted-record', 'passthrough'] as const)(
  'the %s exclusion reason is accepted',
  (reason) => {
    expect(
      hostedLocalSqlViolations({
        sites: [site('orchestrator/src/run/allowed.ts')],
        tables: ['question'],
        allowedFiles: [{ pattern: /allowed\.ts$/, reason }],
        stateClasses: [hostedQuestion],
      }),
    ).toEqual([])
  },
)

test('an unreasoned exclusion is refused', () => {
  expect(
    hostedLocalSqlViolations({
      sites: [site('orchestrator/src/run/allowed.ts')],
      tables: ['question'],
      allowedFiles: [{ pattern: /allowed\.ts$/ }],
      stateClasses: [hostedQuestion],
    }),
  ).toContainEqual(expect.stringContaining('hosted-only SQL exemption has no reason'))
})

test('selector-gated SQLite adapter importers use the SQL check adapter pattern', () => {
  const selectorGated = sqliteAdapterAllowedImporters.filter(
    (entry) => 'localSqlAllowed' in entry && entry.localSqlAllowed,
  )
  expect(selectorGated).not.toHaveLength(0)
  for (const entry of selectorGated)
    expect(
      HOSTED_LOCAL_SQL_ALLOWED_FILES.some(
        ({ pattern }) => pattern.source === new RegExp(entry.path).source,
      ),
    ).toBe(true)
})
