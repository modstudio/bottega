import { expect, test } from 'bun:test'
import { bearerHeaders } from '../src/record/record-auth.ts'
import {
  SIGN_UP_AUTH,
  SIGN_UP_CLI_OUTPUT,
  testRecordAuth,
} from './fixtures/record-auth-postgres.ts'

export function registerConfigAccessSpaceCreationProof(input: {
  actorUrl: () => string
  token: () => string
  otherToken: () => string
  userId: () => string
  otherUserId: () => string
  cliOutput: () => string[]
  succeeds: (source: string) => string
}): void {
  test('CLI sign-up creates owner memberships with config access and distinct identities', async () => {
    expect(input.cliOutput()).toEqual(SIGN_UP_CLI_OUTPUT)
    expect(
      input
        .succeeds(
          `SELECT u.email, count(m.id), min(m.role), min(m.permission), bool_and(m.config_access)
         FROM "user" u JOIN membership m ON m.user_id=u.id
         WHERE u.id IN ('${input.userId()}', '${input.otherUserId()}')
         GROUP BY u.email ORDER BY u.email;`,
        )
        .split('\n'),
    ).toEqual([`${SIGN_UP_AUTH.emailA}|1|owner|write|t`, `${SIGN_UP_AUTH.emailB}|1|owner|write|t`])
    const auth = testRecordAuth(input.actorUrl())
    expect((await auth.api.getSession({ headers: bearerHeaders(input.token()) }))?.user.id).toBe(
      input.userId(),
    )
    expect(
      (await auth.api.getSession({ headers: bearerHeaders(input.otherToken()) }))?.user.id,
    ).toBe(input.otherUserId())
  })

  test('afterCreateOrganization grants config access to the creating owner', async () => {
    const auth = testRecordAuth(input.actorUrl())
    const userId = input.userId()
    const created = await auth.api.createOrganization({
      headers: bearerHeaders(input.token()),
      body: { name: 'Config Access Hook', slug: `config-access-hook-${userId.slice(-8)}` },
    })
    expect(
      input.succeeds(
        `SELECT role, permission, config_access
         FROM membership WHERE space_id='${created.id}' AND user_id='${userId}';`,
      ),
    ).toBe('owner|write|t')
  })
}
