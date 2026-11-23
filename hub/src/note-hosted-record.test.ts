import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { decodeHostedNoteRevision, sendHostedRepeatSighting } from './note-hosted-record.ts'
import { getNote } from './note-read.ts'
import type { HostedPushChange } from './push-contract.ts'

test('hosted note revisions decode from integer wire values', () => {
  expect(decodeHostedNoteRevision('workshop#3', '3')).toBe(3)
  expect(decodeHostedNoteRevision('workshop#3', 3)).toBe(3)
  for (const value of ['x', -1, '1.5'])
    expect(() => decodeHostedNoteRevision('workshop#3', value)).toThrow(
      `note workshop#3 has invalid hosted revision ${JSON.stringify(value)}; run \`${PLATFORM_SLUG} record doctor\`, then retry`,
    )
})

test('a hosted read reports an invalid revision with one remedy', async () => {
  const id = '01990000-0000-7000-8000-000000002571'
  const remedy = `run \`${PLATFORM_SLUG} record doctor\`, then retry`
  const options = {
    baseUrl: 'https://hub.example.test',
    token: 'test',
    fetch: async (input: string) =>
      new URL(input).pathname === '/v1/tasks/identity'
        ? Response.json({
            userId: 'user-1',
            activeSpaceId: 'space-a',
            memberships: [],
            capabilities: { targetSpaceNotes: true },
          })
        : Response.json({
            id,
            number: 4,
            project: 'workshop',
            text: 'Hosted note',
            area: null,
            anchors: '[]',
            sightings: 1,
            created_at: '2026-11-21T12:00:00.000Z',
            last_seen_at: '2026-11-21T12:00:00.000Z',
            stale_at: null,
            stale_reason: null,
            promoted_task: null,
            revision: 'x',
          }),
  }

  let failure: unknown
  try {
    await getNote(id, options)
  } catch (cause) {
    failure = cause
  }
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe(
    `note workshop#4 has invalid hosted revision "x"; ${remedy}`,
  )
})

test('a hosted same write sends a decoded numeric revision', async () => {
  const id = '01990000-0000-7000-8000-000000002570'
  const at = '2026-11-21T12:00:00.000Z'
  const pushed: HostedPushChange[] = []
  const options = {
    baseUrl: 'https://hub.example.test',
    token: 'test',
    recordSpace: 'space-a',
    fetch: async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname
      if (path === '/v1/tasks/identity')
        return Response.json({
          userId: 'user-1',
          activeSpaceId: 'space-a',
          memberships: [{ spaceId: 'space-a', slug: 'workshop', permission: 'write' }],
          capabilities: {
            spacePush: true,
            spacePushTables: ['hub_note'],
            targetSpaceNotes: true,
          },
        })
      if (path === `/v1/notes/${id}`)
        return Response.json({
          id,
          number: 3,
          project: 'workshop',
          project_name: 'workshop',
          text: 'Hosted note',
          area: null,
          anchors: '[]',
          sightings: 1,
          created_at: at,
          last_seen_at: at,
          stale_at: null,
          stale_reason: null,
          promoted_task: null,
          updated_at: at,
          deleted_at: null,
          revision: '3',
        })
      if (path === '/v1/changes') {
        const changes = JSON.parse(String(init?.body)) as HostedPushChange[]
        pushed.push(...changes)
        return Response.json(
          changes.map(({ id: changeId }) => ({ id: changeId, status: 'applied' })),
        )
      }
      return Response.json({ error: 'unexpected route' }, { status: 500 })
    },
  }
  const note = await getNote(id, options)

  await sendHostedRepeatSighting(
    note,
    {
      id: crypto.randomUUID(),
      cwd: '/fixtures/repos/workshop',
      project: 'workshop',
      files: [],
      run_record_id: null,
      branch: null,
      commit: null,
      session_id: 'session-a',
    },
    at,
    options,
  )

  expect(pushed).toHaveLength(1)
  expect(pushed[0]).toMatchObject({ table: 'hub_note', expected_revision: 3 })
  expect(typeof pushed[0]?.expected_revision).toBe('number')
})
