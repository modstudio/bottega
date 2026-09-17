import { expect, test } from 'bun:test'
import { registerStandardTransports } from '../standard-transports.ts'
import { clearRegisteredTransportsForTest, transportFor } from './transport.ts'

test('transport selection refuses when entrypoint registration is missing', () => {
  clearRegisteredTransportsForTest()
  try {
    expect(() => transportFor('cli')).toThrow(/registerStandardTransports\(\)/)
  } finally {
    registerStandardTransports()
  }
})
