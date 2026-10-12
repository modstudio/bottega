import { beforeAll, expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { recordAuth } from '../src/record/record-auth.ts'
import { SIGN_UP_AUTH } from './fixtures/record-auth-postgres.ts'

export function registerBoardSharedSpaceApiProof(
  actorUrl: string,
  origin: () => string,
  sharedToken: () => string,
  post: (id: string) => Promise<Response>,
): void {
  let unrelatedToken = ''

  beforeAll(async () => {
    const signed = await recordAuth(actorUrl).api.signUpEmail({
      body: {
        email: 'board-api-shared-space-unrelated@example.test',
        name: 'Board API Shared Space Unrelated',
        password: SIGN_UP_AUTH.password,
      },
    })
    if (!signed.token) throw new Error('unrelated board API user has no bearer token')
    unrelatedToken = signed.token
  })

  test('change feed includes explicit shared-space reach only for a user sharing a space', async () => {
    const id = newRecordId()
    expect((await post(id)).status).toBe(200)
    const changes = async (token: string) =>
      (await (
        await fetch(`${origin()}/v1/board/changes?after=0&limit=100`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { items: Array<{ message: { id: string; sharedSpaceReach?: boolean } }> }
    const shared = await changes(sharedToken())
    expect(shared.items.find((item) => item.message.id === id)?.message.sharedSpaceReach).toBeTrue()
    expect((await changes(unrelatedToken)).items.some((item) => item.message.id === id)).toBeFalse()
  })
}
