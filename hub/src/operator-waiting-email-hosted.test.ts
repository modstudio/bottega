import { expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../shared/brand.ts'
import { hostedRouteTestConfig } from '../test/hosted-route-fixture.ts'
import { operatorWaitingEmailApi } from './operator-waiting-email-api.ts'
import { operatorWaitingEmailRequestSchema } from './operator-waiting-email-contract.ts'
import {
  claimOperatorWaitingEmail,
  decideOperatorWaitingEmailReclaim,
  OPERATOR_EMAIL_INTENT_STALE_MS,
  OPERATOR_EMAIL_MAX_ATTEMPTS,
  type OperatorWaitingEmailInput,
  renderOperatorWaitingEmail,
} from './operator-waiting-email-hosted.ts'

const input: OperatorWaitingEmailInput = {
  kind: 'question',
  item_id: 7,
  item_record_id: '01990000-0000-7000-8000-000000000007',
  episode: 'episode-1',
  project: PLATFORM_NAME.toLowerCase(),
  task_key: 'DEV-943',
  task_id: '01990000-0000-7000-8000-000000000943',
  question: 'Should this be enabled?',
  options: ['Enable it', 'Disable it'],
  recommendation: 'Enable it',
  why: 'The operator asked for email.',
  waiting_since: '2026-09-25T10:00:00.000Z',
  link: 'http://127.0.0.1:7778/inbox/question/7',
  answer_command: `${PLATFORM_SLUG} question answer 42 --q7 --from-operator "<ruling>"`,
}

test('rendered HTML contains the decision and obeys email CSS rules', () => {
  const rendered = renderOperatorWaitingEmail(input, new Date('2026-09-25T11:00:00.000Z'))
  expect(rendered.html).toContain(input.question)
  expect(rendered.html).toContain('Enable it (recommended)')
  expect(rendered.html).toContain(input.link)
  expect(rendered.html).toContain('<meta charset="utf-8">')
  expect(rendered.html).not.toMatch(/display:\s*(flex|grid)|var\(--/i)
})

test('a no-project waiting item renders without a project placeholder', () => {
  const rendered = renderOperatorWaitingEmail(
    { ...input, project: null, task_key: null, task_id: null },
    new Date('2026-09-25T11:00:00.000Z'),
  )
  expect(rendered.subject).toBe('Waiting on you: question')
  expect(rendered.text).toContain(input.question)
})

test('reclaim decision bounds attempts and leaves a fresh intent in flight', () => {
  const now = new Date('2026-09-25T12:00:00.000Z')
  const row = {
    id: 'intent-1',
    status: 'intent' as const,
    reason: null,
    attempts: 1,
    updated_at: new Date(now.getTime() - OPERATOR_EMAIL_INTENT_STALE_MS + 1).toISOString(),
  }
  expect(decideOperatorWaitingEmailReclaim(row, now)).toBe('return')
  expect(
    decideOperatorWaitingEmailReclaim(
      {
        ...row,
        updated_at: new Date(now.getTime() - OPERATOR_EMAIL_INTENT_STALE_MS).toISOString(),
      },
      now,
    ),
  ).toBe('reclaim')
  expect(decideOperatorWaitingEmailReclaim({ ...row, status: 'failed' }, now)).toBe('reclaim')
  expect(
    decideOperatorWaitingEmailReclaim(
      { ...row, status: 'failed', attempts: OPERATOR_EMAIL_MAX_ATTEMPTS },
      now,
    ),
  ).toBe('abandon')
  expect(decideOperatorWaitingEmailReclaim({ ...row, status: 'sent' }, now)).toBe('return')
})

test('hosted endpoint binds space and user from the credential', async () => {
  const callers: Array<{ userId: string; spaceId: string }> = []
  const send: typeof import('./operator-waiting-email-hosted.ts').sendOperatorWaitingEmail = async (
    _databaseUrl,
    caller,
  ) => {
    callers.push(caller)
    return { id: 'intent-1', status: 'sent', reason: null }
  }
  const dependencies = {
    fetch: (async () =>
      Response.json({
        user: { id: '01990000-0000-7000-8000-000000000701' },
        activeSpaceId: '01990000-0000-7000-8000-00000000070a',
        memberships: [
          {
            space_id: '01990000-0000-7000-8000-00000000070a',
            slug: 'active',
            permission: 'write',
          },
        ],
      })) as unknown as typeof fetch,
    mail: { send: async () => undefined },
    send,
  }
  const request = new Request('https://hub.example.test/v1/operator-waiting-emails', {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  expect(
    await (await operatorWaitingEmailApi(request, hostedRouteTestConfig, dependencies))!.json(),
  ).toEqual({
    id: 'intent-1',
    status: 'sent',
    reason: null,
  })
  expect(callers).toEqual([
    {
      userId: '01990000-0000-7000-8000-000000000701',
      spaceId: '01990000-0000-7000-8000-00000000070a',
    },
  ])
})

test('an older waiting-email body defaults omitted UUIDs to null', () => {
  const older = { ...input } as Partial<typeof input>
  delete older.task_id
  delete older.item_record_id
  expect(operatorWaitingEmailRequestSchema.parse(older)).toMatchObject({
    task_id: null,
    item_record_id: null,
  })
})

test('claim uses the item UUID when present and the local label only for an older client', async () => {
  type Intent = {
    id: string
    status: 'sent'
    reason: null
    attempts: number
    updated_at: string
  }
  const intents = new Map<string, Intent>()
  const query = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join('?')
    if (statement === '?::jsonb') return { sql: statement, values }
    if (statement.includes('pg_advisory_xact_lock')) return Promise.resolve([])
    if (statement.includes('SELECT id,status,reason,attempts,updated_at')) {
      const itemRecordId = values[4] as string | null
      const key = itemRecordId ?? `label:${String(values[6])}`
      const existing = intents.get(key)
      return Promise.resolve(existing ? [existing] : [])
    }
    if (statement.includes('SELECT count(*)::int AS count')) return Promise.resolve([{ count: 0 }])
    if (statement.includes('WITH inserted AS')) {
      const itemRecordId = values[5] as string | null
      const key = itemRecordId ?? `label:${String(values[4])}`
      const intent: Intent = {
        id: String(values[0]),
        status: 'sent',
        reason: null,
        attempts: 1,
        updated_at: String(values[17]),
      }
      intents.set(key, intent)
      return Promise.resolve([{ ...intent, email: 'operator@example.test' }])
    }
    throw new Error(`unexpected SQL in claim fixture: ${statement}`)
  }
  const tx = query as unknown as SQL
  const caller = {
    spaceId: '01990000-0000-7000-8000-000000000701',
    userId: '01990000-0000-7000-8000-000000000702',
  }
  const now = new Date('2026-09-25T11:00:00.000Z')
  const firstRecordId = '01990000-0000-7000-8000-000000000711'
  const secondRecordId = '01990000-0000-7000-8000-000000000712'
  const withoutTask = { ...input, task_key: null, task_id: null }

  await claimOperatorWaitingEmail(
    tx,
    caller,
    { ...withoutTask, item_record_id: firstRecordId },
    now,
  )
  await claimOperatorWaitingEmail(
    tx,
    caller,
    { ...withoutTask, item_record_id: secondRecordId },
    now,
  )
  const olderFirst = await claimOperatorWaitingEmail(
    tx,
    caller,
    { ...withoutTask, item_record_id: null },
    now,
  )
  const olderAgain = await claimOperatorWaitingEmail(
    tx,
    caller,
    { ...withoutTask, item_record_id: null },
    now,
  )

  expect([...intents.keys()]).toEqual([firstRecordId, secondRecordId, 'label:7'])
  expect(olderAgain.id).toBe(olderFirst.id)
  expect(olderAgain.action).toBe('return')
})
