import { expect, test } from 'bun:test'
import { CHECK_LEGS, legIsolatesTests } from './check-plan.ts'
import { testIsolationViolation, testIsolationViolations } from './check-test-isolation.ts'

const hubLeg = CHECK_LEGS.find(legIsolatesTests)!

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

test('refuses a plan with no isolated test leg', () => {
  const unmarkedLegs = CHECK_LEGS.map((leg) => {
    const { isolateTests: _, ...unmarked } = leg as typeof leg & { isolateTests?: true }
    return unmarked
  }) as unknown as typeof CHECK_LEGS
  expect(testIsolationViolations(unmarkedLegs, {})).toEqual([
    'scripts/check-plan.ts: no CHECK_LEGS leg is marked isolateTests; mark the hub leg isolateTests: true',
  ])
})

test('refuses an unmarked leg whose test script carries the flag', () => {
  expect(
    testIsolationViolations(CHECK_LEGS, {
      hub: { scripts: { test: 'bun test --isolate' } },
      'hub/data': { scripts: { test: 'bun test --isolate' } },
    }),
  ).toEqual([
    'hub/data/package.json: scripts.test carries --isolate but CHECK_LEGS does not mark "hub/data" isolateTests; mark that leg isolateTests: true',
  ])
})
