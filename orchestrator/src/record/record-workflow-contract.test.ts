import { expect, test } from 'bun:test'
import { recordWorkflowPageSchema } from './record-workflow-contract.ts'

const eventRow = {
  id: '01a154c0-0000-7000-8000-000000000001',
  spaceId: '01a154c0-0000-7000-8000-000000000002',
  ownerVersionId: '01a154c0-0000-7000-8000-000000000003',
  event: 'promote',
  author: 'seed',
  reason: 'seeded',
  sessionId: null,
  at: '2026-10-18T12:00:00.000Z',
}

test('an event page from a server without the insertion cursor reads its at as updatedAt', () => {
  const page = recordWorkflowPageSchema('workflow_event').parse({
    items: [eventRow],
    nextCursor: null,
  })
  expect(page.items[0]).toMatchObject({ updatedAt: eventRow.at })
})

test('an event page with the insertion cursor keeps its own updatedAt', () => {
  const page = recordWorkflowPageSchema('workflow_event').parse({
    items: [{ ...eventRow, updatedAt: '2026-10-19T12:00:00.000Z' }],
    nextCursor: null,
  })
  expect(page.items[0]).toMatchObject({ updatedAt: '2026-10-19T12:00:00.000Z' })
})
