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
    expect(created.person_user_id).toBeNull()
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

  test('a person-scope subscription names a user, and a space-scope one does not', () => {
    const person = planReportSubscription(caller, { scope: { kind: 'person' }, ...daily }, facts)
    expect(person.scope_kind).toBe('person')
    expect(person.person_user_id).toBe(caller.userId)
    expect(person.project_name).toBeNull()
    const space = planReportSubscription(caller, { scope: { kind: 'space' }, ...daily }, facts)
    expect(space.scope_kind).toBe('space')
    expect(space.person_user_id).toBeNull()
    expect(space.project_name).toBeNull()
    expect(() =>
      planReportSubscription(
        caller,
        { scope: { kind: 'person', userId: member }, ...daily },
        facts,
      ),
    ).toThrow('person scope must be the calling member')
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

  test('an update accepts delivery fields and refuses scope or recipient changes', () => {
    expect(
      planReportSubscriptionUpdate({
        cadence: 'weekly',
        hour: 18,
        weekday: 'friday',
        zone: 'Europe/London',
        enabled: false,
      }),
    ).toEqual({
      cadence: 'weekly',
      hour: 18,
      weekday: 'friday',
      zone: 'Europe/London',
      enabled: false,
    })
    expect(() =>
      planReportSubscriptionUpdate({ ...daily, enabled: true, scope: { kind: 'space' } } as never),
    ).toThrow('scope cannot be changed')
    expect(() =>
      planReportSubscriptionUpdate({
        ...daily,
        enabled: true,
        recipientUserIds: [member],
      } as never),
    ).toThrow('scope cannot be changed')
  })
})
