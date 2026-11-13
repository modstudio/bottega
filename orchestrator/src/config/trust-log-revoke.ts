// concern: signed trust-log revocation
/** Verifies the untrusted hosted log and appends one locally signed revoke before record revocation. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ConfigClient } from '../../../shared/config-client.ts'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import { verifyTrustLog } from '../../../shared/trust-log.ts'
import { readRememberedTrustLogHead } from '../../../shared/trust-log-head.ts'
import { appendSignedTrustLogEntry } from './trust-log-append.ts'

export async function appendTrustLogRevoke(
  client: ConfigClient,
  ownKeyId: string,
  targetKeyId: string,
  spaceId: string,
  ports: { at?: number; env?: ConfigEnvironment } = {},
): Promise<Uint8Array | null> {
  const entries = await client.readTrustLog()
  if (entries.length === 0) return null
  const remembered = readRememberedTrustLogHead(spaceId, ports.env)
  const state = verifyTrustLog(entries, { spaceId, rememberedHead: remembered })
  if (!state.keys.has(ownKeyId))
    throw new Error(
      `this machine is not trusted by the space machine trust log; have an owner approve it from an approved machine before retrying \`${PLATFORM_SLUG} machine config machine revoke\``,
    )
  if (!state.keys.has(targetKeyId)) return null
  return appendSignedTrustLogEntry(
    client,
    ownKeyId,
    spaceId,
    { kind: 'revoke', keyId: targetKeyId },
    'machine config machine revoke',
    ports,
  )
}
