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

test('refuses Bun.serve options that cannot be inspected inline', () => {
  expect(
    bunServeTimeoutViolationLines(
      'const options = { fetch() {} }\nBun.serve(options)',
      'hub/src/server.ts',
    ),
  ).toEqual([2])
  expect(bunServeTimeoutViolationLines('Bun.serve()', 'hub/src/server.ts')).toEqual([1])
})

test('refuses a value reference to Bun.serve outside a direct call', () => {
  expect(
    bunServeTimeoutViolationLines(
      'const serve = Bun.serve\nserve({ idleTimeout: 75, fetch() {} })',
      'hub/src/server.ts',
    ),
  ).toEqual([1])
})

test('refuses spread options even when the spread may name idleTimeout', () => {
  expect(
    bunServeTimeoutViolationLines(
      'const options = { idleTimeout: 75 }\nBun.serve({ ...options, fetch() {} })',
      'hub/src/server.ts',
    ),
  ).toEqual([2])
})

test('accepts Bun.serve references in type positions', () => {
  expect(
    bunServeTimeoutViolationLines(
      'type Serve = typeof Bun.serve\ntype Server = ReturnType<typeof Bun.serve>',
      'hub/src/server.ts',
    ),
  ).toEqual([])
})

test('ignores test files', () => {
  expect(
    bunServeTimeoutViolationLines('Bun.serve({ fetch() {} })', 'orchestrator/src/example.test.ts'),
  ).toEqual([])
})

test('ignores test directories and spec files', () => {
  expect(
    bunServeTimeoutViolationLines('Bun.serve({ fetch() {} })', 'orchestrator/src/tests/example.ts'),
  ).toEqual([])
  expect(
    bunServeTimeoutViolationLines('Bun.serve({ fetch() {} })', 'orchestrator/src/example.spec.ts'),
  ).toEqual([])
})
