import { describe, expect, test } from 'bun:test'
import { decideProjectPurge, type ProjectPurgeFacts } from './record-project-purge.ts'

const base: ProjectPurgeFacts = {
  exists: true,
  name: 'demo',
  confirmation: 'demo',
  spaceSlug: 'team',
  callerRole: 'owner',
  publiclyListed: false,
}
describe('project purge guard', () => {
  test('requires confirmation, ownership, and an unpublished project', () => {
    expect(decideProjectPurge({ ...base, confirmation: 'other' })).toMatchObject({
      allowed: false,
      refusal: expect.stringContaining('--confirm demo'),
    })
    expect(decideProjectPurge({ ...base, callerRole: 'admin' })).toMatchObject({
      allowed: false,
      refusal: expect.stringContaining('caller-owner'),
    })
    expect(decideProjectPurge({ ...base, publiclyListed: true })).toMatchObject({
      allowed: false,
      refusal: expect.stringContaining('public-listing'),
    })
    expect(decideProjectPurge(base)).toEqual({ allowed: true, nothing: false })
    expect(decideProjectPurge({ ...base, exists: false })).toEqual({
      allowed: true,
      nothing: true,
    })
  })
})
