import { describe, expect, test } from 'bun:test'
import type { ToolCaller } from './tracker-list-scope.ts'
import {
  readArrayTaskText,
  readCursorTaskText,
  readWorkspaceTaskText,
  TrackerLookupUnverifiable,
} from './tracker-task-text.ts'

const caller = (reply: (name: string, args: Record<string, unknown>) => unknown): ToolCaller => ({
  callTool: async (name, args) => reply(name, args),
})

describe('tracker task text readers', () => {
  test('workspace prefers markdown beside a structured description and reads comments', async () => {
    const read = await readWorkspaceTaskText(
      caller(() => ({
        id: 'task-1',
        short_id: 'ALEPH-1',
        summary: 'Aleph title',
        description: { type: 'doc', content: [] },
        description_markdown: 'Markdown body',
        comments: [{ content: ' first ' }, { content: '  ' }],
      })),
      'ALEPH-1',
      'get-task-tool',
    )
    expect(read).toEqual({
      externalId: 'task-1',
      key: 'ALEPH-1',
      title: 'Aleph title',
      body: 'Markdown body',
      comments: ['first'],
    })
  })

  test('workspace reads a string description and permits absent comments', async () => {
    const read = await readWorkspaceTaskText(
      caller(() => ({
        id: 'task-2',
        short_id: 'STAR-2',
        summary: 'Star title',
        description: 'String body',
      })),
      'STAR-2',
      'get-task-tool',
    )
    expect(read?.body).toBe('String body')
    expect(read?.comments).toEqual([])
  })

  test('cursor reads comments separately using the get reply entity id', async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const read = await readCursorTaskText(
      caller((name, args) => {
        calls.push([name, args])
        return name === 'task.getByKey'
          ? { success: true, data: { id: 'cursor-id', title: 'Cursor title', description: 'Body' } }
          : { success: true, data: [{ body: ' note ' }, { body: '' }] }
      }),
      'STOP-3',
      'task.getByKey',
      'comment.list',
    )
    expect(read).toEqual({
      externalId: 'cursor-id',
      key: 'STOP-3',
      title: 'Cursor title',
      body: 'Body',
      comments: ['note'],
    })
    expect(calls[1]).toEqual(['comment.list', { entityType: 'task', entityId: 'cursor-id' }])
  })

  test('array selects the case-insensitive matching row', async () => {
    const read = await readArrayTaskText(
      caller(() => [
        { id: 'other', key: 'ADA-8', title: 'Other', description: 'Other body' },
        { id: 'match', key: 'ada-9', title: 'Match', description: 'Matched body' },
      ]),
      'ADA-9',
      'task_list',
    )
    expect(read).toEqual({
      externalId: 'match',
      key: 'ada-9',
      title: 'Match',
      body: 'Matched body',
      comments: [],
    })
  })

  test('missing tasks return null and malformed replies throw', async () => {
    await expect(
      readWorkspaceTaskText(
        caller(() => null),
        'A-1',
        'get',
      ),
    ).resolves.toBeNull()
    await expect(
      readCursorTaskText(
        caller(() => ({ success: true, data: null })),
        'C-1',
        'get',
        'comments',
      ),
    ).resolves.toBeNull()
    await expect(
      readArrayTaskText(
        caller(() => []),
        'R-1',
        'get',
      ),
    ).resolves.toBeNull()
    await expect(
      readArrayTaskText(
        caller(() => ({})),
        'R-1',
        'get',
      ),
    ).rejects.toBeInstanceOf(TrackerLookupUnverifiable)
  })
})
