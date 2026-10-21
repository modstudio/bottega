import { test } from 'bun:test'
import { proveCanonImports } from './postgres-docs-proof.ts'
import { registerOwnedCanonPrivacyProof } from './postgres-owned-canon-proof.ts'

export function registerHostedCanonProofs(
  authIds: () => { spaceId: string; ownerUserId: string; otherUserId: string },
  subjectFixture: readonly [string, string, string, string],
  token: () => string,
): void {
  registerOwnedCanonPrivacyProof(authIds, subjectFixture)
  test('canon import deletes an omitted existing row', async () => {
    await proveCanonImports(process.env.ORCH_RECORD_API_URL!, {
      Authorization: `Bearer ${token()}`,
      'content-type': 'application/json',
    })
  })
}
