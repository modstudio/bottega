import { expect, test } from 'bun:test'
import { evidenceFromArgv } from './workflow-commands.ts'

test('workflow next preserves repeated artifact evidence in command order', () => {
  expect(
    evidenceFromArgv(['workflow', 'next', '--artifact', 'task:DEV-1', '--artifact=doc:fixture'])
      .artifacts,
  ).toEqual(['task:DEV-1', 'doc:fixture'])
})
