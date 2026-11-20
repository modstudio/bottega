import { expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { OutboxRowError } from './outbox-failure.ts'
import { projectRecordId } from './record-sync-project-identity.ts'

const PROJECT = '01990000-0000-7000-8000-000000002397'
const SPACE = '01990000-0000-7000-8000-000000002398'

test('an absent project refusal names how to find its destination space', async () => {
  const tx = (async () => []) as unknown as SQL
  const error = await projectRecordId(
    tx,
    { projectId: PROJECT, projectName: 'alpha' },
    { userId: '01990000-0000-7000-8000-000000002399', spaceId: SPACE },
  ).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(OutboxRowError)
  expect(error).toMatchObject({
    message: `record project ${PROJECT} is absent from request space ${SPACE} (project "alpha")`,
    errorClass: 'row-validation',
    remedy: `request was sent to record space ${SPACE}; find project "alpha"'s declared space slug in settings.space from \`${PLATFORM_SLUG} project list --json\`, then retry against that space`,
  })
})
