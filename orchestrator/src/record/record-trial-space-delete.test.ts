import { describe, expect, test } from 'bun:test'
import { decideTrialSpaceDelete, type TrialDeleteFacts } from './record-trial-space-delete.ts'

const base: TrialDeleteFacts = {
  exists: true,
  slug: 'trial-demo',
  marked: true,
  callerUserId: 'owner',
  members: [
    { userId: 'owner', email: 'owner@example.test', role: 'owner', hasRealSpace: false },
    { userId: 'trial', email: 'trial-1@example.test', role: 'member', hasRealSpace: false },
  ],
}
describe('trial space delete guard', () => {
  test('refuses every unsafe shape and allows the trial-only shape', () => {
    expect(decideTrialSpaceDelete({ ...base, slug: 'real' })).toMatchObject({
      allowed: false,
      refusal: expect.stringContaining('trial-slug'),
    })
    expect(decideTrialSpaceDelete({ ...base, marked: false })).toMatchObject({
      allowed: false,
      refusal: expect.stringContaining('trial-marker'),
    })
    expect(decideTrialSpaceDelete({ ...base, callerUserId: 'other' })).toMatchObject({
      allowed: false,
      refusal: expect.stringContaining('caller-owner'),
    })
    expect(
      decideTrialSpaceDelete({
        ...base,
        members: [base.members[0]!, { ...base.members[1]!, email: 'real@example.test' }],
      }),
    ).toMatchObject({ allowed: false, refusal: expect.stringContaining('trial-member-email') })
    expect(
      decideTrialSpaceDelete({
        ...base,
        members: [base.members[0]!, { ...base.members[1]!, hasRealSpace: true }],
      }),
    ).toMatchObject({ allowed: false, refusal: expect.stringContaining('trial-member-spaces') })
    expect(decideTrialSpaceDelete(base)).toEqual({
      allowed: true,
      nothing: false,
      neutralize: [base.members[1]!],
    })
    expect(decideTrialSpaceDelete({ ...base, exists: false, members: [] })).toEqual({
      allowed: true,
      nothing: true,
      neutralize: [],
    })
  })
})
