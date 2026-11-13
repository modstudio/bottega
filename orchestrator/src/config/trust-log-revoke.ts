// concern: signed trust-log revocation
/** Verifies the untrusted hosted log and appends one locally signed revoke before record revocation. */

import type { ConfigClient } from '../../../shared/config-client.ts'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import { appendSignedTrustLogEntry } from './trust-log-append.ts'

export async function appendTrustLogRevoke(
  client: ConfigClient,
  ownKeyId: string,
  targetKeyId: string,
  spaceId: string,
  ports: { at?: number; env?: ConfigEnvironment } = {},
): Promise<Uint8Array | null> {
  return appendSignedTrustLogEntry(
    client,
    ownKeyId,
    spaceId,
    { kind: 'revoke', keyId: targetKeyId },
    { action: 'revoking', retry: 'the revoke' },
    {
      ...ports,
      check: (state) => state.keys.has(targetKeyId),
    },
  )
}
