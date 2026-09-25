import { expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../shared/brand.ts'
import { operatorWaitingEmailApi } from './operator-waiting-email-api.ts'
import {
  type OperatorWaitingEmailInput,
  renderOperatorWaitingEmail,
} from './operator-waiting-email-hosted.ts'
import type { ReportMailClient } from './report-delivery.ts'

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

test('hosted endpoint authenticates and returns an existing status without sending twice', async () => {
  const sent: string[] = []
  const intents = new Map<string, { id: string; status: 'sent'; reason: null }>()
  const mail: ReportMailClient = { send: async () => void sent.push('mail') }
  const send: typeof import('./operator-waiting-email-hosted.ts').sendOperatorWaitingEmail = async (
    _databaseUrl: string,
    caller: { userId: string; spaceId: string },
    body: OperatorWaitingEmailInput,
    options = {},
  ) => {
    const key = `${caller.spaceId}:${caller.userId}:${body.kind}:${body.item_id}:${body.episode}`
    const existing = intents.get(key)
    if (existing) return existing
    await options.mail?.send({} as never)
    const result = { id: 'intent-1', status: 'sent' as const, reason: null }
    intents.set(key, result)
    return result
  }
  const dependencies = {
    fetch: (async () =>
      Response.json({
        user: { id: '01990000-0000-7000-8000-000000000701' },
        activeSpaceId: '01990000-0000-7000-8000-00000000070a',
        memberships: [],
      })) as unknown as typeof fetch,
    mail,
    send,
  }
  const request = () =>
    new Request('https://hub.example.test/v1/operator-waiting-emails', {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  const config = {
    recordApiUrl: 'https://record.example.test',
    recordDatabaseUrl: 'postgres://record',
  }
  expect(await (await operatorWaitingEmailApi(request(), config, dependencies))!.json()).toEqual({
    id: 'intent-1',
    status: 'sent',
    reason: null,
  })
  expect(await (await operatorWaitingEmailApi(request(), config, dependencies))!.json()).toEqual({
    id: 'intent-1',
    status: 'sent',
    reason: null,
  })
  expect(sent).toEqual(['mail'])
})
