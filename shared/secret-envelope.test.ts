import { describe, expect, test } from 'bun:test'
import { machineKeyId } from './machine-key-id.ts'
import {
  generateDataKey,
  generateMachineKeyPair,
  openValue,
  SecretEnvelopeError,
  sealValue,
  unwrapDataKey,
  type ValueContext,
  type WrapContext,
  wrapDataKey,
} from './secret-envelope.ts'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const valueContext: ValueContext = {
  spaceId: '018F4D7B-0E3B-7A41-AB42-6CDB133EE021',
  userId: '018F4D83-299B-77CE-B114-DC861C83E52A',
  keyName: 'provider.token',
  environment: 'production',
  dekId: '018F4D86-C68B-706E-9A45-1F625E07776D',
  rowVersion: 3,
}

const wrapContext: WrapContext = {
  spaceId: valueContext.spaceId,
  dekId: valueContext.dekId,
  dekVersion: 2,
}

function expectReason(action: () => unknown, reason: SecretEnvelopeError['reason']): void {
  expect(action).toThrow(SecretEnvelopeError)
  try {
    action()
  } catch (error) {
    expect((error as SecretEnvelopeError).reason).toBe(reason)
  }
}

async function expectRejectedReason(
  action: () => Promise<unknown>,
  reason: SecretEnvelopeError['reason'],
): Promise<void> {
  try {
    await action()
    throw new Error('Expected the operation to reject.')
  } catch (error) {
    expect(error).toBeInstanceOf(SecretEnvelopeError)
    expect((error as SecretEnvelopeError).reason).toBe(reason)
  }
}

describe('secret values', () => {
  test('seals and opens a value', () => {
    const dek = generateDataKey()
    const plaintext = textEncoder.encode('secret value')
    const envelope = sealValue({ dek, valueContext, plaintext })

    expect(textDecoder.decode(openValue({ envelope, dek, valueContext }))).toBe('secret value')
    expect(envelope.length).toBe(2 + 24 + plaintext.length + 16)
  })

  test.each([
    ['space', { spaceId: '118F4D7B-0E3B-7A41-AB42-6CDB133EE021' }],
    ['user', { userId: '118F4D83-299B-77CE-B114-DC861C83E52A' }],
    ['key name', { keyName: 'provider.other-token' }],
    ['environment', { environment: 'staging' }],
    ['DEK', { dekId: '118F4D86-C68B-706E-9A45-1F625E07776D' }],
    ['row version', { rowVersion: 4 }],
  ] as const)('rejects a changed %s context field', (_name, change) => {
    const dek = generateDataKey()
    const envelope = sealValue({ dek, valueContext, plaintext: textEncoder.encode('bound') })
    expectReason(
      () => openValue({ envelope, dek, valueContext: { ...valueContext, ...change } }),
      'authentication-failed',
    )
  })

  test('rejects every single-byte envelope mutation', () => {
    const dek = generateDataKey()
    const envelope = sealValue({
      dek,
      valueContext,
      plaintext: textEncoder.encode('every byte is authenticated'),
    })

    for (let index = 0; index < envelope.length; index += 1) {
      const changed = envelope.slice()
      changed[index] ^= 1
      expect(() => openValue({ envelope: changed, dek, valueContext })).toThrow(SecretEnvelopeError)
    }
  })

  test('reports unknown versions and algorithms before authentication', () => {
    const dek = generateDataKey()
    const envelope = sealValue({ dek, valueContext, plaintext: textEncoder.encode('value') })
    const unknownVersion = envelope.slice()
    unknownVersion[0] = 255
    const unknownAlgorithm = envelope.slice()
    unknownAlgorithm[1] = 255

    expectReason(
      () => openValue({ envelope: unknownVersion, dek, valueContext }),
      'unknown-version',
    )
    expectReason(
      () => openValue({ envelope: unknownAlgorithm, dek, valueContext }),
      'unknown-algorithm',
    )
  })

  test('length-prefixes fields and distinguishes null, empty and NUL users', () => {
    const dek = generateDataKey()
    const collisionA = { ...valueContext, keyName: 'a|b', environment: 'c' }
    const collisionB = { ...valueContext, keyName: 'a', environment: 'b|c' }
    const collisionEnvelope = sealValue({
      dek,
      valueContext: collisionA,
      plaintext: textEncoder.encode('delimited'),
    })
    expectReason(
      () => openValue({ envelope: collisionEnvelope, dek, valueContext: collisionB }),
      'authentication-failed',
    )

    const nullUser = { ...valueContext, userId: null }
    const emptyUser = { ...valueContext, userId: '' }
    const nulUser = { ...valueContext, userId: '\0' }
    const nullEnvelope = sealValue({
      dek,
      valueContext: nullUser,
      plaintext: textEncoder.encode('null'),
    })
    expectReason(
      () => openValue({ envelope: nullEnvelope, dek, valueContext: emptyUser }),
      'authentication-failed',
    )
    expectReason(
      () => openValue({ envelope: nullEnvelope, dek, valueContext: nulUser }),
      'authentication-failed',
    )
    const emptyEnvelope = sealValue({
      dek,
      valueContext: emptyUser,
      plaintext: textEncoder.encode('empty'),
    })
    expectReason(
      () => openValue({ envelope: emptyEnvelope, dek, valueContext: nulUser }),
      'authentication-failed',
    )
  })

  test('normalizes UUID case and key/environment Unicode to NFC', () => {
    const dek = generateDataKey()
    const decomposed = {
      ...valueContext,
      keyName: 'cafe\u0301',
      environment: 'pre\u0301prod',
    }
    const envelope = sealValue({
      dek,
      valueContext: decomposed,
      plaintext: textEncoder.encode('normalized'),
    })
    const normalized = {
      ...decomposed,
      spaceId: decomposed.spaceId.toLowerCase(),
      userId: decomposed.userId?.toLowerCase() ?? null,
      dekId: decomposed.dekId.toLowerCase(),
      keyName: decomposed.keyName.normalize('NFC'),
      environment: decomposed.environment.normalize('NFC'),
    }

    expect(textDecoder.decode(openValue({ envelope, dek, valueContext: normalized }))).toBe(
      'normalized',
    )
  })

  test('rejects malformed envelopes and invalid versions', () => {
    const dek = generateDataKey()
    expectReason(
      () => openValue({ envelope: new Uint8Array(), dek, valueContext }),
      'malformed-envelope',
    )
    expectReason(
      () => sealValue({ dek, valueContext: { ...valueContext, rowVersion: -1 }, plaintext: dek }),
      'malformed-envelope',
    )
  })
})

