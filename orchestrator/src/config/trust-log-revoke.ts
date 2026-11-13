// concern: signed trust-log revocation
/** Verifies the untrusted hosted log and appends one locally signed revoke before record revocation. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ConfigClient, ConfigClientError } from '../../../shared/config-client.ts'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import { readMachineSigningKey } from '../../../shared/machine-signing-key.ts'
import { signTrustLogEntry, trustLogEntryHash, verifyTrustLog } from '../../../shared/trust-log.ts'
import {
  readRememberedTrustLogHead,
  writeRememberedTrustLogHead,
} from '../../../shared/trust-log-head.ts'

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
  const signing = readMachineSigningKey(ports.env)
  if (!signing)
    throw new Error(
      `machine signing key is not initialized; run \`${PLATFORM_SLUG} machine config machine init\` before retrying the revoke`,
    )
  const encoded = signTrustLogEntry(
    {
      prev: state.head,
      space: spaceId,
      body: { kind: 'revoke', keyId: targetKeyId },
      signer: signing.publicKey,
      at: ports.at ?? Date.now(),
    },
    signing.privateKey,
  )
  const nextHead = trustLogEntryHash(encoded)
  try {
    await client.appendTrustLogEntry(state.head, encoded)
  } catch (error) {
    if (error instanceof ConfigClientError && error.status === 409)
      throw new Error('machine trust log changed while revoking; retry the revoke')
    throw error
  }
  writeRememberedTrustLogHead(spaceId, nextHead, ports.env)
  return nextHead
}
