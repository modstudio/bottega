import { describe, expect, test } from 'bun:test'
import {
  createTrackerTask, type ToolCaller, type TrackerProject,
} from '../../../shared/trackers.ts'

const task = { title: 'Move the adapter', body: 'Protocol-neutral body', status: 'todo' }

const project = (name: string, protocol?: string): TrackerProject => ({
  name,
  settings: protocol ? {
    tracker: {
      protocol,
      envPrefix: 'FIXTURE',
      openStatuses: ['todo'],
      states: { todo: 'open', done: 'done' },
    },
  } : {},
})

const fixtureCaller = () => {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const caller: ToolCaller = {
    async callTool(name, args) {
      calls.push({ name, args })
      return { key: 'ADN-1' }
    },
  }
  return { caller, calls }
}

describe('tracker create protocols', () => {
  test('array-mcp uses its underscored tool and evidenced payload', async () => {
    const fixture = fixtureCaller()

    expect(await createTrackerTask(fixture.caller, project('adanim', 'array-mcp'), task))
      .toEqual({ key: 'ADN-1' })
    expect(fixture.calls).toEqual([{
      name: 'task_create',
      args: {
        title: 'Move the adapter',
        description: 'Protocol-neutral body',
        status: 'todo',
      },
    }])
  })

  test('workspace-mcp refuses its incompatible evidenced status fields', async () => {
    const fixture = fixtureCaller()

    await expect(createTrackerTask(fixture.caller, project('starship', 'workspace-mcp'), task))
      .rejects.toThrow('workspace-mcp create refused: the status field differs')
    expect(fixture.calls).toEqual([])
  })

  test('cursor-mcp refuses the required field absent from the register', async () => {
    const fixture = fixtureCaller()

    await expect(createTrackerTask(fixture.caller, project('stopal', 'cursor-mcp'), task))
      .rejects.toThrow('cursor-mcp create refused: required projectId')
    expect(fixture.calls).toEqual([])
  })

  test('a project with no tracker refuses and names the project', async () => {
    const fixture = fixtureCaller()

    await expect(createTrackerTask(fixture.caller, project('untracked'), task))
      .rejects.toThrow('project untracked has no tracker configured')
    expect(fixture.calls).toEqual([])
  })

  test('an unsupported protocol refuses instead of silently succeeding', async () => {
    const fixture = fixtureCaller()

    await expect(createTrackerTask(fixture.caller, project('future', 'future-mcp'), task))
      .rejects.toThrow('tracker protocol future-mcp has no create support')
    expect(fixture.calls).toEqual([])
  })
})