describe('data key wrapping', () => {
  test('wraps and unwraps a DEK in authenticated mode', async () => {
    const sender = await generateMachineKeyPair()
    const recipient = await generateMachineKeyPair()
    const dek = generateDataKey()
    const wrapped = await wrapDataKey({
      dek,
      wrapContext,
      senderPrivateKey: sender.privateKey,
      senderPublicKey: sender.publicKey,
      recipientPublicKey: recipient.publicKey,
    })
    const trustedSenderKeyIds = new Set([await machineKeyId(sender.publicKey)])

    expect(
      await unwrapDataKey({
        ...wrapped,
        wrapContext,
        recipientPrivateKey: recipient.privateKey,
        senderPublicKey: sender.publicKey,
        trustedSenderKeyIds,
      }),
    ).toEqual(dek)
  })

  test('refuses an unpinned sender before attempting decryption', async () => {
    const forgedSender = await generateMachineKeyPair()
    const recipient = await generateMachineKeyPair()
    const wrapped = await wrapDataKey({
      dek: generateDataKey(),
      wrapContext,
      senderPrivateKey: forgedSender.privateKey,
      senderPublicKey: forgedSender.publicKey,
      recipientPublicKey: recipient.publicKey,
    })

    await expectRejectedReason(
      () =>
        unwrapDataKey({
          enc: wrapped.enc,
          ciphertext: new Uint8Array(),
          wrapContext,
          recipientPrivateKey: recipient.privateKey,
          senderPublicKey: forgedSender.publicKey,
          trustedSenderKeyIds: new Set(),
        }),
      'untrusted-sender',
    )
  })

  test('rejects a wrong recipient and another space context', async () => {
    const sender = await generateMachineKeyPair()
    const recipient = await generateMachineKeyPair()
    const wrongRecipient = await generateMachineKeyPair()
    const wrapped = await wrapDataKey({
      dek: generateDataKey(),
      wrapContext,
      senderPrivateKey: sender.privateKey,
      senderPublicKey: sender.publicKey,
      recipientPublicKey: recipient.publicKey,
    })
    const trustedSenderKeyIds = new Set([await machineKeyId(sender.publicKey)])
    const common = {
      ...wrapped,
      senderPublicKey: sender.publicKey,
      trustedSenderKeyIds,
    }

    await expectRejectedReason(
      () =>
        unwrapDataKey({
          ...common,
          wrapContext,
          recipientPrivateKey: wrongRecipient.privateKey,
        }),
      'authentication-failed',
    )
    await expectRejectedReason(
      () =>
        unwrapDataKey({
          ...common,
          wrapContext: { ...wrapContext, spaceId: `different-${wrapContext.spaceId}` },
          recipientPrivateKey: recipient.privateKey,
        }),
      'authentication-failed',
    )
  })

  test('creates stable 22-character printable machine key ids', async () => {
    const machine = await generateMachineKeyPair()
    const first = await machineKeyId(machine.publicKey)
    expect(first).toBe(await machineKeyId(machine.publicKey.slice()))
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(machine.publicKey).toHaveLength(32)
    expect(machine.privateKey).toHaveLength(32)
  })
})
