import { expect, test } from 'bun:test'
import { recordApiServerConfig } from './record-api-server.ts'

const complete = {
  ORCH_RECORD_URL: 'postgres://record.test/record',
  BETTER_AUTH_SECRET: 'secret-at-least-thirty-two-characters',
  BETTER_AUTH_URL: 'https://api.example.test',
  RECORD_HUB_URL: 'https://hub.example.test',
}

for (const name of ['ORCH_RECORD_URL', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'RECORD_HUB_URL']) {
  test(`server refuses without ${name}`, () => {
    expect(() => recordApiServerConfig({ ...complete, [name]: undefined })).toThrow(
      `${name} is required to serve the record API`,
    )
  })
}

test('server defaults PORT to 3000', () => {
  expect(recordApiServerConfig(complete).port).toBe(3000)
})
