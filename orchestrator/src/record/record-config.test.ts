import { expect, test } from 'bun:test'
import { assertActiveWrapRecipients } from './record-config.ts'

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
