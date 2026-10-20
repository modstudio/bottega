import { describe, expect, test } from 'bun:test'
import { workflowResolutionSpace } from './workflow-resolution-space.ts'

describe('workflowResolutionSpace', () => {
  test('a project without a hosted route resolves locally', () => {
    expect(workflowResolutionSpace(null)).toBeNull()
  })

  test('a routed project resolves its hosted space even when catalogue rows are missing', () => {
    expect(workflowResolutionSpace('space-a')).toBe('space-a')
  })
})
