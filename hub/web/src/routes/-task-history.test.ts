import { expect, test } from 'bun:test'
import type { TaskScreenDetail } from '@/routes/-task-screen-data'
import { taskHistoryEntries } from './-task-history'

const run = (id: string | null, job: string): TaskScreenDetail['runs'][number] => ({
  id,
  source: 'orch',
  agent: null,
  job,
  startedAt: '2026-09-17T10:00:00.000Z',
  endedAt: '2026-09-17T11:00:00.000Z',
  running: false,
})

test('every comment, status change and run becomes one entry with its own id', () => {
  const detail = {
    comments: [
      {
        id: '1',
        body: 'A comment',
        createdAt: '2026-09-17T11:00:00.000Z',
        actorName: 'Person',
        agent: 'codex',
        canEdit: true,
        canDelete: true,
      },
    ],
    statusEvents: [
      {
        id: '1',
        at: '2026-09-17T09:00:00.000Z',
        fromStatus: null,
        toStatus: 'open',
        actorName: 'Person',
        agent: 'codex',
      },
    ],
    runs: [run(null, 'implement'), run(null, 'review'), run('7', 'fix'), run('7', 'fix')],
  } as TaskScreenDetail
  const entries = taskHistoryEntries(detail)
  expect(entries.map((entry) => entry.kind)).toEqual([
    'comment',
    'status',
    'run',
    'run',
    'run',
    'run',
  ])
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length)
  expect(entries[0]).toMatchObject({
    actor: 'Person',
    agent: 'codex',
    canEdit: true,
    canDelete: true,
  })
  expect(entries[1]).toMatchObject({ actor: 'Person', agent: 'codex' })
  expect(entries[2]).toMatchObject({ actor: null })
})
