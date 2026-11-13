import { ed25519 } from '@noble/curves/ed25519.js'
import { signTrustLogEntry, trustLogEntryHash } from '../../../shared/trust-log.ts'

export function trustLogFixtureSigningKey(value: number) {
  const privateKey = new Uint8Array(32).fill(value)
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) }
}

type FixtureKey = readonly [
  keyId: string,
  publicKey: Uint8Array,
  signingPublicKey: Uint8Array,
  label: string,
]

const fixtureKey = ([keyId, publicKey, signingPublicKey, label]: FixtureKey) => ({
  keyId,
  publicKey,
  signingPublicKey,
  label,
})

export function machineRevokeTrustLogFixture(
  enabled: boolean,
  spaceId: string,
  ownMaterial: FixtureKey,
  targetMaterial: FixtureKey,
  ownSigningPrivateKey: Uint8Array,
): Uint8Array[] {
  if (!enabled) return []
  const own = fixtureKey(ownMaterial)
  const target = fixtureKey(targetMaterial)
  const genesis = signTrustLogEntry(
    {
      prev: null,
      space: spaceId,
      body: {
        kind: 'genesis',
        first: own,
        recoveryPublicKey: ed25519.getPublicKey(new Uint8Array(32).fill(33)),
      },
      signer: own.signingPublicKey,
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
          ...target,
        },
        signer: own.signingPublicKey,
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
