import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { commitDocSet } from '../doc/local-doc-write.ts'
import { staleCustomerGuideCommandConditions } from './monitor-customer-guides.ts'

test('reports a cached customer article made stale by a command removal', async () => {
  const input = {
    scope: 'global',
    subject: null,
    owner: null,
    slug: 'stale-command-guide',
    projectId: null,
    title: 'Stale command guide',
    body: `Run \`${PLATFORM_SLUG} task removed-verb\`.`,
    delivery: 'demand',
    audiences: ['customer'] as ['customer'],
    parentId: null,
    position: 0,
    kind: 'article',
    identity: { author: 'test', reason: 'fixture predates command removal', session: null },
    recordId: newRecordId(),
  } as const
  const stale = commitDocSet({ ...input, revisionId: newRecordId() })

  expect(staleCustomerGuideCommandConditions()).toContainEqual(
    expect.objectContaining({
      kind: 'stale-customer-guide-command',
      subject: 'global/_/stale-command-guide',
      detail: expect.stringContaining(
        `customer article "Stale command guide" names unknown command mention: ${PLATFORM_SLUG} task removed-verb`,
      ),
    }),
  )

  commitDocSet({
    ...input,
    body: `Run \`${PLATFORM_SLUG} task show DEV-1353\`.`,
    expectedRevision: stale.revision!,
    revisionId: newRecordId(),
  })
  expect(
    staleCustomerGuideCommandConditions().filter(
      ({ subject }) => subject === 'global/_/stale-command-guide',
    ),
  ).toEqual([])
})
