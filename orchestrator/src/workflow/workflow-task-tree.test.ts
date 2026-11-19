import { expect, test } from 'bun:test'
import { ancestorTaskKeys, descendantTaskKeys } from './workflow-task-tree.ts'

test('parent-key walks stop at a cycle in tracker data', () => {
  const tasks = [
    { key: 'A', parentKey: 'B' },
    { key: 'B', parentKey: 'A' },
    { key: 'C', parentKey: 'A' },
  ]
  expect([...descendantTaskKeys('A', tasks)].sort()).toEqual(['B', 'C'])
  expect(ancestorTaskKeys('A', tasks)).toEqual(['B'])
})
