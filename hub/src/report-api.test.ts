import { expect, test } from 'bun:test'
import { reportApi } from './report-api.ts'

const config = {
  recordApiUrl: 'https://record.example.test',
  recordDatabaseUrl: 'postgres://record',
}
const ownSpace = '01990000-0000-7000-8000-00000000070a'
const otherSpace = '01990000-0000-7000-8000-00000000070b'
const userId = '01990000-0000-7000-8000-000000000701'
const subscriptionId = '01990000-0000-7000-8000-000000000768'

const identityFetch = (async () =>
  Response.json({
    user: { id: userId },
    activeSpaceId: otherSpace,
    memberships: [{ space_id: otherSpace, slug: 'other', permission: 'write' }],
  })) as unknown as typeof fetch

test('the hosted route cannot update or remove a subscription in another space', async () => {
  const refuseOtherSpace = (_url: string, identity: { userId: string; spaceId: string }) => {
    expect(identity).toEqual({ userId, spaceId: otherSpace })
    if (identity.spaceId !== ownSpace) throw new Error('report subscription not found')
    return { id: subscriptionId }
  }
  const dependencies = {
    fetch: identityFetch,
    updateSubscription: refuseOtherSpace,
    unsubscribe: refuseOtherSpace,
  }
  const update = await reportApi(
    new Request(`https://hub.example.test/v1/report-subscriptions/${subscriptionId}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({
        cadence: 'daily',
        hour: 18,
        zone: 'America/New_York',
        enabled: true,
      }),
    }),
    config,
    dependencies,
  )
  const remove = await reportApi(
    new Request(`https://hub.example.test/v1/report-subscriptions/${subscriptionId}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer test' },
    }),
    config,
    dependencies,
  )
  expect(update?.status).toBe(409)
  expect(remove?.status).toBe(409)
  expect(await update?.json()).toEqual({ error: 'report subscription not found' })
  expect(await remove?.json()).toEqual({ error: 'report subscription not found' })
})

test('email unsubscribe lookup and one-click POST need no session', async () => {
  const dependencies = {
    emailRecipientByToken: (_url: string, spaceId: string, token: string) => ({
      ...(spaceId === ownSpace ? {} : { invalidSpace: true }),
      email: `${token}@example.test`,
      subscription: 'daily report',
      space: 'Workshop',
    }),
    unsubscribeEmailRecipient: (_url: string, spaceId: string, token: string) =>
      spaceId === ownSpace && token === 'mail-token',
  }
  const lookup = await reportApi(
    new Request(`https://hub.example.test/v1/report-unsubscribe/${ownSpace}/mail-token`),
    config,
    dependencies,
  )
  const unsubscribe = await reportApi(
    new Request(`https://hub.example.test/unsubscribe/${ownSpace}/mail-token`, { method: 'POST' }),
    config,
    dependencies,
  )
  expect(await lookup?.json()).toEqual({
    email: 'mail-token@example.test',
    subscription: 'daily report',
    space: 'Workshop',
  })
  expect(await unsubscribe?.json()).toEqual({ unsubscribed: true })
})
