import { expect, test } from 'bun:test'
import { readHostedJson } from './hosted-json.ts'

test.each([
  ['successful JSON', Response.json({ ok: true }), { kind: 'json', value: { ok: true } }],
  ['successful JSON null', Response.json(null), { kind: 'json', value: null }],
  ['no content', new Response(null, { status: 204 }), { kind: 'empty' }],
  ['successful empty body', new Response('', { status: 200 }), { kind: 'empty' }],
  [
    'failed JSON',
    Response.json({ error: 'no' }, { status: 502 }),
    { kind: 'json', value: { error: 'no' } },
  ],
  ['failed empty body', new Response('', { status: 502 }), { kind: 'absent' }],
  [
    'failed non-JSON body',
    new Response('<html>bad gateway</html>', { status: 502 }),
    { kind: 'absent' },
  ],
] as const)('reads a %s response once', async (_name, response, expected) => {
  await expect(readHostedJson(response, 'https://record.test/v1/example')).resolves.toEqual(
    expected,
  )
  if (response.body !== null) expect(response.bodyUsed).toBe(true)
})

test.each([
  ['unparseable', new Response('<html>app</html>', { status: 200 })],
  [
    'HTML content type',
    new Response('{"app":true}', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  ],
] as const)('rejects a successful %s body with source diagnostics', async (_name, response) => {
  await expect(readHostedJson(response, 'https://record.test/v1/example')).rejects.toThrow(
    'hosted response from record.test/v1/example was not JSON (status 200, content-type',
  )
  expect(response.bodyUsed).toBe(true)
})
