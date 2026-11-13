import { ed25519 } from '@noble/curves/ed25519.js'
import { writeMachineSigningKey } from '../../../shared/machine-signing-key.ts'
import { signTrustLogEntry, trustLogEntryHash } from '../../../shared/trust-log.ts'

export function machineRevokeTrustLogFixture(
  enabled: boolean,
  spaceId: string,
  own: readonly [keyId: string, publicKey: Uint8Array],
  target: readonly [keyId: string, publicKey: Uint8Array],
): Uint8Array[] {
  if (!enabled) return []
  const ownSigningPrivateKey = new Uint8Array(32).fill(31)
  const ownSigningPublicKey = ed25519.getPublicKey(ownSigningPrivateKey)
  writeMachineSigningKey(
    { privateKey: ownSigningPrivateKey, publicKey: ownSigningPublicKey },
    process.env,
  )
  const genesis = signTrustLogEntry(
    {
      prev: null,
      space: spaceId,
      body: {
        kind: 'genesis',
        first: {
          keyId: own[0],
          publicKey: own[1],
          signingPublicKey: ownSigningPublicKey,
          label: 'current',
        },
        recoveryPublicKey: ed25519.getPublicKey(new Uint8Array(32).fill(33)),
      },
      signer: ownSigningPublicKey,
      at: 1,
    },
    ownSigningPrivateKey,
  )
  return [
    genesis,
    signTrustLogEntry(
      {
        prev: trustLogEntryHash(genesis),
        space: spaceId,
        body: {
          kind: 'add',
          keyId: target[0],
          publicKey: target[1],
          signingPublicKey: ed25519.getPublicKey(new Uint8Array(32).fill(32)),
          label: 'other',
        },
        signer: ownSigningPublicKey,
        at: 2,
      },
      ownSigningPrivateKey,
    ),
  ]
}

export function trackedTrustLogClient(entries: Uint8Array[]) {
  const recordCallOrder: string[] = []
  let appendedTrustLogEntry: Uint8Array | null = null
  return {
    recordCallOrder,
    appendedTrustLogEntry: () => appendedTrustLogEntry,
    methods: {
      readTrustLog: async () => entries,
      appendTrustLogEntry: async (_expectedHead: Uint8Array, entry: Uint8Array) => {
        recordCallOrder.push('appendTrustLogEntry')
        appendedTrustLogEntry = entry
        return trustLogEntryHash(entry)
      },
    },
  }
}
