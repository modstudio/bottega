import { expect, test } from 'bun:test'
import {
  credentialDisplayName,
  credentialHint,
  parseCredentialSlot,
} from './credential-presentation.ts'

test('credential slots use the shared payer and binding grammar', () => {
  expect(parseCredentialSlot('shared@project')).toEqual({ payer: 'shared', binding: 'project' })
  expect(parseCredentialSlot('shared@other')).toBeNull()
})

test('hints mask only long values and display names show mode and environment', () => {
  expect(credentialHint('12345678901234567890')).toBe('1234…7890')
  expect(credentialHint('short')).toBe('5 characters')
  expect(credentialDisplayName('openrouter', null, 'api-key', 'test', 'local')).toBe(
    'openrouter/api-key (mode test, env local)',
  )
})
