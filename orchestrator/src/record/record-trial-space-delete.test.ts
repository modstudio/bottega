import { describe, expect, test } from 'bun:test'
import {
  type ConfirmedSpaceDeleteFacts,
  decideSpaceDelete,
  decideTrialSpaceDelete,
  type SpaceDeleteFacts,
} from './record-trial-space-delete.ts'

const base: SpaceDeleteFacts = {
  exists: true,
  slug: 'trial-demo',
  marked: true,
  publiclyListed: false,
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
    expect(decideTrialSpaceDelete({ ...base, publiclyListed: true })).toMatchObject({
      allowed: false,
      refusal: expect.stringContaining('public-listing'),
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
describe('confirmed space delete guard', () => {
  const general: ConfirmedSpaceDeleteFacts = {
    ...base,
    confirmation: base.slug,
    personalSpace: false,
  }
  test('requires confirmation, ownership, no listing, no personal-space owner, and trial-only peers', () => {
    expect(decideSpaceDelete({ ...general, confirmation: 'other' })).toMatchObject({
      allowed: false,
      refusal: expect.stringContaining('--confirm trial-demo'),
    })
    expect(decideSpaceDelete({ ...general, callerUserId: 'other' })).toMatchObject({
      allowed: false,
      refusal: expect.stringContaining('caller-owner'),
    })
    expect(decideSpaceDelete({ ...general, publiclyListed: true })).toMatchObject({
      allowed: false,
      refusal: expect.stringContaining('public-listing'),
    })
    expect(decideSpaceDelete({ ...general, personalSpace: true })).toMatchObject({
      allowed: false,
      refusal: expect.stringContaining('personal-space'),
    })
    expect(
      decideSpaceDelete({
        ...general,
        members: [base.members[0]!, { ...base.members[1]!, email: 'real@example.test' }],
      }),
    ).toMatchObject({ allowed: false, refusal: expect.stringContaining('member removal') })
    expect(decideSpaceDelete(general)).toEqual({
      allowed: true,
      nothing: false,
      neutralize: [base.members[1]!],
    })
  })
})
