import { expect, test } from 'bun:test'
import { mainStackPublishedAddresses } from './main-stack-network.ts'

test('main-stack network destinations are exact, service-scoped, and deduplicated', () => {
  expect(
    mainStackPublishedAddresses(
      {
        services: {
          db: { ports: [{ published: '5432' }] },
          cache: {
            ports: [
              { host_ip: '::1', published: 6380 },
              { host_ip: '::1', published: 6380 },
            ],
          },
          unrelated: { ports: [{ published: '9000' }] },
        },
      },
      ['db', 'cache'],
    ),
  ).toEqual(['127.0.0.1:5432', '[::1]:6380'])
})

test('a dynamic or missing declared service cannot broaden the writer network', () => {
  expect(() =>
    mainStackPublishedAddresses({ services: { api: { ports: [{ published: '8000-8002' }] } } }),
  ).toThrow('no exact published host port')
  expect(() => mainStackPublishedAddresses({ services: {} }, ['db'])).toThrow(
    'declared main-stack service db is absent',
  )
})
