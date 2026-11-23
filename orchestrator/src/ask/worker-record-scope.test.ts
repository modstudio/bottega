import { describe, expect, test } from 'bun:test'
import {
  decideWorkerRecordReadScope,
  type WorkerRecordReadTarget,
  type WorkerRecordScopeFacts,
} from './worker-record-scope.ts'

const facts: WorkerRecordScopeFacts = {
  authenticated: true,
  runStatus: 'running',
  runTaskId: 'task-child',
  runTaskKey: 'DEV-2',
  runProjectId: 'project-a',
  runSpaceId: 'space-a',
  allowedTaskIds: ['task-child', 'task-parent'],
  allowedTaskKeys: ['DEV-2', 'DEV-1'],
}
const target: WorkerRecordReadTarget = {
  kind: 'task',
  taskId: 'task-child',
  taskKey: 'DEV-2',
  projectId: 'project-a',
  spaceId: 'space-a',
}

describe('confined worker hosted-record scope', () => {
  test.each([
    ['own task', target],
    ['parent task', { ...target, taskId: 'task-parent', taskKey: 'DEV-1' }],
    ['document on an allowed task', { ...target, kind: 'task-document' as const }],
    ['workflow text attached to an allowed task', { ...target, kind: 'workflow-text' as const }],
  ])('allows %s', (_name, requested) => {
    expect(decideWorkerRecordReadScope(facts, requested)).toEqual({ allowed: true })
  })

  test.each([
    ['missing authentication', { ...facts, authenticated: false }, target, 'not authenticated'],
    ['terminal run', { ...facts, runStatus: 'ok' }, target, 'terminal'],
    ['missing task binding', { ...facts, runTaskId: null }, target, 'does not establish'],
    ['missing project binding', { ...facts, runProjectId: null }, target, 'does not establish'],
    ['missing space binding', { ...facts, runSpaceId: null }, target, 'does not establish'],
    ['foreign space', facts, { ...target, spaceId: 'space-b' }, 'outside'],
    ['foreign project', facts, { ...target, projectId: 'project-b' }, 'outside'],
    ['unrelated task', facts, { ...target, taskId: 'task-other', taskKey: 'DEV-9' }, 'outside'],
    [
      'unattached workflow text',
      facts,
      { ...target, kind: 'workflow-text' as const, taskId: 'task-other', taskKey: 'DEV-9' },
      'outside',
    ],
  ])('refuses %s and names the scope', (_name, input, requested, reason) => {
    const decision = decideWorkerRecordReadScope(input, requested)
    expect(decision).toEqual({
      allowed: false,
      reason: expect.stringContaining(reason),
    })
    if (!decision.allowed) {
      expect(decision.reason).toContain('run task DEV-2')
      expect(decision.reason).toContain('parent chain')
      expect(decision.reason).toContain(input.runSpaceId ?? '(unbound space)')
    }
  })
})
