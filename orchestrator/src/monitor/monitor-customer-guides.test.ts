import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { setDoc } from '../doc/docs.ts'
import { staleCustomerGuideCommandConditions } from './monitor-customer-guides.ts'

test('reports a cached customer article made stale by a command removal', async () => {
  await setDoc({
    scope: 'global',
    subject: null,
    slug: 'stale-command-guide',
    title: 'Stale command guide',
    body: `Run \`${PLATFORM_SLUG} task removed-verb\`.`,
    delivery: 'demand',
    audiences: ['customer'],
    kind: 'article',
    reason: 'fixture predates command removal',
    loadKnownCommands: () => [`${PLATFORM_SLUG} task`, `${PLATFORM_SLUG} task removed-verb`],
  })

  expect(staleCustomerGuideCommandConditions()).toContainEqual(
    expect.objectContaining({
      kind: 'stale-customer-guide-command',
      subject: 'global/_/stale-command-guide',
      detail: expect.stringContaining(
        `customer article "Stale command guide" names unknown command mention: ${PLATFORM_SLUG} task removed-verb`,
      ),
    }),
  )
})
