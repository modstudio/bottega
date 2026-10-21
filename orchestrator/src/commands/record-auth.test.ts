import { expect, test } from 'bun:test'
import { httpAddress } from './record-auth.ts'

test('record use accepts only an http(s) address without credentials, query, or fragment', () => {
  expect(httpAddress('https://record.example.test/api')).toBe('https://record.example.test/api')
  expect(() => httpAddress('ssh://record.example.test')).toThrow('http or https')
  expect(() => httpAddress('https://user:secret@record.example.test')).toThrow(
    'credentials; remove them',
  )
  expect(() => httpAddress('https://record.example.test?tenant=one')).toThrow('query; remove it')
  expect(() => httpAddress('https://record.example.test#setup')).toThrow('fragment; remove it')
})
