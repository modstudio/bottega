import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { httpAddress, register } from './record-auth.ts'

test('record use accepts only an http(s) address without credentials, query, or fragment', () => {
  expect(httpAddress('https://record.example.test/api')).toBe('https://record.example.test/api')
  expect(() => httpAddress('ssh://record.example.test')).toThrow('http or https')
  expect(() => httpAddress('https://user:secret@record.example.test')).toThrow(
    'credentials; remove them',
  )
  expect(() => httpAddress('https://record.example.test?tenant=one')).toThrow('query; remove it')
  expect(() => httpAddress('https://record.example.test#setup')).toThrow('fragment; remove it')
})

test.each([
  ['neither retry form', ['record', 'outbox', 'retry']],
  ['both retry forms', ['record', 'outbox', 'retry', '7', '--matching', 'refused']],
])('record outbox retry refuses %s and names both accepted forms', async (_name, args) => {
  const program = new Command().exitOverride()
  register(program)
  await expect(program.parseAsync(['node', PLATFORM_SLUG, ...args])).rejects.toThrow(
    `exactly one retry form is required: \`${PLATFORM_SLUG} record outbox retry <row-id>\` or \`${PLATFORM_SLUG} record outbox retry --matching <text>\``,
  )
})
