import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  resolveHubTaskReference,
  resolveOrPullHubTaskReference,
  taskPullFailureNamesMissingTask,
  taskReadRefusal,
  taskReferenceFromShow,
} from './workflow-task-reference.ts'

test('fresh task reads preserve whether tracker comment ids were verifiable', () => {
  const task = { key: 'DEV-1', record_id: 'task-1', project: 'alpha' }
  expect(
    taskReferenceFromShow({ task, tracker_comment_ids: [], tracker_comments_verifiable: false }),
  ).toMatchObject({ commentsVerifiable: false, commentIds: [] })
  expect(
    taskReferenceFromShow({
      task: { ...task },
      tracker_comment_ids: ['4'],
      tracker_comments_verifiable: true,
    }),
  ).toMatchObject({ commentsVerifiable: true, commentIds: ['4'] })
})

test('resolves a shared key only within the workflow project', async () => {
  const reader = async (project: string) => [
    { key: 'SHARED-42', record_id: `task-${project}`, project },
  ]

  await expect(resolveHubTaskReference('alpha', 'SHARED-42', reader)).resolves.toMatchObject({
    record_id: 'task-alpha',
  })
  await expect(resolveHubTaskReference('beta', 'SHARED-42', reader)).resolves.toMatchObject({
    record_id: 'task-beta',
  })
  await expect(resolveHubTaskReference(null, 'SHARED-42', reader)).resolves.toBeNull()
})

test('task-list refusals withhold secret-shaped child-process detail', () => {
  const refusal = taskReadRefusal('beta', 'tracker failed: token=super-secret')

  expect(refusal.message).toContain('tracker failed: [withheld: assignment]')
  expect(refusal.message).not.toContain('super-secret')
  expect(refusal.message).toContain('task list --project beta --json')
})

test('resolved task refreshes only after a mirror miss', async () => {
  const mirrored = { key: 'DEV-1', record_id: 'mirror-id', project: 'alpha' }
  const pulled = { key: 'DEV-2', record_id: 'pull-id', project: 'alpha' }
  const pulls: string[] = []
  const lookup = async (_project: string, key: string) => (key === mirrored.key ? mirrored : null)
  const puller = async (_project: string, key: string) => {
    pulls.push(key)
    return key === pulled.key ? pulled : null
  }

  await expect(resolveOrPullHubTaskReference('alpha', mirrored.key, lookup, puller)).resolves.toBe(
    mirrored,
  )
  expect(pulls).toEqual([])
  await expect(resolveOrPullHubTaskReference('alpha', pulled.key, lookup, puller)).resolves.toBe(
    pulled,
  )
  expect(pulls).toEqual([pulled.key])
})

test('fresh task failures and absent tasks have distinct actionable refusals', async () => {
  const lookup = async () => null
  await expect(
    resolveOrPullHubTaskReference('alpha', 'DEV-2', lookup, async () => {
      throw new Error('tracker token=super-secret')
    }),
  ).rejects.toThrow(
    `could not read task data for project alpha: tracker [withheld: assignment]; retry: ${PLATFORM_SLUG} task show DEV-2 --project alpha --fresh --json`,
  )
  await expect(
    resolveOrPullHubTaskReference('alpha', 'DEV-3', lookup, async () => null),
  ).rejects.toThrow(
    `no task DEV-3 in project alpha; inspect available tasks with ${PLATFORM_SLUG} task list --project alpha --json`,
  )
})

test('classifies only a pull failure whose canonical missing-task line names the requested key', () => {
  expect(taskPullFailureNamesMissingTask(new Error('no task DEV-2'), 'DEV-2')).toBe(true)
  expect(taskPullFailureNamesMissingTask(new Error('no task DEV-3'), 'DEV-2')).toBe(false)
  expect(taskPullFailureNamesMissingTask(new Error('tracker unavailable'), 'DEV-2')).toBe(false)
})

test('refuses a fresh task identity that differs from the requested key or project', async () => {
  const lookup = async () => null
  await expect(
    resolveOrPullHubTaskReference('alpha', 'DEV-2', lookup, async () => ({
      key: 'DEV-3',
      record_id: 'wrong-key',
      project: 'alpha',
    })),
  ).rejects.toThrow('fresh task read returned')
  await expect(
    resolveOrPullHubTaskReference('alpha', 'DEV-2', lookup, async () => ({
      key: 'DEV-2',
      record_id: 'wrong-project',
      project: 'beta',
    })),
  ).rejects.toThrow('fresh task read returned')
})
