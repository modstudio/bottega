import { expect, test } from 'bun:test'
import { workflowReadSpace } from './project-space.ts'

test('workflow reads choose a project route when a project is present', () => {
  expect(
    workflowReadSpace({
      project: 'routed-project',
      projectSpace: 'project-space',
      activeSpace: 'active-space',
    }),
  ).toBe('project-space')
})

test('workflow reads choose the active record space without a project', () => {
  expect(
    workflowReadSpace({
      project: null,
      projectSpace: null,
      activeSpace: 'active-space',
    }),
  ).toBe('active-space')
  expect(workflowReadSpace({ project: null, projectSpace: null, activeSpace: null })).toBeNull()
})
