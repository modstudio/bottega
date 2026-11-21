import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { recordQuestionClient } from './record-api-client-question.ts'

function clientReturning(body: unknown) {
  return recordQuestionClient(async (_path, init) => {
    if (!init?.schema) throw new Error('fixture expected a response schema')
    return init.schema(body)
  })
}

test('open-for-session refuses rows from a hosted API without step_actions', async () => {
  const client = clientReturning({ items: [{ workflow_slug: 'ship-task' }] })
  await expect(
    client.readQuestions!({ read: 'open-for-session', sessionId: 'session-1' }),
  ).rejects.toThrow(`${PLATFORM_SLUG} release run --rung hosted-api ${PLATFORM_SLUG}`)
})

test('open-for-session parses rows whose step_actions are string arrays', async () => {
  const body = {
    items: [{ workflow_slug: 'ship-task', step_actions: ['pr-create', 'pr-merge'] }],
  }
  const client = clientReturning(body)
  expect(
    await client.readQuestions!({ read: 'open-for-session', sessionId: 'session-1' }),
  ).toEqual(body)
})
