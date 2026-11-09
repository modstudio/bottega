import { describe, expect, test } from 'bun:test'
import { missingTaskLine, missingTaskMessage } from '../../../shared/task-missing.ts'
import type { Project } from '../project/projects.ts'
import {
  classifyHubTaskLookup,
  readTaskText,
  trackerLookupFailureCondition,
} from './task-key-lookup.ts'

describe('built-in task-key lookup output', () => {
  test('classifies hub exact not-found output as established absence', () => {
    expect(classifyHubTaskLookup('DEV-99999', 1, '', missingTaskMessage('DEV-99999'))).toEqual({
      state: 'not-found',
    })
  })

  test("does not classify another task's missing line as this task's absence", () => {
    expect(classifyHubTaskLookup('DEV-12', 1, '', missingTaskMessage('DEV-1'))).toEqual({
      state: 'unreachable',
      condition: missingTaskLine('DEV-1'),
    })
  })

  test('does not infer absence from other failed output', () => {
    expect(classifyHubTaskLookup('DEV-99999', 1, '', 'tracker database is unavailable\n')).toEqual({
      state: 'unreachable',
      condition: 'tracker database is unavailable',
    })
  })

  test('redacts an MCP environment credential from a thrown lookup error', () => {
    const credential = 'sentinel-environment-credential'
    const condition = trackerLookupFailureCondition(new Error(`remote rejected ${credential}`), {
      name: 'fixture',
      env: { TRACKER_TOKEN: credential },
    })

    expect(condition).toBe('tracker lookup failed: remote rejected [redacted]')
    expect(condition).not.toContain(credential)
  })
})

test('reads external task text and resolves its project-scoped mirror record', async () => {
  const project = {
    recordId: 'project-id',
    name: 'remote-project',
    path: '/remote-project',
    stack: null,
    canon: false,
    retiredAt: null,
    settings: { tracker: { protocol: 'array-mcp', envPrefix: 'REMOTE', openStatuses: [] } },
  } as Project
  const result = await readTaskText(project, 'SHARED-7', {
    toolCaller: {
      callTool: async () => [
        {
          id: 'external-id',
          key: 'SHARED-7',
          title: 'Remote title',
          description: 'Remote body',
        },
      ],
    },
    hubTaskReader: async (projectName) => [
      { key: 'SHARED-7', record_id: 'mirror-id', project: projectName },
    ],
  })
  expect(result).toEqual({
    available: true,
    recordId: 'mirror-id',
    key: 'SHARED-7',
    title: 'Remote title',
    body: 'Remote body',
    comments: [],
  })
})
