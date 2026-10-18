import { describe, expect, test } from 'bun:test'
import { workflowResolutionSpace } from './workflow-resolution-space.ts'

describe('workflowResolutionSpace', () => {
  test('a routed project with an empty space resolves locally', () => {
    expect(
      workflowResolutionSpace({
        routedSpaceId: 'space-a',
        hostedHasProductionCatalogue: false,
        hostedHasSelectedWorkflow: false,
      }),
    ).toBeNull()
  })

  test('a space holding the catalogue but not the requested workflow resolves locally', () => {
    expect(
      workflowResolutionSpace({
        routedSpaceId: 'space-a',
        hostedHasProductionCatalogue: true,
        hostedHasSelectedWorkflow: false,
      }),
    ).toBeNull()
  })

  test('a space holding the catalogue and requested workflow resolves hosted', () => {
    expect(
      workflowResolutionSpace({
        routedSpaceId: 'space-a',
        hostedHasProductionCatalogue: true,
        hostedHasSelectedWorkflow: true,
      }),
    ).toBe('space-a')
  })
})
