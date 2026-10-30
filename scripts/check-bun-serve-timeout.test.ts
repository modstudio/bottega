import { expect, test } from 'bun:test'
import { bunServeTimeoutViolationLines } from './check-bun-serve-timeout.ts'

test('accepts a Bun server with an explicit idle timeout', () => {
  expect(
    bunServeTimeoutViolationLines(
      'Bun.serve({ idleTimeout: 75, fetch() {} })',
      'hub/src/server.ts',
    ),
  ).toEqual([])
})

test('refuses a Bun server without an explicit idle timeout', () => {
  expect(bunServeTimeoutViolationLines('Bun.serve({ fetch() {} })', 'hub/src/server.ts')).toEqual([
    1,
  ])
})

test('ignores test files', () => {
  expect(
    bunServeTimeoutViolationLines('Bun.serve({ fetch() {} })', 'orchestrator/src/example.test.ts'),
  ).toEqual([])
})
