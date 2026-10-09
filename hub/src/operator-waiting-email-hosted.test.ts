import { expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../shared/brand.ts'
import { operatorWaitingEmailApi } from './operator-waiting-email-api.ts'
import {
  decideOperatorWaitingEmailReclaim,
  OPERATOR_EMAIL_INTENT_STALE_MS,
  OPERATOR_EMAIL_MAX_ATTEMPTS,
  type OperatorWaitingEmailInput,
  renderOperatorWaitingEmail,
} from './operator-waiting-email-hosted.ts'

const input: OperatorWaitingEmailInput = {
  kind: 'question',
  item_id: 7,
  episode: 'episode-1',
  project: PLATFORM_NAME.toLowerCase(),
  task_key: 'DEV-943',
  question: 'Should this be enabled?',
  options: ['Enable it', 'Disable it'],
  recommendation: 'Enable it',
  why: 'The operator asked for email.',
  waiting_since: '2026-09-25T10:00:00.000Z',
  link: 'http://127.0.0.1:7778/inbox/question/7',
  answer_command: 'orch answer 42 --q7 --from-operator "<ruling>"',
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
    { ...input, project: null, task_key: null },
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
  const config = {
    recordApiUrl: 'https://record.example.test',
    recordDatabaseUrl: 'postgres://record',
  }
  expect(await (await operatorWaitingEmailApi(request, config, dependencies))!.json()).toEqual({
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
