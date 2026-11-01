import { expect, test } from 'bun:test'
import { assertActiveWrapRecipients, assertRegisteredWrapSenders } from './record-config.ts'

const wrap = (recipientKeyId: string) => ({
  recipientKeyId,
  senderKeyId: 'BBBBBBBBBBBBBBBBBBBBBB',
  enc: Uint8Array.of(1),
  ciphertext: Uint8Array.of(2),
})

test('data-key services refuse wraps to absent or revoked recipients', () => {
  expect(() =>
    assertActiveWrapRecipients(
      [wrap('AAAAAAAAAAAAAAAAAAAAAA'), wrap('CCCCCCCCCCCCCCCCCCCCCC')],
      new Set(['AAAAAAAAAAAAAAAAAAAAAA']),
    ),
  ).toThrow('wrap recipient CCCCCCCCCCCCCCCCCCCCCC is not a registered non-revoked machine')
  expect(() => assertActiveWrapRecipients([wrap('AAAAAAAAAAAAAAAAAAAAAA')], new Set())).toThrow(
    'wrap recipient AAAAAAAAAAAAAAAAAAAAAA is not a registered non-revoked machine',
  )
})

test('data-key services refuse an unregistered wrap sender and allow a registered one', () => {
  const candidate = wrap('AAAAAAAAAAAAAAAAAAAAAA')
  try {
    assertRegisteredWrapSenders([candidate], new Set())
    throw new Error('expected an unregistered sender refusal')
  } catch (error) {
    expect(error).toMatchObject({
      message: expect.stringContaining(
        'wrap sender BBBBBBBBBBBBBBBBBBBBBB is not a registered machine in this space',
      ),
      status: 422,
    })
  }
  expect(() =>
    assertRegisteredWrapSenders([candidate], new Set(['BBBBBBBBBBBBBBBBBBBBBB'])),
  ).not.toThrow()
})
