import type { ConfigClient } from './config-client.ts'
import type { ConfigEnvironment } from './config-directory.ts'
import { readTrustList } from './trust-list.ts'
import { type TrustState, verifyTrustLog } from './trust-log.ts'
import { readRememberedTrustLogHead, writeRememberedTrustLogHead } from './trust-log-head.ts'

export type TrustedKeys = Record<string, { public_key: string; label: string }>

export async function verifiedTrustLogForSpace(
  client: Pick<ConfigClient, 'readTrustLog'>,
  spaceId: string,
  env: ConfigEnvironment = process.env,
): Promise<{ entries: Uint8Array[]; state: TrustState | null }> {
  const entries = await client.readTrustLog({ destinationSpaceId: spaceId })
  const remembered = readRememberedTrustLogHead(spaceId, env)
  if (entries.length === 0) {
    if (remembered)
      throw new Error(
        `the record's trust log for space ${spaceId} is empty although this machine has seen a head; do not trust this record, and report it`,
      )
    return { entries, state: null }
  }
  const state = verifyTrustLog(entries, { spaceId, rememberedHead: remembered })
  writeRememberedTrustLogHead(spaceId, state.head, env)
  return { entries, state }
}

export async function trustedKeysForSpace(
  client: Pick<ConfigClient, 'readTrustLog'>,
  spaceId: string,
  env: ConfigEnvironment = process.env,
): Promise<TrustedKeys> {
  const { state } = await verifiedTrustLogForSpace(client, spaceId, env)
  if (!state) {
    const pinned = await readTrustList(env)
    return Object.fromEntries(
      Object.entries(pinned).map(([keyId, key]) => [
        keyId,
        { public_key: key.public_key, label: key.label },
      ]),
    )
  }
  return Object.fromEntries(
    [...state.keys].map(([keyId, key]) => [
      keyId,
      { public_key: Buffer.from(key.publicKey).toString('base64url'), label: key.label },
    ]),
  )
}
