import { expect, test } from 'bun:test'
import { UNATTRIBUTED } from '../../task-attribution.ts'
import { createNoteRouter } from './note.ts'

const NOTE_ID = '11111111-1111-4111-8111-111111111111'

function recordingRouter() {
  const calls: Array<{ id: string; title?: string }> = []
  const router = createNoteRouter({
    listNotes: (() => []) as never,
    promoteNote: (async (id: string, options?: { title?: string }) => {
      calls.push({ id, title: options?.title })
      return { promoted_task: 'LOC-1' }
    }) as never,
    machineAttribution: (async () => UNATTRIBUTED) as never,
  })
  return { calls, caller: router.createCaller({}) }
}

test('the promote input refuses a missing or blank title before the service runs', async () => {
  const { calls, caller } = recordingRouter()
  await expect(caller.promote({ id: NOTE_ID } as never)).rejects.toThrow(
    'Invalid input: expected string, received undefined',
  )
  await expect(caller.promote({ id: NOTE_ID, title: '   ' })).rejects.toThrow(
    'a promoted task needs a title stating its point',
  )
  expect(calls).toHaveLength(0)
})

test('the promote input hands the service the trimmed title', async () => {
  const { calls, caller } = recordingRouter()
  await caller.promote({ id: NOTE_ID, title: '  Rename the promoted task  ' })
  expect(calls).toEqual([{ id: NOTE_ID, title: 'Rename the promoted task' }])
})
