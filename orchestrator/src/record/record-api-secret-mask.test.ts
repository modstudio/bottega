import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerRecordSecretMask } from './record-api-secret-mask.ts'

const SECRET = 'ghp_123456789012345678901234567890123456'

test('record masking rebuilds the raw body seen by text readers', async () => {
  const app = new Hono()
  registerRecordSecretMask(app)
  app.post('/v1/sync', async (context) => context.json(JSON.parse(await context.req.text())))

  const response = await app.request('/v1/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      machine: { name: SECRET, seenAt: '2026-11-22T00:00:00.000Z' },
      rows: [{ id: 1, kind: 'run', payload: SECRET, spaceHint: 'space-a' }],
    }),
  })

  expect(await response.json()).toEqual({
    machine: { name: '[withheld: provider-prefix]', seenAt: '2026-11-22T00:00:00.000Z' },
    rows: [
      {
        id: 1,
        kind: 'run',
        payload: '[withheld: provider-prefix]',
        spaceHint: 'space-a',
      },
    ],
  })
})

test('record masking leaves no-free-text protocol bodies byte-identical', async () => {
  const app = new Hono()
  registerRecordSecretMask(app)
  app.post('/v1/config/join/nameplates/:nameplate/messages', async (context) =>
    context.text(await context.req.text()),
  )
  const body = JSON.stringify({ side: 'side', phase: 'pake-a', body: SECRET })
  const response = await app.request('/v1/config/join/nameplates/nameplate/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  expect(await response.text()).toBe(body)
})
