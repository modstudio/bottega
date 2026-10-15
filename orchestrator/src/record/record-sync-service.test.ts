import { expect, spyOn, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { RECORD_ACTOR_ROLE } from '../../../shared/record/schema.ts'
import { fakePostgres } from '../../test/fixtures/record-sync-postgres.ts'
import { projectRecordId } from './record-sync-service.ts'

const PROJECT_ID = '01990000-0000-7000-8000-000000000088'
const SPACE_ID = '01990000-0000-7000-8000-000000000001'
const OTHER_SPACE_ID = '01990000-0000-7000-8000-000000000777'
const PRINCIPAL = { userId: '01990000-0000-7000-8000-000000000002', spaceId: SPACE_ID }

test('project identity prefers id, logs one name mismatch, and falls back without id', async () => {
  const remote = fakePostgres()
  const warning = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(
      await projectRecordId(remote.sql, { projectId: PROJECT_ID, projectName: 'stale' }, PRINCIPAL),
    ).toBe(PROJECT_ID)
    expect(warning).toHaveBeenCalledTimes(1)
    expect(await projectRecordId(remote.sql, { projectName: PLATFORM_SLUG }, PRINCIPAL)).toBe(
      PROJECT_ID,
    )
  } finally {
    warning.mockRestore()
  }
})

test('project identity refuses an id owned by another space', async () => {
  const remote = fakePostgres(false, RECORD_ACTOR_ROLE, undefined, undefined, undefined, {
    id: PROJECT_ID,
    name: PLATFORM_SLUG,
    spaceId: OTHER_SPACE_ID,
  })
  expect(
    projectRecordId(remote.sql, { projectId: PROJECT_ID, projectName: PLATFORM_SLUG }, PRINCIPAL),
  ).rejects.toThrow('absent from request space')
})
