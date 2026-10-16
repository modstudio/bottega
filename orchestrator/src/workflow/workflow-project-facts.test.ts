import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { WorkflowAutonomyResolution } from './autonomy.ts'
import { resolveWorkflowProjectFacts } from './workflow-project-facts.ts'

const autonomy: WorkflowAutonomyResolution = {
  steps: {},
  rulings: { value: 'user', scope: 'test' },
  shipTo: { value: 'trunk', scope: 'test' },
}

describe('workflow project facts', () => {
  test('exposes a declared generated reference', () => {
    const reference = {
      directory: 'docs/reference',
      publish: `${PLATFORM_SLUG} doc reference publish`,
    }
    const { facts } = resolveWorkflowProjectFacts(
      { name: 'fixture', stack: 'bun', settings: { reference } },
      ['reference'],
      false,
      {},
      autonomy,
    )

    expect(facts).toEqual({ reference })
  })

})
