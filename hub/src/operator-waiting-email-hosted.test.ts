import { expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../shared/brand.ts'
import { hostedRouteTestConfig } from '../test/hosted-route-fixture.ts'
import { operatorWaitingEmailApi } from './operator-waiting-email-api.ts'
import {
  decideOperatorWaitingEmailReclaim,
  OPERATOR_EMAIL_INTENT_STALE_MS,
  OPERATOR_EMAIL_MAX_ATTEMPTS,
  type OperatorWaitingEmailInput,
  renderOperatorWaitingEmail,
  sendOperatorWaitingEmail,
} from './operator-waiting-email-hosted.ts'

const input: OperatorWaitingEmailInput = {
  kind: 'question',
  item_id: 7,
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

function waitingEmailSql(hostedTask: { id: string; spaceId: string } | null) {
  let storedTaskId: unknown
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const source = parts.join('?')
    if (source.includes('SELECT count(*)::int AS count')) return [{ count: 0 }]
    if (source.includes('SELECT id::text AS id FROM hub_task')) {
      return hostedTask && hostedTask.spaceId === values[0] && hostedTask.id === values[1]
        ? [{ id: hostedTask.id }]
        : []
    }
    if (source.includes('WITH inserted AS')) {
      storedTaskId = values[8]
      return [
        {
          id: '01990000-0000-7000-8000-000000000777',
          user_id: values[2],
          status: 'intent',
          reason: null,
          email: 'operator@example.test',
        },
      ]
    }
    if (source.includes('UPDATE operator_waiting_email SET status=')) {
      return [{ id: values[3], status: values[0], reason: values[1] }]
    }
    return []
  }) as unknown as SQL
  const sql = Object.assign(tx, {
    begin: async (work: (transaction: SQL) => unknown) => work(tx),
  }) as unknown as SQL
  return { sql, storedTaskId: () => storedTaskId }
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

test.each([
  [
    'a same-space task',
    input.task_id,
    { id: input.task_id!, spaceId: '01990000-0000-7000-8000-00000000070a' },
  ],
  ['an absent task', null, null],
  [
    'a task in another space',
    null,
    { id: input.task_id!, spaceId: '01990000-0000-7000-8000-00000000070b' },
  ],
] as const)(
  'the hosted waiting-email edge stores the resolved UUID for %s',
  async (_label, expected, task) => {
    const database = waitingEmailSql(task)
    const caller = {
      userId: '01990000-0000-7000-8000-000000000701',
      spaceId: '01990000-0000-7000-8000-00000000070a',
    }
    expect(
      await sendOperatorWaitingEmail(database.sql, caller, input, {
        mail: { send: async () => undefined },
        now: new Date('2026-09-25T11:00:00.000Z'),
      }),
    ).toMatchObject({ status: 'sent' })
    expect(database.storedTaskId()).toBe(expected)
  },
)
