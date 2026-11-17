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
    message: `record project ${PROJECT} is absent from request space ${SPACE}`,
    errorClass: 'row-validation',
    remedy: `send it to the space that holds the project (\`${PLATFORM_SLUG} project list --json\` names it), then retry`,
  })
})
