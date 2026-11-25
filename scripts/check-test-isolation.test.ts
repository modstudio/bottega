import { expect, test } from 'bun:test'
import { testIsolationViolation } from './check-test-isolation.ts'

const hubLeg = { directory: 'hub', isolateTests: true } as const

test('refuses an isolated leg whose test script omits the flag', () => {
  expect(testIsolationViolation(hubLeg, { scripts: { test: 'bun test' } })).toBe(
    'hub/package.json: CHECK_LEGS marks "hub" isolateTests; add --isolate to scripts.test',
  )
})

test('accepts an isolated leg whose test script carries the flag', () => {
  expect(
    testIsolationViolation(hubLeg, {
      scripts: { test: "bun test --isolate --path-ignore-patterns 'data/**'" },
    }),
  ).toBeUndefined()
})
