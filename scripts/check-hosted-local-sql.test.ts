import { expect, test } from 'bun:test'
import { HOSTED_LOCAL_SQL_ALLOWED_FILES } from '../orchestrator/src/database/hosted-table-guard.ts'
import { sqliteAdapterAllowedImporters } from './architecture-boundaries.ts'
import { hostedLocalRenderedSqlRisk, hostedLocalSqlViolations } from './check-hosted-local-sql.ts'
import {
  extractSqlFromSource,
  type HostedSqlSite,
  type HostedSqlUnresolvedSite,
} from './hosted-sql-schema.ts'
import type { StateClassDeclaration } from './identity-state-classes.ts'

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
      allowedFiles: [{ pattern: /question-store-sqlite\.ts$/, reason: 'local adapter' }],
      stateClasses: [hostedQuestion],
    }),
  ).toEqual([])
})

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
  ).toEqual({ sites: [], unresolved: [] })
})

test('an allowed file with no hosted-only or unresolved SQL is rejected as unused', () => {
  expect(
    hostedLocalSqlViolations({
      sites: [],
      tables: ['question'],
      allowedFiles: [{ pattern: /unused\.ts$/, reason: 'fixture exemption' }],
      stateClasses: [hostedQuestion],
    }),
  ).toEqual([expect.stringContaining('unused hosted-only SQL exemption /unused\\.ts$/')])
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
