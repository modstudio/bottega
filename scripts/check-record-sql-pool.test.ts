import { expect, test } from 'bun:test'
import { recordSqlPoolViolations } from './check-record-sql-pool.ts'

test('refuses a per-call record client and names the pool remedy', () => {
  expect(
    recordSqlPoolViolations([
      {
        file: 'orchestrator/src/record/example.ts',
        source: "import { SQL } from 'bun'\nconst client = new SQL(url)\n",
      },
    ]),
  ).toEqual([
    'orchestrator/src/record/example.ts:2: new SQL() is not allowed here; use recordPool(url) from orchestrator/src/record/record-pool.ts',
  ])
})

test('allows only the declared sites in an exempt file', () => {
  expect(
    recordSqlPoolViolations([
      {
        file: 'orchestrator/src/record/record-board-wake.ts',
        source: 'const listener = new SQL(url)',
      },
    ]),
  ).toEqual([])
  expect(
    recordSqlPoolViolations([
      {
        file: 'orchestrator/src/record/record-board-wake.ts',
        source: 'const listener = new SQL(url)\nconst extra = new SQL(url)',
      },
    ]),
  ).toEqual([
    'orchestrator/src/record/record-board-wake.ts:2: new SQL() is not allowed here; use recordPool(url) from orchestrator/src/record/record-pool.ts',
  ])
})
