import { expect, test } from 'bun:test'
import { upsertProject } from '../project/projects.ts'
import { subjectCommand } from './subject-commands.ts'

const flags = {
  has: () => false,
  flag: (name: string) => (name === 'definition' ? 'Changed definition.' : undefined),
}
const presentation = { log: () => undefined }

test('rename, define, and retire unknown subjects name the list command that clears them', async () => {
  upsertProject({ name: 'alpha', path: '/w/alpha' })
  for (const [verb, tail] of [
    ['rename', ['Missing', 'New name']],
    ['define', ['Missing']],
    ['retire', ['Missing']],
  ] as const) {
    await expect(
      subjectCommand(verb, ['subject', verb, 'alpha', ...tail], flags, presentation),
    ).rejects.toThrow('orch subject list alpha')
  }
})
