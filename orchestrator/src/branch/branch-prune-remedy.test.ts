import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { branchVerdictRemedy } from './branch-prune-remedy.ts'

test('superseded branch remedy archives the branch before deletion', () => {
  expect(branchVerdictRemedy('superseded', 'example', 'DEV-2265-run', 'DEV-2265')).toBe(
    `${PLATFORM_SLUG} tree branch dispose example:DEV-2265-run --reason superseded --note "superseded by <branch>"`,
  )
})
