import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { httpAddress, promptPassword, register } from './record-auth.ts'

test('the password prompt refuses when a terminal reaches end of file', async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean }
  input.isTTY = true
  const output = new PassThrough()
  const password = promptPassword(input, output, undefined)
  input.end()

  await expect(password).rejects.toThrow(
    `record password prompt ended before a password was entered; set ${PLATFORM_SLUG.toUpperCase()}_RECORD_PASSWORD to supply it non-interactively`,
  )
})

test('the terminal password prompt shows only the prompt followed by a newline', async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean }
  input.isTTY = true
  const output = new PassThrough()
  let rendered = ''
  output.on('data', (chunk) => {
    rendered += chunk.toString()
  })

  const password = promptPassword(input, output, undefined)
  input.write('visible-secret\n')

  expect(await password).toBe('visible-secret')
  expect(rendered).toContain('Record password: ')
  expect(rendered.endsWith('\n')).toBe(true)
  expect(rendered).not.toContain('visible-secret')
})

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

test.each([[''], ['  ']])('record outbox retry refuses empty --matching text %p', async (text) => {
  const program = new Command().exitOverride()
  register(program)
  await expect(
    program.parseAsync(['node', PLATFORM_SLUG, 'record', 'outbox', 'retry', '--matching', text]),
  ).rejects.toThrow('--matching requires non-empty text')
})
