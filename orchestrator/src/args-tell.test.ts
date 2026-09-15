import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dir } from '../test/fixtures/store.ts'
import {
  TELL_WORKING_FORMS,
  assertWorkerText,
  parseWorkerMessageArgs,
  readMessageText,
} from './args.ts'
import { trackedTestResidue } from '../test/residue.ts'
const trackResidue = trackedTestResidue()

test('tell reads long context from a file without shell interpretation', async () => {
  const path = trackResidue(join(dir, 'mailbox-long-note.txt'))
  const body = 'keep `literal` and $VALUE\nsecond paragraph\n'
  writeFileSync(path, body)
  const source = parseWorkerMessageArgs(['--file', path])
  expect(await readMessageText({ missing: 'no message', sources: source })).toBe(body)
})
test('tell refuses a message that is only --file', async () => {
  const path = trackResidue(join(dir, 'mailbox-dash-token.txt'))
  writeFileSync(path, '--file')
  const text = await readMessageText({
    missing: 'no message',
    sources: parseWorkerMessageArgs(['--file', path]),
  })
  expect(() => assertWorkerText(text!, 'message', TELL_WORKING_FORMS)).toThrow(
    'received "--file" as a message',
  )
})
test('tell accepts a two-word message beginning with --', async () => {
  const source = parseWorkerMessageArgs(['--literal', 'is intended'])
  expect(await readMessageText({ missing: 'no message', sources: source })).toBe(
    '--literal is intended',
  )
})
test('tell --file refuses invalid UTF-8 at the byte offset', async () => {
  const path = trackResidue(join(dir, 'mailbox-bad-utf8.bin'))
  writeFileSync(path, Buffer.from([0x66, 0x80, 0xff, 0x67]))
  expect(
    readMessageText({ missing: 'no message', sources: parseWorkerMessageArgs(['--file', path]) }),
  ).rejects.toThrow('invalid UTF-8 in')
  expect(
    readMessageText({ missing: 'no message', sources: parseWorkerMessageArgs(['--file', path]) }),
  ).rejects.toThrow('byte offset 1')
})
test('tell stdin refuses invalid UTF-8 at the byte offset', async () => {
  const stdin = { isTTY: false, bytes: async () => Buffer.from([0x66, 0x80, 0xff, 0x67]) }
  expect(
    readMessageText({ missing: 'no message', sources: { positionals: [] } }, stdin),
  ).rejects.toThrow('invalid UTF-8 in stdin at byte offset 1')
})
test('tell keeps flag-shaped words after the message starts', () => {
  expect(parseWorkerMessageArgs(['use', '--agent', 'codex', 'exactly']).positionals).toEqual([
    'use',
    '--agent',
    'codex',
    'exactly',
  ])
})
test('tell stdin refuses whitespace-only input', async () => {
  const stdin = { isTTY: false, bytes: async () => Buffer.from([0x20, 0x09, 0x0d, 0x0a]) }
  const text = await readMessageText({ missing: 'no message', sources: { positionals: [] } }, stdin)
  expect(() => assertWorkerText(text!, 'message', TELL_WORKING_FORMS)).toThrow('empty message')
})
test('tell refuses a message that is only a flag-shaped word', async () => {
  const source = parseWorkerMessageArgs(['--quiet'])
  const text = await readMessageText({ missing: 'no message', sources: source })
  expect(() => assertWorkerText(text!, 'message', TELL_WORKING_FORMS)).toThrow(
    'received "--quiet" as a message',
  )
})
