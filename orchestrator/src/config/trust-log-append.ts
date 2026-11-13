// concern: authenticated machine trust-log append

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ConfigClient, ConfigClientError } from '../../../shared/config-client.ts'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import { readMachineSigningKey } from '../../../shared/machine-signing-key.ts'
import {
  bytesEqual,
  signTrustLogEntry,
  type TrustLogBody,
  verifyTrustLog,
} from '../../../shared/trust-log.ts'
import {
  readRememberedTrustLogHead,
  writeRememberedTrustLogHead,
} from '../../../shared/trust-log-head.ts'

export async function appendSignedTrustLogEntry(
  client: ConfigClient,
  ownKeyId: string,
  spaceId: string,
  body: TrustLogBody,
  verb: string,
  ports: { at?: number; env?: ConfigEnvironment } = {},
): Promise<Uint8Array> {
  const entries = await client.readTrustLog({ destinationSpaceId: spaceId })
  const remembered = readRememberedTrustLogHead(spaceId, ports.env)
  const state = verifyTrustLog(entries, { spaceId, rememberedHead: remembered })
  if (!state.keys.has(ownKeyId))
    throw new Error(
      `this machine is not trusted by the space machine trust log; have an owner approve it from an approved machine before retrying \`${PLATFORM_SLUG} ${verb}\``,
    )
  const signing = readMachineSigningKey(ports.env)
  if (!signing)
    throw new Error(
      `machine signing key is not initialized; run \`${PLATFORM_SLUG} machine config machine init\` before retrying ${verb}`,
    )
  const trustedOwnKey = state.keys.get(ownKeyId)!
  if (!bytesEqual(trustedOwnKey.signingPublicKey, signing.publicKey))
    throw new Error(
      `this machine's signing key is not the key the space machine trust log trusts for its key id; have an owner re-approve this machine from an approved machine before retrying ${verb === 'machine config machine revoke' ? 'the revoke' : verb}`,
    )
  const encoded = signTrustLogEntry(
    {
      prev: state.head,
      space: spaceId,
      body,
      signer: signing.publicKey,
      at: ports.at ?? Date.now(),
    },
    signing.privateKey,
  )
  const nextHead = verifyTrustLog([...entries, encoded], {
    spaceId,
    rememberedHead: remembered,
  }).head
  try {
    await client.appendTrustLogEntry(state.head, encoded, { destinationSpaceId: spaceId })
  } catch (error) {
    if (error instanceof ConfigClientError && error.status === 409)
      throw new Error(
        verb === 'machine config machine revoke'
          ? 'machine trust log changed while revoking; retry the revoke'
          : `machine trust log changed while running ${verb}; retry ${verb}`,
      )
    throw error
  }
  writeRememberedTrustLogHead(spaceId, nextHead, ports.env)
  return nextHead
}
