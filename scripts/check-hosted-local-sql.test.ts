import { expect, test } from 'bun:test'
import { hostedLocalSqlViolations } from './check-hosted-local-sql.ts'
import type { HostedSqlSite } from './hosted-sql-schema.ts'
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
