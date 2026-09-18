import { describe, expect, test } from 'bun:test'
import { taskBranchLandingBypassWarning } from './dispatch-cli-service.ts'

describe('task branch landing bypass warning', () => {
  test('refusal-text mutation: explicit base success does not print a refusal', () => {
    const warning = taskBranchLandingBypassWarning('DEV-750', 'feature/DEV-750', {
      action: 'refuse',
      reason: 'targeted listing was truncated',
      branch: 'feature/old-DEV-750',
      tip: 'abc123',
    })

    expect(warning).not.toContain('refusing')
    expect(warning).toContain('used as given')
  })
})
