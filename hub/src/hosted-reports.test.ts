import { describe, expect, test } from 'bun:test'
import {
  assertReportSubscriptionFound,
  planReportSubscription,
  planReportSubscriptionUpdate,
} from './hosted-reports.ts'

const caller = {
  userId: '01990000-0000-7000-8000-000000000701',
  spaceId: '01990000-0000-7000-8000-00000000070a',
}
const member = '01990000-0000-7000-8000-000000000702'
const outsider = '01990000-0000-7000-8000-000000000799'
const crossProject = '01990000-0000-7000-8000-000000000798'
const ownProject = '01990000-0000-7000-8000-000000000797'
const facts = { projectNames: ['workshop'], memberUserIds: [caller.userId, member] }
const daily = { cadence: 'daily', hour: 8, zone: 'America/New_York' }

describe('report subscriptions', () => {
  test('a project in the caller space is created; a project in another space is refused', () => {
    const created = planReportSubscription(
      caller,
      { scope: { kind: 'project', project: 'workshop' }, ...daily },
      facts,
    )
    expect(created.scope_kind).toBe('project')
    expect(created.project_name).toBe('workshop')
    expect(created.member_user_ids).toEqual([])
    expect(created.recipient_user_ids).toEqual([caller.userId])
    expect(() =>
      planReportSubscription(
        caller,
        { scope: { kind: 'project', project: 'other-space-project' }, ...daily },
        facts,
      ),
    ).toThrow('project other-space-project is not in this space')
  })

  test('a recipient who is not a member of the space is refused, naming that', () => {
    expect(() =>
      planReportSubscription(
        caller,
        { scope: { kind: 'space' }, ...daily, recipientUserIds: [outsider] },
        facts,
      ),
    ).toThrow('every recipient must be a member of this space')
    expect(() =>
      planReportSubscription(
        caller,
        { scope: { kind: 'space' }, ...daily, recipientUserIds: [] },
        facts,
      ),
    ).toThrow('a subscription requires at least one recipient')
  })

  test('only an owner or admin can add an email recipient, and member addresses are refused', () => {
    expect(() =>
      planReportSubscription(
        caller,
        {
          scope: { kind: 'space' },
          ...daily,
          recipientUserIds: [],
          recipientEmails: ['outside@example.test'],
        },
        { ...facts, membershipRole: 'member' },
      ),
    ).toThrow('only a space owner or admin may change email recipients')
    expect(() =>
      planReportSubscription(
        caller,
        {
          scope: { kind: 'space' },
          ...daily,
          recipientUserIds: [],
          recipientEmails: [' READER@EXAMPLE.TEST '],
        },
        { ...facts, membershipRole: 'owner', memberEmails: ['reader@example.test'] },
      ),
    ).toThrow('space members must be added as member recipients')
    expect(
      planReportSubscription(
        caller,
        {
          scope: { kind: 'space' },
          ...daily,
          recipientUserIds: [],
          recipientEmails: [' Outside@Example.Test '],
        },
        { ...facts, membershipRole: 'admin', memberEmails: [] },
      ).recipient_emails,
    ).toEqual(['outside@example.test'])
  })

  test('a members-scope subscription accepts any space members and requires one', () => {
    const selected = planReportSubscription(
      caller,
      { scope: { kind: 'members', userIds: [member, caller.userId] }, ...daily },
      facts,
    )
    expect(selected.scope_kind).toBe('members')
    expect(selected.member_user_ids).toEqual([member, caller.userId])
    expect(selected.project_name).toBeNull()
    const space = planReportSubscription(caller, { scope: { kind: 'space' }, ...daily }, facts)
    expect(space.scope_kind).toBe('space')
    expect(space.member_user_ids).toEqual([])
    expect(space.project_name).toBeNull()
    expect(() =>
      planReportSubscription(
        caller,
        { scope: { kind: 'members', userIds: [outsider] }, ...daily },
        facts,
      ),
    ).toThrow('every report member must be a member of this space')
    expect(() =>
      planReportSubscription(caller, { scope: { kind: 'members', userIds: [] }, ...daily }, facts),
    ).toThrow('members scope requires at least one member')
  })

  test('projects scope accepts own-space projects for a member and personal cross-space projects', () => {
    expect(
      planReportSubscription(
        caller,
        { scope: { kind: 'projects', projectIds: [ownProject] }, ...daily },
        {
          ...facts,
          membershipRole: 'member',
          personalSpaceId: outsider,
          ownSpaceProjectIds: [ownProject],
        },
      ),
    ).toMatchObject({ scope_kind: 'projects', project_ids: [ownProject], project_name: null })
    expect(
      planReportSubscription(
        caller,
        { scope: { kind: 'projects', projectIds: [crossProject] }, ...daily },
        { ...facts, personalSpaceId: caller.spaceId, eligibleProjectIds: [crossProject] },
      ),
    ).toMatchObject({ scope_kind: 'projects', project_ids: [crossProject], project_name: null })
    expect(() =>
      planReportSubscription(
        caller,
        { scope: { kind: 'projects', projectIds: [crossProject] }, ...daily },
        { ...facts, personalSpaceId: outsider, eligibleProjectIds: [crossProject] },
      ),
    ).toThrow('every report project must be in this space')
    expect(() =>
      planReportSubscription(
        caller,
        { scope: { kind: 'projects', projectIds: [] }, ...daily },
        { ...facts, personalSpaceId: caller.spaceId, eligibleProjectIds: [] },
      ),
    ).toThrow('projects scope requires at least one project')
    expect(() =>
      planReportSubscription(
        caller,
        { scope: { kind: 'projects', projectIds: [crossProject] }, ...daily },
        { ...facts, personalSpaceId: caller.spaceId, eligibleProjectIds: [] },
      ),
    ).toThrow('a non-personal space may only choose its own projects')
  })

  test('the cadence round-trips with its zone', () => {
    const weekly = planReportSubscription(
      caller,
      {
        scope: { kind: 'space' },
        cadence: 'weekly',
        hour: 7,
        weekday: 'Monday',
        zone: 'Europe/London',
        recipientUserIds: [caller.userId, member],
      },
      facts,
    )
    expect(weekly).toMatchObject({
      cadence: 'weekly',
      hour: 7,
      weekday: 'monday',
      zone: 'Europe/London',
      recipient_user_ids: [caller.userId, member],
      enabled: true,
    })
  })

  test('unsubscribing a row that does not exist refuses', () => {
    expect(() => assertReportSubscriptionFound(undefined)).toThrow('report subscription not found')
    expect(() => assertReportSubscriptionFound(null)).toThrow('report subscription not found')
  })

  test('an update validates and carries scope and recipient changes like create', () => {
    expect(
      planReportSubscriptionUpdate(
        caller,
        {
          scope: { kind: 'members', userIds: [member] },
          recipientUserIds: [member],
          cadence: 'weekly',
          hour: 18,
          weekday: 'friday',
          zone: 'Europe/London',
          enabled: false,
        },
        facts,
      ),
    ).toMatchObject({
      scope_kind: 'members',
      member_user_ids: [member],
      recipient_user_ids: [member],
      cadence: 'weekly',
      hour: 18,
      weekday: 'friday',
      zone: 'Europe/London',
      enabled: false,
    })
  })

  test('a member can preserve existing email recipients but cannot change them', () => {
    const input = {
      scope: { kind: 'space' } as const,
      recipientUserIds: [caller.userId],
      recipientEmails: ['outside@example.test'],
      ...daily,
      enabled: true,
    }
    expect(
      planReportSubscriptionUpdate(caller, input, {
        ...facts,
        membershipRole: 'member',
        existingRecipientEmails: ['outside@example.test'],
      }).recipient_emails,
    ).toEqual(['outside@example.test'])
    expect(() =>
      planReportSubscriptionUpdate(
        caller,
        { ...input, recipientEmails: ['other@example.test'] },
        {
          ...facts,
          membershipRole: 'member',
          existingRecipientEmails: ['outside@example.test'],
        },
      ),
    ).toThrow('only a space owner or admin may change email recipients')
  })
})
