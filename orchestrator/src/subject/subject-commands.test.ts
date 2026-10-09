import { expect, test } from 'bun:test'
import { upsertProject } from '../project/projects.ts'
import { subjectCommand } from './subject-commands.ts'

const flags = {
  has: () => false,
  flag: (name: string) => (name === 'definition' ? 'Changed definition.' : undefined),
}
const presentation = { log: () => undefined }

test('list presents an empty registered project as one line while JSON stays an array', async () => {
  upsertProject({ name: 'alpha', path: '/w/alpha' })
  const lines: unknown[][] = []
  await subjectCommand('list', ['subject', 'list', 'alpha'], flags, {
    log: (...values) => lines.push(values),
  })
  expect(lines).toEqual([
    [
      'project alpha has no subjects; add one with: orch subject add alpha <name> --definition <definition>',
    ],
  ])

  const jsonLines: unknown[][] = []
  await subjectCommand(
    'list',
    ['subject', 'list', 'alpha'],
    { ...flags, has: (name) => name === 'json' },
    { log: (...values) => jsonLines.push(values) },
  )
  expect(jsonLines).toEqual([['[]']])
})

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
