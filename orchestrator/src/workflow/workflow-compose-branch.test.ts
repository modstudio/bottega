import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type LandingBranchFacts, landingBranchRefusal } from './workflow-compose-branch.ts'

const facts = (overrides: Partial<LandingBranchFacts> = {}): LandingBranchFacts => ({
  workflow: 'ship-task',
  branch: 'DEV-1-built',
  landingBranch: 'main',
  commitsPastLanding: 0,
  ...overrides,
})

test('a landing workflow refuses a branch the landing branch already contains', () => {
  expect(landingBranchRefusal(facts())).toBe(
    'refusing to compose ship-task for branch DEV-1-built: it has no commits past main, and ' +
      `ship-task lands a built branch; build the change first with \`${PLATFORM_SLUG} run start implement --key <key>\``,
  )
})

test('a landing workflow composes a branch that carries commits past the landing branch', () => {
  expect(landingBranchRefusal(facts({ commitsPastLanding: 3 }))).toBeNull()
})

test('an unread commit count never refuses a composition', () => {
  expect(landingBranchRefusal(facts({ commitsPastLanding: null }))).toBeNull()
})

test('a workflow that builds its own branch is never refused', () => {
  expect(landingBranchRefusal(facts({ workflow: 'plan-task', commitsPastLanding: 0 }))).toBeNull()
})
